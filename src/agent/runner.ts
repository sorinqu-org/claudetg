import type { Api, RawApi } from "grammy";
import {
  query,
  type HookCallback,
  type Options,
  type PreToolUseHookInput,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { getProject, getProvider, assertProviderModel } from "../config.js";
import type { Database } from "../db.js";
import type { RuntimeConfig, SessionRecord } from "../domain.js";
import type { EffortStore } from "../effort-store.js";
import type { Logger } from "../logger.js";
import { errorFields } from "../logger.js";
import { collectPathViolations, redactText } from "../security.js";
import { escapeHtml, truncate } from "../telegram/format.js";
import { buildEfficiencyEnvironment, buildEfficiencyPlugins, resolveEffortLevel, type EffortSetting } from "./efficiency.js";
import { InteractionBroker } from "./interaction-broker.js";
import { AgentMessageRenderer } from "./message-renderer.js";

interface ActiveRun {
  sessionId: string;
  abortController: AbortController;
  startedAt: number;
}

interface QueuedPrompt {
  userId: number;
  text: string;
}

const SAFE_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
] as const;

function buildAgentEnv(
  config: RuntimeConfig,
  session: SessionRecord,
  effort: EffortSetting,
): { env: Record<string, string | undefined>; secrets: string[] } {
  const project = getProject(config, session.projectId);
  const provider = getProvider(config, session.providerId);
  assertProviderModel(provider, session.modelId);
  const secret = process.env[provider.auth.env]?.trim();
  if (!secret) throw new Error(`Provider credential environment variable is missing: ${provider.auth.env}`);
  const env: Record<string, string | undefined> = {};
  for (const name of SAFE_ENV_NAMES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, buildEfficiencyEnvironment(env.PATH, effort));
  for (const name of project.passEnv ?? []) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, provider.extraEnv ?? {});
  env.ANTHROPIC_BASE_URL = provider.baseUrl;
  env.ANTHROPIC_MODEL = session.modelId;
  const modelName = session.modelId.toLowerCase();
  if (modelName.includes("opus")) env.ANTHROPIC_DEFAULT_OPUS_MODEL = session.modelId;
  if (modelName.includes("sonnet")) env.ANTHROPIC_DEFAULT_SONNET_MODEL = session.modelId;
  if (modelName.includes("haiku")) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = session.modelId;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "claudetg/1.0.0";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1";
  if ((project.additionalDirectories?.length ?? 0) > 0) {
    env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";
  }
  if (provider.auth.type === "bearer") {
    env.ANTHROPIC_AUTH_TOKEN = secret;
    delete env.ANTHROPIC_API_KEY;
  } else {
    env.ANTHROPIC_API_KEY = secret;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  const secrets = [
    secret,
    ...(project.passEnv ?? []).map((name) => process.env[name] ?? ""),
    ...Object.values(provider.extraEnv ?? {}),
  ].filter((value) => value.length >= 6);
  return { env, secrets: [...new Set(secrets)] };
}

function sdkSessionId(message: SDKMessage): string | undefined {
  const value = (message as unknown as Record<string, unknown>).session_id;
  return typeof value === "string" && value ? value : undefined;
}

function resultRecord(message: SDKMessage): Record<string, unknown> | undefined {
  const record = message as unknown as Record<string, unknown>;
  return record.type === "result" ? record : undefined;
}

function buildPolicyHooks(input: {
  api: Api<RawApi>;
  database: Database;
  logger: Logger;
  chatId: number;
  sessionId: string;
  allowedRoots: string[];
  autoAllowReadTools: boolean;
  secrets: string[];
}): NonNullable<Options["hooks"]> {
  const callback: HookCallback = async (rawInput) => {
    const hookInput = rawInput as PreToolUseHookInput;
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const toolName = hookInput.tool_name;
    const toolInput = hookInput.tool_input && typeof hookInput.tool_input === "object"
      ? hookInput.tool_input as Record<string, unknown>
      : {};
    const cwd = typeof hookInput.cwd === "string" ? hookInput.cwd : input.allowedRoots[0];
    const violations = collectPathViolations(toolInput, input.allowedRoots, cwd);
    if (violations.length > 0) {
      const reason = `Blocked path outside configured project roots: ${violations.join(", ")}`;
      input.database.addEvent(input.sessionId, "host_policy_denied", `${toolName}: ${redactText(reason, input.secrets)}`);
      await input.api.sendMessage(
        input.chatId,
        `🛡️ <b>Blocked by host policy</b>\n${escapeHtml(redactText(reason, input.secrets))}`,
        { parse_mode: "HTML" },
      ).catch((error: unknown) => input.logger.debug("Could not send host-policy denial", { error: String(error) }));
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    }
    if (input.autoAllowReadTools && ["Read", "Glob", "Grep"].includes(toolName)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "Read-only tool inside configured project roots",
        },
      };
    }
    return {};
  };
  return {
    PreToolUse: [{
      matcher: "^(Read|Write|Edit|NotebookEdit|Glob|Grep)$",
      hooks: [callback],
    }],
  };
}

