import type { BashAnalysisIssue, BashAnalysisIssueCode } from "./contracts.js";

/** Strict recognizer for the curated Bash subset in specs/bash-command-analysis.md Section 7. */

export const MAX_COMMAND_BYTES = 16 * 1024;

interface BashWordSource {
  /** Exact source text, including quotes. */
  readonly raw: string;
  readonly offset: number;
  readonly end: number;
  readonly quoted: boolean;
}

export interface BashLiteralWord extends BashWordSource {
  readonly kind: "literal";
  /** Exact literal value after quote removal; never expanded or rescanned. */
  readonly value: string;
}

export interface BashHomeRelativeWord extends BashWordSource {
  readonly kind: "home_relative";
  /** Literal text after the initial ~/; HOME is deliberately not resolved. */
  readonly suffix: string;
  readonly quoted: false;
}

export type BashWord = BashLiteralWord | BashHomeRelativeWord;

export type BashStandardStream = 1 | 2;

export type BashRedirection =
  | {
      readonly kind: "discard";
      readonly fds: readonly BashStandardStream[];
      readonly append: boolean;
      readonly target: BashLiteralWord;
      readonly offset: number;
    }
  | {
      readonly kind: "duplicate";
      readonly fd: BashStandardStream;
      readonly target: BashStandardStream;
      readonly offset: number;
    }
  | {
      readonly kind: "input";
      readonly fd: 0;
      readonly target: BashLiteralWord;
      readonly offset: number;
    };

export interface BashSimpleCommand {
  /** Arguments in source order; the first word is the command name. */
  readonly words: readonly BashWord[];
  /** Redirections in source order, applied by Bash left to right. */
  readonly redirections: readonly BashRedirection[];
  readonly offset: number;
}

export interface BashPipeline {
  readonly commands: readonly BashSimpleCommand[];
}

export type BashListOperator = "&&" | "||";

export interface BashAndOrList {
  readonly pipelines: readonly BashPipeline[];
  /** Operator before each pipeline after the first. */
  readonly operators: readonly BashListOperator[];
}

export interface BashScript {
  readonly statements: readonly BashAndOrList[];
}

/** Optional semantic checks invoked in source order; an issue stops recognition. */
export interface BashParseHooks {
  commandName?(word: BashLiteralWord): BashAnalysisIssue | undefined;
  command?(command: BashSimpleCommand): BashAnalysisIssue | undefined;
}

export type BashParseResult =
  | { readonly ok: true; readonly script: BashScript }
  | { readonly ok: false; readonly issue: BashAnalysisIssue };

const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "!",
  "[[",
  "]]",
  "{",
  "}",
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while",
]);

const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const NETWORK_PATH = /^\/+dev\/+(?:tcp|udp)(?:\/|$)/;
const EXCERPT_LIMIT = 40;

type Operator = ";" | "|" | "&&" | "||" | "<" | ">" | ">>" | "&>" | ">&";

type Token =
  | { readonly type: "word"; readonly word: BashWord; readonly ioNumber: boolean }
  | { readonly type: "operator"; readonly operator: Operator; readonly offset: number }
  | { readonly type: "newline"; readonly offset: number }
  | { readonly type: "end"; readonly offset: number };

class RecognitionError extends Error {
  public constructor(public readonly issue: BashAnalysisIssue) {
    super(issue.message);
  }
}

function fail(code: BashAnalysisIssueCode, message: string, offset?: number): never {
  throw new RecognitionError(offset === undefined ? { code, message } : { code, message, offset });
}

/** Bounded, single-line quotation of untrusted input for issue messages. */
export function excerpt(text: string, limit = EXCERPT_LIMIT): string {
  const shortened = text.length > limit ? `${text.slice(0, limit)}...` : text;
  return JSON.stringify(shortened).replace(
    /[^ -~]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function describeCharacter(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  if (code < 0x20 || code >= 0x7f) {
    return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return JSON.stringify(character);
}

function isUnquotedCharacter(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    "_./,:@%+=-".includes(String.fromCharCode(code))
  );
}

function isWordBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === ";" ||
    character === "|" ||
    character === "&" ||
    character === "<" ||
    character === ">" ||
    character === "(" ||
    character === ")"
  );
}

