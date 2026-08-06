import { redactUnknown, safeJson } from "../security.js";

export const TELEGRAM_TEXT_LIMIT = 4096;
export const SAFE_MESSAGE_LIMIT = 3800;
export const TOOL_CARD_DETAIL_LIMIT = 3000;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 20))}\n… [truncated ${value.length - limit} chars]`;
}

export function splitText(value: string, limit = SAFE_MESSAGE_LIMIT): string[] {
  if (value.length <= limit) return [value];
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit * 0.55)) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < Math.floor(limit * 0.55)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\s+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function expandableBlockquote(body: string): string {
  return `<blockquote expandable>${escapeHtml(body)}</blockquote>`;
}

export function compactInputSummary(toolName: string, input: Record<string, unknown>): string {
  const getString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  switch (toolName) {
    case "Bash":
      return getString("description") ?? getString("command") ?? "shell command";
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return getString("file_path", "path", "notebook_path") ?? "file operation";
    case "Glob":
      return getString("pattern") ?? "glob";
    case "Grep":
      return [getString("pattern"), getString("path")].filter(Boolean).join(" · ") || "search";
    case "WebFetch":
      return getString("url") ?? "web fetch";
    case "WebSearch":
      return getString("query") ?? "web search";
    case "Agent":
    case "Task":
      return getString("description", "subagent_type") ?? "subagent";
    case "AskUserQuestion":
      return "waiting for your answer";
    case "TaskCreate":
      return getString("subject") ?? "create task";
    case "TaskUpdate":
      return [getString("taskId"), getString("status")].filter(Boolean).join(" · ") || "update task";
    default:
      return getString("description", "name", "path", "command") ?? "tool call";
  }
}

export function renderToolDetails(
  toolName: string,
  input: Record<string, unknown>,
  maxChars: number,
  secrets: string[] = [],
): string {
  const summary = compactInputSummary(toolName, input);
  const detail = truncate(safeJson(redactUnknown(input, secrets), [], 2), Math.min(maxChars, TOOL_CARD_DETAIL_LIMIT));
  return `⚙️ <b>${escapeHtml(toolName)}</b> · ${escapeHtml(truncate(summary, 180))}\n${expandableBlockquote(detail)}`;
}

export function renderToolResult(
  toolName: string,
  summary: string,
  output: string,
  isError: boolean,
  maxChars: number,
): string {
  const icon = isError ? "❌" : "✅";
  const detail = truncate(output || "Completed without textual output", Math.min(maxChars, TOOL_CARD_DETAIL_LIMIT));
  return `${icon} <b>${escapeHtml(toolName)}</b> · ${escapeHtml(truncate(summary, 180))}\n${expandableBlockquote(detail)}`;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

export function formatMoney(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") return record.text;
        return safeJson(record);
      }
      return String(item);
    }).join("\n");
  }
  if (content === undefined || content === null) return "";
  return safeJson(content);
}
