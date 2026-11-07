export const SUBAGENTS_POLICY_SUBJECT = "subagents";

/** Application-owned operations; these names are never external extension slots. */
export const SUBAGENT_TOOL_NAMES = Object.freeze([
  "spawn_agent",
  "steer_agent",
  "cancel_agent",
  "resume_agent",
  "inspect_agent",
] as const);

/** Several operations share one administrator approval policy and session grant. */
export function managedToolPolicySubject(name: string): string {
  return SUBAGENT_TOOL_NAMES.some((tool) => tool === name) ? SUBAGENTS_POLICY_SUBJECT : name;
}

export function policyToolNames(subject: string): readonly string[] {
  return subject === SUBAGENTS_POLICY_SUBJECT ? SUBAGENT_TOOL_NAMES : [subject];
}

export interface SubagentsConfig {
  readonly enabled: boolean;
  readonly maxConcurrent: number;
  readonly maxTotal: number;
}
