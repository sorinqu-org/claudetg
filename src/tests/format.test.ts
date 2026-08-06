import assert from "node:assert/strict";
import test from "node:test";
import { compactInputSummary, escapeHtml, renderToolDetails, renderToolResult, splitText, TELEGRAM_TEXT_LIMIT } from "../telegram/format.js";

test("escapeHtml escapes Telegram HTML metacharacters", () => {
  assert.equal(escapeHtml("<tag a=\"x\">&"), "&lt;tag a=&quot;x&quot;&gt;&amp;");
});

test("splitText respects the requested limit", () => {
  const chunks = splitText("a".repeat(25), 10);
  assert.deepEqual(chunks.map((item) => item.length), [10, 10, 5]);
});

test("compactInputSummary uses tool-specific fields", () => {
  assert.equal(compactInputSummary("Bash", { command: "npm test", description: "Run tests" }), "Run tests");
  assert.equal(compactInputSummary("Read", { file_path: "/tmp/a" }), "/tmp/a");
});


test("tool cards remain below the Telegram message limit", () => {
  const inputCard = renderToolDetails("Bash", { command: "x".repeat(20_000) }, 20_000);
  const resultCard = renderToolResult("Bash", "long command", "x".repeat(20_000), false, 20_000);
  assert.ok(inputCard.length < TELEGRAM_TEXT_LIMIT);
  assert.ok(resultCard.length < TELEGRAM_TEXT_LIMIT);
});
