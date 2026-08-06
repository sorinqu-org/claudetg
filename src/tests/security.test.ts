import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectPathViolations, isPathInside, redactUnknown } from "../security.js";

test("redactUnknown removes secret-shaped fields and exact secret values", () => {
  const value = redactUnknown({
    apiKey: "top-secret",
    nested: { command: "curl -H 'Authorization: Bearer exact-secret'" },
  }, ["exact-secret"]);
  assert.deepEqual(value, {
    apiKey: "[redacted]",
    nested: { command: "curl -H 'Authorization: Bearer [redacted]'" },
  });
});

test("path containment rejects sibling and parent paths", () => {
  assert.equal(isPathInside("/workspace/app", "/workspace/app/src/index.ts"), true);
  assert.equal(isPathInside("/workspace/app", "/workspace/other/file"), false);
  assert.equal(isPathInside("/workspace/app", "/workspace/app2/file"), false);
});

test("collectPathViolations finds absolute tool paths outside roots", () => {
  const violations = collectPathViolations({
    file_path: "/etc/passwd",
    nested: { directory: "/workspace/app/src" },
  }, ["/workspace/app"]);
  assert.deepEqual(violations, ["/etc/passwd"]);
});


test("collectPathViolations blocks relative parent traversal", () => {
  const violations = collectPathViolations({ file_path: "../../etc/passwd" }, ["/workspace/app"], "/workspace/app/src");
  assert.deepEqual(violations, ["../../etc/passwd"]);
});

test("collectPathViolations resolves symlinks before applying the root policy", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "claudetg-security-"));
  const root = path.join(directory, "root");
  const outside = path.join(directory, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  symlinkSync(outside, path.join(root, "escape"));
  try {
    const violations = collectPathViolations({ file_path: path.join(root, "escape", "secret.txt") }, [root], root);
    assert.equal(violations.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
