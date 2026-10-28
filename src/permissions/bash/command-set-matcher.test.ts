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
  options: {
    "--format": { kind: "values", values: ["text", "json"] },
    "-f": { kind: "values", values: ["text", "json"] },
    "-m": { kind: "any_literal" },
    "--message": { kind: "any_literal" },
    "--exact": { kind: "values", values: ["*", "string", "--"] },
  },
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
    "--read --format json --format=text file",
    "--read -f json -f text file",
    "--read -m first -m second file",
    "--read --message first --message=second file",
    "--read '-m' 'a message' --message='another message' file",
    "--read -m '' --message= file",
    "--read -m -x --message -- file",
    "--read -m --read file",
    "--read -m '$HOME' --message '$(touch sentinel)' file",
    "--read --exact '*' --exact string --exact -- file",
    `--read -m '${"x".repeat(1024)}' file`,
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
    "--read --format json --format xml file",
    "--read --format xml --format json file",
    "--read --format json --format= file",
    "--read -f text -f",
    "--read -m first -m",
    "--read -m",
    "--read --message",
    "--read --message ~/file",
    "--read -m ~/file",
    "--read -mfoo file",
    "--read --mess=data file",
    "--read file -m message",
    "--read --exact anything file",
    "-m --read file",
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

  it("records actual option names without treating consumed values as flags", () => {
    expect(matchCommandSet(rule, argumentsOf("--read -m --verbose -m -- --message= file"))).toEqual(
      { ok: true, optionNames: new Set(["--read", "-m", "--message"]) },
    );
  });

  it("supports a zero-operand command without making any flags implicitly valid", () => {
    const zero: BashCommandSet = { ...rule, operands: { min: 0, max: 0 } };
    expect(matchCommandSet(zero, argumentsOf("--read"))).toMatchObject({ ok: true });
    expect(matchCommandSet(zero, argumentsOf("--read --"))).toMatchObject({ ok: true });
    expect(matchCommandSet(zero, argumentsOf("--read file"))).toMatchObject({ ok: false });
  });
});
