import { describe, expect, it } from "vitest";
import type { BashStageCoverage } from "./bash/contracts.js";
import { freezeCommandStages, validCommandStages } from "./command-set-evidence.js";

const custom: BashStageCoverage = {
  command: "utility",
  knownReadOnly: false,
  commandSets: ["Utility-Read"],
};

describe("configured command stage evidence", () => {
  it("admits exact stage and ID bounds but rejects larger evidence", () => {
    expect(validCommandStages(Array.from({ length: 256 }, () => custom))).toBe(true);
    expect(validCommandStages(Array.from({ length: 257 }, () => custom))).toBe(false);
    expect(
      validCommandStages([
        { ...custom, commandSets: Array.from({ length: 64 }, (_, i) => `rule_${i}`) },
      ]),
    ).toBe(true);
    expect(
      validCommandStages([
        { ...custom, commandSets: Array.from({ length: 65 }, (_, i) => `rule_${i}`) },
      ]),
    ).toBe(false);
    expect(validCommandStages([{ ...custom, commandSets: ["a".repeat(64)] }])).toBe(true);
    expect(validCommandStages([{ ...custom, commandSets: ["a".repeat(65)] }])).toBe(false);
  });
  it.each<unknown>([
    null,
    undefined,
    {},
    [],
    [null],
    [{ ...custom, extra: true }],
    [{ ...custom, commandSets: ["same", "same"] }],
    [{ ...custom, commandSets: ["../bad"] }],
    [{ ...custom, commandSets: ["constructor"] }],
    [{ ...custom, commandSets: [1] }],
    [{ ...custom, commandSets: "rule" }],
    [{ ...custom, knownReadOnly: "true" }],
    [{ ...custom, command: "./utility" }],
    [{ ...custom, commandSets: [] }],
    [{ command: "grep", knownReadOnly: true, commandSets: [] }],
  ])("rejects malformed or entirely built-in evidence %#", (value) => {
    expect(validCommandStages(value)).toBe(false);
  });
  it("retains built-in stages only alongside a custom stage", () => {
    expect(
      validCommandStages([custom, { command: "cd", knownReadOnly: true, commandSets: [] }]),
    ).toBe(true);
  });
  it("deep-copies and freezes stage data", () => {
    const input = [{ command: "utility", knownReadOnly: false, commandSets: ["Utility-Read"] }];
    const frozen = freezeCommandStages(input);
    input[0]!.command = "changed";
    input[0]!.knownReadOnly = true;
    input[0]!.commandSets[0] = "changed";
    input.push({ command: "other", knownReadOnly: true, commandSets: [] });
    expect(frozen).toEqual([custom]);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen[0])).toBe(true);
    expect(Object.isFrozen(frozen[0]!.commandSets)).toBe(true);
  });
});
