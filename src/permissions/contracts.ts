import type { CommandClass } from "./bash/contracts.js";

export {
  TOOL_NAMES,
  type BuiltInToolName,
} from "../../packages/sandbox-extension/src/invocation.js";

/** Model-visible registered tool name, including build-selected extension tools. */
export type ToolName = string;

export type ApprovalSubject = string;

export const POLICY_MODES = Object.freeze(["allow", "ask", "deny", "disabled"] as const);

export type PolicyMode = (typeof POLICY_MODES)[number];

export const SESSION_GRANT_POLICIES = Object.freeze(["never", "offer"] as const);

export type SessionGrantPolicy = (typeof SESSION_GRANT_POLICIES)[number];

/** Availability is tool-level only, so a command class cannot be disabled. */
export const COMMAND_CLASS_MODES = Object.freeze(["allow", "ask", "deny"] as const);

export type CommandClassMode = (typeof COMMAND_CLASS_MODES)[number];

export interface CommandClassPolicy {
  readonly mode: CommandClassMode;
  readonly sessionGrant: SessionGrantPolicy;
}

export type CommandClassPolicies = Readonly<Partial<Record<CommandClass, CommandClassPolicy>>>;

export interface SubjectPolicy {
  readonly mode: PolicyMode;
  readonly sessionGrant: SessionGrantPolicy;
  /** Present only when non-empty; every entry is strictly more permissive than the main policy. */
  readonly commandClasses?: CommandClassPolicies;
}
