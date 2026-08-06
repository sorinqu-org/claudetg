import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
export type { PermissionMode };

export type AuthType = "bearer" | "api-key";
export type SettingSource = "user" | "project" | "local";

export interface ModelConfig {
  id: string;
  name: string;
  description?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  auth: {
    type: AuthType;
    env: string;
  };
  models: ModelConfig[];
  extraEnv?: Record<string, string>;
}

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  providerId: string;
  modelId: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  settingSources?: SettingSource[];
  passEnv?: string[];
  systemPromptAppend?: string;
  autoAllowReadTools?: boolean;
}

export interface AgentRuntimeConfig {
  maxTurns: number;
  maxBudgetUsd?: number;
  turnTimeoutMs: number;
  approvalTimeoutMs: number;
  streamFlushMs: number;
  maxToolDetailChars: number;
  queueLimit: number;
  eventRetentionPerSession: number;
}

export interface AppFileConfig {
  defaultProjectId: string;
  providers: ProviderConfig[];
  projects: ProjectConfig[];
  agent: AgentRuntimeConfig;
}

export interface RuntimeConfig extends AppFileConfig {
  telegramBotToken: string;
  allowedUserIds: Set<number>;
  allowGroupChats: boolean;
  dataDir: string;
  databasePath: string;
  healthPort: number;
  logLevel: LogLevel;
  configPath: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type SessionStatus = "idle" | "running" | "stopped" | "error" | "archived";

export interface UserSettings {
  chatId: number;
  telegramUserId: number;
  defaultProjectId: string;
  defaultProviderId: string;
  defaultModelId: string;
  defaultPermissionMode: PermissionMode;
}

export interface SessionRecord {
  id: string;
  chatId: number;
  title: string;
  projectId: string;
  providerId: string;
  modelId: string;
  permissionMode: PermissionMode;
  sdkSessionId?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  totalCostUsd: number;
  totalTurns: number;
  sessionAllowedTools: string[];
  runtime?: Record<string, unknown>;
}

export interface EventRecord {
  id: number;
  sessionId: string;
  kind: string;
  summary: string;
  detail?: string;
  createdAt: string;
}

export interface WorkflowItem {
  sessionId: string;
  taskId: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner?: string;
  updatedAt: string;
}
