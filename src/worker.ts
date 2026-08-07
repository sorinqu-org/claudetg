import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { once } from "node:events";
import {
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type PermissionResult,
  type PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { buildEfficiencyEnvironment, buildEfficiencyPlugins } from "./agent/efficiency.js";
import { Logger } from "./logger.js";
import { collectPathViolations, redactText } from "./security.js";
import type {
  WorkerPermissionRequest,
  WorkerPermissionResponse,
  WorkerSettingsFile,
  WorkerSettingsResponse,
  WorkerStreamEnvelope,
  WorkerTurnRequest,
} from "./worker-protocol.js";

const WORKER_PORT = Number.parseInt(process.env.WORKER_PORT?.trim() || "3100", 10);
const WORKER_PROJECT_ID = process.env.WORKER_PROJECT_ID?.trim() || "main";
const WORKSPACE_PATH = path.resolve(process.env.WORKSPACE_PATH?.trim() || "/workspace");
const CLAUDE_HOME = path.resolve(process.env.HOME?.trim() || "/home/claude");
const CONTROLLER_URL = (process.env.CLAUDETG_CONTROLLER_URL?.trim() || "http://claudetg:3000").replace(/\/+$/, "");
const INTERNAL_TOKEN = process.env.CLAUDETG_INTERNAL_TOKEN?.trim() || "";
const LOG_LEVEL = (process.env.LOG_LEVEL?.trim() || "info") as "debug" | "info" | "warn" | "error";
const BODY_LIMIT = 2 * 1024 * 1024;
const logger = new Logger(LOG_LEVEL);

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

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as T;
}

function authenticated(request: IncomingMessage): boolean {
  if (!INTERNAL_TOKEN) return false;
  return request.headers["x-claudetg-internal-token"] === INTERNAL_TOKEN;
}

function allowedRoots(request: WorkerTurnRequest): string[] {
  const roots = [WORKSPACE_PATH, CLAUDE_HOME];
  for (const candidate of request.additionalDirectories) {
    const resolved = path.resolve(candidate);
    if (resolved.startsWith(`${WORKSPACE_PATH}${path.sep}`) || resolved === WORKSPACE_PATH) roots.push(resolved);
    else if (resolved.startsWith(`${CLAUDE_HOME}${path.sep}`) || resolved === CLAUDE_HOME) roots.push(resolved);
  }
  return [...new Set(roots)];
}

function buildWorkerEnv(request: WorkerTurnRequest): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of SAFE_ENV_NAMES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, buildEfficiencyEnvironment(env.PATH, request.effort));
  for (const name of request.passEnv) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.HOME = CLAUDE_HOME;
  env.ANTHROPIC_BASE_URL = request.providerProxyUrl.replace(/\/+$/, "");
  // Deliberately non-secret. The real provider credential exists only in the controller.
  env.ANTHROPIC_AUTH_TOKEN = "claudetg-worker-proxy";
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_MODEL = request.model;
  const model = request.model.toLowerCase();
  if (model.includes("opus")) env.ANTHROPIC_DEFAULT_OPUS_MODEL = request.model;
  if (model.includes("sonnet")) env.ANTHROPIC_DEFAULT_SONNET_MODEL = request.model;
  if (model.includes("haiku")) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = request.model;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "claudetg-worker/2.0.0";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  // Docker is the isolation boundary. No real provider/cloud secret is put in the Claude process.
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "0";
  env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1";
  return env;
}

