import type { ApprovalSubject, SubjectPolicy } from "./contracts.js";
import { describe, expect, it, vi } from "vitest";
import {
  prepareSandboxToolRequest,
  type JsonObject,
} from "../../packages/sandbox-extension/src/invocation.js";
import {
  PolicyEngine,
  prepareApprovalRequest,
  type ApprovalPrompt,
  type ApprovalPromptDecision,
  type ApprovalUi,
} from "./index.js";

const allow: SubjectPolicy = { mode: "allow", sessionGrant: "never" };

function policies(overrides: Readonly<Record<string, SubjectPolicy>> = {}) {
  const base = Object.fromEntries(
    ["read", "grep", "find", "ls", "write", "edit", "bash"].map((subject) => [subject, allow]),
  ) as Record<ApprovalSubject, SubjectPolicy>;
  return { ...base, ...overrides };
}

function request(subject: ApprovalSubject = "bash") {
  return prepareApprovalRequest({
    subject,
    display: subject === "bash" ? "Run: printf ok" : `Invoke ${subject}`,
    arguments: { command: "printf ok", nested: { z: true, a: [1, null] } },
  });
}

class RecordingUi implements ApprovalUi {
  public readonly prompts: ApprovalPrompt[] = [];

  public constructor(
    private readonly decide: (
      prompt: ApprovalPrompt,
      signal: AbortSignal,
    ) => Promise<ApprovalPromptDecision> | ApprovalPromptDecision,
  ) {}

  public async prompt(
    prompt: ApprovalPrompt,
    signal: AbortSignal,
  ): Promise<ApprovalPromptDecision> {
    this.prompts.push(prompt);
    return this.decide(prompt, signal);
  }
}

