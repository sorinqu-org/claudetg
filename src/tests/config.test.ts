import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkerProjectPath } from "../config.js";

test("legacy per-project workspace path is normalized to worker root", () => {
  assert.equal(normalizeWorkerProjectPath("/workspace/main", "main"), "/workspace");
  assert.equal(normalizeWorkerProjectPath("/workspace/project-a", "project-a"), "/workspace");
});

test("custom worker paths are preserved", () => {
  assert.equal(normalizeWorkerProjectPath("/repo", "main"), "/repo");
  assert.equal(normalizeWorkerProjectPath("/workspace/subdir", "main"), "/workspace/subdir");
});

test("worker project path must be absolute", () => {
  assert.throws(() => normalizeWorkerProjectPath("workspace/main", "main"), /absolute path/);
});
