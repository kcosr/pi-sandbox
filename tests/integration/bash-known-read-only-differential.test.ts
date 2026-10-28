import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBashCommandAnalyzer } from "../../src/permissions/bash/analyzer.js";
import type { BashCommandAnalyzer } from "../../src/permissions/bash/contracts.js";
import {
  KNOWN_READ_ONLY_COMMANDS,
  knownReadOnlyProfile,
} from "../../src/permissions/bash/registry.js";
import {
  parseBashCommand,
  type BashPipeline,
  type BashScript,
  type BashWord,
} from "../../src/permissions/bash/syntax.js";

/**
 * Differential qualification of the recognizer against the real `/bin/bash -c`
 * (specs/bash-command-analysis.md Section 11). Executables on PATH are POSIX `sh`
 * stubs: each writes a unique marker to standard output and standard error, and
 * records its name, argv, the file type of descriptors 0-2 and every marker it
 * reads from standard input. Standard input and input files carry their own
 * markers. Where each marker arrives shows stage wiring, capture routing,
 * `/dev/null` discards and duplication without device or inode numbers, which
 * differ between Linux and the macOS `/dev/fd` file system. Builtins run for real
 * and produce no record.
 */

const BASH = "/bin/bash";
const MKTEMP = "/usr/bin/mktemp";
const CAT = "/bin/cat";
const MV = "/bin/mv";
const available = [BASH, MKTEMP, CAT, MV].every((path) => existsSync(path));
const EXECUTABLES = KNOWN_READ_ONLY_COMMANDS.filter((command) => command.kind === "executable").map(
  (command) => command.name,
);
const MARKER = /#@[A-Z]:[^@\n]*@#/g;
const STDIN_MARKER = "#@S:stdin@#";
const INPUT_FILES: readonly (readonly [string, string])[] = [
  ["in", "b\na\nb\n"],
  ["in put", "x\n"],
  ["a", "a\n"],
  ["b", "b\n"],
  ["x", "x\n"],
  ["sub/nested", "n\n"],
  ["sub/in", "s\n"],
];

/** Descriptor file type: regular file, directory, character device or pipe. */
type Kind = "f" | "d" | "c" | "p";
type Source =
  | { readonly type: "stdin" }
  | { readonly type: "file"; readonly path: string }
  | { readonly type: "pipe"; readonly key: string };
type Sink =
  { readonly type: "out" | "err" | "null" } | { readonly type: "pipe"; readonly key: string };

interface Stage {
  readonly name: string;
  readonly argv: readonly string[];
  readonly kinds: readonly Kind[];
  readonly stdin: Source;
  readonly stdout: Sink;
  readonly stderr: Sink;
  /** Markers read from inherited standard input or an input file. */
  readonly input: readonly string[];
}

interface Observed {
  readonly id: string;
  readonly name: string;
  readonly argv: readonly string[];
  readonly kinds: readonly string[];
  readonly input: readonly string[];
}

interface Prediction {
  readonly stages: readonly Stage[];
  readonly status: number;
}

interface Outcome {
  readonly observed: readonly Observed[];
  readonly incomplete: readonly string[];
  readonly status: number | null;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly stderr: string;
}

function markers(text: string): string[] {
  return text.match(MARKER) ?? [];
}

function kindOf(path: string): Kind {
  const info = statSync(path);
  return info.isDirectory() ? "d" : info.isCharacterDevice() ? "c" : info.isFIFO() ? "p" : "f";
}

