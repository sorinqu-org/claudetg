import { Bot, InlineKeyboard, type Context } from "grammy";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { getProject, getProvider } from "./config.js";
import type { Database } from "./db.js";
import type { RuntimeConfig, SessionRecord, UserSettings } from "./domain.js";
import { EffortStore } from "./effort-store.js";
import type { Logger } from "./logger.js";
import { errorFields } from "./logger.js";
import { inspectProjectSettings } from "./settings-inspector.js";
import { escapeHtml, expandableBlockquote, formatDuration, formatMoney, splitText, truncate } from "./telegram/format.js";
import { AgentRunner } from "./agent/runner.js";
import { InteractionBroker } from "./agent/interaction-broker.js";
import { resolveEffortLevel, type EffortSetting } from "./agent/efficiency.js";

const MODES: Array<{ value: PermissionMode; label: string; description: string }> = [
  { value: "default", label: "Default", description: "Спрашивать разрешения" },
  { value: "acceptEdits", label: "Accept edits", description: "Разрешать файловые изменения" },
  { value: "plan", label: "Plan", description: "Только анализ и план" },
  { value: "dontAsk", label: "Don't ask", description: "Отклонять всё не разрешённое заранее" },
  { value: "auto", label: "Auto", description: "Решение классификатора SDK" },
];

const EFFORTS: Array<{ value: EffortSetting; label: string; description: string }> = [
  { value: "auto", label: "Auto", description: "Использовать значение модели по умолчанию" },
  { value: "low", label: "Low", description: "Минимальная цена для коротких и простых задач" },
  { value: "medium", label: "Medium", description: "Баланс цены и качества для обычной разработки" },
  { value: "high", label: "High", description: "Сложная отладка и чувствительные к качеству изменения" },
  { value: "xhigh", label: "XHigh", description: "Длинные agentic-задачи; расход заметно выше" },
  { value: "max", label: "Max", description: "Максимум рассуждений без ограничения расходов" },
];