function buildPathPolicyHooks(roots: string[]): NonNullable<Options["hooks"]> {
  const callback: HookCallback = async (rawInput) => {
    const hookInput = rawInput as PreToolUseHookInput;
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const toolInput = hookInput.tool_input && typeof hookInput.tool_input === "object"
      ? hookInput.tool_input as Record<string, unknown>
      : {};
    const cwd = typeof hookInput.cwd === "string" ? hookInput.cwd : WORKSPACE_PATH;
    const violations = collectPathViolations(toolInput, roots, cwd);
    if (violations.length === 0) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Path is outside worker workspace/home: ${violations.join(", ")}`,
      },
    };
  };
  return {
    PreToolUse: [{
      matcher: "^(Read|Write|Edit|NotebookEdit|Glob|Grep)$",
      hooks: [callback],
    }],
  };
}

async function requestPermission(
  request: WorkerTurnRequest,
  roots: string[],
  toolName: string,
  toolInput: Record<string, unknown>,
  signal: AbortSignal,
  decisionReason?: string,
  blockedPath?: string,
): Promise<PermissionResult> {
  const body: WorkerPermissionRequest = {
    chatId: request.chatId,
    userId: request.userId,
    sessionId: request.sessionId,
    toolName,
    toolInput,
    autoAllowReadTools: request.autoAllowReadTools,
    allowedRoots: roots,
    ...(decisionReason ? { decisionReason } : {}),
    ...(blockedPath ? { blockedPath } : {}),
  };
  try {
    const response = await fetch(`${CONTROLLER_URL}/internal/tool-permission`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claudetg-internal-token": INTERNAL_TOKEN,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      return { behavior: "deny", message: `Controller permission service returned HTTP ${response.status}` };
    }
    const payload = await response.json() as WorkerPermissionResponse;
    return payload.result;
  } catch (error) {
    if (signal.aborted) return { behavior: "deny", message: "Turn was stopped.", interrupt: true };
    return { behavior: "deny", message: `Controller permission service unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function buildCanUseTool(request: WorkerTurnRequest, roots: string[]): CanUseTool {
  return async (toolName, toolInput, options) => {
    const input = toolInput && typeof toolInput === "object" ? toolInput as Record<string, unknown> : {};
    const violations = collectPathViolations(input, roots, WORKSPACE_PATH);
    if (violations.length > 0) {
      return { behavior: "deny", message: `Path is outside worker workspace/home: ${violations.join(", ")}` };
    }
    return requestPermission(
      request,
      roots,
      toolName,
      input,
      options.signal,
      options.decisionReason,
      options.blockedPath,
    );
  };
}

async function writeEnvelope(response: ServerResponse, envelope: WorkerStreamEnvelope): Promise<void> {
  if (!response.write(`${JSON.stringify(envelope)}\n`)) await once(response, "drain");
}

function inspectFile(candidate: string): WorkerSettingsFile | undefined {
  if (!existsSync(candidate)) return undefined;
  try {
    if (!statSync(candidate).isFile()) return undefined;
    if (statSync(candidate).size > 1_000_000) return { path: candidate, content: "[file larger than 1 MB]" };
    return { path: candidate, content: readFileSync(candidate, "utf8").slice(0, 100_000) };
  } catch (error) {
    return { path: candidate, content: `[unreadable: ${error instanceof Error ? error.message : String(error)}]` };
  }
}

async function handleSettings(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (!authenticated(request)) return json(response, 401, { error: "unauthorized" });
  const projectId = url.searchParams.get("projectId") || WORKER_PROJECT_ID;
  if (projectId !== WORKER_PROJECT_ID) return json(response, 404, { error: "project_not_hosted_by_worker" });
  const candidates = [
    path.join(WORKSPACE_PATH, ".claude", "settings.json"),
    path.join(WORKSPACE_PATH, ".claude", "settings.local.json"),
    path.join(WORKSPACE_PATH, ".mcp.json"),
    path.join(WORKSPACE_PATH, "CLAUDE.md"),
    path.join(CLAUDE_HOME, ".claude", "settings.json"),
  ];
  const files = candidates.map(inspectFile).filter((item): item is WorkerSettingsFile => Boolean(item));
  const result: WorkerSettingsResponse = {
    projectId,
    home: CLAUDE_HOME,
    workspace: WORKSPACE_PATH,
    files,
  };
  json(response, 200, result);
}

async function handleTurn(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!authenticated(request)) return json(response, 401, { error: "unauthorized" });
  if (!INTERNAL_TOKEN) return json(response, 503, { error: "CLAUDETG_INTERNAL_TOKEN is not configured" });
  let input: WorkerTurnRequest;
  try {
    input = await readJson<WorkerTurnRequest>(request);
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  if (input.projectId !== WORKER_PROJECT_ID) return json(response, 409, { error: "wrong_worker_project" });
  if (path.resolve(input.projectPath) !== WORKSPACE_PATH) {
    return json(response, 409, { error: `worker workspace is ${WORKSPACE_PATH}, request expected ${input.projectPath}` });
  }

  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  const roots = allowedRoots(input);

  try {
    const options: Options = {
      abortController,
      cwd: WORKSPACE_PATH,
      additionalDirectories: input.additionalDirectories,
      model: input.model,
      permissionMode: input.permissionMode,
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      canUseTool: buildCanUseTool(input, roots),
      hooks: buildPathPolicyHooks(roots),
      env: buildWorkerEnv(input),
      includePartialMessages: true,
      includeHookEvents: true,
      forwardSubagentText: true,
      agentProgressSummaries: false,
      promptSuggestions: false,
      maxTurns: input.maxTurns,
      tools: { type: "preset", preset: "claude_code" },
      plugins: buildEfficiencyPlugins(),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(input.systemPromptAppend ? { append: input.systemPromptAppend } : {}),
      },
      settingSources: input.settingSources,
      strictMcpConfig: false,
      persistSession: true,
      title: input.title,
      toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
      stderr: (data) => {
        void writeEnvelope(response, { type: "stderr", data: redactText(data).slice(0, 4000) }).catch(() => undefined);
      },
      ...(input.sdkSessionId ? { resume: input.sdkSessionId } : {}),
      ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
    };

    for await (const message of query({ prompt: input.prompt ?? "", options } as Parameters<typeof query>[0] & { prompt: string })) {
      if (abortController.signal.aborted) break;
      await writeEnvelope(response, { type: "sdk", message: message as unknown as Record<string, unknown> });
    }
    if (!abortController.signal.aborted) await writeEnvelope(response, { type: "done" });
  } catch (error) {
    if (!abortController.signal.aborted) {
      await writeEnvelope(response, { type: "error", message: redactText(error instanceof Error ? error.message : String(error)).slice(0, 4000) });
    }
  } finally {
    request.off("aborted", abort);
    response.off("close", abort);
    if (!response.writableEnded) response.end();
  }
}

if (!Number.isFinite(WORKER_PORT) || WORKER_PORT <= 0) throw new Error("WORKER_PORT must be a positive integer");
if (!INTERNAL_TOKEN) throw new Error("CLAUDETG_INTERNAL_TOKEN is required in the worker container");
if (!existsSync(WORKSPACE_PATH)) throw new Error(`Worker workspace does not exist: ${WORKSPACE_PATH}`);

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "worker"}`);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return json(response, 200, { status: "ok", projectId: WORKER_PROJECT_ID, workspace: WORKSPACE_PATH, home: CLAUDE_HOME });
  }
  if (request.method === "GET" && url.pathname === "/v1/settings") {
    void handleSettings(request, response, url).catch((error) => json(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/turn") {
    void handleTurn(request, response).catch((error) => {
      logger.error("Unhandled worker turn error", { error: String(error) });
      if (!response.headersSent) json(response, 500, { error: "worker_internal_error" });
      else if (!response.writableEnded) response.end();
    });
    return;
  }
  json(response, 404, { error: "not_found" });
});

server.listen(WORKER_PORT, "0.0.0.0", () => {
  logger.info("Claude worker listening", { port: WORKER_PORT, projectId: WORKER_PROJECT_ID, workspace: WORKSPACE_PATH, home: CLAUDE_HOME });
});

const shutdown = (signal: string): void => {
  logger.info("Worker shutting down", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