describe("prepareApprovalRequest", () => {
  it("preserves the sandbox's approved JSON values in the private managed copy", async () => {
    const sandbox = prepareSandboxToolRequest(
      "write",
      JSON.parse('{"__proto__":{"value":-0},"path":"/work/file","values":[-0,true]}') as JsonObject,
    );
    const managed = prepareApprovalRequest({ ...sandbox, display: "Write /work/file" });
    expect(managed.arguments).toStrictEqual(sandbox.arguments);
    expect(managed.arguments).not.toBe(sandbox.arguments);
    expect(Object.hasOwn(managed.arguments, "__proto__")).toBe(true);
    expect(Object.isFrozen(managed.arguments.__proto__)).toBe(true);
    await expect(new PolicyEngine(policies()).evaluate(managed)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("creates a deterministic fingerprint and an immutable argument snapshot", () => {
    const args = { b: 2, a: { value: "before" } };
    const prepared = prepareApprovalRequest({
      subject: "write",
      display: "Write file",
      arguments: args,
    });
    args.a.value = "after";

    const equivalent = prepareApprovalRequest({
      subject: "write",
      display: "Write file",
      arguments: { a: { value: "before" }, b: 2 },
    });
    expect(prepared.fingerprint).toBe(equivalent.fingerprint);
    expect(prepared.arguments).toEqual({ a: { value: "before" }, b: 2 });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.arguments.a)).toBe(true);
  });

  it("binds the fingerprint to the subject and exact display", () => {
    const args = { path: "file.txt" };
    const first = prepareApprovalRequest({
      subject: "read",
      display: "Read file.txt",
      arguments: args,
    });
    const second = prepareApprovalRequest({
      subject: "write",
      display: "Write file.txt",
      arguments: args,
    });
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("rejects empty displays and non-JSON arguments", () => {
    expect(() => prepareApprovalRequest({ subject: "read", display: "", arguments: {} })).toThrow(
      "must not be empty",
    );
    expect(() =>
      prepareApprovalRequest({
        subject: "read",
        display: "Read",
        arguments: { value: Number.NaN },
      }),
    ).toThrow("non-finite");
  });
});

describe("PolicyEngine", () => {
  it.each([
    ["allow", true, "policy_allowed"],
    ["deny", false, "policy_denied"],
    ["disabled", false, "disabled"],
  ] as const)("applies %s without showing UI", async (mode, allowed, reason) => {
    const ui = new RecordingUi(() => "deny");
    const engine = new PolicyEngine(policies({ bash: { mode, sessionGrant: "offer" } }));
    await expect(engine.evaluate(request(), { ui })).resolves.toMatchObject({ allowed, reason });
    expect(ui.prompts).toHaveLength(0);
    expect(engine.isEnabled("bash")).toBe(mode !== "disabled");
  });

  it("fails closed when ask has no UI, the prompt fails, or the user denies", async () => {
    const engine = new PolicyEngine(policies({ bash: { mode: "ask", sessionGrant: "never" } }));
    await expect(engine.evaluate(request())).resolves.toMatchObject({
      allowed: false,
      reason: "no_ui",
    });
    await expect(
      engine.evaluate(request(), {
        ui: new RecordingUi(() => Promise.reject(new Error("lost UI"))),
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "prompt_error" });
    await expect(
      engine.evaluate(request(), { ui: new RecordingUi(() => "deny") }),
    ).resolves.toMatchObject({ allowed: false, reason: "user_denied" });
  });

  it("offers session grants only when configured and rejects an invalid UI response", async () => {
    const neverUi = new RecordingUi(() => "allow_session");
    const neverEngine = new PolicyEngine(
      policies({ bash: { mode: "ask", sessionGrant: "never" } }),
    );
    await expect(neverEngine.evaluate(request(), { ui: neverUi })).resolves.toMatchObject({
      allowed: false,
      reason: "invalid_prompt_decision",
    });
    expect(neverUi.prompts[0]?.allowForSession).toBe(false);
    expect(neverEngine.hasSessionGrant("bash")).toBe(false);

    const offerUi = new RecordingUi(() => "allow_session");
    const offerEngine = new PolicyEngine(
      policies({ bash: { mode: "ask", sessionGrant: "offer" } }),
    );
    await expect(offerEngine.evaluate(request(), { ui: offerUi })).resolves.toMatchObject({
      allowed: true,
      source: "prompt",
    });
    expect(offerUi.prompts[0]?.allowForSession).toBe(true);
    expect(offerEngine.hasSessionGrant("bash")).toBe(true);
    await expect(offerEngine.evaluate(request(), { ui: offerUi })).resolves.toMatchObject({
      allowed: true,
      source: "session_grant",
    });
    expect(offerUi.prompts).toHaveLength(1);
  });

  it("clears all model-tool session grants", async () => {
    const ui = new RecordingUi(() => "allow_session");
    const engine = new PolicyEngine(policies({ bash: { mode: "ask", sessionGrant: "offer" } }));
    await engine.evaluate(request("bash"), { ui });
    expect(engine.hasSessionGrant("bash")).toBe(true);
    expect(ui.prompts).toHaveLength(1);

    engine.clearSessionGrants();
    expect(engine.hasSessionGrant("bash")).toBe(false);
  });

  it("scopes session grants to the exact approval subject", async () => {
    const ui = new RecordingUi(() => "allow_session");
    const engine = new PolicyEngine(
      policies({
        git_clone: { mode: "ask", sessionGrant: "offer" },
        service_api: { mode: "ask", sessionGrant: "never" },
      }),
    );

    await expect(engine.evaluate(request("git_clone"), { ui })).resolves.toMatchObject({
      allowed: true,
      source: "prompt",
    });
    expect(engine.hasSessionGrant("git_clone")).toBe(true);
    expect(engine.hasSessionGrant("service_api")).toBe(false);
    await expect(engine.evaluate(request("git_clone"), { ui })).resolves.toMatchObject({
      allowed: true,
      source: "session_grant",
    });
    await expect(engine.evaluate(request("service_api"))).resolves.toMatchObject({
      allowed: false,
      reason: "no_ui",
    });
  });

  it("fails closed for an approval subject absent from the configured policy map", async () => {
    const ui = new RecordingUi(() => "allow_once");
    const engine = new PolicyEngine(policies());

    expect(engine.isEnabled("unconfigured_extension_tool")).toBe(false);
    expect(engine.hasSessionGrant("unconfigured_extension_tool")).toBe(false);
    await expect(engine.evaluate(request("unconfigured_extension_tool"), { ui })).resolves.toEqual({
      allowed: false,
      source: "policy",
      reason: "policy_denied",
    });
    expect(ui.prompts).toHaveLength(0);
  });

  it("serializes prompts and lets a queued request consume the first session grant", async () => {
    let resolveFirst: ((decision: ApprovalPromptDecision) => void) | undefined;
    const ui = new RecordingUi(
      () =>
        new Promise<ApprovalPromptDecision>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const engine = new PolicyEngine(policies({ bash: { mode: "ask", sessionGrant: "offer" } }));
    const first = engine.evaluate(request(), { ui });
    const second = engine.evaluate(request(), { ui });

    await vi.waitFor(() => expect(ui.prompts).toHaveLength(1));
    resolveFirst?.("allow_session");
    await expect(first).resolves.toMatchObject({ allowed: true, source: "prompt" });
    await expect(second).resolves.toMatchObject({ allowed: true, source: "session_grant" });
    expect(ui.prompts).toHaveLength(1);
  });

  it("denies cancellation before, while queued, and during a prompt", async () => {
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    const engine = new PolicyEngine(policies({ bash: { mode: "ask", sessionGrant: "never" } }));
    await expect(
      engine.evaluate(request(), {
        signal: alreadyCancelled.signal,
        ui: new RecordingUi(() => "allow_once"),
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "cancelled" });

    const resolutions: Array<(decision: ApprovalPromptDecision) => void> = [];
    const ui = new RecordingUi(() => new Promise((resolve) => resolutions.push(resolve)));
    const first = engine.evaluate(request(), { ui });
    const queuedController = new AbortController();
    const queued = engine.evaluate(request(), { ui, signal: queuedController.signal });
    await vi.waitFor(() => expect(ui.prompts).toHaveLength(1));
    queuedController.abort();
    await expect(queued).resolves.toMatchObject({ allowed: false, reason: "cancelled" });

    const activeController = new AbortController();
    const active = engine.evaluate(request("bash"), { ui, signal: activeController.signal });
    resolutions[0]?.("deny");
    await expect(first).resolves.toMatchObject({ allowed: false, reason: "user_denied" });
    await vi.waitFor(() => expect(ui.prompts).toHaveLength(2));
    activeController.abort();
    await expect(active).resolves.toMatchObject({ allowed: false, reason: "cancelled" });
    resolutions[1]?.("deny");
  });

  it("does not overlap a new prompt with a cancelled prompt that has not closed", async () => {
    const resolutions: Array<(decision: ApprovalPromptDecision) => void> = [];
    const ui = new RecordingUi(() => new Promise((resolve) => resolutions.push(resolve)));
    const engine = new PolicyEngine(policies({ bash: { mode: "ask", sessionGrant: "never" } }));
    const controller = new AbortController();
    const cancelled = engine.evaluate(request(), { ui, signal: controller.signal });
    await vi.waitFor(() => expect(ui.prompts).toHaveLength(1));
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ allowed: false, reason: "cancelled" });

    const next = engine.evaluate(request(), { ui });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ui.prompts).toHaveLength(1);

    resolutions[0]?.("deny");
    await vi.waitFor(() => expect(ui.prompts).toHaveLength(2));
    resolutions[1]?.("allow_once");
    await expect(next).resolves.toMatchObject({ allowed: true, source: "prompt" });
  });
});

describe("command-class policies", () => {
  function bashPolicy(
    main: SubjectPolicy,
    knownReadOnly?: NonNullable<SubjectPolicy["commandClasses"]>["known_read_only"],
  ): SubjectPolicy {
    return knownReadOnly === undefined
      ? main
      : { ...main, commandClasses: { known_read_only: knownReadOnly } };
  }

  function bashRequest(commandClass?: "known_read_only" | "unclassified", command = "ls") {
    return prepareApprovalRequest({
      subject: "bash",
      display: `bash: ${command}`,
      arguments: { command },
      ...(commandClass === undefined ? {} : { commandClass }),
    });
  }

  it("binds the analyzed class into the frozen request and its fingerprint", async () => {
    const known = bashRequest("known_read_only");
    const unclassified = bashRequest("unclassified");
    const absent = bashRequest();
    expect(known.commandClass).toBe("known_read_only");
    expect(Object.isFrozen(known)).toBe(true);
    expect(absent).not.toHaveProperty("commandClass");
    expect(new Set([known, unclassified, absent].map((item) => item.fingerprint)).size).toBe(3);
    expect(bashRequest("known_read_only").fingerprint).toBe(known.fingerprint);

    const forged = Object.freeze({ ...unclassified, commandClass: "known_read_only" as const });
    const engine = new PolicyEngine(
      policies({
        bash: bashPolicy(
          { mode: "deny", sessionGrant: "never" },
          { mode: "allow", sessionGrant: "never" },
        ),
      }),
    );
    await expect(engine.evaluate(forged)).rejects.toThrow("fingerprint does not match");
    expect(() =>
      prepareApprovalRequest({
        subject: "bash",
        display: "bash: ls",
        arguments: { command: "ls" },
        commandClass: "harmless" as "known_read_only",
      }),
    ).toThrow("command class is not recognized");
  });

  it.each([
    // main, class, known_read_only result, unclassified result
    ["deny", "never", "allow", "never", "policy_allowed", "policy_denied"],
    ["deny", "never", "ask", "never", "no_ui", "policy_denied"],
    ["ask", "never", "allow", "never", "policy_allowed", "no_ui"],
    ["ask", "never", "ask", "offer", "no_ui", "no_ui"],
    ["ask", "offer", "allow", "never", "policy_allowed", "no_ui"],
  ] as const)(
    "evaluates main %s/%s with class %s/%s by the join only for classified requests",
    async (mainMode, mainGrant, classMode, classGrant, known, unclassified) => {
      const engine = new PolicyEngine(
        policies({
          bash: bashPolicy(
            { mode: mainMode, sessionGrant: mainGrant },
            { mode: classMode, sessionGrant: classGrant },
          ),
        }),
      );
      await expect(engine.evaluate(bashRequest("known_read_only"))).resolves.toMatchObject({
        reason: known,
      });
      await expect(engine.evaluate(bashRequest("unclassified"))).resolves.toMatchObject({
        reason: unclassified,
      });
      await expect(engine.evaluate(bashRequest())).resolves.toMatchObject({
        reason: unclassified,
      });
    },
  );

  it("uses the main policy when a classified request has no class policy or the tool is disabled", async () => {
    const engine = new PolicyEngine(policies({ bash: { mode: "deny", sessionGrant: "never" } }));
    await expect(engine.evaluate(bashRequest("known_read_only"))).resolves.toMatchObject({
      reason: "policy_denied",
    });
    const disabled = new PolicyEngine(
      policies({
        bash: bashPolicy(
          { mode: "disabled", sessionGrant: "never" },
          { mode: "allow", sessionGrant: "never" },
        ),
      }),
    );
    await expect(disabled.evaluate(bashRequest("known_read_only"))).resolves.toMatchObject({
      reason: "disabled",
    });
  });

  it("offers class-scoped session grants that cover only later classified requests", async () => {
    const ui = new RecordingUi(() => "allow_session");
    const engine = new PolicyEngine(
      policies({
        bash: bashPolicy(
          { mode: "ask", sessionGrant: "never" },
          { mode: "ask", sessionGrant: "offer" },
        ),
      }),
    );
    await expect(engine.evaluate(bashRequest("known_read_only"), { ui })).resolves.toMatchObject({
      allowed: true,
      source: "prompt",
    });
    expect(ui.prompts[0]).toMatchObject({
      allowForSession: true,
      sessionGrantScope: "known_read_only",
    });
    expect(engine.hasSessionGrant("bash", "known_read_only")).toBe(true);
    expect(engine.hasSessionGrant("bash")).toBe(false);
    await expect(
      engine.evaluate(bashRequest("known_read_only", "cat a"), { ui }),
    ).resolves.toMatchObject({ allowed: true, source: "session_grant" });
    expect(ui.prompts).toHaveLength(1);

    const unclassified = new RecordingUi(() => "allow_once");
    await expect(
      engine.evaluate(bashRequest("unclassified"), { ui: unclassified }),
    ).resolves.toMatchObject({ allowed: true, source: "prompt" });
    expect(unclassified.prompts[0]).toMatchObject({
      allowForSession: false,
      sessionGrantScope: "tool",
    });
    await expect(engine.evaluate(bashRequest("unclassified"))).resolves.toMatchObject({
      reason: "no_ui",
    });

    engine.clearSessionGrants();
    expect(engine.hasSessionGrant("bash", "known_read_only")).toBe(false);
    await expect(engine.evaluate(bashRequest("known_read_only"))).resolves.toMatchObject({
      reason: "no_ui",
    });
  });

  it("lets a tool-scoped grant cover classified requests", async () => {
    // Not a valid administrator policy, but it isolates the generic lookup rule.
    const ui = new RecordingUi(() => "allow_session");
    const engine = new PolicyEngine(
      policies({
        bash: bashPolicy(
          { mode: "ask", sessionGrant: "offer" },
          { mode: "ask", sessionGrant: "offer" },
        ),
      }),
    );
    await engine.evaluate(bashRequest("unclassified"), { ui });
    expect(ui.prompts[0]?.sessionGrantScope).toBe("tool");
    expect(engine.hasSessionGrant("bash")).toBe(true);
    expect(engine.hasSessionGrant("bash", "known_read_only")).toBe(false);
    await expect(engine.evaluate(bashRequest("known_read_only"))).resolves.toMatchObject({
      allowed: true,
      source: "session_grant",
    });
    await expect(engine.evaluate(bashRequest("unclassified"))).resolves.toMatchObject({
      allowed: true,
      source: "session_grant",
    });
    expect(ui.prompts).toHaveLength(1);
  });

  it("rejects a class-scoped session decision when the class does not offer one", async () => {
    const engine = new PolicyEngine(
      policies({
        bash: bashPolicy(
          { mode: "deny", sessionGrant: "never" },
          { mode: "ask", sessionGrant: "never" },
        ),
      }),
    );
    await expect(
      engine.evaluate(bashRequest("known_read_only"), {
        ui: new RecordingUi(() => "allow_session"),
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "invalid_prompt_decision" });
    expect(engine.hasSessionGrant("bash", "known_read_only")).toBe(false);
  });

  it("includes class policies in grant revisions", async () => {
    let classGrant: "never" | "offer" = "offer";
    const engine = new PolicyEngine({}, (subject) =>
      subject === "dynamic_bash"
        ? {
            revision: "fixed",
            policy: {
              mode: "deny",
              sessionGrant: "never",
              commandClasses: { known_read_only: { mode: "ask", sessionGrant: classGrant } },
            },
          }
        : undefined,
    );
    const request = prepareApprovalRequest({
      subject: "dynamic_bash",
      display: "dynamic_bash: ls",
      arguments: { command: "ls" },
      commandClass: "known_read_only",
    });
    await engine.evaluate(request, { ui: new RecordingUi(() => "allow_session") });
    expect(engine.hasSessionGrant("dynamic_bash", "known_read_only")).toBe(true);
    classGrant = "never";
    expect(engine.hasSessionGrant("dynamic_bash", "known_read_only")).toBe(false);
    classGrant = "offer";
    expect(engine.hasSessionGrant("dynamic_bash", "known_read_only")).toBe(true);
    engine.invalidateSubject("dynamic_bash");
    expect(engine.hasSessionGrant("dynamic_bash", "known_read_only")).toBe(false);
  });

  it("freezes a private copy of class policies", async () => {
    const classPolicy = { mode: "allow" as "allow" | "deny", sessionGrant: "never" as const };
    const engine = new PolicyEngine(
      policies({
        bash: {
          mode: "deny",
          sessionGrant: "never",
          commandClasses: { known_read_only: classPolicy },
        },
      }),
    );
    classPolicy.mode = "deny";
    await expect(engine.evaluate(bashRequest("known_read_only"))).resolves.toMatchObject({
      allowed: true,
    });
  });
});
