import { describe, expect, it } from "vitest";

import type { BashCommandSet } from "./command-set-contracts.js";
import { matchCommandSet } from "./command-set-matcher.js";
import { parseBashCommand, type BashWord } from "./syntax.js";

const rule: BashCommandSet = {
  commands: ["records"],
  mode: "allow",
  sessionGrant: "never",
  requiredFlags: ["--read"],
  optionalFlags: ["--verbose", "-v"],
  options: { "--format": ["text", "json"], "-f": ["text", "json"] },
  operands: { min: 1, max: 1 },
};

function argumentsOf(arguments_: string): readonly BashWord[] {
  const parsed = parseBashCommand(`records ${arguments_}`);
  if (!parsed.ok) throw new Error(parsed.issue.message);
  return parsed.script.statements[0]!.pipelines[0]!.commands[0]!.words.slice(1);
}

describe("configured command argument matching", () => {
  it.each([
    "--read file",
    "'--read' 'a file'",
    "--verbose --read file",
    "--read -v file",
    "--read --format json file",
    "--format=text --read file",
    "--read -f json file",
    "--read -- file",
    "--read ./-file",
  ])("matches the complete explicit form %s", (arguments_) => {
    expect(matchCommandSet(rule, argumentsOf(arguments_)).ok).toBe(true);
  });

  it.each([
    "file",
    "--read",
    "--read first second",
    "--read file --verbose",
    "--read file --format json",
    "file --read",
    "--read -- -file",
    "--read -",
    "--read -- --verbose",
    "--read --read file",
    "--read --verbose --verbose file",
    "--read --format json --format text file",
    "--read=true file",
    "--rea file",
    "--write file",
    "--read --format xml file",
    "--read --format",
    "--read --format= file",
    "--read -fjson file",
    "--read -vv file",
    "--read -vf json file",
    "--read --format ~/file",
    "--read ~/file",
  ])("rejects the incomplete or ambiguous form %s", (arguments_) => {
    expect(matchCommandSet(rule, argumentsOf(arguments_)).ok).toBe(false);
  });

  it("checks values separately from operand counts", () => {
    const result = matchCommandSet(rule, argumentsOf("--read --format json file"));
    expect(result).toEqual({ ok: true, optionNames: new Set(["--read", "--format"]) });
  });

  it("supports a zero-operand command without making any flags implicitly valid", () => {
    const zero: BashCommandSet = { ...rule, operands: { min: 0, max: 0 } };
    expect(matchCommandSet(zero, argumentsOf("--read"))).toMatchObject({ ok: true });
    expect(matchCommandSet(zero, argumentsOf("--read --"))).toMatchObject({ ok: true });
    expect(matchCommandSet(zero, argumentsOf("--read file"))).toMatchObject({ ok: false });
  });
});
