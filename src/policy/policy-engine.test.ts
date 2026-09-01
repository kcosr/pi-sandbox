import type { ApprovalSubject, SandboxConfig, SubjectPolicy } from "../domain/index.js";
import { describe, expect, it, vi } from "vitest";
import {
  PolicyEngine,
  createApprovalPolicies,
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

  it("creates policies from the configured model tools", () => {
    const config: SandboxConfig = {
      configVersion: 5,
      modelsFile: "/etc/pi-sandbox/models.json",
      execution: { backend: "bubblewrap" },
      identity: { mode: "disabled" },
      network: { mode: "none" },
      environment: { pi: {}, sandbox: {}, extensions: {} },
      extensions: {
        git: {
          id: "git",
          settings: {
            allowed_hosts: ["github.com"],
            allowed_schemes: ["https", "ssh"],
          },
          toolNames: ["git_clone"],
        },
      },
      tools: {
        read: allow,
        grep: allow,
        find: allow,
        ls: allow,
        write: allow,
        edit: allow,
        bash: { mode: "deny", sessionGrant: "never" },
        git_clone: { mode: "ask", sessionGrant: "offer" },
      },
    };
    const created = createApprovalPolicies(config);
    expect(created.bash).toEqual({ mode: "deny", sessionGrant: "never" });
    expect(created.git_clone).toEqual({ mode: "ask", sessionGrant: "offer" });
    expect(Object.keys(created)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "write",
      "edit",
      "bash",
      "git_clone",
    ]);
  });
});
