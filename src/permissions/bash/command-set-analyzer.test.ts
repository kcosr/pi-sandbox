import { describe, expect, it } from "vitest";

import { createBashCommandAnalyzer } from "./analyzer.js";
import type { BashCommandSet, BashCommandSets } from "./command-set-contracts.js";
import type { BashAnalysis, ExecutableProbe } from "./contracts.js";
import { KNOWN_READ_ONLY_VERSION } from "./registry.js";

const rule: BashCommandSet = {
  commands: ["records"],
  mode: "allow",
  sessionGrant: "never",
  requiredFlags: ["--read"],
  optionalFlags: ["--verbose"],
  options: { "--format": ["text", "json"] },
  operands: { min: 1, max: 1 },
};
const probe: ExecutableProbe = {
  isExecutableFile: (path) => Promise.resolve(/^\/usr\/bin\/(records|grep|head|rg)$/.test(path)),
  realpath: (path) => Promise.resolve(path),
};

function analyzer(
  commandSets: BashCommandSets = { records_read: rule },
  environment: Readonly<Record<string, string>> = { PATH: "/usr/bin" },
  executableProbe = probe,
) {
  return createBashCommandAnalyzer(
    { backend: "bubblewrap", cwd: "/work/project", environment, commandSets },
    executableProbe,
  );
}

async function classified(command: string): Promise<BashAnalysis> {
  return analyzer().analyze(command);
}

