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
import type { SubagentsConfig } from "./subagents.js";

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

export interface ExecutionConfig {
  readonly backend: ExecutionBackend;
  readonly maximumTimeoutMs?: number;
  /** Main-policy command lookup prefixes; never selected by user/group overrides. */
  readonly commandPathPrepend?: readonly string[];
}

export interface ToolPolicy extends SubjectPolicy {
  readonly audit: boolean;
}

export interface AuditConfig {
  readonly enabled: boolean;
}
export interface ModelAuthConfig {
  readonly personalProviders: readonly string[];
}

export interface ExportsConfig {
  readonly enabled: boolean;
}

export interface SkillsConfig {
  readonly directories: readonly string[];
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

export interface AccountOverrides {
  readonly workspace?: WorkspaceOverrides;
  readonly execution?: Pick<ExecutionConfig, "backend">;
  readonly network?: NetworkConfig;
  readonly filesystem?: Pick<FilesystemConfig, "cwdWritable">;
  readonly mcp?: {
    readonly servers: Readonly<Record<string, McpServerOverride>>;
  };
  readonly tools: Readonly<Partial<Record<string, Omit<SubjectPolicy, "commandSets">>>>;
}

export type EnvironmentVariables = Readonly<Record<string, string>>;

export interface EnvironmentFileReference {
  readonly file: string;
}

/** File contents cross the source boundary without becoming expandable templates. */
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

export interface SandboxConfig<PiValue = string> {
  readonly configVersion: 16;
  /** Administrator-authored prompt additions, keyed by optional extension ID. */
  readonly extensionGuidance?: Readonly<Record<string, string>>;
  readonly subagents?: SubagentsConfig;
  readonly codemode: CodeModeConfig;
  readonly mcp: McpConfig;
  readonly audit: AuditConfig;
  readonly sessions: SessionsConfig;
  readonly exports: ExportsConfig;
  readonly skills: SkillsConfig;
  readonly execution: ExecutionConfig;
  readonly modelAuth: ModelAuthConfig;
  readonly network: NetworkConfig;
  readonly filesystem: FilesystemConfig;
  readonly environment: ManagedEnvironment<PiValue>;
  readonly extensions: Readonly<Record<string, ExtensionConfig>>;
  readonly tools: ToolPolicies;
}

export interface WorkspaceOverrides {
  readonly allowed?: readonly string[];
  readonly default?: string;
}

export interface WorkspaceMode<PiValue = string> {
  readonly description?: string;
  readonly config: SandboxConfig<PiValue>;
}

/** All authored modes are complete and validated before identity resolution. */
export interface AuthoredSandboxConfig<PiValue = string> {
  readonly workspace: {
    readonly default: string;
    readonly allowed: readonly string[];
    readonly modes: Readonly<Record<string, WorkspaceMode<PiValue>>>;
  };
}

export interface WorkspaceModeSummary {
  readonly name: string;
  readonly description?: string;
}

export interface WorkspaceAccess {
  readonly default: string;
  readonly allowed: readonly WorkspaceModeSummary[];
}

export interface WorkspaceSelection extends WorkspaceModeSummary {
  readonly source: "cli" | "default";
}

export function isToolName(value: string, toolNames: readonly string[] = TOOL_NAMES): boolean {
  return toolNames.includes(value);
}
