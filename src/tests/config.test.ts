import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getProject, loadRuntimeConfig, normalizeWorkerProjectPath } from "../config.js";

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

test("runtime config migrates the old /workspace/<projectId> layout", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "claudetg-config-"));
  const configPath = path.join(directory, "config.json");
  const dataDir = path.join(directory, "data");
  writeFileSync(configPath, JSON.stringify({
    defaultProjectId: "main",
    providers: [{
      id: "custom",
      name: "Custom",
      baseUrl: "https://provider.example.com",
      auth: { type: "bearer", env: "TEST_PROVIDER_KEY" },
      models: [{ id: "claude-test", name: "Claude Test" }],
    }],
    projects: [{
      id: "main",
      name: "Main",
      path: "/workspace/main",
      workerUrl: "http://worker-main:3100",
      providerId: "custom",
      modelId: "claude-test",
    }],
    agent: {},
  }));

  const names = [
    "CONFIG_PATH",
    "DATA_DIR",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
    "CLAUDETG_INTERNAL_TOKEN",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CONFIG_PATH = configPath;
    process.env.DATA_DIR = dataDir;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
    process.env.CLAUDETG_INTERNAL_TOKEN = "internal-test-token";

    const config = await loadRuntimeConfig();
    assert.equal(getProject(config, "main").path, "/workspace");
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
