import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "./logger.js";
import type {
  WorkerSettingsResponse,
  WorkerStreamEnvelope,
  WorkerTurnRequest,
} from "./worker-protocol.js";

const MAX_LINE_BYTES = 8 * 1024 * 1024;

function workerEndpoint(workerUrl: string, path: string): string {
  return `${workerUrl.replace(/\/+$/, "")}${path}`;
}

export class WorkerClient {
  constructor(
    private readonly workerUrl: string,
    private readonly internalToken: string,
    private readonly logger: Logger,
  ) {}

  async runTurn(
    request: WorkerTurnRequest,
    signal: AbortSignal,
    onMessage: (message: SDKMessage) => Promise<void>,
  ): Promise<void> {
    const response = await fetch(workerEndpoint(this.workerUrl, "/v1/turn"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claudetg-internal-token": this.internalToken,
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Worker returned HTTP ${response.status}${body ? `: ${body.slice(0, 1200)}` : ""}`);
    }
    if (!response.body) throw new Error("Worker returned an empty streaming response");

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > MAX_LINE_BYTES) throw new Error("Worker stream line exceeded safety limit");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        await this.handleEnvelope(line, onMessage);
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) await this.handleEnvelope(tail, onMessage);
  }

  async inspectSettings(projectId: string, signal?: AbortSignal): Promise<WorkerSettingsResponse> {
    const response = await fetch(workerEndpoint(this.workerUrl, `/v1/settings?projectId=${encodeURIComponent(projectId)}`), {
      headers: { "x-claudetg-internal-token": this.internalToken },
      signal,
    });
    if (!response.ok) throw new Error(`Worker settings endpoint returned HTTP ${response.status}`);
    return await response.json() as WorkerSettingsResponse;
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(workerEndpoint(this.workerUrl, "/healthz"), { signal });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async handleEnvelope(
    line: string,
    onMessage: (message: SDKMessage) => Promise<void>,
  ): Promise<void> {
    let envelope: WorkerStreamEnvelope;
    try {
      envelope = JSON.parse(line) as WorkerStreamEnvelope;
    } catch (error) {
      throw new Error(`Worker returned invalid NDJSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (envelope.type === "sdk") {
      await onMessage(envelope.message as unknown as SDKMessage);
      return;
    }
    if (envelope.type === "stderr") {
      this.logger.debug("Claude worker stderr", { data: envelope.data.slice(0, 2000) });
      return;
    }
    if (envelope.type === "error") throw new Error(envelope.message);
  }
}
