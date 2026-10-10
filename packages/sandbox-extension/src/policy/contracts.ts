export const TOOL_NAMES = Object.freeze([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "bash",
] as const);

export type BuiltInToolName = (typeof TOOL_NAMES)[number];

/** Model-visible registered tool name, including build-selected extension tools. */
export type ToolName = string;

export type ApprovalSubject = string;

export const POLICY_MODES = Object.freeze(["allow", "ask", "deny", "disabled"] as const);

export type PolicyMode = (typeof POLICY_MODES)[number];

export const SESSION_GRANT_POLICIES = Object.freeze(["never", "offer"] as const);

export type SessionGrantPolicy = (typeof SESSION_GRANT_POLICIES)[number];

export interface SubjectPolicy {
  readonly mode: PolicyMode;
  readonly sessionGrant: SessionGrantPolicy;
}
