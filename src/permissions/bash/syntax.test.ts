import { describe, expect, it } from "vitest";

import {
  MAX_COMMAND_BYTES,
  parseBashCommand,
  type BashScript,
  type BashSimpleCommand,
} from "./syntax.js";

function script(input: string): BashScript {
  const result = parseBashCommand(input);
  if (!result.ok) {
    throw new Error(`expected ${JSON.stringify(input)} to parse: ${result.issue.message}`);
  }
  return result.script;
}

function commands(input: string): BashSimpleCommand[] {
  return script(input).statements.flatMap((statement) =>
    statement.pipelines.flatMap((pipeline) => [...pipeline.commands]),
  );
}

function argv(input: string): string[][] {
  return commands(input).map((command) => command.words.map((word) => word.value));
}

function issue(input: string): { code: string; offset?: number } {
  const result = parseBashCommand(input);
  if (result.ok) {
    throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
  }
  const { code, offset } = result.issue;
  return offset === undefined ? { code } : { code, offset };
}

describe("Bash recognizer words", () => {
  it("decodes unquoted, single-quoted and double-quoted parts", () => {
    expect(argv(`cat a'b c'"d e" '' "" x.y,z:@%+=-_/`)).toEqual([
      ["cat", "ab cd e", "", "", "x.y,z:@%+=-_/"],
    ]);
    const [command] = commands(`ls  -la 'x y'`);
    expect(command?.words).toEqual([
      { value: "ls", raw: "ls", offset: 0, end: 2, quoted: false },
      { value: "-la", raw: "-la", offset: 4, end: 7, quoted: false },
      { value: "x y", raw: "'x y'", offset: 8, end: 13, quoted: true },
    ]);
  });

  it("keeps quoted metacharacters, newlines and non-ASCII text literal", () => {
    expect(argv(`echo '$x' "a'b" '\\' '!' "#" "*?[]{}()~" 'é' "日本"`)).toEqual([
      ["echo", "$x", "a'b", "\\", "!", "#", "*?[]{}()~", "é", "日本"],
    ]);
    expect(argv("echo 'a\nb'\techo")).toEqual([["echo", "a\nb", "echo"]]);
    expect(argv("echo '\u00a0x'")).toEqual([["echo", "\u00a0x"]]);
  });

  it.each([
    ["ls $x", 3],
    ["ls ${x@P}", 3],
    ["echo $(( $(id) ))", 5],
    ["ls `id`", 3],
    ["l\\s", 1],
    ["ls ~", 3],
    ["ls *", 3],
    ["ls a?", 4],
    ["ls [a]", 3],
    ["{ls,-la}", 0],
    ["rg --pre{=,=sh} x", 8],
    ["find . -de\\lete", 10],
    ["ls #c", 3],
    ["ls a#c", 4],
    ["ls ^x", 3],
    ["echo $'\\x6c\\x73'", 5],
    ['echo "$x"', 6],
    ['echo "a\\b"', 7],
    ['echo "`id`"', 6],
    ['echo "!x"', 6],
    ["ls\u00a0x", 2],
    ["ls é", 3],
    ["echo !x", 5],
    ["ls\\\n-la", 2],
  ])("rejects unsupported character in %j", (input, offset) => {
    expect(issue(input)).toEqual({ code: "unsupported_character", offset });
  });

  it("rejects malformed input text", () => {
    expect(issue("ls\r")).toEqual({ code: "unsupported_character", offset: 2 });
    expect(issue("ls\0")).toEqual({ code: "unsupported_character", offset: 2 });
    expect(issue("echo '\u001b[31m'")).toEqual({ code: "unsupported_character", offset: 6 });
    expect(issue("echo '\u007f'")).toEqual({ code: "unsupported_character", offset: 6 });
    expect(issue("echo '\ud800'")).toEqual({ code: "unsupported_character", offset: 6 });
    expect(issue("echo '\udc00'")).toEqual({ code: "unsupported_character", offset: 6 });
    expect(issue("echo '\v'")).toEqual({ code: "unsupported_character", offset: 6 });
    expect(issue(`echo 'x`)).toEqual({ code: "unsupported_syntax", offset: 5 });
    expect(issue(`echo "x`)).toEqual({ code: "unsupported_syntax", offset: 5 });
    expect(argv(`echo '😀'`)).toEqual([["echo", "😀"]]);
  });

  it("enforces the input size limit in UTF-8 bytes", () => {
    const fits = `echo '${"x".repeat(MAX_COMMAND_BYTES - 7)}'`;
    expect(Buffer.byteLength(fits)).toBe(MAX_COMMAND_BYTES);
    expect(parseBashCommand(fits).ok).toBe(true);
    expect(issue(`echo '${"é".repeat(MAX_COMMAND_BYTES / 2)}'`)).toEqual({
      code: "input_too_large",
    });
  });
});

