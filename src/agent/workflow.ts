import type { Database } from "../db.js";

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStatus(value: unknown): "pending" | "in_progress" | "completed" | "deleted" {
  return value === "in_progress" || value === "completed" || value === "deleted" ? value : "pending";
}

export class WorkflowTracker {
  private readonly pendingCreates = new Map<string, string>();

  constructor(
    private readonly database: Database,
    private readonly sessionId: string,
  ) {}

  onToolUse(toolUseId: string, toolName: string, input: Record<string, unknown>): void {
    if (toolName === "TaskCreate") {
      const temporaryId = `pending:${toolUseId}`;
      this.pendingCreates.set(toolUseId, temporaryId);
      const description = stringField(input, "description");
      this.database.upsertWorkflowItem({
        sessionId: this.sessionId,
        taskId: temporaryId,
        subject: stringField(input, "subject") ?? "New task",
        ...(description ? { description } : {}),
        status: "pending",
      });
      return;
    }
    if (toolName === "TaskUpdate") {
      const taskId = stringField(input, "taskId") ?? `unknown:${toolUseId}`;
      const existing = this.database.listWorkflowItems(this.sessionId).find((item) => item.taskId === taskId);
      const description = stringField(input, "description") ?? existing?.description;
      const owner = stringField(input, "owner") ?? existing?.owner;
      this.database.upsertWorkflowItem({
        sessionId: this.sessionId,
        taskId,
        subject: stringField(input, "subject") ?? existing?.subject ?? `Task ${taskId}`,
        ...(description ? { description } : {}),
        status: normalizeStatus(input.status ?? existing?.status),
        ...(owner ? { owner } : {}),
      });
      return;
    }
    if (toolName === "TodoWrite" && Array.isArray(input.todos)) {
      input.todos.forEach((raw, index) => {
        if (!raw || typeof raw !== "object") return;
        const todo = raw as Record<string, unknown>;
        this.database.upsertWorkflowItem({
          sessionId: this.sessionId,
          taskId: `todo:${index + 1}`,
          subject: stringField(todo, "content") ?? `Todo ${index + 1}`,
          status: normalizeStatus(todo.status),
        });
      });
    }
  }

  onToolResult(toolUseId: string, toolName: string, output: string): void {
    if (toolName !== "TaskCreate") return;
    const temporaryId = this.pendingCreates.get(toolUseId);
    if (!temporaryId) return;
    const parsedId = this.extractTaskId(output);
    if (parsedId) this.database.renameWorkflowItemId(this.sessionId, temporaryId, parsedId);
    this.pendingCreates.delete(toolUseId);
  }

  private extractTaskId(output: string): string | undefined {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        const value = record.taskId ?? record.task_id ?? record.id;
        if (typeof value === "string" || typeof value === "number") return String(value);
      }
    } catch {
      // Fall back to a conservative textual match.
    }
    const match = output.match(/(?:task(?:\s+id)?|id)\s*[:#=]?\s*([A-Za-z0-9._-]+)/i);
    return match?.[1];
  }
}
