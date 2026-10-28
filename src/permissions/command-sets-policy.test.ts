import { describe, expect, it, vi } from "vitest";
import { PolicyEngine, prepareApprovalRequest } from "./policy-engine.js";
import type { ApprovalPrompt } from "./policy-engine.js";
import type { SubjectPolicy } from "./contracts.js";
import type { BashStageCoverage } from "./bash/contracts.js";
import type { BashCommandSet } from "./bash/command-set-contracts.js";

const rule: BashCommandSet = {
  commands: ["utility"],
  mode: "allow",
  sessionGrant: "never",
  requiredFlags: ["--read"],
  optionalFlags: [],
  options: {},
  operands: { min: 1, max: 1 },
};
const custom: BashStageCoverage = {
  command: "utility",
  knownReadOnly: false,
  commandSets: ["utility_read"],
};
const builtin: BashStageCoverage = { command: "grep", knownReadOnly: true, commandSets: [] };
const policy = (extra: Partial<SubjectPolicy> = {}): SubjectPolicy => ({
  mode: "ask",
  sessionGrant: "offer",
  commandSets: { utility_read: rule },
  ...extra,
});
function request(
  stages: readonly BashStageCoverage[] = [custom],
  command = "utility --read input",
) {
  return prepareApprovalRequest({
    subject: "bash",
    display: "Run utility",
    arguments: { command },
    commandClass: "configured_command",
    commandStages: stages,
  });
}