export class AgentRunner {
  private readonly active = new Map<number, ActiveRun>();
  private readonly queues = new Map<number, QueuedPrompt[]>();
  private readonly runPromises = new Map<number, Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly api: Api<RawApi>,
    private readonly config: RuntimeConfig,
    private readonly database: Database,
    private readonly broker: InteractionBroker,
    private readonly effortStore: EffortStore,
    private readonly logger: Logger,
  ) {}

  isRunning(chatId: number): boolean {
    return this.active.has(chatId);
  }

  queueLength(chatId: number): number {
    return this.queues.get(chatId)?.length ?? 0;
  }

  getActive(chatId: number): ActiveRun | undefined {
    return this.active.get(chatId);
  }

  async submit(chatId: number, userId: number, text: string): Promise<void> {
    if (this.shuttingDown) {
      await this.api.sendMessage(chatId, "Service is shutting down; the prompt was not started.");
      return;
    }
    if (this.active.has(chatId)) {
      const queue = this.queues.get(chatId) ?? [];
      if (queue.length >= this.config.agent.queueLimit) {
        await this.api.sendMessage(chatId, `Queue limit reached (${this.config.agent.queueLimit}). Use /stop or wait for the current turn.`);
        return;
      }
      queue.push({ userId, text });
      this.queues.set(chatId, queue);
      await this.api.sendMessage(chatId, `📥 Prompt queued. Position: ${queue.length}`);
      return;
    }
    this.startExecution(chatId, userId, text);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.queues.clear();
    const activeChats = [...this.active.keys()];
    await Promise.allSettled(activeChats.map((chatId) => this.broker.cancelForChat(chatId, "Service is shutting down.")));
    for (const active of this.active.values()) active.abortController.abort();
    await Promise.allSettled([...this.runPromises.values()]);
  }

  private startExecution(chatId: number, userId: number, text: string): void {
    const promise = this.execute(chatId, userId, text).catch((error: unknown) => {
      this.logger.error("Uncaught agent turn failure", { chatId, ...errorFields(error) });
    });
    this.runPromises.set(chatId, promise);
    void promise.finally(() => {
      if (this.runPromises.get(chatId) === promise) this.runPromises.delete(chatId);
    });
  }

  async stop(chatId: number): Promise<boolean> {
    const active = this.active.get(chatId);
    this.queues.delete(chatId);
    await this.broker.cancelForChat(chatId, "User stopped the active turn.");
    if (!active) return false;
    active.abortController.abort();
    return true;
  }

  private async execute(chatId: number, userId: number, prompt: string): Promise<void> {
    const session = this.database.getActiveSession(chatId);
    if (!session) {
      await this.api.sendMessage(chatId, "No active session. Use /new first.");
      return;
    }
    const project = getProject(this.config, session.projectId);
    const provider = getProvider(this.config, session.providerId);
    assertProviderModel(provider, session.modelId);
    const effort = this.effortStore.get(session.id) ?? resolveEffortLevel();
    const { env, secrets } = buildAgentEnv(this.config, session, effort);
    const abortController = new AbortController();
    this.active.set(chatId, { sessionId: session.id, abortController, startedAt: Date.now() });
    this.database.updateSession(session.id, { status: "running", lastError: null });
    this.database.addEvent(session.id, "user", truncate(prompt, 1000));
    await this.api.sendMessage(
      chatId,
      `▶️ <b>${escapeHtml(session.title)}</b>\n` +
        `Project: <code>${escapeHtml(project.name)}</code>\n` +
        `Model: <code>${escapeHtml(session.modelId)}</code>\n` +
        `Mode: <code>${escapeHtml(session.permissionMode)}</code>\n` +
        `Effort: <code>${escapeHtml(effort)}</code>`,
      { parse_mode: "HTML" },
    );
    const renderer = new AgentMessageRenderer(
      this.api,
      chatId,
      session.id,
      this.database,
      this.logger,
      this.config.agent.streamFlushMs,
      this.config.agent.maxToolDetailChars,
      secrets,
    );
    let timeout: NodeJS.Timeout | undefined;
    let finalResult: Record<string, unknown> | undefined;
    let latestSdkSessionId = session.sdkSessionId;
    try {
      timeout = setTimeout(() => abortController.abort(), this.config.agent.turnTimeoutMs);
      const allowedRoots = [project.path, ...(project.additionalDirectories ?? [])];
      const autoAllowReadTools = project.autoAllowReadTools ?? true;
      const canUseTool = this.broker.createCanUseTool({
        chatId,
        userId,
        sessionId: session.id,
        allowedRoots,
        autoAllowReadTools,
      });
      const options: Options = {
        abortController,
        cwd: project.path,
        additionalDirectories: project.additionalDirectories ?? [],
        model: session.modelId,
        permissionMode: session.permissionMode,
        allowedTools: project.allowedTools ?? [],
        disallowedTools: project.disallowedTools ?? [],
        canUseTool,
        hooks: buildPolicyHooks({
          api: this.api,
          database: this.database,
          logger: this.logger,
          chatId,
          sessionId: session.id,
          allowedRoots,
          autoAllowReadTools,
          secrets,
        }),
        env,
        includePartialMessages: true,
        includeHookEvents: true,
        forwardSubagentText: true,
        agentProgressSummaries: false,
        promptSuggestions: false,
        maxTurns: this.config.agent.maxTurns,
        tools: { type: "preset", preset: "claude_code" },
        plugins: buildEfficiencyPlugins(),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(project.systemPromptAppend ? { append: project.systemPromptAppend } : {}),
        },
        settingSources: project.settingSources ?? ["project", "local"],
        strictMcpConfig: false,
        persistSession: true,
        title: session.title,
        toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
        stderr: (data) => this.logger.debug("Claude Agent SDK stderr", {
          sessionId: session.id,
          data: truncate(redactText(data, secrets), 2000),
        }),
        ...(session.sdkSessionId ? { resume: session.sdkSessionId } : {}),
        ...(this.config.agent.maxBudgetUsd !== undefined ? { maxBudgetUsd: this.config.agent.maxBudgetUsd } : {}),
      };
      for await (const message of query({ prompt, options })) {
        const id = sdkSessionId(message);
        if (id && id !== latestSdkSessionId) {
          latestSdkSessionId = id;
          this.database.updateSession(session.id, { sdkSessionId: id });
        }
        const result = resultRecord(message);
        if (result) finalResult = result;
        await renderer.handle(message);
      }
      const isError = finalResult?.is_error === true || (
        typeof finalResult?.subtype === "string" && finalResult.subtype !== "success"
      );
      const cost = typeof finalResult?.total_cost_usd === "number" ? finalResult.total_cost_usd : 0;
      const turns = typeof finalResult?.num_turns === "number" ? finalResult.num_turns : 0;
      const errors = Array.isArray(finalResult?.errors) ? finalResult.errors.map(String).join("; ") : undefined;
      this.database.updateSession(session.id, {
        status: isError ? "error" : "idle",
        ...(errors ? { lastError: truncate(errors, 2000) } : { lastError: null }),
        totalCostUsdDelta: cost,
        totalTurnsDelta: turns,
        ...(latestSdkSessionId ? { sdkSessionId: latestSdkSessionId } : {}),
      });
    } catch (error) {
      const aborted = abortController.signal.aborted;
      const rawMessage = aborted ? "Turn stopped or timed out." : error instanceof Error ? error.message : String(error);
      const message = redactText(rawMessage, secrets);
      this.database.updateSession(session.id, {
        status: aborted ? "stopped" : "error",
        lastError: truncate(message, 2000),
        ...(latestSdkSessionId ? { sdkSessionId: latestSdkSessionId } : {}),
      });
      this.database.addEvent(session.id, aborted ? "stopped" : "error", truncate(message, 1000));
      await this.api.sendMessage(
        chatId,
        `${aborted ? "⛔" : "❌"} ${escapeHtml(message)}`,
        { parse_mode: "HTML" },
      );
      if (!aborted) this.logger.error("Agent turn failed", { chatId, sessionId: session.id, ...errorFields(error) });
    } finally {
      if (timeout) clearTimeout(timeout);
      await renderer.close().catch((error: unknown) => {
        this.logger.debug("Renderer close failed", { error: String(error) });
      });
      this.active.delete(chatId);
      const queue = this.queues.get(chatId);
      const next = queue?.shift();
      if (queue && queue.length === 0) this.queues.delete(chatId);
      if (next && !this.shuttingDown) {
        await this.api.sendMessage(chatId, "▶️ Starting the next queued prompt.");
        this.startExecution(chatId, next.userId, next.text);
      }
    }
  }
}
