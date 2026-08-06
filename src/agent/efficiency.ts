import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EffortLevel, Options } from "@anthropic-ai/claude-agent-sdk";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGINS_ROOT = path.join(APP_ROOT, "plugins");
const EFFORT_LEVELS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);

export function enabledFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function resolveEffortLevel(raw = process.env.CLAUDE_CODE_EFFORT_LEVEL): EffortLevel {
  const value = (raw?.trim().toLowerCase() || "medium") as EffortLevel;
  if (!EFFORT_LEVELS.has(value)) {
    throw new Error(`CLAUDE_CODE_EFFORT_LEVEL must be one of: ${[...EFFORT_LEVELS].join(", ")}`);
  }
  return value;
}

export function buildEfficiencyEnvironment(currentPath?: string): Record<string, string> {
  const bundledBin = path.join(APP_ROOT, "node_modules", ".bin");
  const environment: Record<string, string> = {
    PATH: [bundledBin, currentPath].filter((value): value is string => Boolean(value)).join(path.delimiter),
    MCP_TIMEOUT: process.env.MCP_TIMEOUT?.trim() || "60000",
    CLAUDE_CODE_EFFORT_LEVEL: resolveEffortLevel(),
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION:
      process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION?.trim() || "false",
  };

  if (enabledFromEnv("CLAUDE_CODE_DISABLE_THINKING", false)) {
    environment.CLAUDE_CODE_DISABLE_THINKING = "1";
  }

  return environment;
}

export function buildEfficiencyPlugins(): NonNullable<Options["plugins"]> {
  const plugins: NonNullable<Options["plugins"]> = [];

  if (enabledFromEnv("TOKEN_EFFICIENCY_ENABLED", true)) {
    const pluginPath = path.join(PLUGINS_ROOT, "claudetg-efficiency");
    if (existsSync(pluginPath)) plugins.push({ type: "local", path: pluginPath });
  }

  if (enabledFromEnv("SERENA_ENABLED", false)) {
    const pluginPath = path.join(PLUGINS_ROOT, "claudetg-serena");
    if (existsSync(pluginPath)) plugins.push({ type: "local", path: pluginPath });
  }

  return plugins;
}