function sinkKind(sink: Sink): Kind {
  return sink.type === "null" ? "c" : sink.type === "pipe" ? "p" : "f";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Deterministic PRNG for the generated corpus (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// prettier-ignore
const NAMES = [
  "ls", "cat", "grep", "head", "tail", "sort", "uniq", "wc", "cut", "tr", "nl", "stat", "du",
  "diff", "find", "sed", "rg", "basename", "dirname", "readlink", "realpath", "echo", "true",
  "false", "pwd", "cd", "sleep", "rm", "git", "X=1", "./ls", "'ls'", "l's'",
];
// prettier-ignore
const ARGUMENTS = [
  "-l", "-n", "-a", "-la", "-c", "-u", "-r", "-s", "-v", "-i", "-1", "-n5", "-n 2", "-5", "-o",
  "-z", "-e x", "-k2", "-t:", "--", "-", "x", "in", "sub", ".", "a", "b", "'a b'", '"c d"', "''",
  '""', "2", "1", "0", "12", "a2", "'2'", "x=y", "1p", "'$p'", "1,2p", "+5", "--pre=sh", "--color",
  "--color=never", "-name", "'*.txt'", "-type", "f", "-print", "'('", "')'", "'!'", "-delete",
  "'é'", '"ü"', "'a\nb'", "'\t'", "%s", "@:,+=", "-P", "-L",
  "~/sub", "~/missing", '"a\\|b"', '"a\\$b"', '"a\\\\b"', "'/a/,/b/p'",
];
// prettier-ignore
const REDIRECTIONS = [
  ">/dev/null", "> /dev/null", "1>/dev/null", "2>/dev/null", ">>/dev/null", "2>>/dev/null",
  "&>/dev/null", "2>&1", "1>&2", ">&2", "2>&2", "1>&1", ">& 1", ">&2", "<in", "< in", "0<in",
  "<'in put'", "<sub", "<missing", "<''", ">out", "2>&3", ">&-", "<<<x", "<>x", ">|/dev/null",
  "&>>/dev/null", "3>/dev/null", "01>/dev/null", ">&/dev/null",
];
// prettier-ignore
const TRICKY = [
  "$x", "`id`", "\\", "*", "?", "{a,b}", "(", ")", "#c", "~", "!", "\r", "\u00a0", "'", '"', "$'x'",
  "[a]", "&", "^", "é", '"$x"', "'\u0007'",
];
// prettier-ignore
const OPERATORS = [
  " | ", " && ", " || ", "; ", "\n", " | ", " && ", "|\n", "&&\n", ";\n", " & ", " |& ", ";;",
  "\n\n",
];
// prettier-ignore
const JOINERS = [
  " ", " ", " ", " ", "\t", "", "  ",
];

function generateCorpus(seed: number, count: number): string[] {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const corpus: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let text = next() < 0.1 ? pick(["", "\n", " ", ";", "\t"]) : "";
    const stages = 1 + Math.floor(next() * 4);
    for (let stage = 0; stage < stages; stage += 1) {
      if (stage > 0) {
        text += pick(OPERATORS);
      }
      const items: string[] = [];
      if (next() < 0.15) {
        items.push(pick(REDIRECTIONS));
      }
      items.push(pick(NAMES));
      const extra = Math.floor(next() * 5);
      for (let item = 0; item < extra; item += 1) {
        const roll = next();
        items.push(roll < 0.55 ? pick(ARGUMENTS) : roll < 0.9 ? pick(REDIRECTIONS) : pick(TRICKY));
      }
      text += items.reduce(
        (joined, item, position) => joined + (position === 0 ? "" : pick(JOINERS)) + item,
        "",
      );
    }
    if (next() < 0.1) {
      text += pick([";", "\n", " ", ";\n"]);
    }
    corpus.push(text);
  }
  return corpus;
}

const ACCEPTED_CORPUS = [
  "ls",
  "ls -la",
  "ls -la | grep x | head -3",
  "cat <in | sort -u | uniq -c | sort -rn | head -n 5",
  "cat 0< 'in put' 2>/dev/null",
  "grep -rn x . 2>&1 | wc -l",
  "rg -n 'a b' 2>&1 >/dev/null | tail -n +2",
  "ls >/dev/null 2>&1",
  "ls 2>&1 >/dev/null",
  "ls >&2 2>/dev/null",
  "ls 1>&2 2>&1",
  "ls &>/dev/null | cat",
  "ls >>/dev/null 2>>/dev/null",
  "echo 2>/dev/null x",
  "echo a2>/dev/null",
  "cat '2'>/dev/null",
  'cat 2"">/dev/null',
  "cat 2 >/dev/null",
  "head -2>/dev/null",
  "cat 2&>/dev/null",
  "ls >&2>/dev/null",
  "ls >& 1",
  "2>/dev/null ls -a",
  "<in cat",
  "cat <missing; ls",
  "cat <missing && ls || head x",
  "cat <in <'in put'",
  "cat <sub",
  "true && ls || cat",
  "false && ls || cat",
  "false || ls && cat",
  "true\nfalse\nls",
  "ls |\n\n grep x &&\n\n head ||\n cat",
  "cd sub && ls; pwd -P",
  "cd sub && cat <nested",
  "cd sub | cat <in",
  "cd missing || ls",
  "cd; ls",
  "cd -; ls",
  "cd . && cd - && ls",
  "cd '' || ls",
  "cd sub | cd - || ls",
  "echo hi | cat; echo there >/dev/null",
  "echo 'a b' \"c d\" '' x=y 'é' '\n' | wc",
  "find . -name '*.txt' '(' -type f -o -type d ')' '!' -empty -print0",
  "sed -n '1,$p' in | nl -ba",
  "tr a-z A-Z <in | cut -d: -f1",
  "stat -c %s in; du -sh .; diff -u in in; readlink -f in; realpath in",
  "basename a/b .c; dirname a/b",
  "ls -- -x '-' --",
  "head -20 in; tail -5 in; tail -n +3 in",
  "rg --no-config -e -x -g '!*.min.js' .",
  "sort -k 2,2 -t : -S 1M in",
  "uniq -c - <in",
  "true;",
  "\n\nls\n\n",
  "ls; cat; head",
  "ls | cat; cat",
  "ls >/dev/null | true",
  "ls | true",
  "ls | cat <in",
  "ls 2>&1 | cat",
  "ls 2>&1 >/dev/null | cat",
  "ls >&2 | cat",
  "ls 2>&1 >&2 | cat",
  "cat <in | cat | cat",
  "cat <in | ls 2>&1 | cat >/dev/null",
  "echo x | cat",
  "true | cat",
  "cat </dev/null",
  "<'in put' cat 2>&1 | wc",
  String.raw`grep "a\|b" in 2>&1 | head`,
  String.raw`grep "\bword\b\n" in`,
  String.raw`cat "a\"b" "c\\d" "\$HOME" | cat`,
  'cat "\\`id\\`" | cat',
  String.raw`cat "2">/dev/null`,
  String.raw`cat <"\/dev/tcp/example.invalid/80" || ls`,
  String.raw`sed -n "/start/,/};/p" in | cat`,
  String.raw`sed -n "/\\*start/,/end\$/p" in`,
  "sleep 0; sleep '1' | cat",
  "cd ~/sub && cat <nested",
  "cd -L -P -L ~/sub && cat <nested",
  "cd -P -- ~/sub && cat <nested",
  "cd ~/missing || cat <in",
  "cd ~/sub | cat <in",
  "cd sub; cd ~/ && cat <in",
  "cd ~/sub >/dev/null && cat <nested",
  // Odd source backslash parity makes a literal dollar, never a substitution.
  'cat "' + "\\".repeat(3) + '$(id)" | cat',
];

function literalValue(word: BashWord | undefined): string {
  if (word?.kind !== "literal") throw new Error("expected a literal word");
  return word.value;
}

function predict(script: BashScript, root: string, emptyCdStatus: number): Prediction {
  const stages: Stage[] = [];
  let cwd = join(root, "work");
  let oldpwd: string | undefined;
  let status = 0;
  let group = 0;
  let stdinConsumed = false;

  const runPipeline = (pipeline: BashPipeline): number => {
    group += 1;
    const count = pipeline.commands.length;
    let last = 0;
    pipeline.commands.forEach((command, index) => {
      const fds: [Source, Sink, Sink] = [
        index === 0 ? { type: "stdin" } : { type: "pipe", key: `${group}:${index - 1}` },
        index === count - 1 ? { type: "out" } : { type: "pipe", key: `${group}:${index}` },
        { type: "err" },
      ];
      let failed = false;
      for (const redirection of command.redirections) {
        if (redirection.kind === "discard") {
          for (const fd of redirection.fds) {
            fds[fd] = { type: "null" };
          }
        } else if (redirection.kind === "duplicate") {
          fds[redirection.fd] = fds[redirection.target];
        } else {
          const path = resolve(cwd, redirection.target.value);
          if (redirection.target.value === "" || !existsSync(path)) {
            failed = true;
            break;
          }
          fds[0] = { type: "file", path };
        }
      }
      const [nameWord, ...argumentWords] = command.words;
      const name = literalValue(nameWord);
      const argv = argumentWords.map((word) =>
        word.kind === "literal" ? word.value : `${join(root, "work")}/${word.suffix}`,
      );
      const [stdin, stdout, stderr] = fds;
      let stageStatus = 0;
      if (failed) {
        stageStatus = 1;
      } else if (knownReadOnlyProfile(name)?.kind === "executable") {
        let input: string[] = [];
        if (stdin.type === "stdin") {
          input = stdinConsumed ? [] : [STDIN_MARKER];
          stdinConsumed = true;
        } else if (stdin.type === "file" && statSync(stdin.path).isFile()) {
          input = markers(readFileSync(stdin.path, "utf8"));
        }
        const inputKind: Kind =
          stdin.type === "file" ? kindOf(stdin.path) : stdin.type === "pipe" ? "p" : "f";
        stages.push({
          name,
          argv,
          kinds: [inputKind, sinkKind(stdout), sinkKind(stderr)],
          stdin,
          stdout,
          stderr,
          input,
        });
      } else if (name === "false") {
        stageStatus = 1;
      } else if (name === "cd") {
        let position = 0;
        while (/^-[LP]+$/.test(argv[position] ?? "")) {
          position += 1;
        }
        if (argv[position] === "--") {
          position += 1;
        }
        const operand = argv[position] ?? join(root, "work");
        const target = operand === "-" ? oldpwd : resolve(cwd, operand);
        if (operand === "") {
          stageStatus = emptyCdStatus;
        } else if (target !== undefined && existsSync(target) && statSync(target).isDirectory()) {
          if (count === 1) {
            oldpwd = cwd;
            cwd = target;
          }
        } else {
          stageStatus = 1;
        }
      }
      if (index === count - 1) {
        last = stageStatus;
      }
    });
    return last;
  };

  for (const statement of script.statements) {
    let last = 0;
    statement.pipelines.forEach((pipeline, index) => {
      const operator = index === 0 ? undefined : statement.operators[index - 1];
      if ((operator === "&&" && last !== 0) || (operator === "||" && last === 0)) {
        return;
      }
      last = runPipeline(pipeline);
    });
    status = last;
  }
  return { stages, status };
}

function sameMarkers(expected: readonly string[], actual: readonly string[]): boolean {
  return JSON.stringify([...expected].sort()) === JSON.stringify([...actual].sort());
}

/**
 * Assign each predicted stage to one recorded invocation with the same name, argv
 * and descriptor kinds, then require every marker to arrive exactly where the
 * prediction routes it: a capture file, the standard input of the stage reading a
 * pipe, or nowhere for `/dev/null` and pipes no recorded stage reads.
 */
function matches(prediction: Prediction, outcome: Outcome): boolean {
  const { stages } = prediction;
  const records = outcome.observed;
  if (outcome.incomplete.length > 0 || stages.length !== records.length) {
    return false;
  }
  const readers = new Map<string, number>();
  stages.forEach((stage, index) => {
    if (stage.stdin.type === "pipe") {
      readers.set(stage.stdin.key, index);
    }
  });
  const used = new Array<boolean>(records.length).fill(false);
  const assigned: Observed[] = [];

  const routed = (): boolean => {
    const out: string[] = [];
    const err: string[] = [];
    const inputs = stages.map((stage) => [...stage.input]);
    stages.forEach((stage, index) => {
      const id = (assigned[index] as Observed).id;
      for (const [sink, marker] of [
        [stage.stdout, `#@O:${id}@#`],
        [stage.stderr, `#@E:${id}@#`],
      ] as const) {
        if (sink.type === "out") {
          out.push(marker);
        } else if (sink.type === "err") {
          err.push(marker);
        } else if (sink.type === "pipe") {
          const reader = readers.get(sink.key);
          if (reader !== undefined) {
            inputs[reader]?.push(marker);
          }
        }
      }
    });
    return (
      sameMarkers(out, outcome.out) &&
      sameMarkers(err, outcome.err) &&
      inputs.every((expected, index) => sameMarkers(expected, (assigned[index] as Observed).input))
    );
  };

  const assign = (index: number): boolean => {
    if (index === stages.length) {
      return routed();
    }
    const stage = stages[index] as Stage;
    for (let candidate = 0; candidate < records.length; candidate += 1) {
      const record = records[candidate] as Observed;
      if (
        used[candidate] === true ||
        record.name !== stage.name ||
        JSON.stringify(record.argv) !== JSON.stringify(stage.argv) ||
        record.kinds.join("") !== stage.kinds.join("")
      ) {
        continue;
      }
      used[candidate] = true;
      assigned[index] = record;
      if (assign(index + 1)) {
        return true;
      }
      used[candidate] = false;
    }
    return false;
  };

  return assign(0);
}

describe.skipIf(!available)("known read-only differential against real Bash", () => {
  let root: string;
  let traceDirectory: string;
  let environment: Record<string, string>;
  let analyzer: BashCommandAnalyzer;
  let emptyCdStatus: number;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-bash-differential-")));
    const work = join(root, "work");
    const stubs = join(root, "stubs");
    traceDirectory = join(root, "trace");
    mkdirSync(join(work, "sub"), { recursive: true });
    mkdirSync(stubs);
    for (const [name, content] of INPUT_FILES) {
      writeFileSync(join(work, name), `${content}#@F:${name}@#\n`);
    }
    writeFileSync(join(root, "stdin"), `${STDIN_MARKER}\n`);
    for (const name of ["out", "err"]) {
      writeFileSync(join(root, name), "");
    }
    const descriptorProbe = join(root, "descriptor-kinds.cjs");
    // Inspect inherited descriptors directly. Darwin /dev/fd path stats can transiently
    // report incorrect types or EBADF; redirecting this helper would change the observed fds.
    writeFileSync(
      descriptorProbe,
      [
        'const { fstatSync, writeFileSync } = require("node:fs");',
        "const kinds = [0, 1, 2].map((fd) => {",
        "  const info = fstatSync(fd);",
        '  if (info.isFIFO()) return "p";',
        '  if (info.isCharacterDevice()) return "c";',
        '  if (info.isDirectory()) return "d";',
        '  if (info.isFile()) return "f";',
        "  throw new Error(`unsupported descriptor type for ${fd}`);",
        '}).join(" ");',
        'writeFileSync(process.argv[2], kinds + "\\n");',
        "",
      ].join("\n"),
    );
    for (const name of EXECUTABLES) {
      const stub = [
        "#!/bin/sh",
        "trap '' PIPE",
        `rec=$(${MKTEMP} ${shellQuote(join(traceDirectory, "rec.XXXXXX"))} 2>/dev/null) || exit 97`,
        "id=${rec##*/}",
        `${shellQuote(process.execPath)} ${shellQuote(descriptorProbe)} "$rec.kinds" || exit 97`,
        'read -r k0 k1 k2 <"$rec.kinds" || exit 97',
        // Each marker write runs in its own subshell: after a failed write (for example a
        // broken pipe), Bash 3.2's printf keeps the unwritten output buffered and would
        // flush it into a later redirection, such as the stderr marker.
        "(printf '#@O:%s@#\\n' \"$id\") 2>/dev/null",
        "(printf '#@E:%s@#\\n' \"$id\") >&2 2>/dev/null",
        `${CAT} >"$rec.in" 2>/dev/null`,
        "{",
        `  printf '%s\\000' ${shellQuote(name)} "$k0" "$k1" "$k2"`,
        '  for arg in "$@"; do printf \'%s\\000\' "$arg"; done',
        `} >"$rec.tmp" 2>/dev/null && ${MV} "$rec.tmp" "$rec.done" 2>/dev/null`,
        "exit 0",
        "",
      ].join("\n");
      writeFileSync(join(stubs, name), stub);
      chmodSync(join(stubs, name), 0o755);
    }
    environment = { PATH: stubs, HOME: work, LC_ALL: "C" };
    emptyCdStatus = spawnSync(BASH, ["-c", "cd ''"], { cwd: work, env: environment }).status ?? -1;
    analyzer = createBashCommandAnalyzer({ backend: "direct", cwd: work, environment });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(command: string): Outcome {
    rmSync(traceDirectory, { recursive: true, force: true });
    mkdirSync(traceDirectory);
    const stdin = openSync(join(root, "stdin"), "r");
    const stdout = openSync(join(root, "out"), "w");
    const stderr = openSync(join(root, "err"), "w");
    let status: number | null;
    try {
      status = spawnSync(BASH, ["-c", command], {
        cwd: join(root, "work"),
        env: environment,
        stdio: [stdin, stdout, stderr],
        timeout: 10_000,
      }).status;
    } finally {
      closeSync(stdin);
      closeSync(stdout);
      closeSync(stderr);
    }
    const observed: Observed[] = [];
    const incomplete: string[] = [];
    for (const id of readdirSync(traceDirectory).filter((file) =>
      /^rec\.[A-Za-z0-9]+$/.test(file),
    )) {
      const done = join(traceDirectory, `${id}.done`);
      if (!existsSync(done)) {
        incomplete.push(id);
        continue;
      }
      const fields = readFileSync(done).toString("utf8").split("\0");
      fields.pop();
      const [name, kind0, kind1, kind2, ...argv] = fields;
      observed.push({
        id,
        name: name ?? "",
        argv,
        kinds: [kind0 ?? "", kind1 ?? "", kind2 ?? ""],
        input: markers(readFileSync(join(traceDirectory, `${id}.in`), "utf8")),
      });
    }
    const errText = readFileSync(join(root, "err"), "utf8");
    return {
      observed,
      incomplete,
      status,
      out: markers(readFileSync(join(root, "out"), "utf8")),
      err: markers(errText),
      stderr: errText,
    };
  }

  function prediction(command: string): Prediction {
    const parsed = parseBashCommand(command);
    if (!parsed.ok) {
      throw new Error(`${command}: ${parsed.issue.message}`);
    }
    return predict(parsed.script, root, emptyCdStatus);
  }

  async function verify(command: string): Promise<void> {
    const parsed = parseBashCommand(command);
    expect(parsed.ok, command).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const analysis = await analyzer.analyze(command);
    expect(analysis, command).toMatchObject({ commandClass: "known_read_only" });
    const names = parsed.script.statements.flatMap((statement) =>
      statement.pipelines.flatMap((pipeline) =>
        pipeline.commands.map((simple) => literalValue(simple.words[0])),
      ),
    );
    if (analysis.commandClass === "known_read_only") {
      expect(analysis.commands, command).toEqual(names);
    }
    const expected = predict(parsed.script, root, emptyCdStatus);
    const outcome = run(command);
    const context = JSON.stringify({ command, expected, outcome });
    expect(outcome.stderr, context).not.toMatch(/syntax error|command not found/);
    expect(outcome.status, context).toBe(expected.status);
    expect(matches(expected, outcome), context).toBe(true);
  }

  it("classifies inherited descriptor kinds directly on this platform", () => {
    const outcome = run("ls </dev/null 2>/dev/null | head <sub");
    const kinds = Object.fromEntries(
      outcome.observed.map((record) => [record.name, record.kinds.join("")]),
    );
    expect(
      kinds,
      "stubs must see /dev/null as c, pipes as p, directories as d and files as f",
    ).toEqual({ ls: "cpc", head: "dff" });
  });

  it("matches Bash for the curated accepted corpus", async () => {
    for (const command of ACCEPTED_CORPUS) {
      await verify(command);
    }
  }, 120_000);

  it("matches Bash for every accepted input of a seeded generated corpus", async () => {
    const corpus = generateCorpus(0x5eed_2026, 4000);
    let accepted = 0;
    for (const command of corpus) {
      if ((await analyzer.analyze(command)).commandClass !== "known_read_only") {
        continue;
      }
      accepted += 1;
      await verify(command);
    }
    expect(accepted).toBeGreaterThan(150);
  }, 300_000);

  it.each([
    'echo "' + "\\".repeat(2) + '$(id)"',
    String.raw`echo "\!"`,
    String.raw`cat >"\/dev\/null"`,
    String.raw`cat <"/dev/tcp/example.invalid/80"`,
    'cat 2>&"1"',
    "echo ~/sub",
    "true ~/sub",
    "false ~/sub",
    "cat <~/sub/in",
    "cd ~/sub; cat >out >/dev/null",
    "sed -n '/start/,/end/p;w out' in",
    "sleep -- 1",
  ])("keeps unsafe or unsupported syntax unclassified: %s", async (command) => {
    expect(await analyzer.analyze(command)).toMatchObject({ commandClass: "unclassified" });
  });

  it.each([
    ["ls >/dev/null | cat", "ls | cat >/dev/null"],
    ["ls 2>&1 >/dev/null | cat", "ls >/dev/null 2>&1 | cat"],
    ["ls >/dev/null | true", "ls | true"],
    ["ls; cat", "cat; ls"],
    ["cat <in | cat", "cat <'in put' | cat"],
    ["ls >&2", "ls"],
    ["cd ~/sub && cat <in", "cat <in"],
    [String.raw`grep "a\|b" in`, "grep ab in"],
  ])("detects a prediction for %j that does not match %j", (predicted, executed) => {
    expect(matches(prediction(predicted), run(executed))).toBe(false);
  });
});
