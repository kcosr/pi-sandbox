import { freezeBashCommandSets } from "./bash/command-set-contracts.js";
import { createHash } from "node:crypto";

import {
  COMMAND_CLASSES,
  type BashRequestClass,
  type CommandClass,
  type BashStageCoverage,
} from "./bash/contracts.js";
import { freezeCommandStages, validCommandStages } from "./command-set-evidence.js";
import { commandClassPolicy, freezeCommandClassPolicies, joinPolicies } from "./command-classes.js";
import type { ApprovalSubject, SubjectPolicy } from "./contracts.js";

import {
  canonicalizeJson,
  snapshotJsonObject,
  type JsonObject,
} from "../../packages/sandbox-extension/src/invocation.js";
export type { JsonObject, JsonValue } from "../../packages/sandbox-extension/src/invocation.js";

export type ApprovalPolicies = Readonly<Record<ApprovalSubject, SubjectPolicy>>;

export interface ResolvedSubjectPolicy {
  readonly policy: SubjectPolicy;
  readonly revision: string;
}
export type SubjectPolicyResolver = (subject: ApprovalSubject) => ResolvedSubjectPolicy | undefined;

const approvalRequestBrand: unique symbol = Symbol("ApprovalRequest");

export interface ApprovalRequest {
  readonly subject: ApprovalSubject;
  readonly display: string;
  readonly arguments: JsonObject;
  /** Analyzer result bound before approval; absent when the subject has no class policy. */
  readonly commandClass?: BashRequestClass;
  readonly commandStages?: readonly BashStageCoverage[];
  readonly fingerprint: string;
  readonly [approvalRequestBrand]: true;
}

export type ApprovalPromptDecision = "allow_once" | "allow_session" | "deny";

/** A tool-scope grant covers every request; a class-scope grant covers only that class. */
export type SessionGrantScope = "tool" | CommandClass;

export interface ApprovalPrompt {
  readonly request: ApprovalRequest;
  readonly allowForSession: boolean;
  readonly sessionGrantScope: SessionGrantScope;
}

export interface ApprovalUi {
  prompt(prompt: ApprovalPrompt, signal: AbortSignal): Promise<ApprovalPromptDecision>;
}

export interface EvaluateApprovalOptions {
  readonly ui?: ApprovalUi;
  readonly signal?: AbortSignal;
}

export type ApprovalDecision =
  | {
      readonly allowed: true;
      readonly source: "policy" | "prompt" | "session_grant";
      readonly reason: "policy_allowed" | "user_allowed" | "session_granted";
    }
  | {
      readonly allowed: false;
      readonly source: "policy" | "prompt";
      readonly reason:
        | "cancelled"
        | "disabled"
        | "invalid_prompt_decision"
        | "no_ui"
        | "policy_denied"
        | "prompt_error"
        | "user_denied";
    };

interface MutexWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

class CancelledError extends Error {
  public constructor() {
    super("Approval was cancelled");
    this.name = "CancelledError";
  }
}

class AsyncMutex {
  private locked = false;
  private readonly waiters: MutexWaiter[] = [];

  public acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      return Promise.reject(new CancelledError());
    }

    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.createRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: MutexWaiter =
        signal === undefined ? { resolve, reject } : { resolve, reject, signal };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
          }
          reject(new CancelledError());
        };
        Object.assign(waiter, { onAbort });
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return (): void => {
      if (released) {
        return;
      }
      released = true;
      this.advance();
    };
  }

  private advance(): void {
    const next = this.waiters.shift();
    if (next === undefined) {
      this.locked = false;
      return;
    }

    if (next.signal !== undefined && next.onAbort !== undefined) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    next.resolve(this.createRelease());
  }
}

export function prepareApprovalRequest(input: {
  readonly subject: ApprovalSubject;
  readonly display: string;
  readonly arguments: JsonObject;
  readonly commandClass?: BashRequestClass;
  readonly commandStages?: readonly BashStageCoverage[];
}): ApprovalRequest {
  if (input.display.length === 0) {
    throw new Error("Approval request display must not be empty");
  }
  const commandClass = input.commandClass;
  if (
    commandClass !== undefined &&
    commandClass !== "unclassified" &&
    commandClass !== "configured_command" &&
    !(COMMAND_CLASSES as readonly string[]).includes(commandClass)
  ) {
    throw new Error("Approval request command class is not recognized");
  }

  if (
    commandClass === "configured_command"
      ? input.subject !== "bash" || !validCommandStages(input.commandStages)
      : input.commandStages !== undefined
  ) {
    throw new Error("Approval request command evidence is invalid");
  }
  const commandStages =
    input.commandStages === undefined ? undefined : freezeCommandStages(input.commandStages);

  const argumentsCopy = snapshotJsonObject(input.arguments);
  return Object.freeze({
    subject: input.subject,
    display: input.display,
    arguments: argumentsCopy,
    ...(commandClass === undefined ? {} : { commandClass }),
    ...(commandStages === undefined ? {} : { commandStages }),
    fingerprint: requestFingerprint(
      input.subject,
      input.display,
      argumentsCopy,
      commandClass,
      commandStages,
    ),
    [approvalRequestBrand]: true as const,
  });
}

