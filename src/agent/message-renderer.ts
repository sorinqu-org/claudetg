import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Api, RawApi } from "grammy";
import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import { redactText, safeJson } from "../security.js";
import {
  compactInputSummary,
  escapeHtml,
  expandableBlockquote,
  extractToolResultText,
  formatDuration,
  formatMoney,
  renderToolDetails,
  renderToolResult,
  TOOL_CARD_DETAIL_LIMIT,
  truncate,
} from "../telegram/format.js";
import { TelegramStreamWriter } from "../telegram/stream-writer.js";
import { WorkflowTracker } from "./workflow.js";

interface ToolCard {
  messageId: number;
  toolName: string;
  summary: string;
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: string;
}

function messageRecord(message: SDKMessage): Record<string, unknown> {
  return message as unknown as Record<string, unknown>;
}

function contentBlocks(value: unknown): ContentBlock[] {
  if (!value || typeof value !== "object") return [];
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.filter((item): item is ContentBlock => Boolean(item && typeof item === "object"));
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function compactEvent(record: Record<string, unknown>): string {
  const copy = { ...record };
  delete copy.type;
  delete copy.uuid;
  delete copy.session_id;
  return safeJson(copy);
}

export class AgentMessageRenderer {
  private readonly stream: TelegramStreamWriter;
  private readonly toolCards = new Map<string, ToolCard>();
  private readonly workflow: WorkflowTracker;
  private currentAssistantDelta = "";
  private lastProgressAt = 0;
  private lastRateLimitAt = 0;

  constructor(
    private readonly api: Api<RawApi>,
    private readonly chatId: number,
    private readonly sessionId: string,
    private readonly database: Database,
    private readonly logger: Logger,
    flushMs: number,
    private readonly maxToolDetailChars: number,
    private readonly secrets: string[],
  ) {
    this.stream = new TelegramStreamWriter(api, chatId, flushMs, logger);
    this.workflow = new WorkflowTracker(database, sessionId);
  }

  get hasAssistantText(): boolean {
    return this.stream.hasContent;
  }

  async handle(message: SDKMessage): Promise<void> {
    const record = messageRecord(message);
    if (record.type === "stream_event") {
      this.handleStreamEvent(record.event);
      return;
    }
    if (record.type === "assistant") {
      await this.handleAssistant(record);
      return;
    }
    if (record.type === "user") {
      await this.handleUser(record);
      return;
    }
    if (record.type === "system") {
      await this.handleSystem(record);
      return;
    }
    if (record.type === "tool_progress") {
      await this.handleToolProgress(record);
      return;
    }
    if (record.type === "result") {
      await this.handleResult(record);
      return;
    }
    if (record.type === "tool_use_summary") {
      const summary = firstString(record, ["summary", "message"]) ?? compactEvent(record);
      const clean = redactText(summary, this.secrets);
      await this.api.sendMessage(this.chatId, `🧰 ${escapeHtml(truncate(clean, 1000))}`, { parse_mode: "HTML" });
      this.database.addEvent(this.sessionId, "tool_use_summary", truncate(clean, 1000));
      return;
    }
    if (record.type === "auth_status") {
      const status = firstString(record, ["status", "message", "error"]) ?? compactEvent(record);
      const clean = redactText(status, this.secrets);
      await this.api.sendMessage(this.chatId, `🔐 ${escapeHtml(truncate(clean, 1000))}`, { parse_mode: "HTML" });
      this.database.addEvent(this.sessionId, "auth_status", truncate(clean, 1000));
      return;
    }
    if (record.type === "rate_limit_event") {
      await this.handleRateLimit(record);
      return;
    }
    if (record.type === "prompt_suggestion" && typeof record.suggestion === "string") {
      this.database.addEvent(this.sessionId, "suggestion", truncate(record.suggestion, 500));
      return;
    }
    const eventType = typeof record.type === "string" ? record.type : "unknown";
    this.database.addEvent(this.sessionId, `sdk_${eventType}`, truncate(redactText(compactEvent(record), this.secrets), 1000));
  }

  async close(): Promise<void> {
    await this.stream.close();
  }

  private handleStreamEvent(rawEvent: unknown): void {
    if (!rawEvent || typeof rawEvent !== "object") return;
    const event = rawEvent as Record<string, unknown>;
    if (event.type === "message_start") this.currentAssistantDelta = "";
    if (event.type !== "content_block_delta") return;
    const delta = event.delta;
    if (!delta || typeof delta !== "object") return;
    const value = delta as Record<string, unknown>;
    if (value.type === "text_delta" && typeof value.text === "string") {
      const text = redactText(value.text, this.secrets);
      this.currentAssistantDelta += text;
      this.stream.append(text);
    }
  }

  private async handleAssistant(record: Record<string, unknown>): Promise<void> {
    const blocks = contentBlocks(record.message);
    const fullText = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => redactText(block.text ?? "", this.secrets))
      .join("");
    if (fullText && fullText.trim() !== this.currentAssistantDelta.trim()) {
      if (!this.currentAssistantDelta || !fullText.includes(this.currentAssistantDelta)) {
        this.stream.append(fullText);
      } else {
        this.stream.append(fullText.slice(this.currentAssistantDelta.length));
      }
    }
    if (fullText) this.database.addEvent(this.sessionId, "assistant", truncate(fullText, 1000));
    for (const block of blocks) {
      if (block.type !== "tool_use" || !block.id || !block.name) continue;
      const input = block.input ?? {};
      await this.stream.flush();
      const summary = compactInputSummary(block.name, input);
      const text = renderToolDetails(block.name, input, this.maxToolDetailChars, this.secrets);
      const sent = await this.api.sendMessage(this.chatId, text, { parse_mode: "HTML" });
      this.toolCards.set(block.id, { messageId: sent.message_id, toolName: block.name, summary });
      this.database.addEvent(this.sessionId, "tool_use", `${block.name}: ${truncate(summary, 400)}`);
      this.workflow.onToolUse(block.id, block.name, input);
    }
  }

  private async handleUser(record: Record<string, unknown>): Promise<void> {
    const blocks = contentBlocks(record.message);
    for (const block of blocks) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const card = this.toolCards.get(block.tool_use_id);
      const output = redactText(extractToolResultText(block.content), this.secrets);
      const toolName = card?.toolName ?? "Tool";
      const summary = card?.summary ?? "completed";
      const rendered = renderToolResult(toolName, summary, output, block.is_error === true, this.maxToolDetailChars);
      if (card) {
        try {
          await this.api.editMessageText(this.chatId, card.messageId, rendered, { parse_mode: "HTML" });
        } catch (error) {
          this.logger.debug("Could not update tool card", { error: String(error) });
          await this.api.sendMessage(this.chatId, rendered, { parse_mode: "HTML" });
        }
      } else {
        await this.api.sendMessage(this.chatId, rendered, { parse_mode: "HTML" });
      }
      this.database.addEvent(
        this.sessionId,
        block.is_error ? "tool_error" : "tool_result",
        `${toolName}: ${truncate(output || summary, 500)}`,
      );
      this.workflow.onToolResult(block.tool_use_id, toolName, output);
    }
  }

  private async handleSystem(record: Record<string, unknown>): Promise<void> {
    const subtype = typeof record.subtype === "string" ? record.subtype : "unknown";
    if (subtype === "init") {
      const runtime = {
        claudeCodeVersion: record.claude_code_version,
        cwd: record.cwd,
        tools: record.tools,
        model: record.model,
        permissionMode: record.permissionMode,
        slashCommands: record.slash_commands,
        skills: record.skills,
        mcpServers: record.mcp_servers,
      };
      this.database.updateSession(this.sessionId, { runtime });
      this.database.addEvent(this.sessionId, "system_init", truncate(redactText(safeJson(runtime), this.secrets), 1000));
      return;
    }
    if (subtype === "local_command_output") {
      const output = redactText(firstString(record, ["content", "output", "message"]) ?? compactEvent(record), this.secrets);
      await this.api.sendMessage(
        this.chatId,
        `🖥️ <b>Local command output</b>\n${expandableBlockquote(truncate(output, Math.min(this.maxToolDetailChars, TOOL_CARD_DETAIL_LIMIT)))}`,
        { parse_mode: "HTML" },
      );
      this.database.addEvent(this.sessionId, "local_command_output", truncate(output, 1000));
      return;
    }
    if (subtype === "permission_denied") {
      const toolName = typeof record.tool_name === "string" ? record.tool_name : "tool";
      const reason = firstString(record, ["message", "reason", "error"]) ?? "Permission denied";
      const clean = redactText(reason, this.secrets);
      await this.api.sendMessage(
        this.chatId,
        `🚫 <b>${escapeHtml(toolName)}</b>\n${escapeHtml(truncate(clean, 1000))}`,
        { parse_mode: "HTML" },
      );
      this.database.addEvent(this.sessionId, "permission_denied", `${toolName}: ${truncate(clean, 500)}`);
      return;
    }
    if (subtype === "task_started") {
      const description = firstString(record, ["description", "summary", "message"]) ?? "Background task started";
      await this.api.sendMessage(this.chatId, `🧩 ${escapeHtml(truncate(redactText(description, this.secrets), 1000))}`, { parse_mode: "HTML" });
      this.database.addEvent(this.sessionId, "task_started", truncate(description, 1000));
      return;
    }
    if (subtype === "task_progress" || subtype === "hook_progress") {
      const now = Date.now();
      const summary = firstString(record, ["summary", "description", "message"]) ?? `${subtype} is running`;
      this.database.addEvent(this.sessionId, subtype, truncate(redactText(summary, this.secrets), 1000));
      if (now - this.lastProgressAt < 10_000) return;
      this.lastProgressAt = now;
      await this.api.sendMessage(this.chatId, `⏳ ${escapeHtml(truncate(redactText(summary, this.secrets), 700))}`, { parse_mode: "HTML" });
      return;
    }
    if (subtype === "task_notification" || subtype === "notification" || subtype === "task_updated") {
      const summary = firstString(record, ["summary", "message", "description", "status"]) ?? compactEvent(record);
      const clean = redactText(summary, this.secrets);
      await this.api.sendMessage(this.chatId, `🔔 ${escapeHtml(truncate(clean, 1000))}`, { parse_mode: "HTML" });
      this.database.addEvent(this.sessionId, subtype, truncate(clean, 1000));
      return;
    }
    if (subtype === "hook_response") {
      const outcome = firstString(record, ["outcome", "status"]) ?? "completed";
      const details = firstString(record, ["message", "error", "stderr", "output"]);
      const summary = redactText(details ? `${outcome}: ${details}` : outcome, this.secrets);
      this.database.addEvent(this.sessionId, "hook_response", truncate(summary, 1000));
      if (outcome !== "success" && outcome !== "completed") {
        await this.api.sendMessage(this.chatId, `🪝 ${escapeHtml(truncate(summary, 1000))}`, { parse_mode: "HTML" });
      }
      return;
    }
    if (subtype === "api_retry" || subtype === "mirror_error") {
      const summary = firstString(record, ["message", "error", "reason", "status"]) ?? compactEvent(record);
      const clean = redactText(summary, this.secrets);
      await this.api.sendMessage(this.chatId, `⚠️ ${escapeHtml(truncate(clean, 1200))}`, { parse_mode: "HTML" });
      this.database.addEvent(this.sessionId, subtype, truncate(clean, 1000));
      return;
    }

    this.database.addEvent(this.sessionId, `system_${subtype}`, truncate(redactText(compactEvent(record), this.secrets), 1000));
  }

  private async handleRateLimit(record: Record<string, unknown>): Promise<void> {
    const info = record.rate_limit_info && typeof record.rate_limit_info === "object"
      ? record.rate_limit_info as Record<string, unknown>
      : record;
    const status = firstString(info, ["status", "message"]) ?? "Rate limit status changed";
    const resetValue = info.resetsAt ?? info.resets_at;
    let reset: string | undefined;
    if (typeof resetValue === "number") {
      const millis = resetValue > 10_000_000_000 ? resetValue : resetValue * 1000;
      reset = new Date(millis).toISOString();
    } else if (typeof resetValue === "string") {
      reset = resetValue;
    }
    const utilization = typeof info.utilization === "number" ? `${Math.round(info.utilization * 100)}%` : undefined;
    const summary = [status, utilization ? `utilization ${utilization}` : undefined, reset ? `reset ${reset}` : undefined]
      .filter(Boolean)
      .join(" · ");
    const clean = redactText(summary, this.secrets);
    this.database.addEvent(this.sessionId, "rate_limit", truncate(clean, 1000));
    const now = Date.now();
    if (now - this.lastRateLimitAt < 30_000) return;
    this.lastRateLimitAt = now;
    await this.api.sendMessage(this.chatId, `🚦 ${escapeHtml(truncate(clean, 1000))}`, { parse_mode: "HTML" });
  }

  private async handleToolProgress(record: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    if (now - this.lastProgressAt < 10_000) return;
    this.lastProgressAt = now;
    const tool = typeof record.tool_name === "string" ? record.tool_name : "Tool";
    const seconds = typeof record.elapsed_time_seconds === "number" ? record.elapsed_time_seconds : 0;
    await this.api.sendMessage(this.chatId, `⏳ <b>${escapeHtml(tool)}</b> · ${escapeHtml(formatDuration(seconds * 1000))}`, {
      parse_mode: "HTML",
    });
  }

  private async handleResult(record: Record<string, unknown>): Promise<void> {
    const isError = record.is_error === true || (typeof record.subtype === "string" && record.subtype !== "success");
    const duration = typeof record.duration_ms === "number" ? record.duration_ms : 0;
    const turns = typeof record.num_turns === "number" ? record.num_turns : 0;
    const cost = typeof record.total_cost_usd === "number" ? record.total_cost_usd : 0;
    const result = typeof record.result === "string" ? redactText(record.result, this.secrets) : "";
    if (result && !this.stream.hasContent) this.stream.append(result);
    await this.stream.close();
    const details = [
      duration ? formatDuration(duration) : undefined,
      turns ? `${turns} turns` : undefined,
      cost ? formatMoney(cost) : undefined,
    ].filter(Boolean).join(" · ");
    if (details || isError) {
      const errors = Array.isArray(record.errors) ? record.errors.map(String).join("\n") : "";
      const text = `${isError ? "❌" : "🏁"} <b>${isError ? "Turn ended with an error" : "Turn completed"}</b>${details ? `\n${escapeHtml(details)}` : ""}${errors ? `\n${escapeHtml(truncate(redactText(errors, this.secrets), 1500))}` : ""}`;
      await this.api.sendMessage(this.chatId, text, { parse_mode: "HTML" });
    }
  }
}
