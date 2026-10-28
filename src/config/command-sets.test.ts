import { describe, expect, it } from "vitest";

import {
  isCommandSetAbsolutePath,
  isCommandSetCommand,
  MAXIMUM_COMMAND_SETS_BYTES,
} from "../permissions/bash/command-set-contracts.js";
import { parseBashCommandSets } from "./command-sets.js";

const PATH = "config.tools.bash.command_sets";
function rule(overrides: Record<string, unknown> = {}) {
  return {
    command: "utility",
    mode: "allow",
    session_grant: "never",
    required_flags: ["--read"],
    optional_flags: ["-v", "--verbose"],
    options: { "--format": ["text", "json"] },
    operands: { min: 1, max: 1 },
    ...overrides,
  };
}

describe("administrator command-set grammar", () => {
  it("normalizes literal options and exact enumerations into deeply frozen predicates", () => {
    const option = { any_literal: true };
    const source = { read: rule({ options: { "-m": option, "--exact": ["*", "string"] } }) };
    const parsed = parseBashCommandSets(source, PATH);
    expect(parsed.read!.options).toEqual({
      "-m": { kind: "any_literal" },
      "--exact": { kind: "values", values: ["*", "string"] },
    });
    option.any_literal = false;
    expect(parsed.read!.options["-m"]).toEqual({ kind: "any_literal" });
    expect(Object.isFrozen(parsed.read!.options["-m"])).toBe(true);
  });

  it.each([
    {},
    { any_literal: false },
    { any_literal: "true" },
    { any_literal: 1 },
    { any_literal: true, values: ["x"] },
    { any_literal: true, extra: true },
    { kind: "any_literal" },
    { values: ["x"] },
    "string",
    "*",
    true,
    1,
    null,
  ])("rejects invalid option predicates %#", (option) => {
    expect(() =>
      parseBashCommandSets({ read: rule({ options: { "-m": option } }) }, PATH),
    ).toThrow();
  });

  it.each(["json", true, 1, null])(
    "explains both accepted option forms for scalar %#",
    (option) => {
      expect(() =>
        parseBashCommandSets({ read: rule({ options: { "-m": option } }) }, PATH),
      ).toThrow(
        `${PATH}.read.options.-m must be an array of exact literal values or { any_literal = true }`,
      );
    },
  );

  it("counts literal predicates in the shared option limit and spelling checks", () => {
    const options = Object.fromEntries(
      Array.from({ length: 62 }, (_, i) => [`--opt${i}`, { any_literal: true }]),
    );
    const source = rule({ optional_flags: ["-v"], options });
    expect(Object.keys(parseBashCommandSets({ read: source }, PATH).read!.options)).toHaveLength(
      62,
    );
    options["--overflow"] = { any_literal: true };
    expect(() => parseBashCommandSets({ read: source }, PATH)).toThrow("at most 64");
    expect(() =>
      parseBashCommandSets({ read: rule({ options: { "--read": { any_literal: true } } }) }, PATH),
    ).toThrow("repeat");
  });

  it("normalizes strings and explicit alternatives into one immutable command list", () => {
    for (const command of [
      "utility",
      "/usr/libexec/pi-sandbox/utility",
      "/opt/tool suite/utility",
      "/bin/printf",
    ]) {
      const scalar = parseBashCommandSets({ inspect: rule({ command }) }, PATH);
      const list = parseBashCommandSets({ inspect: rule({ command: [command] }) }, PATH);
      expect(scalar).toEqual(list);
      expect(scalar.inspect!.commands).toEqual([command]);
      expect(scalar.inspect).not.toHaveProperty("command");
      expect(Object.isFrozen(scalar.inspect!.commands)).toBe(true);
    }
    const command = ["utility", "/usr/libexec/pi-sandbox/utility"];
    const parsed = parseBashCommandSets({ inspect: rule({ command }) }, PATH);
    command[0] = "other";
    command.push("third");
    expect(parsed.inspect!.commands).toEqual(["utility", "/usr/libexec/pi-sandbox/utility"]);
    expect(isCommandSetCommand("/usr/bin/utility")).toBe(false);
    expect(isCommandSetAbsolutePath("utility")).toBe(false);
  });

  it.each(
    [
      [],
      ["utility", "utility"],
      ["/usr/bin/utility", "/usr/bin/utility"],
      ["utility", false],
      ["utility", ["other"]],
      [""],
      ["utility", "./utility"],
      ["utility", "/"],
      ["utility", "//usr/bin/utility"],
      ["utility", "/usr//bin/utility"],
      ["utility", "/usr/bin/utility/"],
      ["utility", "/usr/./bin/utility"],
      ["utility", "/usr/bin/../utility"],
      ["utility", "/usr/bin/\u0000utility"],
      ["utility", "/usr/bin/\u202eutility"],
      ["utility", "/usr/bin/\u2028utility"],
      ["utility", "/usr/bin/\ud800utility"],
      ["utility", "printf"],
      null,
      1,
      {},
    ].map((command) => ({ command })),
  )("rejects invalid command alternatives %#", ({ command }) => {
    expect(() => parseBashCommandSets({ inspect: rule({ command }) }, PATH)).toThrow();
  });

  it("enforces per-entry, list and aggregate command bounds", () => {
    const commands = Array.from({ length: 64 }, (_, index) => `utility${index}`);
    expect(
      parseBashCommandSets({ inspect: rule({ command: commands }) }, PATH).inspect!.commands,
    ).toEqual(commands);
    expect(() =>
      parseBashCommandSets({ inspect: rule({ command: [...commands, "overflow"] }) }, PATH),
    ).toThrow("at most 64");
    for (const command of ["a".repeat(256), `/${"a".repeat(255)}`, `/a${"é".repeat(127)}`]) {
      expect(Buffer.byteLength(command)).toBe(256);
      expect(parseBashCommandSets({ inspect: rule({ command }) }, PATH).inspect!.commands).toEqual([
        command,
      ]);
      expect(() =>
        parseBashCommandSets({ inspect: rule({ command: `${command}x` }) }, PATH),
      ).toThrow();
    }
    const manyAliases = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `rule${index}`,
        rule({ command: commands.map((name) => `${name}${"x".repeat(240)}`) }),
      ]),
    );
    expect(() => parseBashCommandSets(manyAliases, PATH)).toThrow("exceeds");
  });

  it("deeply snapshots the accepted positive grammar", () => {
    const source = { read_data: rule() };
    const result = parseBashCommandSets(source, PATH);
    expect(result.read_data).toEqual({
      commands: ["utility"],
      mode: "allow",
      sessionGrant: "never",
      requiredFlags: ["--read"],
      optionalFlags: ["-v", "--verbose"],
      options: { "--format": { kind: "values", values: ["text", "json"] } },
      operands: { min: 1, max: 1 },
    });
    source.read_data.required_flags.push("--write");
    source.read_data.options["--format"].push("binary");
    source.read_data.operands.max = 4;
    expect(result.read_data!.requiredFlags).toEqual(["--read"]);
    expect(result.read_data!.options["--format"]).toEqual({
      kind: "values",
      values: ["text", "json"],
    });
    const option = result.read_data!.options["--format"]!;
    if (option.kind !== "values") throw new Error("expected enumerated option");
    expect(Object.isFrozen(option.values)).toBe(true);
    expect(result.read_data!.operands.max).toBe(1);
    for (const value of [
      result,
      result.read_data,
      result.read_data!.commands,
      result.read_data!.requiredFlags,
      result.read_data!.optionalFlags,
      result.read_data!.options,
      result.read_data!.options["--format"],
      result.read_data!.operands,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("uses empty collections only for omitted optional fields", () => {
    const result = parseBashCommandSets(
      {
        inspect: {
          command: "inspect",
          mode: "allow",
          session_grant: "never",
          operands: { min: 0, max: 0 },
        },
      },
      PATH,
    );
    expect(result.inspect).toMatchObject({ requiredFlags: [], optionalFlags: [], options: {} });
    expect(parseBashCommandSets({}, PATH)).toEqual({});
    for (const key of ["required_flags", "optional_flags", "options"])
      expect(() => parseBashCommandSets({ inspect: rule({ [key]: null }) }, PATH)).toThrow();
  });

  it.each(["command", "mode", "session_grant", "operands"])("requires %s", (key) => {
    const source: Record<string, unknown> = rule();
    delete source[key];
    expect(() => parseBashCommandSets({ read_data: source }, PATH)).toThrow(`${key} is required`);
  });

  it.each([
    { extra: true },
    { mode: "ask" },
    { mode: "deny" },
    { session_grant: "offer" },
    { command: "../utility" },
    { command: "utility arg" },
    { command: "utility\n" },
    { command: "a".repeat(257) },
    { required_flags: ["--read", "--read"] },
    { optional_flags: ["--read"] },
    { optional_flags: ["--verbose", "--verbose"] },
    { required_flags: ["--read=yes"] },
    { required_flags: ["--"] },
    { required_flags: ["-vv"] },
    { options: { "--read": ["yes"] } },
    { options: { format: ["json"] } },
    { options: { "--format": [] } },
    { options: { "--format": ["json", "json"] } },
    { options: { "--format": [true] } },
    { options: { "--format": [""] } },
    { options: { "--format": ["json\n"] } },
    { options: { "--format": ["x".repeat(257)] } },
    { operands: { min: 1 } },
    { operands: { max: 1 } },
    { operands: { min: 0, max: 1, extra: true } },
    { operands: { min: -1, max: 1 } },
    { operands: { min: 2, max: 1 } },
    { operands: { min: 0.5, max: 1 } },
    { operands: { min: 0, max: Infinity } },
    { operands: { min: 0, max: 1025 } },
    { operands: { min: "0", max: 1 } },
  ])("rejects malformed or ambiguous rule %j", (change) => {
    expect(() => parseBashCommandSets({ read_data: rule(change) }, PATH)).toThrow();
  });

  it.each(["__proto__", "constructor", "prototype", "bad.id", "bad id", "1rule", "x".repeat(65)])(
    "rejects unsafe identifier %s",
    (id) => {
      expect(() => parseBashCommandSets(Object.fromEntries([[id, rule()]]), PATH)).toThrow(
        "identifier",
      );
    },
  );

  it.each([
    "alias",
    "bg",
    "builtin",
    "cd",
    "command",
    "compgen",
    "compopt",
    "declare",
    "echo",
    "enable",
    "eval",
    "exec",
    "export",
    "false",
    "getopts",
    "hash",
    "help",
    "history",
    "jobs",
    "kill",
    "local",
    "mapfile",
    "printf",
    "pwd",
    "read",
    "readarray",
    "readonly",
    "return",
    "set",
    "shift",
    "shopt",
    "source",
    "test",
    "time",
    "times",
    "trap",
    "true",
    "type",
    "typeset",
    "ulimit",
    "umask",
    "unset",
    "wait",
    "if",
    "for",
    "in",
    "then",
    "do",
    "done",
    "fi",
    "while",
    "until",
    "coproc",
    "function",
    ":",
    ".",
    "[",
    "[[",
    "{",
    "!",
  ])("rejects shell command %s", (command) => {
    expect(isCommandSetCommand(command)).toBe(false);
    expect(() => parseBashCommandSets({ read_data: rule({ command }) }, PATH)).toThrow(
      "external executable",
    );
  });

  it("bounds definitions, spellings, values, operands and aggregate bytes", () => {
    const sets = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`set${index}`, rule()]),
    );
    expect(() => parseBashCommandSets(sets, PATH)).toThrow("at most 64 command sets");
    expect(() =>
      parseBashCommandSets(
        {
          read_data: rule({
            optional_flags: Array.from({ length: 64 }, (_, index) => `--flag${index}`),
          }),
        },
        PATH,
      ),
    ).toThrow("at most 64 option spellings");
    expect(() =>
      parseBashCommandSets(
        {
          read_data: rule({
            options: { "--format": Array.from({ length: 65 }, (_, index) => String(index)) },
          }),
        },
        PATH,
      ),
    ).toThrow("at most 64 entries");
    const large = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `set${index}`,
        rule({
          options: {
            "--format": Array.from({ length: 64 }, (_, value) => `${value}${"x".repeat(250)}`),
          },
        }),
      ]),
    );
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(MAXIMUM_COMMAND_SETS_BYTES);
    expect(() => parseBashCommandSets(large, PATH)).toThrow("exceeds");
    expect(
      parseBashCommandSets({ read_data: rule({ operands: { min: 0, max: 1024 } }) }, PATH)
        .read_data!.operands.max,
    ).toBe(1024);
  });
});
