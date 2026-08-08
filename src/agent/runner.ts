import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Api, RawApi } from "grammy";
import { assertProviderModel, getProject, getProvider } from "../config.js";
import type { Database } from "../db.js";
import type { RuntimeConfig, SessionRecord } from "../domain.js";
import type { EffortStore } from "../effort-store.js";
import type { Logger } from "../logger.js";
import { errorFields } from "../logger.js";
import { redactText } from "../security.js";
import { escapeHtml, truncate } from "../telegram/format.js";
import { WorkerClient } from "../worker-client.js";
import type { WorkerTurnRequest } from "../worker-protocol.js";
import { resolveEffortLevel } from "./efficiency.js";
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

function sdkSessionId(message: SDKMessage): string | undefined {
  const value = (message as unknown as Record<string, unknown>).session_id;
  return typeof value === "string" && value ? value : undefined;
}

function resultRecord(message: SDKMessage): Record<string, unknown> | undefined {
  const record = message as unknown as Record<string, unknown>;
  return record.type === "result" ? record : undefined;
}

function providerSecrets(config: RuntimeConfig, session: SessionRecord): string[] {
  const provider = getProvider(config, session.providerId);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.auth.env)) {
    throw new Error("Provider auth.env must contain an environment variable name (for example AGENTROUTER_API_KEY), not the API key itself.");
  }
  const secret = process.env[provider.auth.env]?.trim();
  if (!secret) throw new Error(`Provider credential environment variable is missing: ${provider.auth.env}`);
  return [secret, ...Object.values(provider.extraEnv ?? {})].filter((value) => value.length >= 6);
}

function controllerInternalUrl(config: RuntimeConfig): string {
  return (process.env.CLAUDETG_CONTROLLER_INTERNAL_URL?.trim() || `http://claudetg:${config.healthPort}`).replace(/\/+$/, "");
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
    const promise = this.execute(chatId, userId, text).catch(async (error: unknown) => {
      const message = redactText(error instanceof Error ? error.message : String(error));
      const session = this.database.getActiveSession(chatId);
      if (session) {
        this.database.updateSession(session.id, { status: "error", lastError: truncate(message, 2000) });
        this.database.addEvent(session.id, "startup_error", truncate(message, 1000));
      }
      this.logger.error("Uncaught agent turn failure", { chatId, ...errorFields(error) });
      await this.api.sendMessage(
        chatId,
        `❌ <b>Не удалось запустить Claude</b>\n${escapeHtml(message)}`,
        { parse_mode: "HTML" },
      ).catch((sendError: unknown) => this.logger.debug("Could not send startup error to Telegram", { error: String(sendError) }));
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
    const secrets = providerSecrets(this.config, session);
    const effort = this.effortStore.get(session.id) ?? resolveEffortLevel();
    const abortController = new AbortController();
    this.active.set(chatId, { sessionId: session.id, abortController, startedAt: Date.now() });
    this.database.updateSession(session.id, { status: "running", lastError: null });
    this.database.addEvent(session.id, "user", truncate(prompt, 1000));

    await this.api.sendMessage(
      chatId,
      `▶️ <b>${escapeHtml(session.title)}</b>\n` +
        `Project: <code>${escapeHtml(project.name)}</code>\n` +
        `Worker: <code>${escapeHtml(project.workerUrl)}</code>\n` +
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
    const worker = new WorkerClient(project.workerUrl, this.config.internalWorkerToken, this.logger);
    let timeout: NodeJS.Timeout | undefined;
    let finalResult: Record<string, unknown> | undefined;
    let latestSdkSessionId = session.sdkSessionId;

    try {
      timeout = setTimeout(() => abortController.abort(), this.config.agent.turnTimeoutMs);
      const available = await worker.health(abortController.signal);
      if (!available) throw new Error(`Claude worker is unavailable: ${project.workerUrl}`);

      const request: WorkerTurnRequest = {
        runId: randomUUID(),
        chatId,
        userId,
        sessionId: session.id,
        projectId: project.id,
        projectPath: project.path,
        additionalDirectories: project.additionalDirectories ?? [],
        prompt,
        model: session.modelId,
        permissionMode: session.permissionMode,
        allowedTools: project.allowedTools ?? [],
        disallowedTools: project.disallowedTools ?? [],
        settingSources: project.settingSources ?? ["user", "project", "local"],
        autoAllowReadTools: project.autoAllowReadTools ?? true,
        ...(project.systemPromptAppend ? { systemPromptAppend: project.systemPromptAppend } : {}),
        title: session.title,
        effort,
        maxTurns: this.config.agent.maxTurns,
        ...(this.config.agent.maxBudgetUsd !== undefined ? { maxBudgetUsd: this.config.agent.maxBudgetUsd } : {}),
        ...(session.sdkSessionId ? { sdkSessionId: session.sdkSessionId } : {}),
        providerProxyUrl: `${controllerInternalUrl(this.config)}/provider-proxy/${encodeURIComponent(provider.id)}`,
        passEnv: project.passEnv ?? [],
      };

      await worker.runTurn(request, abortController.signal, async (message) => {
        const id = sdkSessionId(message);
        if (id && id !== latestSdkSessionId) {
          latestSdkSessionId = id;
          this.database.updateSession(session.id, { sdkSessionId: id });
        }
        const result = resultRecord(message);
        if (result) finalResult = result;
        await renderer.handle(message);
      });

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
      await this.api.sendMessage(chatId, `${aborted ? "⛔" : "❌"} ${escapeHtml(message)}`, { parse_mode: "HTML" });
      if (!aborted) this.logger.error("Remote agent turn failed", { chatId, sessionId: session.id, workerUrl: project.workerUrl, ...errorFields(error) });
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