function checkInput(input: string): void {
  if (Buffer.byteLength(input, "utf8") > MAX_COMMAND_BYTES) {
    fail("input_too_large", `command exceeds ${MAX_COMMAND_BYTES} bytes`);
  }
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      fail("unsupported_character", "invalid Unicode text", index);
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      fail("unsupported_character", "invalid Unicode text", index);
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      fail(
        "unsupported_character",
        `control character ${describeCharacter(input[index] ?? "")} is not supported`,
        index,
      );
    }
  }
}

class Lexer {
  private position = 0;
  private lookahead: Token | undefined;

  public constructor(private readonly input: string) {}

  public peek(): Token {
    this.lookahead ??= this.scan();
    return this.lookahead;
  }

  public next(): Token {
    const token = this.peek();
    this.lookahead = undefined;
    return token;
  }

  private scan(): Token {
    const input = this.input;
    while (input[this.position] === " " || input[this.position] === "\t") {
      this.position += 1;
    }
    const offset = this.position;
    const character = input[offset];
    const following = input[offset + 1];
    if (character === undefined) {
      return { type: "end", offset };
    }
    switch (character) {
      case "\n":
        this.position += 1;
        return { type: "newline", offset };
      case ";":
        if (following === ";" || following === "&") {
          fail("unsupported_syntax", `operator ";${following}" is not supported`, offset);
        }
        return this.operator(";", offset);
      case "|":
        if (following === "|") return this.operator("||", offset);
        if (following === "&") fail("unsupported_syntax", 'operator "|&" is not supported', offset);
        return this.operator("|", offset);
      case "&":
        if (following === "&") return this.operator("&&", offset);
        if (following === ">") {
          if (input[offset + 2] === ">") {
            fail("unsupported_redirection", 'redirection "&>>" is not supported', offset);
          }
          return this.operator("&>", offset);
        }
        fail("unsupported_syntax", "background execution with & is not supported", offset);
        break;
      case "<":
        if (following === "<") {
          fail(
            "unsupported_redirection",
            "here-documents and here-strings are not supported",
            offset,
          );
        }
        if (following === "&" || following === ">") {
          fail("unsupported_redirection", `redirection "<${following}" is not supported`, offset);
        }
        if (following === "(") {
          fail("unsupported_syntax", "process substitution is not supported", offset);
        }
        return this.operator("<", offset);
      case ">":
        if (following === ">") return this.operator(">>", offset);
        if (following === "&") return this.operator(">&", offset);
        if (following === "|") {
          fail("unsupported_redirection", 'redirection ">|" is not supported', offset);
        }
        if (following === "(") {
          fail("unsupported_syntax", "process substitution is not supported", offset);
        }
        return this.operator(">", offset);
      case "(":
      case ")":
        fail("unsupported_syntax", "subshells and grouping are not supported", offset);
        break;
      default:
        break;
    }
    return this.word(offset);
  }

  private operator(operator: Operator, offset: number): Token {
    this.position = offset + operator.length;
    return { type: "operator", operator, offset };
  }

  private word(offset: number): Token {
    const input = this.input;
    if (input[offset] === "~" && input[offset + 1] === "/") {
      return this.homeRelativeWord(offset);
    }
    let value = "";
    let quoted = false;
    for (;;) {
      const character = input[this.position];
      if (isWordBoundary(character)) {
        break;
      }
      const start = this.position;
      if (character === "'") {
        const close = input.indexOf("'", start + 1);
        if (close < 0) fail("unsupported_syntax", "unterminated single quote", start);
        value += input.slice(start + 1, close);
        quoted = true;
        this.position = close + 1;
        continue;
      }
      if (character === '"') {
        let index = start + 1;
        for (;;) {
          const inner = input[index];
          if (inner === undefined) fail("unsupported_syntax", "unterminated double quote", start);
          if (inner === '"') break;
          if (inner === "\\") {
            const next = input[index + 1];
            if (next === undefined) fail("unsupported_syntax", "unterminated double quote", start);
            if (next === "\n") {
              fail("unsupported_character", "line continuations are not supported", index);
            }
            if (next === "!") {
              fail(
                "unsupported_character",
                'character "!" is not supported inside double quotes',
                index + 1,
              );
            }
            value +=
              next === '"' || next === "\\" || next === "$" || next === "`" ? next : `\\${next}`;
            index += 2;
            continue;
          }
          if (inner === "$" || inner === "`" || inner === "!") {
            fail(
              "unsupported_character",
              `character ${JSON.stringify(inner)} is not supported inside double quotes`,
              index,
            );
          }
          value += inner;
          index += 1;
        }
        quoted = true;
        this.position = index + 1;
        continue;
      }
      const code = input.charCodeAt(start);
      if (!isUnquotedCharacter(code)) {
        const outside = code >= 0x80 ? "non-ASCII character" : "character";
        fail(
          "unsupported_character",
          `${outside} ${describeCharacter(String.fromCodePoint(input.codePointAt(start) ?? code))} is not supported outside quotes`,
          start,
        );
      }
      value += character;
      this.position += 1;
    }
    const raw = input.slice(offset, this.position);
    const next = input[this.position];
    const ioNumber = !quoted && /^[0-9]+$/.test(raw) && (next === "<" || next === ">");
    return {
      type: "word",
      word: { kind: "literal", value, raw, offset, end: this.position, quoted },
      ioNumber,
    };
  }

