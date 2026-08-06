import type { Api, RawApi } from "grammy";
import { escapeHtml, SAFE_MESSAGE_LIMIT } from "./format.js";
import type { Logger } from "../logger.js";

export class TelegramStreamWriter {
  private currentMessageId: number | undefined;
  private currentChunk = "";
  private pending = "";
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private wroteAnything = false;

  constructor(
    private readonly api: Api<RawApi>,
    private readonly chatId: number,
    private readonly flushMs: number,
    private readonly logger: Logger,
  ) {}

  get hasContent(): boolean {
    return this.wroteAnything || this.pending.trim().length > 0;
  }

  append(text: string): void {
    if (this.closed || !text) return;
    this.pending += text;
    this.wroteAnything = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch((error: unknown) => {
          this.logger.warn("Failed to flush Telegram stream", { error: String(error) });
        });
      }, this.flushMs);
    }
  }

  async flush(): Promise<void> {
    if (!this.pending) return;
    this.currentChunk += this.pending;
    this.pending = "";
    while (this.currentChunk.length > SAFE_MESSAGE_LIMIT) {
      let splitAt = this.currentChunk.lastIndexOf("\n", SAFE_MESSAGE_LIMIT);
      if (splitAt < SAFE_MESSAGE_LIMIT * 0.6) splitAt = SAFE_MESSAGE_LIMIT;
      const finalized = this.currentChunk.slice(0, splitAt);
      this.currentChunk = this.currentChunk.slice(splitAt).replace(/^\s+/, "");
      await this.upsert(finalized);
      this.currentMessageId = undefined;
    }
    await this.upsert(this.currentChunk);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  private async upsert(text: string): Promise<void> {
    const html = `<b>Claude</b>\n${escapeHtml(text || "…")}`;
    if (!this.currentMessageId) {
      const message = await this.api.sendMessage(this.chatId, html, { parse_mode: "HTML" });
      this.currentMessageId = message.message_id;
      return;
    }
    try {
      await this.api.editMessageText(this.chatId, this.currentMessageId, html, { parse_mode: "HTML" });
    } catch (error) {
      const message = String(error);
      if (message.includes("message is not modified")) return;
      throw error;
    }
  }
}