describe("Bash recognizer structure", () => {
  it("parses statements, lists and pipelines", () => {
    const parsed = script("\n\nls -la | grep x | head -3 && pwd || echo no; cat a\n\ntrue;\n");
    expect(
      parsed.statements.map((statement) => ({
        operators: statement.operators,
        pipelines: statement.pipelines.map((pipeline) =>
          pipeline.commands.map((command) => command.words.map((word) => word.value).join(" ")),
        ),
      })),
    ).toEqual([
      {
        operators: ["&&", "||"],
        pipelines: [["ls -la", "grep x", "head -3"], ["pwd"], ["echo no"]],
      },
      { operators: [], pipelines: [["cat a"]] },
      { operators: [], pipelines: [["true"]] },
    ]);
  });

  it("treats newlines after |, && and || as whitespace", () => {
    expect(script("ls |\n\n grep x &&\n pwd ||\n\n echo").statements).toHaveLength(1);
    expect(script("ls\npwd").statements).toHaveLength(2);
    expect(script("ls;\n\npwd;").statements).toHaveLength(2);
    expect(script("ls ; pwd").statements).toHaveLength(2);
  });

  it.each([
    ["", undefined, "empty_command"],
    ["\n\n", undefined, "empty_command"],
    ["  \t", undefined, "empty_command"],
    [";", 0, "unsupported_syntax"],
    ["ls;;", 2, "unsupported_syntax"],
    ["ls; ;", 4, "unsupported_syntax"],
    ["ls\n;", 3, "unsupported_syntax"],
    ["ls;&", 2, "unsupported_syntax"],
    ["| ls", 0, "unsupported_syntax"],
    ["ls |", 4, "unsupported_syntax"],
    ["ls &&", 5, "unsupported_syntax"],
    ["ls ||\n", 6, "unsupported_syntax"],
    ["ls && ; pwd", 6, "unsupported_syntax"],
    ["ls | | pwd", 5, "unsupported_syntax"],
    ["ls &", 3, "unsupported_syntax"],
    ["ls & pwd", 3, "unsupported_syntax"],
    ["ls |& head", 3, "unsupported_syntax"],
    ["(ls)", 0, "unsupported_syntax"],
    ["ls )", 3, "unsupported_syntax"],
    ["! ls", 0, "unsupported_character"],
    ["time ls", 0, "unsupported_syntax"],
    ["if ls", 0, "unsupported_syntax"],
    ["ls; then", 4, "unsupported_syntax"],
    ["function ls", 0, "unsupported_syntax"],
    ["coproc ls", 0, "unsupported_syntax"],
    ["PAGER=curl ls", 0, "unsupported_syntax"],
    ["A+=1 ls", 0, "unsupported_syntax"],
    [">/dev/null X=1 ls", 11, "unsupported_syntax"],
    ["ls <(pwd)", 3, "unsupported_syntax"],
    ["ls >(pwd)", 3, "unsupported_syntax"],
    ["> x", 0, "unsupported_redirection"],
    [">/dev/null", 0, "empty_command"],
    ["ls | 2>/dev/null", 5, "empty_command"],
  ])("rejects %j", (input, offset, code) => {
    expect(issue(input)).toEqual(offset === undefined ? { code } : { code, offset });
  });

  it("does not treat quoted reserved words or quoted assignments specially", () => {
    expect(argv("'time' ls")).toEqual([["time", "ls"]]);
    expect(argv(`X"=1" ls`)).toEqual([["X=1", "ls"]]);
    expect(argv(`'X'=1 ls`)).toEqual([["X=1", "ls"]]);
    expect(argv("echo X=1 if then")).toEqual([["echo", "X=1", "if", "then"]]);
  });

  it("invokes hooks in source order and stops at the first issue", () => {
    const seen: string[] = [];
    const result = parseBashCommand("ls a; rm b; cat $x", {
      commandName(word) {
        seen.push(`name:${word.value}`);
        return word.value === "rm"
          ? { code: "unknown_command", message: "unknown", offset: word.offset }
          : undefined;
      },
      command(command) {
        seen.push(`command:${command.words.map((word) => word.value).join(" ")}`);
        return undefined;
      },
    });
    expect(result).toEqual({
      ok: false,
      issue: { code: "unknown_command", message: "unknown", offset: 6 },
    });
    expect(seen).toEqual(["name:ls", "command:ls a", "name:rm"]);
  });
});

