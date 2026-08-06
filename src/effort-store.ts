import { DatabaseSync } from "node:sqlite";
import { isEffortSetting, type EffortSetting } from "./agent/efficiency.js";

export class EffortStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS session_effort (
        session_id TEXT PRIMARY KEY,
        effort_level TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  get(sessionId: string): EffortSetting | undefined {
    const row = this.db.prepare("SELECT effort_level FROM session_effort WHERE session_id = ?")
      .get(sessionId) as { effort_level: string } | undefined;
    return row && isEffortSetting(row.effort_level) ? row.effort_level : undefined;
  }

  set(sessionId: string, effort: EffortSetting): void {
    if (!isEffortSetting(effort)) throw new Error(`Unsupported effort level: ${String(effort)}`);
    this.db.prepare(`
      INSERT INTO session_effort (session_id, effort_level, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        effort_level = excluded.effort_level,
        updated_at = excluded.updated_at
    `).run(sessionId, effort, new Date().toISOString());
  }
}
