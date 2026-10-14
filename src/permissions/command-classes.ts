import { COMMAND_CLASSES, type BashRequestClass, type CommandClass } from "./bash/contracts.js";
import type {
  CommandClassPolicy,
  CommandClassPolicies,
  SessionGrantPolicy,
  SubjectPolicy,
} from "./contracts.js";

/** Command classes refine only the model tool whose input the analyzer understands. */
export const COMMAND_CLASS_TOOL = "bash";

/** Skipping a class prompt is justified only when these tools can already observe the same data. */
const ALLOW_REQUIRES_ALLOWED_TOOLS: Readonly<Record<CommandClass, readonly string[]>> =
  Object.freeze({ known_read_only: Object.freeze(["read", "grep", "find", "ls"]) });

const MODE_RANK = Object.freeze({ deny: 0, ask: 1, allow: 2 });

interface RankedPolicy {
  readonly mode: keyof typeof MODE_RANK;
  readonly sessionGrant: SessionGrantPolicy;
}

export type CommandClassPolicyViolation = "main_disabled" | "not_more_permissive";

export function hasCommandClassPolicies(policy: SubjectPolicy | undefined): boolean {
  return COMMAND_CLASSES.some(
    (commandClass) => policy?.commandClasses?.[commandClass] !== undefined,
  );
}

export function commandClassPolicy(
  policy: SubjectPolicy,
  commandClass: BashRequestClass | undefined,
): CommandClassPolicy | undefined {
  if (commandClass === undefined || commandClass === "unclassified") return undefined;
  return policy.commandClasses?.[commandClass];
}

/** Greater mode and greater session option, offered only when the joined mode prompts. */
export function joinPolicies(main: SubjectPolicy, commandClass: CommandClassPolicy): SubjectPolicy {
  if (main.mode === "disabled") return main;
  const mode = MODE_RANK[commandClass.mode] > MODE_RANK[main.mode] ? commandClass.mode : main.mode;
  const offered = main.sessionGrant === "offer" || commandClass.sessionGrant === "offer";
  return Object.freeze({ mode, sessionGrant: mode === "ask" && offered ? "offer" : "never" });
}

export function isStrictlyMorePermissive(candidate: RankedPolicy, base: RankedPolicy): boolean {
  return (
    MODE_RANK[candidate.mode] > MODE_RANK[base.mode] ||
    (candidate.mode === "ask" &&
      base.mode === "ask" &&
      candidate.sessionGrant === "offer" &&
      base.sessionGrant === "never")
  );
}

/** A class policy that is not strictly more permissive could be escaped by unclassifying a command. */
export function commandClassPolicyViolation(
  main: Pick<SubjectPolicy, "mode" | "sessionGrant">,
  commandClass: CommandClassPolicy,
): CommandClassPolicyViolation | undefined {
  if (main.mode === "disabled") return "main_disabled";
  return isStrictlyMorePermissive(commandClass, {
    mode: main.mode,
    sessionGrant: main.sessionGrant,
  })
    ? undefined
    : "not_more_permissive";
}

/** Class `allow` preconditions on the complete effective tool policy map. */
export function commandClassPreconditionIssues(
  tools: Readonly<Record<string, SubjectPolicy | undefined>>,
  prefix: string,
): string[] {
  const issues: string[] = [];
  const classes = tools[COMMAND_CLASS_TOOL]?.commandClasses;
  for (const commandClass of COMMAND_CLASSES) {
    if (classes?.[commandClass]?.mode !== "allow") continue;
    for (const tool of ALLOW_REQUIRES_ALLOWED_TOOLS[commandClass]) {
      const mode = tools[tool]?.mode;
      if (mode === "allow") continue;
      issues.push(
        `${prefix}.${COMMAND_CLASS_TOOL}.${commandClass}.mode "allow" requires ${prefix}.${tool}.mode "allow" (it is ${mode === undefined ? "not configured" : `"${mode}"`})`,
      );
    }
  }
  return issues;
}

export function commandClassAllowRequirements(commandClass: CommandClass): readonly string[] {
  return ALLOW_REQUIRES_ALLOWED_TOOLS[commandClass];
}

export function freezeCommandClassPolicies(
  policies: CommandClassPolicies | undefined,
): CommandClassPolicies | undefined {
  if (policies === undefined) return undefined;
  const frozen: Partial<Record<CommandClass, CommandClassPolicy>> = {};
  for (const commandClass of COMMAND_CLASSES) {
    const policy = policies[commandClass];
    if (policy !== undefined)
      frozen[commandClass] = Object.freeze({
        mode: policy.mode,
        sessionGrant: policy.sessionGrant,
      });
  }
  return Object.keys(frozen).length === 0 ? undefined : Object.freeze(frozen);
}
