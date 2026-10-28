import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  root = await mkdtemp(join(tmpdir(), "pi-command-set-"));
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
        command: "records",
        mode: "allow",
        sessionGrant: "never",
        requiredFlags: ["--read"],
        optionalFlags: [],
        options: { "--format": ["text", "json"] },
        operands: { min: 1, max: 1 },
      },
    },
  });
}

describe("native configured command composition", () => {
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
  ])("keeps the entire invocation on ordinary policy: %s", async (command) => {
    expect(await analyzer().analyze(command)).toMatchObject({ commandClass: "unclassified" });
    await expect(access(join(cwd, "output"))).rejects.toThrow();
  });
});