const shortId = (id: string): string => id.slice(0, 8);
const titleFor = (name: string): string => `${name} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
const commandMatch = (ctx: Context): string => typeof ctx.match === "string" ? ctx.match.trim() : "";

function icon(status: SessionRecord["status"]): string {
  return status === "running" ? "🟢" : status === "error" ? "🔴" : status === "stopped" ? "⛔" : status === "archived" ? "🗄️" : "⚪";
}

export class ClaudeTelegramApp {
  readonly bot: Bot;
  readonly broker: InteractionBroker;
  readonly runner: AgentRunner;
  readonly effortStore: EffortStore;

  constructor(private readonly config: RuntimeConfig, private readonly database: Database, private readonly logger: Logger) {
    this.bot = new Bot(config.telegramBotToken);
    this.effortStore = new EffortStore(config.databasePath);
    const secrets = config.providers.map((p) => process.env[p.auth.env]?.trim()).filter((v): v is string => Boolean(v));
    this.broker = new InteractionBroker(this.bot.api, database, logger, config.agent.approvalTimeoutMs, config.agent.maxToolDetailChars, secrets);
    this.runner = new AgentRunner(this.bot.api, config, database, this.broker, this.effortStore, logger);
    this.middleware();
    this.handlers();
  }

  async start(): Promise<void> {
    await this.bot.api.setMyCommands([
      { command: "new", description: "Новая Claude-сессия" }, { command: "sessions", description: "Сессии" },
      { command: "project", description: "Проект" }, { command: "provider", description: "API-провайдер" },
      { command: "model", description: "Модель" }, { command: "mode", description: "Permission mode" },
      { command: "effort", description: "Цена и глубина рассуждений" },
      { command: "status", description: "Статус" }, { command: "workflow", description: "Workflow" },
      { command: "tools", description: "Tools, MCP и skills" }, { command: "settings", description: "Настройки" },
      { command: "history", description: "История" }, { command: "stop", description: "Остановить turn" },
      { command: "help", description: "Справка" },
    ]);
    await this.bot.start({ onStart: (info) => this.logger.info("Telegram bot started", { username: info.username }) });
  }

  async stop(): Promise<void> {
    this.bot.stop();
    await this.runner.shutdown();
    this.effortStore.close();
  }

  private middleware(): void {
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id; const chatId = ctx.chat?.id;
      if (!userId || !chatId) return;
      if (!this.config.allowedUserIds.has(userId)) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true }); else await ctx.reply("Доступ запрещён.");
        return;
      }
      if (!this.config.allowGroupChats && ctx.chat?.type !== "private") {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Только личный чат", show_alert: true }); else await ctx.reply("Бот разрешён только в личном чате.");
        return;
      }
      this.ensureUser(chatId, userId); await next();
    });
    this.bot.catch((error) => this.logger.error("Telegram update failed", { updateId: error.ctx.update.update_id, ...errorFields(error.error) }));
  }

  private handlers(): void {
    this.bot.command("start", async (ctx) => { if (!this.database.getActiveSession(ctx.chat.id)) this.createSession(ctx.chat.id); await this.help(ctx); });
    this.bot.command("help", (ctx) => this.help(ctx));
    this.bot.command("new", async (ctx) => { const s = this.createSession(ctx.chat.id, commandMatch(ctx) || undefined); await ctx.reply(`Создана ${shortId(s.id)}: ${s.title}`); });
    this.bot.command(["sessions", "switch"], (ctx) => this.sessions(ctx));
    this.bot.command(["project", "projects"], (ctx) => this.projects(ctx));
    this.bot.command(["provider", "providers"], (ctx) => this.providers(ctx));
    this.bot.command(["model", "models"], (ctx) => this.models(ctx));
    this.bot.command("mode", (ctx) => this.modes(ctx));
    this.bot.command("effort", (ctx) => this.efforts(ctx));
    this.bot.command("status", (ctx) => this.status(ctx));
    this.bot.command("workflow", (ctx) => this.workflow(ctx));
    this.bot.command("tools", (ctx) => this.tools(ctx));
    this.bot.command("settings", (ctx) => this.settings(ctx));
    this.bot.command("history", (ctx) => this.history(ctx));
    this.bot.command("stop", async (ctx) => ctx.reply(await this.runner.stop(ctx.chat.id) ? "Останавливаю turn и очищаю очередь." : "Активного turn нет."));
    this.bot.command("cancel", async (ctx) => ctx.reply(await this.broker.cancelForChat(ctx.chat.id) ? "Запрос ввода отменён." : "Нет ожидающего ввода."));
    this.bot.command("clearapprovals", async (ctx) => { const s = this.database.getActiveSession(ctx.chat.id); if (!s) return void await ctx.reply("Нет сессии."); this.database.clearSessionAllowedTools(s.id); await ctx.reply("Разрешения сессии очищены."); });
    this.bot.command("rename", async (ctx) => { const s = this.database.getActiveSession(ctx.chat.id); const name = commandMatch(ctx); if (!s || !name) return void await ctx.reply("Использование: /rename Название"); this.database.updateSession(s.id, { title: truncate(name, 120) }); await ctx.reply("Переименовано."); });
    this.bot.command("close", async (ctx) => { if (this.runner.isRunning(ctx.chat.id)) return void await ctx.reply("Сначала /stop"); const s = this.database.getActiveSession(ctx.chat.id); if (!s) return void await ctx.reply("Нет сессии."); this.database.archiveSession(s.id); const next = this.database.listSessions(ctx.chat.id, 1)[0] ?? this.createSession(ctx.chat.id); this.database.setActiveSession(ctx.chat.id, next.id); await ctx.reply(`Активна: ${next.title}`); });
    this.bot.on("callback_query:data", async (ctx) => { if (!(await this.broker.handleCallback(ctx))) await this.configurationCallback(ctx); });
    this.bot.on("message:text", async (ctx) => { const text = ctx.message.text.trim(); if (!text || text.startsWith("/")) return; if (await this.broker.consumeText(ctx.chat.id, ctx.from.id, text)) return; if (!this.database.getActiveSession(ctx.chat.id)) this.createSession(ctx.chat.id); await this.runner.submit(ctx.chat.id, ctx.from.id, text); });
  }

  private ensureUser(chatId: number, userId: number): UserSettings {
    const existing = this.database.getUser(chatId); if (existing) return existing;
    const p = getProject(this.config, this.config.defaultProjectId);
    return this.database.upsertUser({ chatId, telegramUserId: userId, defaultProjectId: p.id, defaultProviderId: p.providerId, defaultModelId: p.modelId, defaultPermissionMode: p.permissionMode ?? "default" });
  }

  private createSession(chatId: number, title?: string): SessionRecord {
    const user = this.database.getUser(chatId); if (!user) throw new Error(`User missing: ${chatId}`);
    const project = getProject(this.config, user.defaultProjectId); const provider = getProvider(this.config, user.defaultProviderId);
    const model = provider.models.find((m) => m.id === user.defaultModelId) ?? provider.models[0]; if (!model) throw new Error("Provider has no models");
    if (model.id !== user.defaultModelId) this.database.updateUserDefaults(chatId, { defaultModelId: model.id });
    return this.database.createSession({ chatId, title: truncate(title ?? titleFor(project.name), 120), projectId: project.id, providerId: provider.id, modelId: model.id, permissionMode: user.defaultPermissionMode });
  }

  private effortFor(session: SessionRecord): EffortSetting {
    return this.effortStore.get(session.id) ?? resolveEffortLevel();
  }

  private async help(ctx: Context): Promise<void> {
    await ctx.reply(["<b>ClaudeTG</b> — Claude Agent SDK в Telegram.", "", "Отправьте обычный текст для запуска turn.", "Tool use свёрнут; approvals и вопросы интерактивны.", "", "/new · /sessions · /project · /provider · /model · /mode · /effort", "/status · /workflow · /tools · /settings · /history", "/stop · /cancel · /clearapprovals · /rename · /close"].join("\n"), { parse_mode: "HTML" });
  }

  private async sessions(ctx: Context): Promise<void> {
    const list = this.database.listSessions(ctx.chat!.id, 20); const active = this.database.getActiveSession(ctx.chat!.id); const keyboard = new InlineKeyboard();
    list.forEach((s) => keyboard.text(`${s.id === active?.id ? "✓ " : ""}${icon(s.status)} ${truncate(s.title, 34)}`, `session:${s.id}`).row());
    await ctx.reply(list.length ? "Выберите сессию:" : "Сессий нет. /new", list.length ? { reply_markup: keyboard } : {});
  }

  private async projects(ctx: Context): Promise<void> { const k = new InlineKeyboard(); this.config.projects.forEach((p, i) => k.text(p.name, `cfg:project:${i}`).row()); await ctx.reply("Выбор проекта создаст новую сессию:", { reply_markup: k }); }
  private async providers(ctx: Context): Promise<void> { const k = new InlineKeyboard(); this.config.providers.forEach((p, i) => k.text(p.name, `cfg:provider:${i}`).row()); await ctx.reply("Выбор провайдера создаст новую сессию:", { reply_markup: k }); }
  private async models(ctx: Context): Promise<void> {
    const u = this.database.getUser(ctx.chat!.id); if (!u) return; const pi = this.config.providers.findIndex((p) => p.id === u.defaultProviderId); const p = this.config.providers[pi]; if (!p) return void await ctx.reply("Провайдер не найден.");
    const k = new InlineKeyboard(); p.models.forEach((m, i) => k.text(m.name, `cfg:model:${pi}:${i}`).row()); await ctx.reply(`Модели ${p.name}:`, { reply_markup: k });
  }

  private async modes(ctx: Context): Promise<void> { const s = this.database.getActiveSession(ctx.chat!.id); const k = new InlineKeyboard(); MODES.forEach((m) => k.text(`${s?.permissionMode === m.value ? "✓ " : ""}${m.label}`, `cfg:mode:${m.value}`).row()); await ctx.reply(MODES.map((m) => `<b>${m.label}</b> — ${m.description}`).join("\n"), { parse_mode: "HTML", reply_markup: k }); }

  private async efforts(ctx: Context): Promise<void> {
    const s = this.database.getActiveSession(ctx.chat!.id); if (!s) return void await ctx.reply("Нет сессии.");
    const current = this.effortFor(s); const k = new InlineKeyboard();
    EFFORTS.forEach((item) => k.text(`${current === item.value ? "✓ " : ""}${item.label}`, `cfg:effort:${item.value}`).row());
    await ctx.reply([
      `<b>Effort текущей сессии: ${escapeHtml(current)}</b>`,
      "Ниже effort обычно дешевле, но на сложных задачах может потребовать повторных попыток.",
      "Изменение применяется со следующего turn и может сбросить prompt cache этой сессии.",
      "",
      ...EFFORTS.map((item) => `<b>${item.label}</b> — ${item.description}`),
    ].join("\n"), { parse_mode: "HTML", reply_markup: k });
  }

  private async status(ctx: Context): Promise<void> {
    const s = this.database.getActiveSession(ctx.chat!.id); if (!s) return void await ctx.reply("Нет сессии."); const run = this.runner.getActive(ctx.chat!.id); const p = getProject(this.config, s.projectId);
    const lines = [`${icon(run ? "running" : s.status)} <b>${escapeHtml(s.title)}</b>`, `ID: <code>${shortId(s.id)}</code>`, `Project: <code>${escapeHtml(p.name)}</code>`, `Provider: <code>${escapeHtml(s.providerId)}</code>`, `Model: <code>${escapeHtml(s.modelId)}</code>`, `Mode: <code>${escapeHtml(s.permissionMode)}</code>`, `Effort: <code>${escapeHtml(this.effortFor(s))}</code>`, `SDK session: <code>${escapeHtml(s.sdkSessionId ?? "not started")}</code>`, `Queue: ${this.runner.queueLength(ctx.chat!.id)}`, `Turns: ${s.totalTurns} · Cost: ${formatMoney(s.totalCostUsd)}`, run ? `Running: ${formatDuration(Date.now() - run.startedAt)}` : undefined, s.lastError ? `Last error: ${escapeHtml(truncate(s.lastError, 1000))}` : undefined].filter(Boolean);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }

  private async workflow(ctx: Context): Promise<void> { const s = this.database.getActiveSession(ctx.chat!.id); if (!s) return void await ctx.reply("Нет сессии."); const items = this.database.listWorkflowItems(s.id); if (!items.length) return void await ctx.reply("Workflow пока пуст."); const signs: Record<string,string> = { pending:"○",in_progress:"▶",completed:"✓",deleted:"×" }; await this.long(ctx, items.map((i) => `${signs[i.status]} <b>${escapeHtml(i.subject)}</b>${i.owner ? ` · ${escapeHtml(i.owner)}` : ""}${i.description ? `\n${escapeHtml(truncate(i.description, 400))}` : ""}`).join("\n\n")); }

  private async tools(ctx: Context): Promise<void> { const s = this.database.getActiveSession(ctx.chat!.id); if (!s) return void await ctx.reply("Нет сессии."); const p = getProject(this.config, s.projectId); const r = s.runtime ?? {}; await this.long(ctx, [`<b>Allow rules</b>: ${escapeHtml((p.allowedTools ?? []).join(", ") || "none")}`, `<b>Auto reads</b>: ${p.autoAllowReadTools ?? true}`, `<b>Deny rules</b>: ${escapeHtml((p.disallowedTools ?? []).join(", ") || "none")}`, `<b>Session approvals</b>: ${escapeHtml(s.sessionAllowedTools.join(", ") || "none")}`, `<b>Runtime tools</b>: ${escapeHtml(Array.isArray(r.tools) ? r.tools.map(String).join(", ") : "not initialized")}`, `<b>Skills</b>: ${escapeHtml(Array.isArray(r.skills) ? r.skills.map(String).join(", ") : "none")}`, `<b>Slash commands</b>: ${escapeHtml(Array.isArray(r.slashCommands) ? r.slashCommands.map(String).join(", ") : "none")}`, `<b>MCP</b>: ${escapeHtml(r.mcpServers ? truncate(JSON.stringify(r.mcpServers), 1800) : "none")}`].join("\n\n")); }

  private async settings(ctx: Context): Promise<void> { const s = this.database.getActiveSession(ctx.chat!.id); if (!s) return void await ctx.reply("Нет сессии."); const p = getProject(this.config, s.projectId); const provider = getProvider(this.config, s.providerId); const secret = process.env[provider.auth.env]?.trim(); await ctx.reply([`<b>Config</b>: <code>${escapeHtml(this.config.configPath)}</code>`, `<b>Project</b>: <code>${escapeHtml(p.path)}</code>`, `<b>Base URL</b>: <code>${escapeHtml(provider.baseUrl)}</code>`, `<b>Auth</b>: ${provider.auth.type} via <code>${escapeHtml(provider.auth.env)}</code>`, `<b>Model</b>: <code>${escapeHtml(s.modelId)}</code>`, `<b>Effort</b>: <code>${escapeHtml(this.effortFor(s))}</code>`].join("\n"), { parse_mode: "HTML" }); const files = inspectProjectSettings(p.path, secret ? [secret] : []); if (!files.length) return void await ctx.reply("Claude settings не найдены."); for (const f of files) await this.long(ctx, `<b>${escapeHtml(f.path)}</b>\n${expandableBlockquote(f.content)}`); }

  private async history(ctx: Context): Promise<void> {
    const s = this.database.getActiveSession(ctx.chat!.id);
    if (!s) return void await ctx.reply("Нет сессии.");
    const n = Number.parseInt(commandMatch(ctx), 10);
    const events = this.database.listEvents(s.id, Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 30).reverse();
    if (!events.length) return void await ctx.reply("История пуста.");
    await this.long(ctx, events.map((e) => `<code>${e.createdAt.slice(11,19)}</code> <b>${escapeHtml(e.kind)}</b> — ${escapeHtml(truncate(e.summary,700))}`).join("\n"));
  }

  private async configurationCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data; const chatId = ctx.chat?.id; if (!data || !chatId) return;
    if (this.runner.isRunning(chatId)) return void await ctx.answerCallbackQuery({ text: "Сначала /stop", show_alert: true });
    if (data.startsWith("session:")) { const s = this.database.getSession(data.slice(8)); if (!s || s.chatId !== chatId) return void await ctx.answerCallbackQuery({ text: "Не найдено", show_alert: true }); this.database.setActiveSession(chatId, s.id); await ctx.answerCallbackQuery({ text: "Выбрано" }); await ctx.reply(`Активна: ${s.title}`); return; }
    const [, kind, a, b] = data.split(":"); if (!kind) return; const u = this.database.getUser(chatId); if (!u) return;
    if (kind === "project") { const p = this.config.projects[Number(a)]; if (!p) return; this.database.updateUserDefaults(chatId, { defaultProjectId:p.id, defaultProviderId:p.providerId, defaultModelId:p.modelId, defaultPermissionMode:p.permissionMode ?? u.defaultPermissionMode }); }
    else if (kind === "provider") { const p = this.config.providers[Number(a)]; const m = p?.models[0]; if (!p || !m) return; this.database.updateUserDefaults(chatId, { defaultProviderId:p.id, defaultModelId:m.id }); }
    else if (kind === "model") { const p = this.config.providers[Number(a)]; const m = p?.models[Number(b)]; if (!p || !m) return; this.database.updateUserDefaults(chatId, { defaultProviderId:p.id, defaultModelId:m.id }); }
    else if (kind === "mode") { const mode = a as PermissionMode; if (!MODES.some((m) => m.value === mode)) return; this.database.updateUserDefaults(chatId, { defaultPermissionMode:mode }); const s = this.database.getActiveSession(chatId); if (s) this.database.updateSession(s.id, { permissionMode:mode }); await ctx.answerCallbackQuery({ text:`Mode: ${mode}` }); await ctx.reply(`Permission mode: ${mode}`); return; }
    else if (kind === "effort") { const effort = a as EffortSetting; if (!EFFORTS.some((item) => item.value === effort)) return; const s = this.database.getActiveSession(chatId); if (!s) return void await ctx.answerCallbackQuery({ text: "Нет сессии", show_alert: true }); this.effortStore.set(s.id, effort); this.database.addEvent(s.id, "effort_changed", effort); await ctx.answerCallbackQuery({ text: `Effort: ${effort}` }); await ctx.reply(`Effort активной сессии: ${effort}. Применится со следующего turn.`); return; }
    else return;
    const s = this.createSession(chatId); await ctx.answerCallbackQuery({ text:"Выбрано" }); await ctx.reply(`Создана сессия ${shortId(s.id)}: ${s.modelId}`);
  }

  private async long(ctx: Context, html: string): Promise<void> { if (html.length <= 3900) { await ctx.reply(html, { parse_mode:"HTML" }); return; } const plain = html.replace(/<[^>]+>/g, ""); for (const chunk of splitText(plain)) await ctx.reply(escapeHtml(chunk), { parse_mode:"HTML" }); }
}
