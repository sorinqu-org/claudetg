import { randomBytes } from "node:crypto";
import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { InlineKeyboard, type Api, type Context, type RawApi } from "grammy";
import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import { collectPathViolations, redactText, safeJson } from "../security.js";
import { escapeHtml, expandableBlockquote, renderToolDetails, truncate } from "../telegram/format.js";

interface ApprovalPending {
  kind: "approval";
  token: string;
  chatId: number;
  userId: number;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  messageId: number;
  timeout: NodeJS.Timeout;
  resolve: (result: PermissionResult) => void;
  settled: boolean;
}

interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface QuestionPending {
  kind: "question";
  token: string;
  chatId: number;
  userId: number;
  messageId: number;
  question: Question;
  selected: Set<number>;
  timeout: NodeJS.Timeout;
  resolve: (answer: string | undefined) => void;
  settled: boolean;
}

type Pending = ApprovalPending | QuestionPending;

function token(): string {
  return randomBytes(6).toString("base64url");
}

function parseQuestions(input: Record<string, unknown>): Question[] {
  if (!Array.isArray(input.questions)) return [];
  const questions: Question[] = [];
  for (const raw of input.questions) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.question !== "string" || !Array.isArray(record.options)) continue;
    const options = record.options.slice(0, 8).flatMap((option): QuestionOption[] => {
      if (!option || typeof option !== "object") return [];
      const item = option as Record<string, unknown>;
      if (typeof item.label !== "string") return [];
      return [{
        label: item.label,
        description: typeof item.description === "string" ? item.description : "",
        ...(typeof item.preview === "string" ? { preview: item.preview } : {}),
      }];
    });
    if (options.length === 0) continue;
    questions.push({
      question: record.question,
      header: typeof record.header === "string" ? record.header : "Question",
      options,
      multiSelect: record.multiSelect === true,
    });
  }
  return questions;
}