  private homeRelativeWord(offset: number): Token {
    this.position = offset + 2;
    while (!isWordBoundary(this.input[this.position])) {
      if (!isUnquotedCharacter(this.input.charCodeAt(this.position))) {
        fail(
          "unsupported_character",
          "home-relative paths require a wholly unquoted literal suffix",
          this.position,
        );
      }
      this.position += 1;
    }
    return {
      type: "word",
      word: {
        kind: "home_relative",
        suffix: this.input.slice(offset + 2, this.position),
        raw: this.input.slice(offset, this.position),
        offset,
        end: this.position,
        quoted: false,
      },
      ioNumber: false,
    };
  }
}

function describeToken(token: Token): string {
  switch (token.type) {
    case "word":
      return `word ${excerpt(token.word.raw)}`;
    case "operator":
      return `"${token.operator}"`;
    case "newline":
      return "newline";
    case "end":
      return "end of input";
  }
}

class Parser {
  private readonly lexer: Lexer;

  public constructor(
    input: string,
    private readonly hooks: BashParseHooks,
  ) {
    this.lexer = new Lexer(input);
  }

  public script(): BashScript {
    const statements: BashAndOrList[] = [];
    this.skipNewlines();
    while (this.lexer.peek().type !== "end") {
      statements.push(this.andOrList());
      const token = this.lexer.peek();
      if (token.type === "operator" && token.operator === ";") {
        this.lexer.next();
        this.skipNewlines();
      } else if (token.type === "newline") {
        this.skipNewlines();
      } else if (token.type !== "end") {
        fail("unsupported_syntax", `unexpected ${describeToken(token)}`, tokenOffset(token));
      }
    }
    if (statements.length === 0) {
      fail("empty_command", "the command is empty");
    }
    return { statements };
  }

  private skipNewlines(): void {
    while (this.lexer.peek().type === "newline") {
      this.lexer.next();
    }
  }

  private andOrList(): BashAndOrList {
    const pipelines = [this.pipeline()];
    const operators: BashListOperator[] = [];
    for (;;) {
      const token = this.lexer.peek();
      if (token.type !== "operator" || (token.operator !== "&&" && token.operator !== "||")) {
        break;
      }
      this.lexer.next();
      this.skipNewlines();
      operators.push(token.operator);
      pipelines.push(this.pipeline());
    }
    return { pipelines, operators };
  }

  private pipeline(): BashPipeline {
    const commands = [this.simpleCommand()];
    for (;;) {
      const token = this.lexer.peek();
      if (token.type !== "operator" || token.operator !== "|") {
        break;
      }
      this.lexer.next();
      this.skipNewlines();
      commands.push(this.simpleCommand());
    }
    return { commands };
  }

  private simpleCommand(): BashSimpleCommand {
    const words: BashWord[] = [];
    const redirections: BashRedirection[] = [];
    const first = this.lexer.peek();
    const offset = tokenOffset(first);
    for (;;) {
      const token = this.lexer.peek();
      if (token.type === "word" && !token.ioNumber) {
        this.lexer.next();
        if (words.length === 0) {
          this.checkCommandName(token.word);
        }
        words.push(token.word);
        continue;
      }
      if (token.type === "word" || (token.type === "operator" && isRedirection(token.operator))) {
        redirections.push(this.redirection());
        continue;
      }
      break;
    }
    if (words.length === 0) {
      if (redirections.length === 0) {
        const token = this.lexer.peek();
        fail("unsupported_syntax", `expected a command before ${describeToken(token)}`, offset);
      }
      fail("empty_command", "a command consisting only of redirections is not supported", offset);
    }
    const command: BashSimpleCommand = { words, redirections, offset };
    const issue = this.hooks.command?.(command);
    if (issue !== undefined) {
      throw new RecognitionError(issue);
    }
    return command;
  }

