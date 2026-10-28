import type {
  BashAnalysisIssue,
  KnownReadOnlyCommandDescription,
  KnownReadOnlyCommandKind,
} from "./contracts.js";
import { describeOption, parseOptions, type OptionGrammar, type OptionSpec } from "./options.js";
import { excerpt, type BashLiteralWord, type BashWord } from "./syntax.js";

/** Version-2 known read-only command registry (specs/bash-command-analysis.md Section 8). */

export const KNOWN_READ_ONLY_VERSION = 2;

/** Environment variable that makes a profile unsafe when non-empty. */
export interface EnvironmentDependency {
  readonly variable: string;
  /** The variable is irrelevant when this exact option spelling is present. */
  readonly unlessOption?: string;
}

export type ProfileCheckResult =
  | { readonly ok: true; readonly optionNames: ReadonlySet<string> }
  | { readonly ok: false; readonly issue: BashAnalysisIssue };

export interface KnownReadOnlyProfile {
  readonly name: string;
  readonly kind: KnownReadOnlyCommandKind;
  /** Accepted options and operands, rendered for administrators. */
  readonly summary: string;
  readonly environment: readonly EnvironmentDependency[];
  /** Check the words after the command name. */
  check(words: readonly BashWord[]): ProfileCheckResult;
}

const NONE: ReadonlySet<string> = new Set();
const COUNT = /^[0-9]+$/;
const SIGNED_COUNT = /^[+-]?[0-9]+$/;
const isCount = (value: string): boolean => COUNT.test(value);

function flag(short: string | undefined, long?: string): OptionSpec {
  return {
    ...(short === undefined ? {} : { short }),
    ...(long === undefined ? {} : { long }),
    argument: "none",
  };
}

function valued(
  short: string | undefined,
  long: string | undefined,
  placeholder: string,
  validate?: (value: string) => boolean,
): OptionSpec {
  return {
    ...(short === undefined ? {} : { short }),
    ...(long === undefined ? {} : { long }),
    argument: "required",
    placeholder,
    ...(validate === undefined ? {} : { validate }),
  };
}

function optional(long: string, placeholder: string): OptionSpec {
  return { long, argument: "optional", placeholder };
}

function operandIssue(word: BashWord | undefined, message: string): ProfileCheckResult {
  return {
    ok: false,
    issue: Object.freeze(
      word === undefined
        ? { code: "unsupported_operand" as const, message }
        : { code: "unsupported_operand" as const, message, offset: word.offset },
    ),
  };
}

interface GetoptProfileOptions {
  readonly name: string;
  readonly kind?: KnownReadOnlyCommandKind;
  readonly grammar: OptionGrammar;
  /** Plain-English description of operands for documentation. */
  readonly operands: string;
  /** Maximum operands, counted as an implementation that stops at the first operand would. */
  readonly maxOperands?: number;
  readonly operandIssue?: (operand: BashLiteralWord) => string | undefined;
  readonly requireOption?: readonly string[];
  readonly environment?: readonly EnvironmentDependency[];
  readonly note?: string;
  readonly check?: (operands: readonly BashLiteralWord[]) => ProfileCheckResult | undefined;
}

/** Keep symbolic directory words out of every literal-only profile, even in direct calls. */
function literalProfile(
  profile: Omit<KnownReadOnlyProfile, "check"> & {
    check(words: readonly BashLiteralWord[]): ProfileCheckResult;
  },
): KnownReadOnlyProfile {
  return Object.freeze({
    ...profile,
    check(words: readonly BashWord[]): ProfileCheckResult {
      const literals: BashLiteralWord[] = [];
      for (const word of words) {
        if (word.kind !== "literal") {
          return operandIssue(word, `${profile.name} accepts only literal arguments`);
        }
        literals.push(word);
      }
      return profile.check(literals);
    },
  });
}

function describeEnvironment(environment: readonly EnvironmentDependency[]): string {
  return environment
    .map(
      (dependency) =>
        `Unclassified while \`${dependency.variable}\` is non-empty` +
        (dependency.unlessOption === undefined
          ? ""
          : ` unless \`${dependency.unlessOption}\` is given`) +
        ".",
    )
    .join(" ");
}

