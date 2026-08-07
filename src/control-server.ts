import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { assertProviderModel, getProvider } from "./config.js";
import type { InteractionBroker } from "./agent/interaction-broker.js";
import type { RuntimeConfig } from "./domain.js";
import type { Logger } from "./logger.js";
import { redactText } from "./security.js";
import type { WorkerPermissionRequest, WorkerPermissionResponse } from "./worker-protocol.js";

const INTERNAL_PROXY_CREDENTIAL = "claudetg-worker-proxy";
const BODY_LIMIT = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, limit = BODY_LIMIT): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function internalAuthenticated(request: IncomingMessage, token: string): boolean {
  return request.headers["x-claudetg-internal-token"] === token;
}

function proxyAuthenticated(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  const apiKey = request.headers["x-api-key"];
  return authorization === `Bearer ${INTERNAL_PROXY_CREDENTIAL}` || apiKey === INTERNAL_PROXY_CREDENTIAL;
}

function providerSecret(config: RuntimeConfig, providerId: string): string {
  const provider = getProvider(config, providerId);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.auth.env)) {
    throw new Error(`Provider ${provider.id} auth.env must be an environment variable name`);
  }
  const secret = process.env[provider.auth.env]?.trim();
  if (!secret) throw new Error(`Provider credential environment variable is missing: ${provider.auth.env}`);
  return secret;
}

async function handlePermission(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  broker: InteractionBroker,
): Promise<void> {
  if (!internalAuthenticated(request, config.internalWorkerToken)) return json(response, 401, { error: "unauthorized" });
  let input: WorkerPermissionRequest;
  try {
    input = JSON.parse((await readBody(request, 2 * 1024 * 1024)).toString("utf8")) as WorkerPermissionRequest;
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  if (!Number.isSafeInteger(input.chatId) || !Number.isSafeInteger(input.userId) || !input.sessionId || !input.toolName) {
    return json(response, 400, { error: "invalid_permission_request" });
  }
  const abortController = new AbortController();
  request.once("aborted", () => abortController.abort());
  response.once("close", () => {
    if (!response.writableEnded) abortController.abort();
  });

  const canUseTool = broker.createCanUseTool({
    chatId: input.chatId,
    userId: input.userId,
    sessionId: input.sessionId,
    allowedRoots: input.allowedRoots,
    autoAllowReadTools: input.autoAllowReadTools,
  });
  const options = {
    signal: abortController.signal,
    ...(input.decisionReason ? { decisionReason: input.decisionReason } : {}),
    ...(input.blockedPath ? { blockedPath: input.blockedPath } : {}),
  } as Parameters<typeof canUseTool>[2];
  const decision = await canUseTool(input.toolName, input.toolInput, options);
  const result: PermissionResult = decision ?? {
    behavior: "deny",
    message: "Controller did not return a permission decision.",
  };
  const payload: WorkerPermissionResponse = { result };
  if (!response.writableEnded) json(response, 200, payload);
}

function proxyRoute(pathname: string): { providerId: string; upstreamPath: string } | undefined {
  const match = pathname.match(/^\/provider-proxy\/([^/]+)(\/.*)$/);
  if (!match?.[1] || !match[2]) return undefined;
  return { providerId: decodeURIComponent(match[1]), upstreamPath: match[2] };
}

function allowedProviderPath(pathname: string): boolean {
  return pathname === "/v1/messages" ||
    pathname === "/v1/messages/count_tokens" ||
    pathname === "/v1/models";
}

async function handleProviderProxy(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  route: { providerId: string; upstreamPath: string },
  logger: Logger,
  url: URL,
): Promise<void> {
  if (!proxyAuthenticated(request)) return json(response, 401, { error: "proxy_unauthorized" });
  if (!allowedProviderPath(route.upstreamPath)) return json(response, 404, { error: "provider_path_not_allowed" });
  const provider = getProvider(config, route.providerId);
  const secret = providerSecret(config, provider.id);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);

  if (body && route.upstreamPath !== "/v1/models") {
    try {
      const payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      if (typeof payload.model === "string") assertProviderModel(provider, payload.model);
    } catch (error) {
      if (error instanceof SyntaxError) return json(response, 400, { error: "invalid_json" });
      throw error;
    }
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "authorization" || lower === "x-api-key") continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (typeof value === "string") headers.set(name, value);
  }
  if (!headers.has("content-type") && body) headers.set("content-type", "application/json");
  if (provider.auth.type === "bearer") headers.set("authorization", `Bearer ${secret}`);
  else headers.set("x-api-key", secret);

  const upstreamAbort = new AbortController();
  const abortUpstream = (): void => upstreamAbort.abort();
  request.once("aborted", abortUpstream);
  response.once("close", () => {
    if (!response.writableEnded) upstreamAbort.abort();
  });

  const query = url.search || "";
  const upstreamUrl = `${provider.baseUrl}${route.upstreamPath}${query}`;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method || "POST",
      headers,
      ...(body ? { body } : {}),
      redirect: "manual",
      signal: upstreamAbort.signal,
    });
  } catch (error) {
    request.off("aborted", abortUpstream);
    if (upstreamAbort.signal.aborted) {
      if (!response.writableEnded) response.end();
      return;
    }
    logger.error("Provider proxy request failed", {
      providerId: provider.id,
      path: route.upstreamPath,
      error: redactText(error instanceof Error ? error.message : String(error), [secret]),
    });
    return json(response, 502, { error: "provider_unreachable" });
  }

  const outboundHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie") outboundHeaders[name] = value;
  });
  response.writeHead(upstream.status, outboundHeaders);
  if (!upstream.body) {
    request.off("aborted", abortUpstream);
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    while (!upstreamAbort.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => response.once("drain", resolve));
      }
    }
  } finally {
    request.off("aborted", abortUpstream);
    if (upstreamAbort.signal.aborted) void reader.cancel().catch(() => undefined);
    else reader.releaseLock();
    if (!response.writableEnded) response.end();
  }
}

export function startControlServer(
  config: RuntimeConfig,
  broker: InteractionBroker,
  logger: Logger,
): Server {
  const startedAt = Date.now();
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "controller"}`);
    if ((url.pathname === "/healthz" || url.pathname === "/readyz") && request.method === "GET") {
      return json(response, 200, {
        status: "ok",
        role: "controller",
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      });
    }
    if (url.pathname === "/internal/tool-permission" && request.method === "POST") {
      void handlePermission(request, response, config, broker).catch((error) => {
        logger.error("Permission callback failed", { error: String(error) });
        if (!response.headersSent) json(response, 500, { error: "permission_internal_error" });
      });
      return;
    }
    const route = proxyRoute(url.pathname);
    if (route) {
      void handleProviderProxy(request, response, config, route, logger, url).catch((error) => {
        const provider = config.providers.find((item) => item.id === route.providerId);
        const secret = provider ? process.env[provider.auth.env]?.trim() : undefined;
        logger.error("Provider proxy failed", {
          providerId: route.providerId,
          error: redactText(error instanceof Error ? error.message : String(error), secret ? [secret] : []),
        });
        if (!response.headersSent) json(response, 500, { error: "proxy_internal_error" });
        else if (!response.writableEnded) response.end();
      });
      return;
    }
    json(response, 404, { error: "not_found" });
  });
  server.listen(config.healthPort, "0.0.0.0", () => {
    logger.info("Controller server listening", { port: config.healthPort });
  });
  return server;
}
