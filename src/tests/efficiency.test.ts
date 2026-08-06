import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  buildEfficiencyEnvironment,
  buildEfficiencyPlugins,
  enabledFromEnv,
} from "../agent/efficiency.js";

function withEnv(name: string, value: string | undefined, callback: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try {
    callback();
  } finally {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
}

test("enabledFromEnv supports common boolean values", () => {
  withEnv("EFFICIENCY_TEST_FLAG", "yes", () => assert.equal(enabledFromEnv("EFFICIENCY_TEST_FLAG", false), true));
  withEnv("EFFICIENCY_TEST_FLAG", "off", () => assert.equal(enabledFromEnv("EFFICIENCY_TEST_FLAG", true), false));
  withEnv("EFFICIENCY_TEST_FLAG", undefined, () => assert.equal(enabledFromEnv("EFFICIENCY_TEST_FLAG", true), true));
});

test("bundled tool directory is prepended to PATH", () => {
  const environment = buildEfficiencyEnvironment("/usr/bin");
  const pathValue = environment.PATH;
  assert.ok(pathValue);
  const entries = pathValue.split(path.delimiter);
  assert.match(entries[0] ?? "", /node_modules[/\\]\.bin$/);
  assert.equal(entries.at(-1), "/usr/bin");
  assert.equal(environment.MCP_TIMEOUT, "60000");
});

test("base efficiency plugin is enabled and Serena is opt-in", () => {
  withEnv("TOKEN_EFFICIENCY_ENABLED", undefined, () => {
    withEnv("SERENA_ENABLED", undefined, () => {
      const names = buildEfficiencyPlugins().map((plugin) => path.basename(plugin.path));
      assert.deepEqual(names, ["claudetg-efficiency"]);
    });
  });

  withEnv("SERENA_ENABLED", "true", () => {
    const names = buildEfficiencyPlugins().map((plugin) => path.basename(plugin.path));
    assert.deepEqual(names, ["claudetg-efficiency", "claudetg-serena"]);
  });
});