function getoptProfile(options: GetoptProfileOptions): KnownReadOnlyProfile {
  const { name, grammar } = options;
  const environment = Object.freeze([...(options.environment ?? [])]);
  const accepted = [
    ...grammar.options.map(describeOption),
    ...(grammar.numericOption === true ? ["`-NUM`"] : []),
  ];
  const summary = [
    accepted.length === 0 ? "No options." : `Options: ${accepted.join(", ")}.`,
    `Operands: ${options.operands}.`,
    options.note ?? "",
    describeEnvironment(environment),
  ]
    .filter((part) => part !== "")
    .join(" ");
  return literalProfile({
    name,
    kind: options.kind ?? "executable",
    summary,
    environment,
    check(words: readonly BashLiteralWord[]): ProfileCheckResult {
      const parsed = parseOptions(name, words, grammar);
      if (!parsed.ok) {
        return parsed;
      }
      const { options: present, operands, strictOperands } = parsed.arguments;
      const optionNames = new Set(present.map((option) => option.name));
      if (
        options.requireOption !== undefined &&
        !options.requireOption.some((required) => optionNames.has(required))
      ) {
        return {
          ok: false,
          issue: Object.freeze({
            code: "unsupported_option" as const,
            message: `${name} requires ${options.requireOption.map((option) => `"${option}"`).join(" or ")}`,
          }),
        };
      }
      if (options.maxOperands !== undefined && strictOperands.length > options.maxOperands) {
        return operandIssue(
          strictOperands[options.maxOperands],
          options.maxOperands === 0
            ? `${name} accepts no operands`
            : `${name} accepts at most ${options.maxOperands} operand${options.maxOperands === 1 ? "" : "s"}`,
        );
      }
      for (const operand of strictOperands) {
        const problem = options.operandIssue?.(operand);
        if (problem !== undefined) {
          return operandIssue(operand, problem);
        }
      }
      const special = options.check?.(operands);
      if (special !== undefined) {
        return special;
      }
      return { ok: true, optionNames };
    },
  });
}

function anyWordsProfile(name: string, summary: string): KnownReadOnlyProfile {
  return literalProfile({
    name,
    kind: "shell_builtin" as const,
    summary,
    environment: Object.freeze([]),
    check: (): ProfileCheckResult => ({ ok: true, optionNames: NONE }),
  });
}

const FIND_LEADING_OPTIONS: readonly string[] = ["-H", "-L", "-P"];
const FIND_OPERATORS: readonly string[] = ["(", ")", "!", "-not", "-a", "-and", "-o", "-or"];
const FIND_NULLARY: readonly string[] = [
  "-depth",
  "-empty",
  "-executable",
  "-false",
  "-follow",
  "-ls",
  "-mount",
  "-nogroup",
  "-noleaf",
  "-nouser",
  "-print",
  "-print0",
  "-prune",
  "-quit",
  "-readable",
  "-true",
  "-writable",
  "-xdev",
];
const FIND_UNARY: readonly string[] = [
  "-amin",
  "-anewer",
  "-atime",
  "-cmin",
  "-cnewer",
  "-ctime",
  "-fstype",
  "-gid",
  "-group",
  "-ilname",
  "-iname",
  "-inum",
  "-ipath",
  "-iregex",
  "-iwholename",
  "-links",
  "-lname",
  "-maxdepth",
  "-mindepth",
  "-mmin",
  "-mtime",
  "-name",
  "-newer",
  "-path",
  "-perm",
  "-printf",
  "-regex",
  "-regextype",
  "-samefile",
  "-size",
  "-type",
  "-uid",
  "-user",
  "-wholename",
];
const FIND_NEWER_XY = /^-newer[aBcm][aBcmt]$/;

function isFindExpressionStart(value: string): boolean {
  return value.startsWith("-") || value === "(" || value === ")" || value === "!" || value === ",";
}

