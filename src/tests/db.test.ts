import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Database } from "../db.js";

test("database persists users, sessions, events and workflow", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "claudetg-test-"));
  const database = new Database(path.join(directory, "test.sqlite"));
  try {
    database.upsertUser({
      chatId: 1,
      telegramUserId: 2,
      defaultProjectId: "main",
      defaultProviderId: "custom",
      defaultModelId: "claude-opus-4-8",
      defaultPermissionMode: "default",
    });
    const session = database.createSession({
      chatId: 1,
      title: "Test",
      projectId: "main",
      providerId: "custom",
      modelId: "claude-opus-4-8",
      permissionMode: "default",
    });
    database.addSessionAllowedTool(session.id, "Bash");
    database.addEvent(session.id, "assistant", "hello");
    database.upsertWorkflowItem({
      sessionId: session.id,
      taskId: "1",
      subject: "Run tests",
      status: "in_progress",
    });
    assert.equal(database.getActiveSession(1)?.sessionAllowedTools[0], "Bash");
    assert.equal(database.listEvents(session.id)[0]?.summary, "hello");
    assert.equal(database.listWorkflowItems(session.id)[0]?.subject, "Run tests");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test("database retains only the configured number of events per session", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "claudetg-retention-"));
  const database = new Database(path.join(directory, "test.sqlite"), 3);
  try {
    database.upsertUser({
      chatId: 10,
      telegramUserId: 20,
      defaultProjectId: "main",
      defaultProviderId: "custom",
      defaultModelId: "claude-opus-4-8",
      defaultPermissionMode: "default",
    });
    const session = database.createSession({
      chatId: 10,
      title: "Retention",
      projectId: "main",
      providerId: "custom",
      modelId: "claude-opus-4-8",
      permissionMode: "default",
    });
    for (let index = 0; index < 6; index += 1) database.addEvent(session.id, "test", String(index));
    assert.deepEqual(database.listEvents(session.id, 10).map((event) => event.summary), ["5", "4", "3"]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
