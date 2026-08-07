import type { PermissionMode, PermissionResult, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { EffortSetting } from "./agent/efficiency.js";

export interface WorkerTurnRequest {
  runId: string;
  chatId: number;
  userId: number;
  sessionId: string;
  projectId: string;
  projectPath: string;
  additionalDirectories: string[];
  model: string;
  permissionMode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  settingSources: SettingSource[];
  autoAllowReadTools: boolean;
  systemPromptAppend?: string;
  title: string;
  effort: EffortSetting;
  maxTurns: number;
  maxBudgetUsd?: number;
  sdkSessionId?: string;
  providerProxyUrl: string;
  passEnv: string[];
}

export type WorkerStreamEnvelope =
  | { type: "sdk"; message: Record<string, unknown> }
  | { type: "stderr"; data: string }
  | { type: "error"; message: string }
  | { type: "done" };

export interface WorkerPermissionRequest {
  chatId: number;
  userId: number;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  autoAllowReadTools: boolean;
  allowedRoots: string[];
  decisionReason?: string;
  blockedPath?: string;
}

export interface WorkerPermissionResponse {
  result: PermissionResult;
}

export interface WorkerSettingsFile {
  path: string;
  content: string;
}

export interface WorkerSettingsResponse {
  projectId: string;
  home: string;
  workspace: string;
  files: WorkerSettingsFile[];
}
