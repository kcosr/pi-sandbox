import { TOOL_NAMES } from "../../packages/sandbox-extension/src/invocation.js";
import type { SubjectPolicy } from "../permissions/contracts.js";
export {
  TOOL_NAMES,
  type BuiltInToolName,
} from "../../packages/sandbox-extension/src/invocation.js";
export {
  COMMAND_CLASS_MODES,
  POLICY_MODES,
  SESSION_GRANT_POLICIES,
} from "../permissions/contracts.js";
export type {
  ToolName,
  ApprovalSubject,
  CommandClassMode,
  CommandClassPolicies,
  CommandClassPolicy,
  PolicyMode,
  SessionGrantPolicy,
  SubjectPolicy,
} from "../permissions/contracts.js";
import type { CodeModeConfig, McpConfig, McpServerOverride } from "./mcp.js";

import { buildLayout } from "../build-layout/index.js";

export const IDENTITY_BROKER_SOCKET_PATH = buildLayout.identitySocketPath;

import type { NetworkMode } from "../../packages/sandbox-extension/src/runtime/contracts.js";
export {
  NETWORK_MODES,
  type NetworkMode,
} from "../../packages/sandbox-extension/src/runtime/contracts.js";

export interface NetworkConfig {
  readonly mode: NetworkMode;
}

export const EXECUTION_BACKENDS = Object.freeze(["bubblewrap", "direct", "seatbelt"] as const);

export type ExecutionBackend = (typeof EXECUTION_BACKENDS)[number];

export interface FilesystemConfig {
  readonly cwdWritable: boolean;
  readonly hiddenPaths: readonly string[];
  readonly deniedPaths: readonly string[];
}

export const WORKSPACE_MODES = Object.freeze(["read_only", "read_write"] as const);
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export interface AdministrativeFilesystemConfig {
  readonly cwdDefault: WorkspaceMode;
  readonly cwdAllowed: readonly WorkspaceMode[];
  readonly hiddenPaths: readonly string[];
  readonly deniedPaths: readonly string[];
}

/** The mode is selected once, after all administrative identity overrides. */
export interface WorkspaceSelection {
  readonly mode: WorkspaceMode;
  readonly default: WorkspaceMode;
  readonly allowed: readonly WorkspaceMode[];
  readonly source: "default" | "flag";
}

export interface WorkspaceApprovalPolicy extends SubjectPolicy {
  readonly mode: Exclude<SubjectPolicy["mode"], "disabled">;
}

export interface WorkspaceToolPolicy {
  readonly enabled: boolean;
  readonly audit: boolean;
  readonly readOnly: WorkspaceApprovalPolicy;
  readonly readWrite: WorkspaceApprovalPolicy;
}

export interface WorkspaceToolOverride {
  readonly enabled?: boolean;
  readonly readOnly?: WorkspaceApprovalPolicy;
  readonly readWrite?: WorkspaceApprovalPolicy;
}

/** Compiled TOOL_NAMES determines which shape is permitted for a tool. */
export type AdministrativeToolPolicies = Readonly<Record<string, WorkspaceToolPolicy | ToolPolicy>>;

export interface ExecutionConfig {
  readonly backend: ExecutionBackend;
  readonly maximumTimeoutMs?: number;
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
  readonly execution?: Pick<ExecutionConfig, "backend">;
  readonly network?: NetworkConfig;
  readonly filesystem?: Partial<Pick<AdministrativeFilesystemConfig, "cwdDefault" | "cwdAllowed">>;
  readonly mcp?: {
    readonly servers: Readonly<Record<string, McpServerOverride>>;
  };
  readonly tools: Readonly<Partial<Record<string, SubjectPolicy | WorkspaceToolOverride>>>;
}

export type EnvironmentVariables = Readonly<Record<string, string>>;

export interface EnvironmentFileReference {
  readonly file: string;
}

/** File contents cross the broker boundary without becoming expandable templates. */
export interface LiteralEnvironmentValue {
  readonly literal: string;
}

export type AuthoredPiEnvironmentValue = string | EnvironmentFileReference;
export type ResolvedPiEnvironmentValue = string | LiteralEnvironmentValue;
export type PendingPiEnvironmentValue = AuthoredPiEnvironmentValue | LiteralEnvironmentValue;

export interface ManagedEnvironment<PiValue = string> {
  readonly pi: Readonly<Record<string, PiValue>>;
  readonly sandbox: EnvironmentVariables;
  readonly extensions: Readonly<Record<string, EnvironmentVariables>>;
}

export interface CommonConfig<PiValue = string> {
  readonly configVersion: 14;
  readonly codemode: CodeModeConfig;
  readonly mcp: McpConfig;
  readonly audit: AuditConfig;
  readonly sessions: SessionsConfig;
  readonly modelsFile: string;
  readonly execution: ExecutionConfig;
  readonly identity: IdentityConfig;
  readonly network: NetworkConfig;
  readonly environment: ManagedEnvironment<PiValue>;
  readonly extensions: Readonly<Record<string, ExtensionConfig>>;
}

export interface AdministrativeConfig<PiValue = string> extends CommonConfig<PiValue> {
  readonly filesystem: AdministrativeFilesystemConfig;
  readonly tools: AdministrativeToolPolicies;
}

export interface SandboxConfig<PiValue = string> extends CommonConfig<PiValue> {
  readonly filesystem: FilesystemConfig;
  readonly tools: ToolPolicies;
  readonly workspace: WorkspaceSelection;
}

export function isToolName(value: string, toolNames: readonly string[] = TOOL_NAMES): boolean {
  return toolNames.includes(value);
}