function requestFingerprint(
  subject: ApprovalSubject,
  display: string,
  arguments_: JsonObject,
  commandClass: BashRequestClass | undefined,
  commandStages?: readonly BashStageCoverage[],
): string {
  const fingerprintInput = canonicalizeJson(
    {
      version: 3,
      subject,
      display,
      arguments: arguments_,
      commandClass: commandClass ?? null,
      commandStages:
        commandStages === undefined
          ? null
          : commandStages.map((stage) => ({
              command: stage.command,
              knownReadOnly: stage.knownReadOnly,
              commandSets: [...stage.commandSets],
            })),
    },
    "request",
  );
  return createHash("sha256").update(fingerprintInput, "utf8").digest("hex");
}

interface EffectivePolicy {
  readonly policy: SubjectPolicy;
  readonly scope: SessionGrantScope;
}

export class PolicyEngine {
  private readonly resolveSubject: SubjectPolicyResolver;
  private readonly promptMutex = new AsyncMutex();
  private readonly sessionGrants = new Map<ApprovalSubject, Map<SessionGrantScope, string>>();
  private readonly subjectEpochs = new Map<ApprovalSubject, number>();
  private grantEpoch = 0;

  public constructor(policies: ApprovalPolicies, resolveDynamic?: SubjectPolicyResolver) {
    const fixed = freezePolicies(policies);
    this.resolveSubject = (subject) =>
      Object.hasOwn(fixed, subject)
        ? { policy: fixed[subject]!, revision: "static" }
        : resolveDynamic?.(subject);
  }

  public invalidateSubject(subject: ApprovalSubject): void {
    this.sessionGrants.delete(subject);
    this.subjectEpochs.set(subject, (this.subjectEpochs.get(subject) ?? 0) + 1);
  }

  private revision(subject: ApprovalSubject, resolved: ResolvedSubjectPolicy): string {
    return JSON.stringify([
      resolved.revision,
      this.grantEpoch,
      this.subjectEpochs.get(subject) ?? 0,
      resolved.policy.mode,
      resolved.policy.sessionGrant,
      resolved.policy.commandSets ?? null,
      COMMAND_CLASSES.map((commandClass) => {
        const policy = resolved.policy.commandClasses?.[commandClass];
        return policy === undefined ? null : [commandClass, policy.mode, policy.sessionGrant];
      }),
    ]);
  }

  private isCurrent(subject: ApprovalSubject, revision: string): boolean {
    const current = this.resolveSubject(subject);
    return current !== undefined && this.revision(subject, current) === revision;
  }

  public isEnabled(subject: ApprovalSubject): boolean {
    const policy = this.resolveSubject(subject)?.policy;
    return policy !== undefined && policy.mode !== "disabled";
  }

  /** Whether a current grant exists in exactly this scope; evaluation also accepts a tool grant for a class. */
  public hasSessionGrant(subject: ApprovalSubject, scope: SessionGrantScope = "tool"): boolean {
    const current = this.resolveSubject(subject);
    if (current === undefined) return false;
    const effective = effectivePolicy(current.policy, scope === "tool" ? undefined : scope);
    return (
      effective.scope === scope &&
      effective.policy.mode === "ask" &&
      this.sessionGrants.get(subject)?.get(scope) === this.revision(subject, current)
    );
  }

  public clearSessionGrants(): void {
    this.sessionGrants.clear();
    this.grantEpoch += 1;
  }

  public async evaluate(
    request: ApprovalRequest,
    options: EvaluateApprovalOptions = {},
  ): Promise<ApprovalDecision> {
    verifyPreparedRequest(request);

    if (options.signal?.aborted === true) {
      return denied("policy", "cancelled");
    }

    const resolved = this.resolveSubject(request.subject);
    if (resolved === undefined) {
      return denied("policy", "policy_denied");
    }
    const effective = effectivePolicy(resolved.policy, request.commandClass, request.commandStages);
    const revision = this.revision(request.subject, resolved);
    switch (effective.policy.mode) {
      case "allow":
        return { allowed: true, source: "policy", reason: "policy_allowed" };
      case "deny":
        return denied("policy", "policy_denied");
      case "disabled":
        return denied("policy", "disabled");
      case "ask":
        return this.evaluatePrompt(request, resolved.policy, effective, revision, options);
    }
  }

  private isCovered(
    subject: ApprovalSubject,
    main: SubjectPolicy,
    scope: SessionGrantScope,
    revision: string,
  ): boolean {
    const grants = this.sessionGrants.get(subject);
    return (
      grants !== undefined &&
      ((main.mode === "ask" && grants.get("tool") === revision) ||
        (scope !== "tool" && grants.get(scope) === revision))
    );
  }