describe("administrator command set approval", () => {
  it("allows a custom invocation without granting any later unmatched invocation", async () => {
    const engine = new PolicyEngine({ bash: policy() });
    expect(await engine.evaluate(request())).toMatchObject({ allowed: true, source: "policy" });
    expect(engine.hasSessionGrant("bash")).toBe(false);
    expect(
      await engine.evaluate(
        prepareApprovalRequest({
          subject: "bash",
          display: "write",
          arguments: { command: "utility --write file" },
        }),
      ),
    ).toMatchObject({ allowed: false, reason: "no_ui" });
  });
  it("requires effective builtin allow for every non-custom stage", async () => {
    for (const known of [
      undefined,
      { mode: "ask", sessionGrant: "offer" },
      { mode: "deny", sessionGrant: "never" },
    ] as const) {
      const engine = new PolicyEngine({
        bash: policy(known ? { commandClasses: { known_read_only: known } } : {}),
      });
      expect(await engine.evaluate(request([custom, builtin]))).toMatchObject({
        allowed: false,
        reason: "no_ui",
      });
    }
    const engine = new PolicyEngine({
      bash: policy({
        commandClasses: { known_read_only: { mode: "allow", sessionGrant: "never" } },
      }),
    });
    expect(await engine.evaluate(request([custom, builtin]))).toMatchObject({
      allowed: true,
      source: "policy",
    });
  });
  it("prompts for the entire mixed call and uses ordinary tool grant scope", async () => {
    const prompt = vi.fn((prompt: ApprovalPrompt) => {
      void prompt;
      return Promise.resolve("allow_once" as const);
    });
    const engine = new PolicyEngine({ bash: policy() });
    expect(await engine.evaluate(request([builtin, custom]), { ui: { prompt } })).toMatchObject({
      allowed: true,
      source: "prompt",
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      sessionGrantScope: "tool",
      allowForSession: true,
    });
  });
  it("never revives disabled Bash and permits explicit allow exceptions to deny", async () => {
    expect(
      await new PolicyEngine({
        bash: policy({ mode: "disabled", sessionGrant: "never" }),
      }).evaluate(request()),
    ).toMatchObject({ allowed: false, reason: "disabled" });
    expect(
      await new PolicyEngine({ bash: policy({ mode: "deny", sessionGrant: "never" }) }).evaluate(
        request(),
      ),
    ).toMatchObject({ allowed: true, source: "policy" });
  });
  it("requires current named rules with the same command identity", async () => {
    for (const commandSets of [{}, { utility_read: { ...rule, commands: ["other"] } }]) {
      expect(
        await new PolicyEngine({ bash: policy({ commandSets }) }).evaluate(request()),
      ).toMatchObject({ allowed: false, reason: "no_ui" });
    }
  });
  it("requires exact alternative membership without implicit basename or path aliases", async () => {
    const absolute = "/usr/libexec/pi-sandbox/utility";
    for (const commands of [["utility"], [absolute], ["utility", absolute]]) {
      const engine = new PolicyEngine({
        bash: policy({ commandSets: { utility_read: { ...rule, commands } } }),
      });
      for (const command of [
        "utility",
        absolute,
        "/other/utility",
        "/usr/libexec/pi-sandbox/utility-link",
      ]) {
        const result = await engine.evaluate(
          request([{ ...custom, command }], `${command} --read input`),
        );
        expect(result).toMatchObject(
          commands.includes(command)
            ? { allowed: true, source: "policy" }
            : { allowed: false, reason: "no_ui" },
        );
      }
    }
  });

  it("binds each actual command spelling into the evidence fingerprint", () => {
    const absolute = "/usr/libexec/pi-sandbox/utility";
    expect(request([{ ...custom, command: absolute }]).fingerprint).not.toBe(request().fingerprint);
  });

  it("invalidates ordinary session grants when configured alternatives change", async () => {
    let selected = policy();
    const engine = new PolicyEngine({}, () => ({
      policy: selected,
      revision: "unchanged-provider-revision",
    }));
    const unmatched = prepareApprovalRequest({
      subject: "bash",
      display: "write",
      arguments: { command: "utility --write file" },
    });
    expect(
      await engine.evaluate(unmatched, {
        ui: { prompt: () => Promise.resolve("allow_session" as const) },
      }),
    ).toMatchObject({ allowed: true });
    expect(engine.hasSessionGrant("bash")).toBe(true);
    selected = policy({
      commandSets: {
        utility_read: { ...rule, commands: ["utility", "/usr/libexec/pi-sandbox/utility"] },
      },
    });
    expect(engine.hasSessionGrant("bash")).toBe(false);
    expect(await engine.evaluate(unmatched)).toMatchObject({ allowed: false, reason: "no_ui" });
  });
  it("binds and freezes stage evidence, and rejects missing or misplaced evidence", () => {
    const stages = [{ ...custom, commandSets: ["utility_read"] }];
    const prepared = request(stages);
    stages[0]!.commandSets[0] = "other";
    expect(prepared.commandStages?.[0]?.commandSets).toEqual(["utility_read"]);
    expect(Object.isFrozen(prepared.commandStages?.[0]?.commandSets)).toBe(true);
    expect(request([{ ...custom, commandSets: ["another"] }]).fingerprint).not.toBe(
      prepared.fingerprint,
    );
    expect(() =>
      prepareApprovalRequest({
        subject: "bash",
        display: "run",
        arguments: {},
        commandClass: "configured_command",
      }),
    ).toThrow("evidence");
    expect(() =>
      prepareApprovalRequest({
        subject: "write",
        display: "run",
        arguments: {},
        commandClass: "configured_command",
        commandStages: [custom],
      }),
    ).toThrow("evidence");
    expect(() =>
      prepareApprovalRequest({
        subject: "bash",
        display: "run",
        arguments: {},
        commandClass: "known_read_only",
        commandStages: [custom],
      }),
    ).toThrow("evidence");
  });

  it("invalidates grants when an option changes between enumerated and unrestricted literals", async () => {
    let selected = policy({
      commandSets: {
        utility_read: { ...rule, options: { "-m": { kind: "values", values: ["first"] } } },
      },
    });
    const engine = new PolicyEngine({}, () => ({ policy: selected, revision: "same-provider" }));
    const unmatched = prepareApprovalRequest({
      subject: "bash",
      display: "write",
      arguments: { command: "utility --write file" },
    });
    for (const option of [
      { kind: "any_literal" } as const,
      { kind: "values", values: ["second"] } as const,
    ]) {
      expect(
        await engine.evaluate(unmatched, {
          ui: { prompt: () => Promise.resolve("allow_session" as const) },
        }),
      ).toMatchObject({ allowed: true });
      expect(engine.hasSessionGrant("bash")).toBe(true);
      selected = policy({ commandSets: { utility_read: { ...rule, options: { "-m": option } } } });
      expect(engine.hasSessionGrant("bash")).toBe(false);
      expect(await engine.evaluate(unmatched)).toMatchObject({ allowed: false, reason: "no_ui" });
    }
  });
  it("snapshots administrator rules before caller mutation", async () => {
    const mutable = { ...rule, commands: ["utility"] };
    const engine = new PolicyEngine({ bash: policy({ commandSets: { utility_read: mutable } }) });
    mutable.commands[0] = "other";
    mutable.commands.push("added");
    expect(await engine.evaluate(request())).toMatchObject({ allowed: true, source: "policy" });
    expect(await engine.evaluate(request([{ ...custom, command: "added" }]))).toMatchObject({
      allowed: false,
      reason: "no_ui",
    });
  });
});
