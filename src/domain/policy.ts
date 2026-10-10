import { TOOL_NAMES } from "../../packages/sandbox-extension/src/invocation.js";
import type { SubjectPolicy } from "../permissions/contracts.js";
export {
  TOOL_NAMES,
  type BuiltInToolName,
} from "../../packages/sandbox-extension/src/invocation.js";
export { POLICY_MODES, SESSION_GRANT_POLICIES } from "../permissions/contracts.js";
export type {
  ToolName,
  ApprovalSubject,
  PolicyMode,
  SessionGrantPolicy,
  SubjectPolicy,
} from "../permissions/contracts.js";
import type { CodeModeConfig, McpConfig } from "./mcp.js";

import { buildLayout } from "../build-layout/index.js";

export const IDENTITY_BROKER_SOCKET_PATH = buildLayout.identitySocketPath;

import type {
  NetworkMode,
  ProcessLifetime,
} from "../../packages/sandbox-extension/src/runtime/contracts.js";
export {
  NETWORK_MODES,
  PROCESS_LIFETIMES,
  type NetworkMode,
  type ProcessLifetime,
} from "../../packages/sandbox-extension/src/runtime/contracts.js";

export interface NetworkConfig {
  readonly mode: NetworkMode;
}

export const EXECUTION_BACKENDS = Object.freeze(["bubblewrap", "direct", "smolvm"] as const);

export type ExecutionBackend = (typeof EXECUTION_BACKENDS)[number];

export interface FilesystemConfig {
  readonly cwdWritable: boolean;
  readonly hiddenPaths: readonly string[];
}

export interface ExecutionConfig {
  readonly backend: ExecutionBackend;
  readonly processLifetime: ProcessLifetime;
}

export interface SmolvmConfig {
  readonly image: string;
  readonly imageSha256: string;
  readonly stateDirectory: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly storageGiB: number;
  readonly overlayGiB: number;
}

export interface ToolPolicy extends SubjectPolicy {
  readonly audit: boolean;
}

export const AUDIT_FACILITIES = Object.freeze([
  "local0",
  "local1",
  "local2",
  "local3",
  "local4",
  "local5",
  "local6",
  "local7",
] as const);
export type AuditFacility = (typeof AUDIT_FACILITIES)[number];
export interface AuditConfig {
  readonly enabled: boolean;
  readonly facility: AuditFacility;
}

export interface SessionsConfig {
  readonly retentionDays: number;
}

export type ToolPolicies = Readonly<Record<string, ToolPolicy>>;

export interface ExtensionConfig {
  readonly id: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly toolNames: readonly string[];
}

export interface DisabledIdentityConfig {
  readonly mode: "disabled";
}

export interface BrokerIdentityConfig {
  readonly mode: "broker";
}

export type IdentityConfig = DisabledIdentityConfig | BrokerIdentityConfig;

export interface IdentityOverrides {
  readonly modelsFile?: string;
  readonly execution?: Partial<ExecutionConfig>;
  readonly network?: NetworkConfig;
  readonly filesystem?: Pick<FilesystemConfig, "cwdWritable">;
  readonly tools: Readonly<Partial<Record<string, SubjectPolicy>>>;
}

export type EnvironmentVariables = Readonly<Record<string, string>>;

export interface ManagedEnvironment {
  readonly pi: EnvironmentVariables;
  readonly sandbox: EnvironmentVariables;
  readonly extensions: Readonly<Record<string, EnvironmentVariables>>;
}

export interface SandboxConfig {
  readonly configVersion: 11;
  readonly codemode: CodeModeConfig;
  readonly mcp: McpConfig;
  readonly audit: AuditConfig;
  readonly sessions: SessionsConfig;
  readonly modelsFile: string;
  readonly execution: ExecutionConfig;
  readonly smolvm?: SmolvmConfig;
  readonly identity: IdentityConfig;
  readonly network: NetworkConfig;
  readonly filesystem: FilesystemConfig;
  readonly environment: ManagedEnvironment;
  readonly extensions: Readonly<Record<string, ExtensionConfig>>;
  readonly tools: ToolPolicies;
}

export function isToolName(value: string, toolNames: readonly string[] = TOOL_NAMES): boolean {
  return toolNames.includes(value);
}