const findProfile: KnownReadOnlyProfile = literalProfile({
  name: "find",
  kind: "executable" as const,
  summary:
    `Leading options: ${FIND_LEADING_OPTIONS.map((option) => `\`${option}\``).join(", ")}. ` +
    "Operands: starting paths, then an expression of " +
    `operators ${FIND_OPERATORS.map((operator) => `\`${operator}\``).join(", ")}; ` +
    `primaries without arguments ${FIND_NULLARY.map((primary) => `\`${primary}\``).join(", ")}; ` +
    `primaries with one argument ${[...FIND_UNARY, "-newerXY"].map((primary) => `\`${primary}\``).join(", ")} ` +
    "(`XY` from `aBcm` then `aBcmt`).",
  environment: Object.freeze([]),
  check(words: readonly BashLiteralWord[]): ProfileCheckResult {
    let index = 0;
    while (index < words.length && FIND_LEADING_OPTIONS.includes(words[index]?.value ?? "")) {
      index += 1;
    }
    while (index < words.length && !isFindExpressionStart(words[index]?.value ?? "")) {
      index += 1;
    }
    while (index < words.length) {
      const word = words[index] as BashLiteralWord;
      const token = word.value;
      if (FIND_OPERATORS.includes(token) || FIND_NULLARY.includes(token)) {
        index += 1;
        continue;
      }
      if (FIND_UNARY.includes(token) || FIND_NEWER_XY.test(token)) {
        if (index + 1 >= words.length) {
          return {
            ok: false,
            issue: Object.freeze({
              code: "unsupported_option" as const,
              message: `find primary ${excerpt(token, 32)} requires an argument`,
              offset: word.offset,
            }),
          };
        }
        index += 2;
        continue;
      }
      return {
        ok: false,
        issue: Object.freeze({
          code: "unsupported_option" as const,
          message: `find expression ${excerpt(token, 32)} is not accepted`,
          offset: word.offset,
        }),
      };
    }
    return { ok: true, optionNames: NONE };
  },
});

const SED_SCRIPT = /^(?:[0-9]+|\$|[0-9]+,(?:[0-9]+|\$))p$/;

/** Read one deliberately bracket-free BRE, without interpreting its regex semantics. */
function sedRegexEnd(script: string, start: number): number | undefined {
  for (let index = start; index < script.length; index += 1) {
    const character = script[index] as string;
    if (character === "/") {
      return index === start ? undefined : index;
    }
    if (character === "\\") {
      const escaped = script[index + 1];
      if (escaped === undefined || !"\\/*.^$".includes(escaped)) {
        return undefined;
      }
      index += 1;
    } else if (
      character === "[" ||
      character.charCodeAt(0) < 0x20 ||
      character.charCodeAt(0) > 0x7e
    ) {
      return undefined;
    }
  }
  return undefined;
}

function isSedPrintScript(script: string): boolean {
  if (SED_SCRIPT.test(script)) {
    return true;
  }
  if (!script.startsWith("/")) {
    return false;
  }
  const first = sedRegexEnd(script, 1);
  if (first === undefined || script.slice(first, first + 3) !== "/,/") {
    return false;
  }
  const second = sedRegexEnd(script, first + 3);
  return second !== undefined && script.slice(second) === "/p";
}

const literalCdProfile = getoptProfile({
  name: "cd",
  kind: "shell_builtin",
  grammar: { options: [flag("L"), flag("P")] },
  operands: "at most one directory",
  maxOperands: 1,
});

const cdProfile: KnownReadOnlyProfile = Object.freeze({
  ...literalCdProfile,
  summary:
    literalCdProfile.summary +
    " A home-relative `~/...` directory must be the final word, preceded only by individual `-L`/`-P` words and at most one final `--`.",
  check(words: readonly BashWord[]): ProfileCheckResult {
    const homeIndex = words.findIndex((word) => word.kind === "home_relative");
    if (homeIndex < 0) {
      return literalCdProfile.check(words);
    }
    if (homeIndex !== words.length - 1) {
      return operandIssue(
        words[homeIndex + 1],
        "cd requires the home-relative directory to be its final word",
      );
    }
    const optionNames = new Set<string>();
    for (let index = 0; index < homeIndex; index += 1) {
      const word = words[index] as BashWord;
      if (word.kind !== "literal") {
        return operandIssue(word, "cd accepts only one home-relative directory");
      }
      if (word.value === "-L" || word.value === "-P") {
        optionNames.add(word.value);
      } else if (word.value !== "--" || index !== homeIndex - 1) {
        return operandIssue(
          word,
          "cd accepts only individual -L/-P options and one final -- before a home-relative directory",
        );
      }
    }
    return { ok: true, optionNames };
  },
});

const sleepProfile = literalProfile({
  name: "sleep",
  kind: "executable",
  summary:
    "No options, including `--`. Exactly one canonical decimal integer seconds operand from `0` through `2147483647`; no signs, leading zeros, fractions, exponents or suffixes. This classification adds no timeout.",
  environment: Object.freeze([]),
  check(words: readonly BashLiteralWord[]): ProfileCheckResult {
    const seconds = words[0];
    if (
      words.length !== 1 ||
      seconds === undefined ||
      /^(?:0|[1-9][0-9]{0,9})/.exec(seconds.value)?.[0] !== seconds.value ||
      Number(seconds.value) > 2147483647
    ) {
      return operandIssue(
        words.length > 1 ? words[1] : seconds,
        "sleep requires one canonical decimal integer seconds operand from 0 through 2147483647",
      );
    }
    return { ok: true, optionNames: NONE };
  },
});

const PROFILES: readonly KnownReadOnlyProfile[] = [
  getoptProfile({
    name: "basename",
    grammar: {
      options: [flag("a", "multiple"), valued("s", "suffix", "SUFFIX"), flag("z", "zero")],
    },
    operands: "names (not read)",
  }),
  getoptProfile({
    name: "cat",
    grammar: {
      options: [
        flag("A", "show-all"),
        flag("b", "number-nonblank"),
        flag("e"),
        flag("E", "show-ends"),
        flag("n", "number"),
        flag("s", "squeeze-blank"),
        flag("t"),
        flag("T", "show-tabs"),
        flag("u"),
        flag("v", "show-nonprinting"),
      ],
    },
    operands: "files to read",
  }),
  cdProfile,
  getoptProfile({
    name: "cut",
    grammar: {
      options: [
        valued("b", "bytes", "LIST"),
        valued("c", "characters", "LIST"),
        valued("d", "delimiter", "DELIM"),
        valued("f", "fields", "LIST"),
        flag("n"),
        flag("s", "only-delimited"),
        flag("z", "zero-terminated"),
        flag(undefined, "complement"),
        valued(undefined, "output-delimiter", "STRING"),
      ],
    },
    operands: "files to read",
  }),
  getoptProfile({
    name: "diff",
    grammar: {
      options: [
        flag("a", "text"),
        flag("b", "ignore-space-change"),
        flag("B", "ignore-blank-lines"),
        flag("c"),
        valued("C", undefined, "NUM", isCount),
        optional("context", "NUM"),
        flag("d", "minimal"),
        flag("i", "ignore-case"),
        valued("I", "ignore-matching-lines", "RE"),
        flag("N", "new-file"),
        flag("p", "show-c-function"),
        flag("q", "brief"),
        flag("r", "recursive"),
        flag("s", "report-identical-files"),
        flag("t", "expand-tabs"),
        flag("T", "initial-tab"),
        flag("u"),
        valued("U", undefined, "NUM", isCount),
        optional("unified", "NUM"),
        flag("w", "ignore-all-space"),
        valued("W", "width", "NUM", isCount),
        valued("x", "exclude", "PAT"),
        valued("X", "exclude-from", "FILE"),
        flag("y", "side-by-side"),
        flag(undefined, "normal"),
        flag(undefined, "strip-trailing-cr"),
        flag(undefined, "suppress-common-lines"),
        optional("color", "WHEN"),
      ],
    },
    operands: "files or directories to compare",
  }),
  getoptProfile({
    name: "dirname",
    grammar: { options: [flag("z", "zero")] },
    operands: "names (not read)",
  }),
  getoptProfile({
    name: "du",
    grammar: {
      options: [
        flag("a", "all"),
        flag("c", "total"),
        valued("d", "max-depth", "N", isCount),
        flag("h", "human-readable"),
        flag("H"),
        flag("k"),
        flag("L", "dereference"),
        flag("m"),
        flag("P", "no-dereference"),
        flag("s", "summarize"),
        flag("x", "one-file-system"),
        flag(undefined, "apparent-size"),
        flag(undefined, "si"),
      ],
    },
    operands: "files or directories to measure",
  }),
  anyWordsProfile("echo", "Any words; output only."),
  anyWordsProfile("false", "Any words (ignored)."),
  findProfile,
  getoptProfile({
    name: "grep",
    grammar: {
      options: [
        flag("E", "extended-regexp"),
        flag("F", "fixed-strings"),
        flag("G", "basic-regexp"),
        flag("P", "perl-regexp"),
        valued("e", "regexp", "PATTERNS"),
        valued("f", "file", "FILE"),
        flag("i", "ignore-case"),
        flag("w", "word-regexp"),
        flag("x", "line-regexp"),
        flag("s", "no-messages"),
        flag("v", "invert-match"),
        valued("m", "max-count", "NUM", isCount),
        flag("b", "byte-offset"),
        flag("n", "line-number"),
        flag(undefined, "line-buffered"),
        flag("H", "with-filename"),
        flag("h", "no-filename"),
        flag("o", "only-matching"),
        flag("q", "quiet"),
        flag(undefined, "silent"),
        flag("a", "text"),
        flag("I"),
        flag("r", "recursive"),
        flag("R", "dereference-recursive"),
        valued(undefined, "include", "GLOB"),
        valued(undefined, "exclude", "GLOB"),
        valued(undefined, "exclude-dir", "GLOB"),
        flag("L", "files-without-match"),
        flag("l", "files-with-matches"),
        flag("c", "count"),
        valued("A", "after-context", "NUM", isCount),
        valued("B", "before-context", "NUM", isCount),
        valued("C", "context", "NUM", isCount),
        optional("color", "WHEN"),
        optional("colour", "WHEN"),
      ],
    },
    operands: "a pattern (unless `-e`/`-f`), then files or directories to read",
    environment: [{ variable: "GREP_OPTIONS" }],
  }),
  getoptProfile({
    name: "head",
    grammar: {
      options: [
        valued("c", "bytes", "NUM", (value) => /^-?[0-9]+$/.test(value)),
        valued("n", "lines", "NUM", (value) => /^-?[0-9]+$/.test(value)),
        flag("q", "quiet"),
        flag(undefined, "silent"),
        flag("v", "verbose"),
      ],
      numericOption: true,
    },
    operands: "files to read",
  }),
  getoptProfile({
    name: "ls",
    grammar: {
      options: [
        flag("1"),
        flag("a", "all"),
        flag("A", "almost-all"),
        flag("C"),
        flag("c"),
        flag("d", "directory"),
        flag("F"),
        optional("classify", "WHEN"),
        optional("color", "WHEN"),
        flag("g"),
        flag("H", "dereference-command-line"),
        flag("h", "human-readable"),
        flag("i", "inode"),
        flag("k"),
        flag("L", "dereference"),
        flag("l"),
        flag("m"),
        flag("n", "numeric-uid-gid"),
        flag("o"),
        flag("p"),
        flag("R", "recursive"),
        flag("r", "reverse"),
        flag("S"),
        flag("s", "size"),
        flag("t"),
        flag("u"),
        flag("x"),
        flag(undefined, "full-time"),
        flag(undefined, "group-directories-first"),
        valued(undefined, "sort", "WORD"),
        valued(undefined, "time", "WORD"),
      ],
    },
    operands: "files or directories to list",
  }),
  getoptProfile({
    name: "nl",
    grammar: {
      options: [
        valued("b", "body-numbering", "STYLE"),
        valued("d", "section-delimiter", "CC"),
        valued("f", "footer-numbering", "STYLE"),
        valued("h", "header-numbering", "STYLE"),
        valued("i", "line-increment", "NUM"),
        valued("l", "join-blank-lines", "NUM"),
        valued("n", "number-format", "FORMAT"),
        flag("p", "no-renumber"),
        valued("s", "number-separator", "STRING"),
        valued("v", "starting-line-number", "NUM"),
        valued("w", "number-width", "NUM"),
      ],
    },
    operands: "files to read",
  }),
  getoptProfile({
    name: "pwd",
    kind: "shell_builtin",
    grammar: { options: [flag("L"), flag("P")] },
    operands: "none",
    maxOperands: 0,
  }),
  getoptProfile({
    name: "readlink",
    grammar: {
      options: [
        flag("f", "canonicalize"),
        flag("e", "canonicalize-existing"),
        flag("m", "canonicalize-missing"),
        flag("n", "no-newline"),
        flag("q", "quiet"),
        flag("s", "silent"),
        flag("v", "verbose"),
        flag("z", "zero"),
      ],
    },
    operands: "paths to resolve",
  }),
  getoptProfile({
    name: "realpath",
    grammar: {
      options: [
        flag("e", "canonicalize-existing"),
        flag("m", "canonicalize-missing"),
        flag("L", "logical"),
        flag("P", "physical"),
        flag("q", "quiet"),
        flag("s", "strip"),
        flag(undefined, "no-symlinks"),
        flag("z", "zero"),
        valued(undefined, "relative-to", "DIR"),
        valued(undefined, "relative-base", "DIR"),
      ],
    },
    operands: "paths to resolve",
  }),
  getoptProfile({
    name: "rg",
    grammar: {
      options: [
        valued("A", "after-context", "NUM", isCount),
        valued("B", "before-context", "NUM", isCount),
        valued("C", "context", "NUM", isCount),
        flag("a", "text"),
        flag("b", "byte-offset"),
        flag("c", "count"),
        flag(undefined, "count-matches"),
        flag("s", "case-sensitive"),
        valued(undefined, "color", "WHEN"),
        flag(undefined, "column"),
        flag(undefined, "crlf"),
        valued("d", "max-depth", "NUM", isCount),
        valued("e", "regexp", "PATTERN"),
        valued("f", "file", "PATTERNFILE"),
        flag("F", "fixed-strings"),
        flag(undefined, "files"),
        flag("l", "files-with-matches"),
        flag(undefined, "files-without-match"),
        flag("L", "follow"),
        valued("g", "glob", "GLOB"),
        flag(undefined, "glob-case-insensitive"),
        valued(undefined, "iglob", "GLOB"),
        flag("H", "with-filename"),
        flag("I", "no-filename"),
        flag(undefined, "heading"),
        flag(undefined, "no-heading"),
        flag(undefined, "hidden"),
        flag("i", "ignore-case"),
        flag(undefined, "json"),
        valued("m", "max-count", "NUM", isCount),
        valued("M", "max-columns", "NUM", isCount),
        valued(undefined, "max-filesize", "SIZE"),
        flag("n", "line-number"),
        flag("N", "no-line-number"),
        flag(undefined, "no-config"),
        flag(undefined, "no-ignore"),
        flag(undefined, "no-ignore-dot"),
        flag(undefined, "no-ignore-exclude"),
        flag(undefined, "no-ignore-files"),
        flag(undefined, "no-ignore-global"),
        flag(undefined, "no-ignore-parent"),
        flag(undefined, "no-ignore-vcs"),
        flag(undefined, "no-messages"),
        flag(undefined, "no-require-git"),
        flag("0", "null"),
        flag(undefined, "null-data"),
        flag(undefined, "one-file-system"),
        flag("o", "only-matching"),
        flag("p", "pretty"),
        flag("P", "pcre2"),
        flag("q", "quiet"),
        valued("r", "replace", "REPLACEMENT"),
        flag("S", "smart-case"),
        valued(undefined, "sort", "SORTBY"),
        valued(undefined, "sortr", "SORTBY"),
        flag(undefined, "stats"),
        valued("t", "type", "TYPE"),
        valued("T", "type-not", "TYPE"),
        flag(undefined, "type-list"),
        flag(undefined, "trim"),
        flag("u", "unrestricted"),
        flag("U", "multiline"),
        flag(undefined, "multiline-dotall"),
        flag("v", "invert-match"),
        flag(undefined, "vimgrep"),
        flag("w", "word-regexp"),
        flag("x", "line-regexp"),
      ],
    },
    operands: "a pattern (unless `-e`/`-f`), then files or directories to search",
    environment: [{ variable: "RIPGREP_CONFIG_PATH", unlessOption: "--no-config" }],
  }),
  getoptProfile({
    name: "sed",
    grammar: { options: [flag("n", "quiet"), flag(undefined, "silent")] },
    operands:
      "one script of the form `Np`, `N,Mp`, `$p`, `N,$p` (decimal `N`, `M`) or `/START/,/END/p`, then at most one file",
    requireOption: ["-n", "--quiet", "--silent"],
    note: "One of `-n`, `--quiet` or `--silent` is required. Regex bodies must be nonempty printable ASCII, with no bracket expressions and only the escapes `\\\\`, `\\/`, `\\*`, `\\.`, `\\^`, `\\$`; no extra commands or modifiers.",
    maxOperands: 2,
    check(operands) {
      const script = operands[0];
      if (script === undefined || !isSedPrintScript(script.value)) {
        return operandIssue(
          script,
          "sed accepts only a numeric or restricted regex-range print script",
        );
      }
      return undefined;
    },
  }),
  sleepProfile,
  getoptProfile({
    name: "sort",
    grammar: {
      options: [
        flag("b", "ignore-leading-blanks"),
        flag("c"),
        flag("C"),
        flag("d", "dictionary-order"),
        flag("f", "ignore-case"),
        flag("g", "general-numeric-sort"),
        flag("h", "human-numeric-sort"),
        flag("i", "ignore-nonprinting"),
        valued("k", "key", "KEYDEF"),
        flag("m", "merge"),
        flag("M", "month-sort"),
        flag("n", "numeric-sort"),
        flag("r", "reverse"),
        flag("R", "random-sort"),
        flag("s", "stable"),
        valued("S", "buffer-size", "SIZE"),
        valued("t", "field-separator", "SEP"),
        flag("u", "unique"),
        flag("V", "version-sort"),
        flag("z", "zero-terminated"),
        valued(undefined, "sort", "WORD"),
      ],
    },
    operands: "files to read",
  }),
  getoptProfile({
    name: "stat",
    grammar: {
      options: [
        flag("L", "dereference"),
        valued("c", "format", "FORMAT"),
        valued(undefined, "printf", "FORMAT"),
        flag("f", "file-system"),
        flag("t", "terse"),
      ],
    },
    operands: "files to describe",
  }),
  getoptProfile({
    name: "tail",
    grammar: {
      options: [
        valued("c", "bytes", "NUM", (value) => SIGNED_COUNT.test(value)),
        valued("n", "lines", "NUM", (value) => SIGNED_COUNT.test(value)),
        flag("q", "quiet"),
        flag(undefined, "silent"),
        flag("v", "verbose"),
      ],
      numericOption: true,
    },
    operands: "files to read",
    note: "Operands starting with `+` are not accepted.",
    operandIssue: (operand) =>
      operand.value.startsWith("+")
        ? "tail operands starting with + are not accepted (obsolete option syntax)"
        : undefined,
  }),
  getoptProfile({
    name: "tr",
    grammar: {
      options: [
        flag("c", "complement"),
        flag("C"),
        flag("d", "delete"),
        flag("s", "squeeze-repeats"),
        flag("t", "truncate-set1"),
      ],
    },
    operands: "character sets (not files); reads standard input only",
  }),
  anyWordsProfile("true", "Any words (ignored)."),
  getoptProfile({
    name: "uniq",
    grammar: {
      options: [
        flag("c", "count"),
        flag("d", "repeated"),
        flag("D"),
        valued("f", "skip-fields", "N", isCount),
        flag("i", "ignore-case"),
        valued("s", "skip-chars", "N", isCount),
        flag("u", "unique"),
      ],
    },
    operands: "at most one input file (a second operand names an output file)",
    maxOperands: 1,
  }),
  getoptProfile({
    name: "wc",
    grammar: {
      options: [
        flag("c", "bytes"),
        flag("l", "lines"),
        flag("m", "chars"),
        flag("w", "words"),
        flag("L", "max-line-length"),
      ],
    },
    operands: "files to read",
  }),
];

const PROFILE_MAP: ReadonlyMap<string, KnownReadOnlyProfile> = new Map(
  PROFILES.map((profile) => [profile.name, profile]),
);

/** Exact-name profile lookup; command names never contain `/`. */
export function knownReadOnlyProfile(name: string): KnownReadOnlyProfile | undefined {
  return PROFILE_MAP.get(name);
}

export const KNOWN_READ_ONLY_PROFILES: readonly KnownReadOnlyProfile[] = Object.freeze(
  [...PROFILES].sort((left, right) => left.name.localeCompare(right.name, "en")),
);

export const KNOWN_READ_ONLY_COMMANDS: readonly KnownReadOnlyCommandDescription[] = Object.freeze(
  KNOWN_READ_ONLY_PROFILES.map((profile) =>
    Object.freeze({ name: profile.name, kind: profile.kind, summary: profile.summary }),
  ),
);

function tableCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/** Deterministic administrator documentation table: one row per known read-only command. */
export function renderKnownReadOnlyTable(): string {
  const rows = KNOWN_READ_ONLY_COMMANDS.map(
    (command) =>
      `| \`${command.name}\` | ${command.kind === "shell_builtin" ? "shell builtin" : "executable"} | ${tableCell(command.summary)} |`,
  );
  return [
    "| Command | Kind | Accepted options and operands |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
