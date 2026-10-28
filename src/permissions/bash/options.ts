import type { BashAnalysisIssue } from "./contracts.js";
import { excerpt, type BashLiteralWord } from "./syntax.js";

/** GNU getopt_long-style option recognition (specs/bash-command-analysis.md Section 8.1). */

export type OptionArgument = "none" | "required" | "optional";

export interface OptionSpec {
  readonly short?: string;
  readonly long?: string;
  readonly argument: OptionArgument;
  /** Documentation placeholder for the value, for example `NUM`. */
  readonly placeholder?: string;
  readonly validate?: (value: string) => boolean;
}

export interface OptionGrammar {
  readonly options: readonly OptionSpec[];
  /** Accept `-NUM` (digits only) as an option word, as in `head -20`. */
  readonly numericOption?: boolean;
}

export interface ParsedOption {
  readonly spec: OptionSpec;
  /** Spelling used, for example `-n` or `--lines`. */
  readonly name: string;
  readonly value?: string;
  readonly word: BashLiteralWord;
}

export interface ParsedArguments {
  readonly options: readonly ParsedOption[];
  /** Operands under GNU argument permutation. */
  readonly operands: readonly BashLiteralWord[];
  /**
   * Every word from the first operand onward. Implementations that stop option parsing at the
   * first operand (BSD getopt, `POSIXLY_CORRECT`) treat all of these as operands.
   */
  readonly strictOperands: readonly BashLiteralWord[];
}

export type OptionParseResult =
  | { readonly ok: true; readonly arguments: ParsedArguments }
  | { readonly ok: false; readonly issue: BashAnalysisIssue };

const NUMERIC_OPTION = /^-[0-9]+$/;

function optionIssue(command: string, name: string, word: BashLiteralWord, detail: string) {
  return {
    ok: false as const,
    issue: Object.freeze({
      code: "unsupported_option" as const,
      message: `${command} option ${excerpt(name, 32)} ${detail}`,
      offset: word.offset,
    }),
  };
}

/** Parse `words` (arguments after the command name) against a positive option list. */
export function parseOptions(
  command: string,
  words: readonly BashLiteralWord[],
  grammar: OptionGrammar,
): OptionParseResult {
  const options: ParsedOption[] = [];
  const operands: BashLiteralWord[] = [];
  let strictStart: number | undefined;
  let endOfOptions = false;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as BashLiteralWord;
    const text = word.value;
    if (endOfOptions || text === "-" || !text.startsWith("-")) {
      operands.push(word);
      strictStart ??= index;
      continue;
    }
    if (text === "--") {
      endOfOptions = true;
      continue;
    }
    if (grammar.numericOption === true && NUMERIC_OPTION.test(text)) {
      options.push({ spec: { argument: "none" }, name: text, word });
      continue;
    }
    if (text.startsWith("--")) {
      const separator = text.indexOf("=");
      const name = separator < 0 ? text : text.slice(0, separator);
      const spec = grammar.options.find((option) => `--${option.long}` === name);
      if (spec === undefined) {
        return optionIssue(command, name, word, "is not accepted");
      }
      let value = separator < 0 ? undefined : text.slice(separator + 1);
      if (spec.argument === "none" && value !== undefined) {
        return optionIssue(command, name, word, "does not take a value");
      }
      if (spec.argument === "required" && value === undefined) {
        const next = words[index + 1];
        if (next === undefined) {
          return optionIssue(command, name, word, "requires a value");
        }
        value = next.value;
        index += 1;
      }
      if (value !== undefined && spec.validate !== undefined && !spec.validate(value)) {
        return optionIssue(command, name, word, "has an unsupported value");
      }
      options.push(value === undefined ? { spec, name, word } : { spec, name, value, word });
      continue;
    }
    for (let position = 1; position < text.length; position += 1) {
      const character = text[position] as string;
      const name = `-${character}`;
      const spec = grammar.options.find((option) => option.short === character);
      if (spec === undefined) {
        return optionIssue(command, name, word, "is not accepted");
      }
      if (spec.argument === "none") {
        options.push({ spec, name, word });
        continue;
      }
      let value: string | undefined = text.slice(position + 1);
      if (value === "") {
        value = undefined;
        if (spec.argument === "required") {
          const next = words[index + 1];
          if (next === undefined) {
            return optionIssue(command, name, word, "requires a value");
          }
          value = next.value;
          index += 1;
        }
      }
      if (value !== undefined && spec.validate !== undefined && !spec.validate(value)) {
        return optionIssue(command, name, word, "has an unsupported value");
      }
      options.push(value === undefined ? { spec, name, word } : { spec, name, value, word });
      break;
    }
  }

  return {
    ok: true,
    arguments: {
      options,
      operands,
      strictOperands: strictStart === undefined ? [] : words.slice(strictStart),
    },
  };
}

/** Render one option for administrator documentation, for example `-n NUM`/`--lines=NUM`. */
export function describeOption(spec: OptionSpec): string {
  const placeholder = spec.placeholder ?? "VALUE";
  const spellings: string[] = [];
  if (spec.short !== undefined) {
    spellings.push(
      spec.argument === "required"
        ? `-${spec.short} ${placeholder}`
        : spec.argument === "optional"
          ? `-${spec.short}[${placeholder}]`
          : `-${spec.short}`,
    );
  }
  if (spec.long !== undefined) {
    spellings.push(
      spec.argument === "required"
        ? `--${spec.long}=${placeholder}`
        : spec.argument === "optional"
          ? `--${spec.long}[=${placeholder}]`
          : `--${spec.long}`,
    );
  }
  return spellings.map((spelling) => `\`${spelling}\``).join("/");
}