  private checkCommandName(word: BashWord): void {
    if (word.kind !== "literal") {
      fail("unknown_command", "home-relative command names are not supported", word.offset);
    }
    if (!word.quoted && RESERVED_WORDS.has(word.raw)) {
      fail(
        "unsupported_syntax",
        `reserved word ${excerpt(word.raw)} is not supported`,
        word.offset,
      );
    }
    if (ASSIGNMENT_PREFIX.test(word.raw)) {
      fail("unsupported_syntax", "variable assignments are not supported", word.offset);
    }
    const issue = this.hooks.commandName?.(word);
    if (issue !== undefined) {
      throw new RecognitionError(issue);
    }
  }

  private redirection(): BashRedirection {
    let fd: number | undefined;
    let token = this.lexer.next();
    const offset = tokenOffset(token);
    if (token.type === "word") {
      fd = /^[012]$/.test(token.word.raw) ? Number(token.word.raw) : undefined;
      if (fd === undefined) {
        fail(
          "unsupported_redirection",
          `file descriptor ${excerpt(token.word.raw, 12)} is not supported`,
          offset,
        );
      }
      token = this.lexer.next();
    }
    if (token.type !== "operator") {
      return fail("unsupported_syntax", "malformed redirection", offset);
    }
    switch (token.operator) {
      case "<": {
        if (fd !== undefined && fd !== 0) {
          fail(
            "unsupported_redirection",
            `input redirection for descriptor ${fd} is not supported`,
            offset,
          );
        }
        const target = this.target(offset);
        if (NETWORK_PATH.test(target.value)) {
          fail("unsupported_redirection", "network redirections are not supported", offset);
        }
        return { kind: "input", fd: 0, target, offset };
      }
      case ">":
      case ">>":
      case "&>": {
        const stream = fd ?? 1;
        if (stream === 0) {
          fail(
            "unsupported_redirection",
            "output redirection for descriptor 0 is not supported",
            offset,
          );
        }
        const target = this.target(offset);
        if (target.value !== "/dev/null") {
          fail(
            "unsupported_redirection",
            "output redirection to a file is not read-only (only /dev/null is accepted)",
            offset,
          );
        }
        const fds: readonly BashStandardStream[] =
          token.operator === "&>" ? [1, 2] : [stream as BashStandardStream];
        return { kind: "discard", fds, append: token.operator === ">>", target, offset };
      }
      case ">&": {
        const stream = fd ?? 1;
        if (stream === 0) {
          fail("unsupported_redirection", "duplicating descriptor 0 is not supported", offset);
        }
        const target = this.lexer.next();
        if (
          target.type !== "word" ||
          target.word.quoted ||
          (target.word.raw !== "1" && target.word.raw !== "2")
        ) {
          fail(
            "unsupported_redirection",
            "only duplication between descriptors 1 and 2 is supported",
            offset,
          );
        }
        return {
          kind: "duplicate",
          fd: stream as BashStandardStream,
          target: Number(target.word.raw) as BashStandardStream,
          offset,
        };
      }
      default:
        return fail("unsupported_syntax", "malformed redirection", offset);
    }
  }

  private target(offset: number): BashLiteralWord {
    const token = this.lexer.next();
    if (token.type !== "word" || token.ioNumber) {
      fail(
        "unsupported_syntax",
        `expected a redirection target before ${describeToken(token)}`,
        tokenOffset(token),
      );
    }
    if (token.word.kind !== "literal") {
      fail(
        "unsupported_redirection",
        "home-relative redirection targets are not supported",
        offset,
      );
    }
    return token.word;
  }
}

function isRedirection(operator: Operator): boolean {
  return (
    operator === "<" ||
    operator === ">" ||
    operator === ">>" ||
    operator === "&>" ||
    operator === ">&"
  );
}

function tokenOffset(token: Token): number {
  return token.type === "word" ? token.word.offset : token.offset;
}

/**
 * Recognize `input` as the literal Bash subset, or report the first reason it is outside it.
 * There is no error recovery; every accepted input has exactly the structure Bash executes.
 */
export function parseBashCommand(input: string, hooks: BashParseHooks = {}): BashParseResult {
  try {
    checkInput(input);
    return Object.freeze({ ok: true, script: new Parser(input, hooks).script() });
  } catch (error) {
    if (error instanceof RecognitionError) {
      return Object.freeze({ ok: false, issue: Object.freeze({ ...error.issue }) });
    }
    throw error;
  }
}
