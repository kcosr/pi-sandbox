import { describe, expect, it } from "vitest";

import { describeOption, parseOptions, type OptionGrammar } from "./options.js";
import { parseBashCommand, type BashLiteralWord } from "./syntax.js";

function words(input: string): BashLiteralWord[] {
  const result = parseBashCommand(`echo ${input}`);
  if (!result.ok) {
    throw new Error(result.issue.message);
  }
  return (result.script.statements[0]?.pipelines[0]?.commands[0]?.words.slice(1) ?? []).map(
    (word) => {
      if (word.kind !== "literal") {
        throw new Error("option fixtures require literal words");
      }
      return word;
    },
  );
}

const grammar: OptionGrammar = {
  options: [
    { short: "a", long: "all", argument: "none" },
    { short: "k", long: "key", argument: "required", placeholder: "KEY" },
    { short: "n", argument: "required", validate: (value) => /^[0-9]+$/.test(value) },
    { short: "c", long: "color", argument: "optional", placeholder: "WHEN" },
    { long: "compress-program-safe", argument: "none" },
  ],
  numericOption: true,
};

function parse(input: string) {
  const result = parseOptions("demo", words(input), grammar);
  if (!result.ok) {
    return { issue: result.issue };
  }
  const { options, operands, strictOperands } = result.arguments;
  return {
    options: options.map((option) =>
      option.value === undefined ? option.name : `${option.name}=${option.value}`,
    ),
    operands: operands.map((word) => word.value),
    strict: strictOperands.map((word) => word.value),
  };
}

describe("option engine", () => {
  it("parses long options exactly", () => {
    expect(parse("--all --key=1,2 --key 3 --color --color=never x")).toEqual({
      options: ["--all", "--key=1,2", "--key=3", "--color", "--color=never"],
      operands: ["x"],
      strict: ["x"],
    });
    expect(parse("--key= x")).toMatchObject({ options: ["--key="], operands: ["x"] });
  });

  it("rejects abbreviations, unknown names, stray values and missing values", () => {
    expect(parse("--al")).toMatchObject({ issue: { code: "unsupported_option", offset: 5 } });
    expect(parse("--compress-program")).toMatchObject({ issue: { code: "unsupported_option" } });
    expect(parse("--compress=sh")).toMatchObject({ issue: { code: "unsupported_option" } });
    expect(parse("--all=yes").issue?.message).toBe('demo option "--all" does not take a value');
    expect(parse("x --key").issue?.message).toBe('demo option "--key" requires a value');
    expect(parse("-k").issue?.message).toBe('demo option "-k" requires a value');
    expect(parse("--color x --colour")).toMatchObject({ issue: { offset: 15 } });
    expect(parse("---all")).toMatchObject({ issue: { code: "unsupported_option" } });
  });

  it("parses short clusters with attached and separate values", () => {
    expect(parse("-aa -akfoo -ak bar -n5 -n 6 -c -cnever")).toEqual({
      options: ["-a", "-a", "-a", "-k=foo", "-a", "-k=bar", "-n=5", "-n=6", "-c", "-c=never"],
      operands: [],
      strict: [],
    });
    expect(parse("-ax")).toMatchObject({ issue: { message: 'demo option "-x" is not accepted' } });
    expect(parse("-a-")).toMatchObject({ issue: { code: "unsupported_option" } });
    expect(parse("-nx")).toMatchObject({
      issue: { message: 'demo option "-n" has an unsupported value' },
    });
    expect(parse("--key -a")).toMatchObject({ options: ["--key=-a"] });
  });

  it("treats -, --, and permuted words like GNU getopt_long", () => {
    expect(parse("- x -a -- -k y")).toEqual({
      options: ["-a"],
      operands: ["-", "x", "-k", "y"],
      strict: ["-", "x", "-a", "--", "-k", "y"],
    });
    expect(parse("-a -- -k")).toEqual({ options: ["-a"], operands: ["-k"], strict: ["-k"] });
    expect(parse("-a --")).toEqual({ options: ["-a"], operands: [], strict: [] });
    expect(parse("x -k v")).toEqual({
      options: ["-k=v"],
      operands: ["x"],
      strict: ["x", "-k", "v"],
    });
    expect(parse("x -z")).toMatchObject({ issue: { code: "unsupported_option" } });
  });

  it("accepts digit-only -NUM words only when the grammar allows them", () => {
    expect(parse("-20 x")).toMatchObject({ options: ["-20"], operands: ["x"] });
    expect(parse("-20f")).toMatchObject({ issue: { message: 'demo option "-2" is not accepted' } });
    expect(parseOptions("demo", words("-20"), { options: grammar.options }).ok).toBe(false);
  });

  it("uses decoded word values", () => {
    expect(parse(`'-a' "--key"=v '-'`)).toEqual({
      options: ["-a", "--key=v"],
      operands: ["-"],
      strict: ["-"],
    });
    expect(parse(String.raw`"--key=\$HOME"`)).toEqual({
      options: ["--key=$HOME"],
      operands: [],
      strict: [],
    });
    expect(parse(String.raw`"--key=one\|two"`)).toEqual({
      options: [String.raw`--key=one\|two`],
      operands: [],
      strict: [],
    });
  });

  it("renders documentation spellings", () => {
    expect(grammar.options.map(describeOption)).toEqual([
      "`-a`/`--all`",
      "`-k KEY`/`--key=KEY`",
      "`-n VALUE`",
      "`-c[WHEN]`/`--color[=WHEN]`",
      "`--compress-program-safe`",
    ]);
  });
});
