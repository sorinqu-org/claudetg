import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type {
  EventRecord,
  SessionRecord,
  SessionStatus,
  UserSettings,
  WorkflowItem,
} from "./domain.js";

interface SessionRow {
  id: string;
  chat_id: number;
  title: string;
  project_id: string;
  provider_id: string;
  model_id: string;
  permission_mode: PermissionMode;
  sdk_session_id: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  total_cost_usd: number;
  total_turns: number;
  allowed_tools_json: string;
  runtime_json: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    title: row.title,
    projectId: row.project_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    permissionMode: row.permission_mode,
    ...(row.sdk_session_id ? { sdkSessionId: row.sdk_session_id } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    totalCostUsd: row.total_cost_usd,
    totalTurns: row.total_turns,
    sessionAllowedTools: parseJson<string[]>(row.allowed_tools_json, []),
    ...(row.runtime_json ? { runtime: parseJson<Record<string, unknown>>(row.runtime_json, {}) } : {}),
  };
}

export class Database {
  private readonly db: DatabaseSync;

  constructor(databasePath: string, private readonly eventRetentionPerSession = 5_000) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.recoverInterruptedSessions();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        chat_id INTEGER PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        default_project_id TEXT NOT NULL,
        default_provider_id TEXT NOT NULL,
        default_model_id TEXT NOT NULL,
        default_permission_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        project_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        sdk_session_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        total_turns INTEGER NOT NULL DEFAULT 0,
        allowed_tools_json TEXT NOT NULL DEFAULT '[]',
        runtime_json TEXT,
        FOREIGN KEY(chat_id) REFERENCES users(chat_id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_chat_updated
        ON sessions(chat_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS chat_state (
        chat_id INTEGER PRIMARY KEY,
        active_session_id TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES users(chat_id),
        FOREIGN KEY(active_session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_id
        ON events(session_id, id DESC);

      CREATE TABLE IF NOT EXISTS workflow_items (
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        owner TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id, task_id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);
  }

  private recoverInterruptedSessions(): void {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE sessions
      SET status = 'stopped',
          last_error = COALESCE(last_error, 'Process restarted while the session was running'),
          updated_at = ?
      WHERE status = 'running'
    `).run(timestamp);
  }

  upsertUser(settings: UserSettings): UserSettings {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO users (
        chat_id, telegram_user_id, default_project_id, default_provider_id,
        default_model_id, default_permission_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        telegram_user_id = excluded.telegram_user_id,
        updated_at = excluded.updated_at
    `).run(
      settings.chatId,
      settings.telegramUserId,
      settings.defaultProjectId,
      settings.defaultProviderId,
      settings.defaultModelId,
      settings.defaultPermissionMode,
      timestamp,
      timestamp,
    );
    return this.getUser(settings.chatId) ?? settings;
  }

  getUser(chatId: number): UserSettings | undefined {
    const row = this.db.prepare(`
      SELECT chat_id, telegram_user_id, default_project_id, default_provider_id,
             default_model_id, default_permission_mode
      FROM users WHERE chat_id = ?
    `).get(chatId) as {
      chat_id: number;
      telegram_user_id: number;
      default_project_id: string;
      default_provider_id: string;
      default_model_id: string;
      default_permission_mode: PermissionMode;
    } | undefined;
    if (!row) return undefined;
    return {
      chatId: row.chat_id,
      telegramUserId: row.telegram_user_id,
      defaultProjectId: row.default_project_id,
      defaultProviderId: row.default_provider_id,
      defaultModelId: row.default_model_id,
      defaultPermissionMode: row.default_permission_mode,
    };
  }

  updateUserDefaults(chatId: number, patch: Partial<Omit<UserSettings, "chatId" | "telegramUserId">>): void {
    const current = this.getUser(chatId);
    if (!current) throw new Error(`Unknown user chat: ${chatId}`);
    const next = { ...current, ...patch };
    this.db.prepare(`
      UPDATE users SET
        default_project_id = ?, default_provider_id = ?, default_model_id = ?,
        default_permission_mode = ?, updated_at = ?
      WHERE chat_id = ?
    `).run(
      next.defaultProjectId,
      next.defaultProviderId,
      next.defaultModelId,
      next.defaultPermissionMode,
      nowIso(),
      chatId,
    );
  }

  createSession(input: {
    chatId: number;
    title: string;
    projectId: string;
    providerId: string;
    modelId: string;
    permissionMode: PermissionMode;
  }): SessionRecord {
    const id = randomUUID();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO sessions (
        id, chat_id, title, project_id, provider_id, model_id, permission_mode,
        status, created_at, updated_at, allowed_tools_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, '[]')
    `).run(
      id,
      input.chatId,
      input.title,
      input.projectId,
      input.providerId,
      input.modelId,
      input.permissionMode,
      timestamp,
      timestamp,
    );
    this.setActiveSession(input.chatId, id);
    const session = this.getSession(id);
    if (!session) throw new Error("Failed to create session");
    return session;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  getActiveSession(chatId: number): SessionRecord | undefined {
    const row = this.db.prepare(`
      SELECT s.* FROM sessions s
      JOIN chat_state c ON c.active_session_id = s.id
      WHERE c.chat_id = ? AND s.status != 'archived'
    `).get(chatId) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  setActiveSession(chatId: number, sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session || session.chatId !== chatId) throw new Error("Session does not belong to this chat");
    this.db.prepare(`
      INSERT INTO chat_state (chat_id, active_session_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        active_session_id = excluded.active_session_id,
        updated_at = excluded.updated_at
    `).run(chatId, sessionId, nowIso());
  }

  listSessions(chatId: number, limit = 20): SessionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE chat_id = ? AND status != 'archived'
      ORDER BY updated_at DESC LIMIT ?
    `).all(chatId, limit) as unknown as SessionRow[];
    return rows.map(mapSession);
  }

  updateSession(id: string, patch: {
    title?: string;
    providerId?: string;
    modelId?: string;
    permissionMode?: PermissionMode;
    sdkSessionId?: string;
    status?: SessionStatus;
    lastError?: string | null;
    runtime?: Record<string, unknown>;
    totalCostUsdDelta?: number;
    totalTurnsDelta?: number;
  }): void {
    const current = this.getSession(id);
    if (!current) throw new Error(`Unknown session: ${id}`);
    const title = patch.title ?? current.title;
    const providerId = patch.providerId ?? current.providerId;
    const modelId = patch.modelId ?? current.modelId;
    const permissionMode = patch.permissionMode ?? current.permissionMode;
    const sdkSessionId = patch.sdkSessionId ?? current.sdkSessionId ?? null;
    const status = patch.status ?? current.status;
    const lastError = patch.lastError === undefined ? current.lastError ?? null : patch.lastError;
    const runtime = patch.runtime === undefined ? current.runtime ?? null : patch.runtime;
    this.db.prepare(`
      UPDATE sessions SET
        title = ?, provider_id = ?, model_id = ?, permission_mode = ?, sdk_session_id = ?,
        status = ?, last_error = ?, runtime_json = ?,
        total_cost_usd = total_cost_usd + ?, total_turns = total_turns + ?, updated_at = ?
      WHERE id = ?
    `).run(
      title,
      providerId,
      modelId,
      permissionMode,
      sdkSessionId,
      status,
      lastError,
      runtime ? JSON.stringify(runtime) : null,
      patch.totalCostUsdDelta ?? 0,
      patch.totalTurnsDelta ?? 0,
      nowIso(),
      id,
    );
  }

  archiveSession(id: string): void {
    this.updateSession(id, { status: "archived" });
  }

  addSessionAllowedTool(sessionId: string, toolName: string): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const tools = [...new Set([...session.sessionAllowedTools, toolName])].sort();
    this.db.prepare(`UPDATE sessions SET allowed_tools_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(tools), nowIso(), sessionId);
  }

  clearSessionAllowedTools(sessionId: string): void {
    this.db.prepare(`UPDATE sessions SET allowed_tools_json = '[]', updated_at = ? WHERE id = ?`)
      .run(nowIso(), sessionId);
  }

  addEvent(sessionId: string, kind: string, summary: string, detail?: string): void {
    this.db.prepare(`
      INSERT INTO events (session_id, kind, summary, detail, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, kind, summary, detail ?? null, nowIso());
    this.db.prepare(`
      DELETE FROM events
      WHERE session_id = ? AND id NOT IN (
        SELECT id FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(sessionId, sessionId, this.eventRetentionPerSession);
  }

  listEvents(sessionId: string, limit = 30): EventRecord[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, kind, summary, detail, created_at
      FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?
    `).all(sessionId, limit) as unknown as Array<{
      id: number;
      session_id: string;
      kind: string;
      summary: string;
      detail: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      summary: row.summary,
      ...(row.detail ? { detail: row.detail } : {}),
      createdAt: row.created_at,
    }));
  }

