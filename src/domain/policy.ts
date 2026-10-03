export const TOOL_NAMES = Object.freeze([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "bash",
] as const);

import { buildLayout } from "../build-layout/index.js";

export const IDENTITY_BROKER_SOCKET_PATH = buildLayout.identitySocketPath;

export type BuiltInToolName = (typeof TOOL_NAMES)[number];

/** Model-visible registered tool name, including build-selected extension tools. */
export type ToolName = string;

export type ApprovalSubject = string;

export const POLICY_MODES = Object.freeze(["allow", "ask", "deny", "disabled"] as const);

export type PolicyMode = (typeof POLICY_MODES)[number];

export const SESSION_GRANT_POLICIES = Object.freeze(["never", "offer"] as const);

export type SessionGrantPolicy = (typeof SESSION_GRANT_POLICIES)[number];

export const NETWORK_MODES = Object.freeze(["none", "host"] as const);

export type NetworkMode = (typeof NETWORK_MODES)[number];

export interface NetworkConfig {
  readonly mode: NetworkMode;
}

export const EXECUTION_BACKENDS = Object.freeze(["bubblewrap", "direct"] as const);

export type ExecutionBackend = (typeof EXECUTION_BACKENDS)[number];

export interface FilesystemConfig {
  readonly cwdWritable: boolean;
  readonly hiddenPaths: readonly string[];
}

export interface ExecutionConfig {
  readonly backend: ExecutionBackend;
}

export interface SubjectPolicy {
  readonly mode: PolicyMode;
  readonly sessionGrant: SessionGrantPolicy;
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
  readonly execution?: ExecutionConfig;
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
  readonly configVersion: 7;
  readonly audit: AuditConfig;
  readonly modelsFile: string;
  readonly execution: ExecutionConfig;
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