describe("configured command stage classification", () => {
  it("retains separate proofs for configured and curated pipeline stages", async () => {
    const result = await classified("records --read input | grep error | head -20");
    expect(result).toEqual({
      commandClass: "configured_command",
      version: KNOWN_READ_ONLY_VERSION,
      commands: ["records", "grep", "head"],
      stages: [
        { command: "records", knownReadOnly: false, commandSets: ["records_read"] },
        { command: "grep", knownReadOnly: true, commandSets: [] },
        { command: "head", knownReadOnly: true, commandSets: [] },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.commandClass !== "configured_command") throw new Error("expected stages");
    expect(Object.isFrozen(result.stages)).toBe(true);
    expect(Object.isFrozen(result.stages[0])).toBe(true);
    expect(Object.isFrozen(result.stages[0]!.commandSets)).toBe(true);
  });

  it.each([
    "records --read input",
    "records --read 'file name' 2>&1 | grep error",
    "cd ~/project; records --read file",
    "records --read input && records --read other || true",
    "records --read input </dev/null >/dev/null",
  ])("classifies each accepted stage in %s", async (command) => {
    expect(await classified(command)).toMatchObject({ commandClass: "configured_command" });
  });

  it.each([
    "records --write file",
    "records --read file | unknown",
    "unknown | records --read file",
    "records --read file; rm out",
    "records --read file >out",
    "records --read file >/dev/null 2>out",
    "records --read file >/dev/null &",
    "records --read file </dev/tcp/host/1",
    "records --read $file",
    "records --read *.txt",
    "records --read ~/file",
    "records --read file --verbose",
    "records --read first second",
    "/usr/bin/records --read file",
    "./records --read file",
    "env records --read file",
    "records --read file | grep --unapproved pattern",
  ])("keeps the whole invocation unclassified for %s", async (command) => {
    expect(await classified(command)).toMatchObject({ commandClass: "unclassified" });
  });

  it("preserves the old all-curated result when no configured stage matches", async () => {
    expect(await classified("grep error file | head -20")).toEqual({
      commandClass: "known_read_only",
      version: KNOWN_READ_ONLY_VERSION,
      commands: ["grep", "head"],
    });
  });

  it("keeps every matching named rule and independent curated recognition", async () => {
    const grepRule: BashCommandSet = {
      ...rule,
      commands: ["grep"],
      requiredFlags: [],
      optionalFlags: ["-i"],
      options: {},
      operands: { min: 1, max: 2 },
    };
    const result = await analyzer({ records_read: grepRule, second: grepRule }).analyze(
      "grep -i x file",
    );
    expect(result).toMatchObject({
      commandClass: "configured_command",
      stages: [{ command: "grep", knownReadOnly: true, commandSets: ["records_read", "second"] }],
    });
  });

  it("allows an administrator shape independently of the built-in argument profile", async () => {
    const grepRule = {
      ...rule,
      commands: ["grep"],
      requiredFlags: ["--custom"],
      operands: { min: 1, max: 1 },
    };
    expect(await analyzer({ records_read: grepRule }).analyze("grep --custom file")).toMatchObject({
      commandClass: "configured_command",
      stages: [{ command: "grep", knownReadOnly: false, commandSets: ["records_read"] }],
    });
  });

  it.each([
    { PATH: "/work/project:/usr/bin" },
    { PATH: ".:/usr/bin" },
    { PATH: "/usr/bin", BASH_ENV: "/tmp/startup" },
    { PATH: "/usr/bin", LD_PRELOAD: "/tmp/plugin.so" },
    { PATH: "/usr/bin", "BASH_FUNC_records%%": "() { echo replacement; }" },
    { PATH: "/usr/bin", "BASH_FUNC_command_not_found_handle%%": "() { echo fallback; }" },
  ])("preserves execution-context checks for %j", async (environment) => {
    expect(await analyzer(undefined, environment).analyze("records --read file")).toMatchObject({
      commandClass: "unclassified",
      issue: { code: "unsafe_environment" },
    });
  });

  it("retains known executable environment gates even for custom-only matches", async () => {
    const grepRule = { ...rule, commands: ["grep"], requiredFlags: ["--custom"] };
    expect(
      await analyzer(
        { records_read: grepRule },
        { PATH: "/usr/bin", GREP_OPTIONS: "--extra" },
      ).analyze("grep --custom file"),
    ).toMatchObject({
      commandClass: "unclassified",
      issue: { code: "unsafe_environment" },
    });
    const rgRule = {
      ...rule,
      commands: ["rg"],
      requiredFlags: ["--custom"],
      optionalFlags: ["--no-config"],
    };
    const configured = analyzer(
      { records_read: rgRule },
      { PATH: "/usr/bin", RIPGREP_CONFIG_PATH: "/tmp/rg-config" },
    );
    expect(await configured.analyze("rg --custom file")).toMatchObject({
      commandClass: "unclassified",
    });
    expect(await configured.analyze("rg --custom --no-config file")).toMatchObject({
      commandClass: "configured_command",
    });
  });

  it("rejects project-resolved executable aliases and missing commands", async () => {
    const alias: ExecutableProbe = {
      ...probe,
      realpath: () => Promise.resolve("/work/project/records"),
    };
    expect(
      await analyzer(undefined, undefined, alias).analyze("records --read file"),
    ).toMatchObject({
      commandClass: "unclassified",
    });
    const absent: ExecutableProbe = { ...probe, isExecutableFile: () => Promise.resolve(false) };
    expect(
      await analyzer(undefined, undefined, absent).analyze("records --read file"),
    ).toMatchObject({
      commandClass: "unclassified",
      issue: { code: "executable_not_found" },
    });
  });

  it("does not let direct embedding definitions shadow shell builtins", async () => {
    const builtinRule = {
      ...rule,
      commands: ["printf"],
      requiredFlags: [],
      operands: { min: 0, max: 10 },
    };
    expect(await analyzer({ records_read: builtinRule }).analyze("printf x")).toMatchObject({
      commandClass: "unclassified",
    });
  });

  it("snapshots all nested rule data before asynchronous analysis", async () => {
    const mutable = {
      ...rule,
      requiredFlags: [...rule.requiredFlags],
      optionalFlags: [...rule.optionalFlags],
      options: { "--format": ["json"] },
      operands: { min: 1, max: 1 },
    };
    const configured = analyzer({ records_read: mutable });
    mutable.requiredFlags.length = 0;
    mutable.optionalFlags.push("--write");
    mutable.options["--format"].push("binary");
    mutable.operands.max = 2;
    for (const command of [
      "records file",
      "records --read --write file",
      "records --read --format binary file",
      "records --read first second",
    ])
      expect(await configured.analyze(command)).toMatchObject({ commandClass: "unclassified" });
    expect(await configured.analyze("records --read --format json file")).toMatchObject({
      commandClass: "configured_command",
    });
  });
});
