import type { BashCommandSet } from "./command-set-contracts.js";
import type { ProfileCheckResult } from "./registry.js";
import { excerpt, type BashWord } from "./syntax.js";

/**
 * Match only explicit option words before operands. Unlike the curated registry,
 * arbitrary administrator commands have no reviewed GNU/BSD option grammar.
 */
export function matchCommandSet(
  rule: BashCommandSet,
  words: readonly BashWord[],
): ProfileCheckResult {
  const present = new Set<string>();
  const flags = new Set([...rule.requiredFlags, ...rule.optionalFlags]);
  let operands = 0;
  let afterOptions = false;
  const fail = (word: BashWord | undefined, option: boolean, message: string) => ({
    ok: false as const,
    issue: {
      code: option ? ("unsupported_option" as const) : ("unsupported_operand" as const),
      message,
      ...(word === undefined ? {} : { offset: word.offset }),
    },
  });

  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word.kind !== "literal")
      return fail(word, false, "configured command sets accept only literal arguments");
    const text = word.value;
    if (text === "--" && !afterOptions) {
      afterOptions = true;
      continue;
    }
    if (text.startsWith("-")) {
      if (afterOptions)
        return fail(word, true, "configured command options must precede all operands");
      const separator = text.startsWith("--") ? text.indexOf("=") : -1;
      const name = separator < 0 ? text : text.slice(0, separator);
      if (flags.has(name)) {
        if (present.has(name))
          return fail(word, true, `configured command flag ${excerpt(name, 32)} is repeated`);
        if (separator >= 0)
          return fail(word, true, `configured command flag ${excerpt(name, 32)} takes no value`);
      } else if (Object.hasOwn(rule.options, name)) {
        let value: string;
        if (separator >= 0) value = text.slice(separator + 1);
        else {
          const next = words[++index];
          if (next?.kind !== "literal")
            return fail(
              word,
              true,
              `configured command option ${excerpt(name, 32)} needs a literal value`,
            );
          value = next.value;
        }
        const option = rule.options[name]!;
        if (option.kind === "values" && !option.values.includes(value))
          return fail(
            word,
            true,
            `configured command option ${excerpt(name, 32)} has an unapproved value`,
          );
      } else {
        return fail(word, true, `configured command option ${excerpt(name, 32)} is not accepted`);
      }
      present.add(name);
      continue;
    }
    afterOptions = true;
    operands++;
    if (operands > rule.operands.max)
      return fail(word, false, "configured command has too many operands");
  }
  if (rule.requiredFlags.some((flag) => !present.has(flag)))
    return fail(undefined, true, "configured command is missing a required flag");
  if (operands < rule.operands.min)
    return fail(undefined, false, "configured command has too few operands");
  return { ok: true, optionNames: present };
}
