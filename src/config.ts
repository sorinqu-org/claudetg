import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AgentRuntimeConfig,
  AppFileConfig,
  LogLevel,
  PermissionMode,
  ProjectConfig,
  ProviderConfig,
  RuntimeConfig,
  SettingSource,
} from "./domain.js";

const PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto",
]);
const SETTING_SOURCES = new Set<SettingSource>(["user", "project", "local"]);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function asBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function asStringArray(value: unknown, label: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function asPositiveNumber(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function parseProvider(raw: unknown, index: number): ProviderConfig {
  const value = asObject(raw, `providers[${index}]`);
  const auth = asObject(value.auth, `providers[${index}].auth`);
  const authType = asString(auth.type, `providers[${index}].auth.type`);
  if (authType !== "bearer" && authType !== "api-key") {
    throw new Error(`providers[${index}].auth.type must be bearer or api-key`);
  }
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new Error(`providers[${index}].models must contain at least one model`);
  }
  const models = value.models.map((rawModel, modelIndex) => {
    const model = asObject(rawModel, `providers[${index}].models[${modelIndex}]`);
    const description = model.description;
    return {
      id: asString(model.id, `providers[${index}].models[${modelIndex}].id`),
      name: asString(model.name, `providers[${index}].models[${modelIndex}].name`),
      ...(typeof description === "string" && description.trim() ? { description: description.trim() } : {}),
    };
  });
  const baseUrl = asString(value.baseUrl, `providers[${index}].baseUrl`).replace(/\/+$/, "");
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("must use HTTPS unless it is localhost");
    }
  } catch (error) {
    throw new Error(`providers[${index}].baseUrl is invalid: ${String(error)}`);
  }
  const extraEnvRaw = value.extraEnv;
  const extraEnv = extraEnvRaw === undefined ? undefined : asObject(extraEnvRaw, `providers[${index}].extraEnv`);
  if (extraEnv && Object.values(extraEnv).some((item) => typeof item !== "string")) {
    throw new Error(`providers[${index}].extraEnv values must be strings`);
  }
  return {
    id: asString(value.id, `providers[${index}].id`),
    name: asString(value.name, `providers[${index}].name`),
    baseUrl,
    auth: {
      type: authType,
      env: asString(auth.env, `providers[${index}].auth.env`),
    },
    models,
    ...(extraEnv ? { extraEnv: extraEnv as Record<string, string> } : {}),
  };
}

function parseProject(raw: unknown, index: number): ProjectConfig {
  const value = asObject(raw, `projects[${index}]`);
  const projectPath = path.resolve(asString(value.path, `projects[${index}].path`));
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(`projects[${index}].path does not exist or is not a directory: ${projectPath}`);
  }
  const permissionModeRaw = value.permissionMode;
  const permissionMode = permissionModeRaw === undefined
    ? undefined
    : asString(permissionModeRaw, `projects[${index}].permissionMode`) as PermissionMode;
  if (permissionMode && !PERMISSION_MODES.has(permissionMode)) {
    throw new Error(`projects[${index}].permissionMode is unsupported`);
  }
  const settingSourcesRaw = asStringArray(value.settingSources, `projects[${index}].settingSources`, ["project", "local"]);
  const settingSources = settingSourcesRaw.map((source) => {
    if (!SETTING_SOURCES.has(source as SettingSource)) {
      throw new Error(`projects[${index}].settingSources contains unsupported source: ${source}`);
    }
    return source as SettingSource;
  });
  return {
    id: asString(value.id, `projects[${index}].id`),
    name: asString(value.name, `projects[${index}].name`),
    path: projectPath,
    providerId: asString(value.providerId, `projects[${index}].providerId`),
    modelId: asString(value.modelId, `projects[${index}].modelId`),
    ...(permissionMode ? { permissionMode } : {}),
    allowedTools: asStringArray(value.allowedTools, `projects[${index}].allowedTools`),
    disallowedTools: asStringArray(value.disallowedTools, `projects[${index}].disallowedTools`),
    additionalDirectories: asStringArray(value.additionalDirectories, `projects[${index}].additionalDirectories`).map((item) => path.resolve(item)),
    settingSources,
    passEnv: asStringArray(value.passEnv, `projects[${index}].passEnv`),
    autoAllowReadTools: asBoolean(value.autoAllowReadTools, `projects[${index}].autoAllowReadTools`, true),
    ...(typeof value.systemPromptAppend === "string" && value.systemPromptAppend.trim()
      ? { systemPromptAppend: value.systemPromptAppend.trim() }
      : {}),
  };
}

