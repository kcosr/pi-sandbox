import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBashCommandAnalyzer } from "../../src/permissions/bash/analyzer.js";

const run = promisify(execFile);
let root: string;
let cwd: string;
let bin: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-command-set-")));
  cwd = join(root, "workspace");
  bin = join(root, "bin");
  await mkdir(cwd);
  await mkdir(bin);
  await writeFile(
    join(bin, "records"),
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o700 },
  );
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function environment() {
  return { PATH: `${bin}:/usr/bin:/bin`, LANG: "C" };
}

function analyzer() {
  return createBashCommandAnalyzer({
    backend: "direct",
    cwd,
    environment: environment(),
    commandSets: {
      inspect_records: {
        commands: ["records"],
        mode: "allow",
        sessionGrant: "never",
        requiredFlags: ["--read"],
        optionalFlags: [],
        options: {
          "--format": { kind: "values", values: ["text", "json"] },
          "-m": { kind: "any_literal" },
          "--message": { kind: "any_literal" },
        },
        operands: { min: 1, max: 1 },
      },
    },
  });
}

describe("native configured command composition", () => {
  it("preserves arbitrary literal and repeated option values as real Bash argv", async () => {
    const command =
      "records --read -m '' -m -x -m -- --message='a; $(touch injected)' --message='$HOME' --format json --format=text input | cat";
    expect(await analyzer().analyze(command)).toMatchObject({ commandClass: "configured_command" });
    const result = await run("/bin/bash", ["--noprofile", "--norc", "-c", command], {
      cwd,
      env: environment(),
      timeout: 5000,
    });
    expect(JSON.parse(result.stdout)).toEqual([
      "--read",
      "-m",
      "",
      "-m",
      "-x",
      "-m",
      "--",
      "--message=a; $(touch injected)",
      "--message=$HOME",
      "--format",
      "json",
      "--format=text",
      "input",
    ]);
    expect(result.stderr).toBe("");
    await expect(access(join(cwd, "injected"))).rejects.toThrow();
  });
  it("runs explicitly configured absolute paths with spaces without PATH lookup", async () => {
    const directory = join(root, "My Tools");
    const executable = join(directory, "records");
    await mkdir(directory);
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 },
    );
    const context = { backend: "direct" as const, cwd, environment: { PATH: "", LANG: "C" } };
    const configured = createBashCommandAnalyzer({
      ...context,
      commandSets: {
        read: {
          commands: [executable],
          mode: "allow",
          sessionGrant: "never",
          requiredFlags: ["--read"],
          optionalFlags: [],
          options: {},
          operands: { min: 1, max: 1 },
        },
      },
    });
    const command = `'${executable}' --read 'literal input'`;
    expect(await configured.analyze(command)).toMatchObject({
      commandClass: "configured_command",
      stages: [{ command: executable, knownReadOnly: false }],
    });
    const result = await run("/bin/bash", ["--noprofile", "--norc", "-c", command], {
      cwd,
      env: context.environment,
      timeout: 5000,
    });
    expect(JSON.parse(result.stdout)).toEqual(["--read", "literal input"]);
    expect(result.stderr).toBe("");
  });

  it("rejects a workspace-owned symlink even when its final target is outside", async () => {
    const alias = join(root, "workspace-alias");
    const link = join(cwd, "records");
    await symlink(cwd, alias);
    await symlink(join(bin, "records"), link);
    const executable = join(alias, "records");
    const configured = createBashCommandAnalyzer({
      backend: "direct",
      cwd,
      environment: environment(),
      commandSets: {
        read: {
          commands: [executable],
          mode: "allow",
          sessionGrant: "never",
          requiredFlags: ["--read"],
          optionalFlags: [],
          options: {},
          operands: { min: 1, max: 1 },
        },
      },
    });
    expect(await configured.analyze(`'${executable}' --read input`)).toMatchObject({
      commandClass: "unclassified",
      issue: { code: "untrusted_executable" },
    });
  });

  it("classifies the mixed pipeline while Bash passes quoted operands literally", async () => {
    const command = "records --read --format json 'a; $(touch injected)' | cat";
    expect(await analyzer().analyze(command)).toMatchObject({
      commandClass: "configured_command",
      stages: [
        { command: "records", knownReadOnly: false, commandSets: ["inspect_records"] },
        { command: "cat", knownReadOnly: true, commandSets: [] },
      ],
    });
    const result = await run("/bin/bash", ["--noprofile", "--norc", "-c", command], {
      cwd,
      env: environment(),
      timeout: 5000,
    });
    expect(JSON.parse(result.stdout)).toEqual([
      "--read",
      "--format",
      "json",
      "a; $(touch injected)",
    ]);
    expect(result.stderr).toBe("");
    await expect(access(join(cwd, "injected"))).rejects.toThrow();
  });

  it.each([
    "records --read input | touch output",
    "records --read input | cat >output",
    "records --read input && touch output",
    "records --write output | cat",
    "records --read input --format json | cat",
    "records --read -m one --format json --format invalid input | cat",
    "records --read -m one -m | cat",
    "records --read -m one input | touch output",
  ])("keeps the entire invocation on ordinary policy: %s", async (command) => {
    expect(await analyzer().analyze(command)).toMatchObject({ commandClass: "unclassified" });
    await expect(access(join(cwd, "output"))).rejects.toThrow();
  });
});