  private async evaluatePrompt(
    request: ApprovalRequest,
    main: SubjectPolicy,
    effective: EffectivePolicy,
    revision: string,
    options: EvaluateApprovalOptions,
  ): Promise<ApprovalDecision> {
    const { policy, scope } = effective;
    if (this.isCovered(request.subject, main, scope, revision)) {
      return { allowed: true, source: "session_grant", reason: "session_granted" };
    }
    const ui = options.ui;
    if (ui === undefined) {
      return denied("prompt", "no_ui");
    }

    let release: (() => void) | undefined;
    try {
      release = await this.promptMutex.acquire(options.signal);
    } catch (error) {
      if (error instanceof CancelledError) {
        return denied("prompt", "cancelled");
      }
      return denied("prompt", "prompt_error");
    }

    if (options.signal?.aborted === true) {
      release();
      return denied("prompt", "cancelled");
    }
    if (!this.isCurrent(request.subject, revision)) {
      release();
      return denied("policy", "policy_denied");
    }
    if (this.isCovered(request.subject, main, scope, revision)) {
      release();
      return { allowed: true, source: "session_grant", reason: "session_granted" };
    }
    const promptPromise = Promise.resolve().then(() =>
      ui.prompt(
        Object.freeze({
          request,
          allowForSession: policy.sessionGrant === "offer",
          sessionGrantScope: scope,
        }),
        options.signal ?? new AbortController().signal,
      ),
    );

    let promptResult: ApprovalPromptDecision;
    try {
      promptResult = await raceCancellation(promptPromise, options.signal);
    } catch (error) {
      if (error instanceof CancelledError) {
        void promptPromise.finally(release).catch(() => undefined);
        release = undefined;
        return denied("prompt", "cancelled");
      }
      release();
      return denied("prompt", "prompt_error");
    } finally {
      release?.();
    }

    if (isCancelled(options.signal)) return denied("policy", "cancelled");
    if (!this.isCurrent(request.subject, revision)) return denied("policy", "policy_denied");
    switch (promptResult) {
      case "allow_once":
        return { allowed: true, source: "prompt", reason: "user_allowed" };
      case "deny":
        return denied("prompt", "user_denied");
      case "allow_session": {
        if (policy.sessionGrant !== "offer") {
          return denied("prompt", "invalid_prompt_decision");
        }
        const grants =
          this.sessionGrants.get(request.subject) ?? new Map<SessionGrantScope, string>();
        grants.set(scope, revision);
        this.sessionGrants.set(request.subject, grants);
        return { allowed: true, source: "prompt", reason: "user_allowed" };
      }
      default:
        return denied("prompt", "invalid_prompt_decision");
    }
  }
}

/** Classified requests use the join with their class policy; all others use the main policy. */
function effectivePolicy(
  policy: SubjectPolicy,
  commandClass: BashRequestClass | undefined,
  commandStages?: readonly BashStageCoverage[],
): EffectivePolicy {
  if (commandClass === "configured_command") {
    const builtin = commandClassPolicy(policy, "known_read_only");
    const builtinAllowed = builtin !== undefined && joinPolicies(policy, builtin).mode === "allow";
    const allowed =
      policy.mode !== "disabled" &&
      validCommandStages(commandStages) &&
      commandStages.every(
        (stage) =>
          stage.commandSets.some(
            (id) =>
              Object.hasOwn(policy.commandSets ?? {}, id) &&
              policy.commandSets![id]!.command === stage.command &&
              policy.commandSets![id]!.mode === "allow",
          ) ||
          (stage.knownReadOnly && builtinAllowed),
      );
    return { policy: allowed ? { mode: "allow", sessionGrant: "never" } : policy, scope: "tool" };
  }
  if (commandClass === undefined || commandClass === "unclassified")
    return { policy, scope: "tool" };
  const classPolicy = commandClassPolicy(policy, commandClass);
  return classPolicy === undefined || policy.mode === "disabled"
    ? { policy, scope: "tool" }
    : { policy: joinPolicies(policy, classPolicy), scope: commandClass };
}

function denied(
  source: "policy" | "prompt",
  reason: Extract<ApprovalDecision, { allowed: false }>["reason"],
): ApprovalDecision {
  return { allowed: false, source, reason };
}

function freezePolicies(policies: ApprovalPolicies): ApprovalPolicies {
  const copy = Object.fromEntries(
    Object.entries(policies).map(([subject, policy]) => {
      const commandClasses = freezeCommandClassPolicies(policy.commandClasses);
      const commandSets =
        policy.commandSets === undefined ? undefined : freezeBashCommandSets(policy.commandSets);
      return [
        subject,
        Object.freeze({
          ...policy,
          ...(commandClasses === undefined ? {} : { commandClasses }),
          ...(commandSets === undefined ? {} : { commandSets }),
        }),
      ];
    }),
  ) as Record<ApprovalSubject, SubjectPolicy>;
  return Object.freeze(copy);
}

function verifyPreparedRequest(request: ApprovalRequest): void {
  if (request[approvalRequestBrand] !== true || !Object.isFrozen(request)) {
    throw new Error("Approval request was not prepared by prepareApprovalRequest");
  }
  const expected = requestFingerprint(
    request.subject,
    request.display,
    request.arguments,
    request.commandClass,
    request.commandStages,
  );
  if (request.fingerprint !== expected) {
    throw new Error("Approval request fingerprint does not match its contents");
  }
}

async function raceCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    throw new CancelledError();
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new CancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function isCancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}