  upsertWorkflowItem(item: Omit<WorkflowItem, "updatedAt">): void {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO workflow_items (
        session_id, task_id, subject, description, status, owner, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, task_id) DO UPDATE SET
        subject = excluded.subject,
        description = excluded.description,
        status = excluded.status,
        owner = excluded.owner,
        updated_at = excluded.updated_at
    `).run(
      item.sessionId,
      item.taskId,
      item.subject,
      item.description ?? null,
      item.status,
      item.owner ?? null,
      timestamp,
    );
  }

  renameWorkflowItemId(sessionId: string, oldTaskId: string, newTaskId: string): void {
    const existing = this.db.prepare(`
      SELECT subject, description, status, owner FROM workflow_items
      WHERE session_id = ? AND task_id = ?
    `).get(sessionId, oldTaskId) as {
      subject: string;
      description: string | null;
      status: WorkflowItem["status"];
      owner: string | null;
    } | undefined;
    if (!existing) return;
    this.upsertWorkflowItem({
      sessionId,
      taskId: newTaskId,
      subject: existing.subject,
      ...(existing.description ? { description: existing.description } : {}),
      status: existing.status,
      ...(existing.owner ? { owner: existing.owner } : {}),
    });
    this.db.prepare(`DELETE FROM workflow_items WHERE session_id = ? AND task_id = ?`)
      .run(sessionId, oldTaskId);
  }

  listWorkflowItems(sessionId: string): WorkflowItem[] {
    const rows = this.db.prepare(`
      SELECT session_id, task_id, subject, description, status, owner, updated_at
      FROM workflow_items
      WHERE session_id = ? AND status != 'deleted'
      ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
               updated_at ASC
    `).all(sessionId) as unknown as Array<{
      session_id: string;
      task_id: string;
      subject: string;
      description: string | null;
      status: WorkflowItem["status"];
      owner: string | null;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      taskId: row.task_id,
      subject: row.subject,
      ...(row.description ? { description: row.description } : {}),
      status: row.status,
      ...(row.owner ? { owner: row.owner } : {}),
      updatedAt: row.updated_at,
    }));
  }
}