function parseAgent(raw: unknown): AgentRuntimeConfig {
  const value = raw === undefined ? {} : asObject(raw, "agent");
  const maxBudgetUsd = value.maxBudgetUsd;
  return {
    maxTurns: asPositiveNumber(value.maxTurns, "agent.maxTurns", 80),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd: asPositiveNumber(maxBudgetUsd, "agent.maxBudgetUsd", 25) }),
    turnTimeoutMs: asPositiveNumber(value.turnTimeoutMs, "agent.turnTimeoutMs", 3_600_000),
    approvalTimeoutMs: asPositiveNumber(value.approvalTimeoutMs, "agent.approvalTimeoutMs", 86_400_000),
    streamFlushMs: asPositiveNumber(value.streamFlushMs, "agent.streamFlushMs", 900),
    maxToolDetailChars: asPositiveNumber(value.maxToolDetailChars, "agent.maxToolDetailChars", 3_000),
    queueLimit: asPositiveNumber(value.queueLimit, "agent.queueLimit", 20),
    eventRetentionPerSession: asPositiveNumber(value.eventRetentionPerSession, "agent.eventRetentionPerSession", 5_000),
  };
}

function parseFileConfig(raw: unknown): AppFileConfig {
  const value = asObject(raw, "config");
  if (!Array.isArray(value.providers) || value.providers.length === 0) {
    throw new Error("providers must contain at least one provider");
  }
  if (!Array.isArray(value.projects) || value.projects.length === 0) {
    throw new Error("projects must contain at least one project");
  }
  const providers = value.providers.map(parseProvider);
  const projects = value.projects.map(parseProject);
  const providerIds = new Set(providers.map((provider) => provider.id));
  const projectIds = new Set(projects.map((project) => project.id));
  if (providerIds.size !== providers.length) throw new Error("Provider IDs must be unique");
  if (projectIds.size !== projects.length) throw new Error("Project IDs must be unique");
  for (const project of projects) {
    const provider = providers.find((item) => item.id === project.providerId);
    if (!provider) throw new Error(`Project ${project.id} references unknown provider ${project.providerId}`);
    if (!provider.models.some((model) => model.id === project.modelId)) {
      throw new Error(`Project ${project.id} references unknown model ${project.modelId}`);
    }
    for (const directory of project.additionalDirectories ?? []) {
      if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        throw new Error(`Additional directory does not exist for project ${project.id}: ${directory}`);
      }
    }
  }
  const defaultProjectId = asString(value.defaultProjectId, "defaultProjectId");
  if (!projectIds.has(defaultProjectId)) throw new Error(`Unknown defaultProjectId: ${defaultProjectId}`);
  return {
    defaultProjectId,
    providers,
    projects,
    agent: parseAgent(value.agent),
  };
}

function parseAllowedUserIds(raw: string): Set<number> {
  const ids = raw.split(",").map((item) => Number.parseInt(item.trim(), 10));
  if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of positive integers");
  }
  return new Set(ids);
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const configPath = path.resolve(process.env.CONFIG_PATH?.trim() || "./config/config.json");
  if (!existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
  const fileConfig = parseFileConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
  const dataDir = path.resolve(process.env.DATA_DIR?.trim() || "./data");
  await mkdir(dataDir, { recursive: true });
  const logLevelRaw = (process.env.LOG_LEVEL?.trim().toLowerCase() || "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevelRaw)) throw new Error("Invalid LOG_LEVEL");
  return {
    ...fileConfig,
    telegramBotToken: requiredEnv("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: parseAllowedUserIds(requiredEnv("TELEGRAM_ALLOWED_USER_IDS")),
    allowGroupChats: parseBoolean(process.env.ALLOW_GROUP_CHATS, false),
    dataDir,
    databasePath: path.join(dataDir, "claudetg.sqlite"),
    healthPort: parseInteger(process.env.HEALTH_PORT, 3000, "HEALTH_PORT"),
    logLevel: logLevelRaw,
    configPath,
  };
}

export function getProject(config: RuntimeConfig, id: string): ProjectConfig {
  const project = config.projects.find((item) => item.id === id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  return project;
}

export function getProvider(config: RuntimeConfig, id: string): ProviderConfig {
  const provider = config.providers.find((item) => item.id === id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function assertProviderModel(provider: ProviderConfig, modelId: string): void {
  if (!provider.models.some((model) => model.id === modelId)) {
    throw new Error(`Provider ${provider.id} does not expose model ${modelId}`);
  }
}