export class InteractionBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly pendingQuestionByChat = new Map<number, string>();

  constructor(
    private readonly api: Api<RawApi>,
    private readonly database: Database,
    private readonly logger: Logger,
    private readonly approvalTimeoutMs: number,
    private readonly maxToolDetailChars: number,
    private readonly secrets: string[],
  ) {}

  createCanUseTool(input: {
    chatId: number;
    userId: number;
    sessionId: string;
    allowedRoots: string[];
    autoAllowReadTools: boolean;
  }): CanUseTool {
    return async (toolName, toolInput, options) => {
      if (toolName === "AskUserQuestion") {
        return this.handleQuestions(input.chatId, input.userId, toolInput, options.signal);
      }
      const session = this.database.getSession(input.sessionId);
      if (!session) return { behavior: "deny", message: "The Telegram session no longer exists." };
      if (session.sessionAllowedTools.includes(toolName)) {
        return { behavior: "allow", updatedInput: toolInput };
      }
      const violations = collectPathViolations(toolInput, input.allowedRoots, input.allowedRoots[0]);
      if (violations.length > 0) {
        const message = `Blocked absolute path outside configured project roots: ${violations.join(", ")}`;
        await this.api.sendMessage(input.chatId, `🛡️ <b>Blocked by host policy</b>\n${escapeHtml(message)}`, { parse_mode: "HTML" });
        return { behavior: "deny", message };
      }
      if (input.autoAllowReadTools && ["Read", "Glob", "Grep"].includes(toolName)) {
        return { behavior: "allow", updatedInput: toolInput };
      }
      return this.requestApproval({
        ...input,
        toolName,
        toolInput,
        signal: options.signal,
        ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
        ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      });
    };
  }

  async handleCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data;
    if (!data || (!data.startsWith("p:") && !data.startsWith("q:"))) return false;
    const parts = data.split(":");
    const kind = parts[0];
    const pendingToken = parts[1];
    const action = parts[2];
    if (!pendingToken || !action) return false;
    const item = this.pending.get(pendingToken);
    if (!item || item.settled) {
      await ctx.answerCallbackQuery({ text: "This request is no longer active.", show_alert: true });
      return true;
    }
    if (ctx.chat?.id !== item.chatId || ctx.from?.id !== item.userId) {
      await ctx.answerCallbackQuery({ text: "This request belongs to another user.", show_alert: true });
      return true;
    }
    if (kind === "p" && item.kind === "approval") {
      await this.handleApprovalCallback(ctx, item, action);
      return true;
    }
    if (kind === "q" && item.kind === "question") {
      await this.handleQuestionCallback(ctx, item, action);
      return true;
    }
    return false;
  }

  async consumeText(chatId: number, userId: number, text: string): Promise<boolean> {
    const pendingToken = this.pendingQuestionByChat.get(chatId);
    if (!pendingToken) return false;
    const item = this.pending.get(pendingToken);
    if (!item || item.kind !== "question" || item.userId !== userId || item.settled) return false;
    await this.finishQuestion(item, text.trim() || undefined, "✍️ Custom answer received");
    return true;
  }

  async cancelForChat(chatId: number, reason = "Cancelled by user"): Promise<boolean> {
    const items = [...this.pending.values()].filter((item) => item.chatId === chatId && !item.settled);
    for (const item of items) {
      if (item.kind === "approval") {
        await this.finishApproval(item, { behavior: "deny", message: reason, interrupt: true }, "⛔ Cancelled");
      } else {
        await this.finishQuestion(item, undefined, "⛔ Cancelled");
      }
    }
    return items.length > 0;
  }

  private async requestApproval(input: {
    chatId: number;
    userId: number;
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    signal: AbortSignal;
    allowedRoots: string[];
    decisionReason?: string;
    blockedPath?: string;
  }): Promise<PermissionResult> {
    const requestToken = token();
    const keyboard = new InlineKeyboard()
      .text("✅ Allow once", `p:${requestToken}:o`)
      .text("🔁 Allow tool for session", `p:${requestToken}:s`)
      .row()
      .text("❌ Deny", `p:${requestToken}:d`)
      .text("⛔ Deny and stop", `p:${requestToken}:x`);
    const metadata = truncate(redactText([
      input.decisionReason ? `Reason: ${input.decisionReason}` : undefined,
      input.blockedPath ? `Blocked path: ${input.blockedPath}` : undefined,
    ].filter(Boolean).join("\n"), this.secrets), 600);
    const body = `${renderToolDetails(input.toolName, input.toolInput, this.maxToolDetailChars, this.secrets)}${metadata ? `\n${expandableBlockquote(metadata)}` : ""}`;
    const message = await this.api.sendMessage(input.chatId, `⚠️ <b>Permission required</b>\n${body}`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return new Promise<PermissionResult>((resolve) => {
      const timeout = setTimeout(() => {
        const item = this.pending.get(requestToken);
        if (item?.kind === "approval" && !item.settled) {
          void this.finishApproval(item, {
            behavior: "deny",
            message: "Telegram approval timed out.",
          }, "⌛ Approval timed out");
        }
      }, this.approvalTimeoutMs);
      const pending: ApprovalPending = {
        kind: "approval",
        token: requestToken,
        chatId: input.chatId,
        userId: input.userId,
        sessionId: input.sessionId,
        toolName: input.toolName,
        input: input.toolInput,
        messageId: message.message_id,
        timeout,
        resolve,
        settled: false,
      };
      this.pending.set(requestToken, pending);
      const abort = () => {
        if (!pending.settled) {
          void this.finishApproval(pending, {
            behavior: "deny",
            message: "The active turn was stopped.",
            interrupt: true,
          }, "⛔ Turn stopped");
        }
      };
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort, { once: true });
    });
  }

  private async handleApprovalCallback(ctx: Context, item: ApprovalPending, action: string): Promise<void> {
    await ctx.answerCallbackQuery();
    switch (action) {
      case "o":
        await this.finishApproval(item, { behavior: "allow", updatedInput: item.input }, "✅ Allowed once");
        break;
      case "s":
        this.database.addSessionAllowedTool(item.sessionId, item.toolName);
        await this.finishApproval(item, { behavior: "allow", updatedInput: item.input }, `🔁 ${item.toolName} allowed for this session`);
        break;
      case "x":
        await this.finishApproval(item, {
          behavior: "deny",
          message: "User denied this action and stopped the current turn.",
          interrupt: true,
        }, "⛔ Denied and stopped");
        break;
      default:
        await this.finishApproval(item, { behavior: "deny", message: "User denied this action." }, "❌ Denied");
    }
  }

  private async finishApproval(item: ApprovalPending, result: PermissionResult, status: string): Promise<void> {
    if (item.settled) return;
    item.settled = true;
    clearTimeout(item.timeout);
    this.pending.delete(item.token);
    try {
      await this.api.editMessageReplyMarkup(item.chatId, item.messageId, { reply_markup: { inline_keyboard: [] } });
      await this.api.sendMessage(item.chatId, `${status}: <b>${escapeHtml(item.toolName)}</b>`, { parse_mode: "HTML" });
    } catch (error) {
      this.logger.debug("Could not update approval message", { error: String(error) });
    }
    item.resolve(result);
  }

  private async handleQuestions(
    chatId: number,
    userId: number,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const questions = parseQuestions(input);
    if (questions.length === 0) {
      return { behavior: "deny", message: "AskUserQuestion contained no valid questions." };
    }
    const answers: Record<string, string> = {};
    for (const question of questions) {
      const answer = await this.askQuestion(chatId, userId, question, signal);
      if (answer === undefined) {
        return { behavior: "deny", message: "User cancelled the clarification request.", interrupt: true };
      }
      answers[question.question] = answer;
    }
    return {
      behavior: "allow",
      updatedInput: {
        questions: input.questions,
        answers,
      },
    };
  }

  private async askQuestion(
    chatId: number,
    userId: number,
    question: Question,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const requestToken = token();
    const keyboard = this.questionKeyboard(requestToken, question, new Set<number>());
    const previews = truncate(question.options
      .map((option, index) => option.preview
        ? `${index + 1}. ${truncate(redactText(option.label, this.secrets), 80)}\n${truncate(redactText(option.preview, this.secrets), 400)}`
        : undefined)
      .filter(Boolean)
      .join("\n\n"), 1000);
    const optionText = question.options.map((option, index) => {
      const label = escapeHtml(truncate(redactText(option.label, this.secrets), 80));
      const description = option.description
        ? ` — ${escapeHtml(truncate(redactText(option.description, this.secrets), 120))}`
        : "";
      return `${index + 1}. <b>${label}</b>${description}`;
    }).join("\n");
    const text = `❓ <b>${escapeHtml(truncate(redactText(question.header, this.secrets), 120))}</b>\n${escapeHtml(truncate(redactText(question.question, this.secrets), 600))}\n\n${optionText}${previews ? `\n${expandableBlockquote(previews)}` : ""}\n\n<i>You can also send a free-text answer.</i>`;
    const message = await this.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: keyboard });
    return new Promise<string | undefined>((resolve) => {
      const timeout = setTimeout(() => {
        const item = this.pending.get(requestToken);
        if (item?.kind === "question" && !item.settled) {
          void this.finishQuestion(item, undefined, "⌛ Question timed out");
        }
      }, this.approvalTimeoutMs);
      const pending: QuestionPending = {
        kind: "question",
        token: requestToken,
        chatId,
        userId,
        messageId: message.message_id,
        question,
        selected: new Set<number>(),
        timeout,
        resolve,
        settled: false,
      };
      this.pending.set(requestToken, pending);
      this.pendingQuestionByChat.set(chatId, requestToken);
      const abort = () => {
        if (!pending.settled) void this.finishQuestion(pending, undefined, "⛔ Turn stopped");
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  private questionKeyboard(requestToken: string, question: Question, selected: Set<number>): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    question.options.forEach((option, index) => {
      const mark = selected.has(index) ? "☑️" : question.multiSelect ? "▫️" : "";
      keyboard.text(`${mark}${mark ? " " : ""}${truncate(option.label, 40)}`, `q:${requestToken}:i${index}`).row();
    });
    if (question.multiSelect) keyboard.text("✅ Done", `q:${requestToken}:done`).row();
    keyboard.text("✍️ Send custom text", `q:${requestToken}:text`).text("❌ Cancel", `q:${requestToken}:cancel`);
    return keyboard;
  }

  private async handleQuestionCallback(ctx: Context, item: QuestionPending, action: string): Promise<void> {
    if (action === "cancel") {
      await ctx.answerCallbackQuery();
      await this.finishQuestion(item, undefined, "❌ Cancelled");
      return;
    }
    if (action === "text") {
      await ctx.answerCallbackQuery({ text: "Send your answer as the next message." });
      return;
    }
    if (action === "done") {
      if (item.selected.size === 0) {
        await ctx.answerCallbackQuery({ text: "Select at least one option.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery();
      const answer = [...item.selected].sort((a, b) => a - b)
        .map((index) => item.question.options[index]?.label)
        .filter((label): label is string => Boolean(label))
        .join(", ");
      await this.finishQuestion(item, answer, `✅ Selected: ${answer}`);
      return;
    }
    if (action.startsWith("i")) {
      const index = Number.parseInt(action.slice(1), 10);
      const option = item.question.options[index];
      if (!option) {
        await ctx.answerCallbackQuery({ text: "Unknown option.", show_alert: true });
        return;
      }
      if (!item.question.multiSelect) {
        await ctx.answerCallbackQuery();
        await this.finishQuestion(item, option.label, `✅ Selected: ${option.label}`);
        return;
      }
      if (item.selected.has(index)) item.selected.delete(index);
      else item.selected.add(index);
      await ctx.answerCallbackQuery({ text: item.selected.has(index) ? "Selected" : "Removed" });
      try {
        await this.api.editMessageReplyMarkup(item.chatId, item.messageId, {
          reply_markup: this.questionKeyboard(item.token, item.question, item.selected),
        });
      } catch (error) {
        this.logger.debug("Could not refresh question keyboard", { error: String(error) });
      }
    }
  }

  private async finishQuestion(item: QuestionPending, answer: string | undefined, status: string): Promise<void> {
    if (item.settled) return;
    item.settled = true;
    clearTimeout(item.timeout);
    this.pending.delete(item.token);
    if (this.pendingQuestionByChat.get(item.chatId) === item.token) this.pendingQuestionByChat.delete(item.chatId);
    try {
      await this.api.editMessageReplyMarkup(item.chatId, item.messageId, { reply_markup: { inline_keyboard: [] } });
      await this.api.sendMessage(item.chatId, escapeHtml(truncate(redactText(status, this.secrets), 1000)), { parse_mode: "HTML" });
    } catch (error) {
      this.logger.debug("Could not update question message", { error: String(error), input: safeJson(item.question) });
    }
    item.resolve(answer);
  }
}