describe("Bash recognizer redirections", () => {
  it("normalizes accepted redirections in source order", () => {
    const [command] = commands(
      "ls >/dev/null 2>>/dev/null &>/dev/null 1>>'/dev/null' 2>&1 1>&2 >&2 2>&2 1>&1 >& 1 <in 0< 'in put'",
    );
    expect(command?.words.map((word) => word.value)).toEqual(["ls"]);
    expect(
      command?.redirections.map((redirection) => {
        switch (redirection.kind) {
          case "discard":
            return `discard ${redirection.fds.join("+")}${redirection.append ? " append" : ""} @${redirection.offset}`;
          case "duplicate":
            return `dup ${redirection.fd}->${redirection.target} @${redirection.offset}`;
          case "input":
            return `input ${redirection.target.value} @${redirection.offset}`;
        }
      }),
    ).toEqual([
      "discard 1 @3",
      "discard 2 append @14",
      "discard 1+2 @27",
      "discard 1 append @39",
      "dup 2->1 @54",
      "dup 1->2 @59",
      "dup 1->2 @64",
      "dup 2->2 @68",
      "dup 1->1 @73",
      "dup 1->1 @78",
      "input in @83",
      "input in put @87",
    ]);
  });

  it("applies the Bash descriptor-number rule", () => {
    const [unspaced] = commands("echo 2>/dev/null");
    expect(unspaced?.words.map((word) => word.value)).toEqual(["echo"]);
    expect(unspaced?.redirections[0]).toMatchObject({ kind: "discard", fds: [2] });

    for (const input of [
      "echo 2 >/dev/null",
      "echo a2>/dev/null",
      `echo '2'>/dev/null`,
      `echo 2"">/dev/null`,
      "echo -2>/dev/null",
      "echo 2&>/dev/null",
    ]) {
      const [command] = commands(input);
      expect(command?.words).toHaveLength(2);
      const first = command?.redirections[0];
      expect(first?.kind === "discard" ? first.fds[0] : undefined).toBe(1);
    }

    const [dupThenDiscard] = commands("echo hi >&2>/dev/null");
    expect(dupThenDiscard?.redirections).toMatchObject([
      { kind: "duplicate", fd: 1, target: 2 },
      { kind: "discard", fds: [1] },
    ]);
    expect(commands("2>/dev/null ls")[0]?.words.map((word) => word.value)).toEqual(["ls"]);
  });

  it.each([
    ["ls > out", 3],
    ["ls >>x", 3],
    ["ls 2>/dev/nul", 3],
    ["ls &>out", 3],
    ["ls &>>/dev/null", 3],
    ["ls >/dev/null2>&1", 3],
    ["ls 0>/dev/null", 3],
    ["ls 3>/dev/null", 3],
    ["ls 12>/dev/null", 3],
    ["ls 01>/dev/null", 3],
    ["ls 99999999999999999999>/dev/null", 3],
    ["ls 2>&3", 3],
    ["ls 2>&0", 3],
    ["ls 0>&1", 3],
    ["ls >&file", 3],
    ["ls >&/dev/null", 3],
    ["ls >&-", 3],
    ["ls 2>&-", 3],
    ["ls >&'1'", 3],
    ["ls 2>&1x", 3],
    ["ls <&0", 3],
    ["ls <>x", 3],
    ["ls >|/dev/null", 3],
    ["ls <<EOF", 3],
    ["ls <<<x", 3],
    ["ls 1<x", 3],
    ["ls 2<x", 3],
    ["cat </dev/tcp/1.2.3.4/80", 4],
    ["cat <'/dev/udp/h/53'", 4],
    ["cat <//dev//tcp/h/80", 4],
  ])("rejects redirection %j", (input, offset) => {
    expect(issue(input)).toEqual({ code: "unsupported_redirection", offset });
  });

  it.each([
    ["ls >", 4, "unsupported_syntax"],
    ["ls >\n/dev/null", 4, "unsupported_syntax"],
    ["ls > 2>/dev/null", 5, "unsupported_syntax"],
    ["ls < ;", 5, "unsupported_syntax"],
    ["ls >&", 3, "unsupported_redirection"],
  ])("rejects missing redirection target %j", (input, offset, code) => {
    expect(issue(input)).toEqual({ code, offset });
  });
});
