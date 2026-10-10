import { createHash } from "node:crypto";

import type { ApprovalSubject, SubjectPolicy } from "./contracts.js";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

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
  readonly fingerprint: string;
  readonly [approvalRequestBrand]: true;
}

export type ApprovalPromptDecision = "allow_once" | "allow_session" | "deny";

export interface ApprovalPrompt {
  readonly request: ApprovalRequest;
  readonly allowForSession: boolean;
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
}): ApprovalRequest {
  if (input.display.length === 0) {
    throw new Error("Approval request display must not be empty");
  }

  const canonicalArguments = canonicalizeJson(input.arguments, "arguments");
  const argumentsCopy = JSON.parse(canonicalArguments) as JsonObject;
  deepFreeze(argumentsCopy);

  const fingerprintInput = canonicalizeJson(
    {
      version: 1,
      subject: input.subject,
      display: input.display,
      arguments: argumentsCopy,
    },
    "request",
  );
  const fingerprint = createHash("sha256").update(fingerprintInput, "utf8").digest("hex");

  return Object.freeze({
    subject: input.subject,
    display: input.display,
    arguments: argumentsCopy,
    fingerprint,
    [approvalRequestBrand]: true as const,
  });
}

export class PolicyEngine {
  private readonly resolveSubject: SubjectPolicyResolver;
  private readonly promptMutex = new AsyncMutex();
  private readonly sessionGrants = new Map<ApprovalSubject, string>();
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

  public hasSessionGrant(subject: ApprovalSubject): boolean {
    const current = this.resolveSubject(subject);
    return (
      current !== undefined &&
      current.policy.mode === "ask" &&
      this.sessionGrants.get(subject) === this.revision(subject, current)
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
    const policy = resolved.policy;
    const revision = this.revision(request.subject, resolved);
    switch (policy.mode) {
      case "allow":
        return { allowed: true, source: "policy", reason: "policy_allowed" };
      case "deny":
        return denied("policy", "policy_denied");
      case "disabled":
        return denied("policy", "disabled");
      case "ask":
        return this.evaluatePrompt(request, policy, revision, options);
    }
  }

  private async evaluatePrompt(
    request: ApprovalRequest,
    policy: SubjectPolicy,
    revision: string,
    options: EvaluateApprovalOptions,
  ): Promise<ApprovalDecision> {
    if (this.hasSessionGrant(request.subject)) {
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
    if (this.hasSessionGrant(request.subject)) {
      release();
      return { allowed: true, source: "session_grant", reason: "session_granted" };
    }
    const promptPromise = Promise.resolve().then(() =>
      ui.prompt(
        Object.freeze({
          request,
          allowForSession: policy.sessionGrant === "offer",
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
      case "allow_session":
        if (policy.sessionGrant !== "offer") {
          return denied("prompt", "invalid_prompt_decision");
        }
        this.sessionGrants.set(request.subject, revision);
        return { allowed: true, source: "prompt", reason: "user_allowed" };
      default:
        return denied("prompt", "invalid_prompt_decision");
    }
  }
}

function denied(
  source: "policy" | "prompt",
  reason: Extract<ApprovalDecision, { allowed: false }>["reason"],
): ApprovalDecision {
  return { allowed: false, source, reason };
}

function freezePolicies(policies: ApprovalPolicies): ApprovalPolicies {
  const copy = Object.fromEntries(
    Object.entries(policies).map(([subject, policy]) => [subject, Object.freeze({ ...policy })]),
  ) as Record<ApprovalSubject, SubjectPolicy>;
  return Object.freeze(copy);
}

function verifyPreparedRequest(request: ApprovalRequest): void {
  if (request[approvalRequestBrand] !== true || !Object.isFrozen(request)) {
    throw new Error("Approval request was not prepared by prepareApprovalRequest");
  }
  const expected = createHash("sha256")
    .update(
      canonicalizeJson(
        {
          version: 1,
          subject: request.subject,
          display: request.display,
          arguments: request.arguments,
        },
        "request",
      ),
      "utf8",
    )
    .digest("hex");
  if (request.fingerprint !== expected) {
    throw new Error("Approval request fingerprint does not match its contents");
  }
}

function canonicalizeJson(value: JsonValue, path: string, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error(`${path} contains a non-JSON value`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${path} contains a cycle`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value as readonly JsonValue[];
      return `[${items.map((item, index) => canonicalizeJson(item, `${path}[${index}]`, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    const object = value as JsonObject;
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeJson(object[key] as JsonValue, `${path}.${key}`, ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze(value: JsonValue): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  Object.freeze(value);
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
