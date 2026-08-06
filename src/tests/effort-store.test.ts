import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EffortStore } from "../effort-store.js";

test("EffortStore persists independent effort values per session", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "claudetg-effort-"));
  const databasePath = path.join(directory, "test.sqlite");
  const store = new EffortStore(databasePath);
  try {
    assert.equal(store.get("session-a"), undefined);
    store.set("session-a", "low");
    store.set("session-b", "xhigh");
    assert.equal(store.get("session-a"), "low");
    assert.equal(store.get("session-b"), "xhigh");
    store.set("session-a", "auto");
    assert.equal(store.get("session-a"), "auto");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
