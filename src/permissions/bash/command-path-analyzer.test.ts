import { describe, expect, it } from "vitest";

import { createBashCommandAnalyzer } from "./analyzer.js";
import type { BashCommandSet } from "./command-set-contracts.js";
import type { BashExecutionContext, ExecutableProbe } from "./contracts.js";

const rule: BashCommandSet = {
  commands: ["records", "/opt/tools/records"],
  mode: "allow",
  sessionGrant: "never",
  requiredFlags: ["--read"],
  optionalFlags: [],
  options: {},
  operands: { min: 1, max: 1 },
};
const probe: ExecutableProbe = {
  isExecutableFile: () => Promise.resolve(true),
  realpath: (path) => Promise.resolve(path),
};

function analyzer(
  commands: readonly string[] = rule.commands,
  environment: Readonly<Record<string, string>> = { PATH: "/opt/tools:/usr/bin" },
  executableProbe: ExecutableProbe = probe,
  overrides: Partial<BashCommandSet> = {},
  context: Partial<BashExecutionContext> = {},
) {
  return createBashCommandAnalyzer(
    {
      backend: "direct",
      cwd: "/work/project",
      environment,
      commandSets: { read_records: { ...rule, commands, ...overrides } },
      ...context,
    },
    executableProbe,
  );
}

describe("explicit command path alternatives", () => {
  it.each(["records --read input", "/opt/tools/records --read input"])(
    "uses the same custom argument rule for %s",
    async (command) => {
      expect(await analyzer().analyze(command)).toMatchObject({
        commandClass: "configured_command",
        stages: [{ knownReadOnly: false, commandSets: ["read_records"] }],
      });
    },
  );

  it.each([
    "/elsewhere/records --read input",
    "/opt/tools//records --read input",
    "/opt/tools/./records --read input",
    "./records --read input",
    "/opt/tools/records --write input",
    "/opt/tools/records --read first second",
    "/opt/tools/records --read input | touch output",
    "/opt/tools/records --read input >output",
    "/opt/tools/records --read $INPUT",
  ])("falls back for an unlisted spelling or unsupported invocation: %s", async (command) => {
    expect(await analyzer().analyze(command)).toMatchObject({ commandClass: "unclassified" });
  });

  it("does not create basename or canonical-path aliases", async () => {
    expect(await analyzer(["records"]).analyze("/opt/tools/records --read input")).toMatchObject({
      commandClass: "unclassified",
    });
    expect(await analyzer(["/opt/tools/records"]).analyze("records --read input")).toMatchObject({
      commandClass: "unclassified",
    });
    const aliases = { ...probe, realpath: () => Promise.resolve("/opt/tools/records") };
    expect(
      await analyzer(["/opt/tools/records"], undefined, aliases).analyze(
        "/alias/records --read input",
      ),
    ).toMatchObject({ commandClass: "unclassified" });
  });

  it("accepts a quoted literal path with spaces", async () => {
    expect(
      await analyzer(["/opt/My Tools/records"]).analyze("'/opt/My Tools/records' --read input"),
    ).toMatchObject({
      commandClass: "configured_command",
      commands: ["/opt/My Tools/records"],
    });
  });

  it("combines an explicit path with an independently safe pipeline stage", async () => {
    expect(await analyzer().analyze("/opt/tools/records --read input | head -1")).toMatchObject({
      commandClass: "configured_command",
      stages: [
        { command: "/opt/tools/records", knownReadOnly: false, commandSets: ["read_records"] },
        { command: "head", knownReadOnly: true, commandSets: [] },
      ],
    });
  });

  it("accepts a trusted external symlink spelling without admitting its canonical alias", async () => {
    const external = {
      ...probe,
      realpath: (path: string) =>
        Promise.resolve(path === "/opt/tools/records" ? "/opt/versioned/records" : path),
    };
    const configured = analyzer(["/opt/tools/records"], {}, external);
    expect(await configured.analyze("/opt/tools/records --read input")).toMatchObject({
      commandClass: "configured_command",
    });
    expect(await configured.analyze("/opt/versioned/records --read input")).toMatchObject({
      commandClass: "unclassified",
    });
  });

  it.each(["/tmp", "/run", "/proc", "/sys", "/dev", "/secret"])(
    "rejects lexical, resolved parent and target paths inside Bubblewrap overlays/masks: %s",
    async (blocked) => {
      const context = { backend: "bubblewrap", hiddenPaths: ["/secret"] } as const;
      for (const location of ["literal", "parent", "target"]) {
        const command = location === "literal" ? `${blocked}/records` : "/opt/tools/records";
        const mapped = {
          ...probe,
          realpath: (path: string) => {
            if (location === "parent" && path === "/opt/tools") return Promise.resolve(blocked);
            if (location === "target" && path === command)
              return Promise.resolve(`${blocked}/records`);
            return Promise.resolve(path);
          },
        };
        expect(
          await analyzer([command], {}, mapped, {}, context).analyze(`${command} --read input`),
        ).toMatchObject({
          commandClass: "unclassified",
          issue: { code: "untrusted_executable" },
        });
      }
    },
  );

  it("snapshots backend exclusions without affecting direct mode or neighboring paths", async () => {
    const deniedPaths = ["/opt/tools"];
    const blocked = analyzer(undefined, {}, probe, {}, { backend: "seatbelt", deniedPaths });
    deniedPaths.length = 0;
    expect(await blocked.analyze("/opt/tools/records --read input")).toMatchObject({
      commandClass: "unclassified",
    });
    for (const context of [
      { backend: "direct", deniedPaths: ["/opt/tools"], hiddenPaths: ["/opt/tools"] },
      { backend: "seatbelt", deniedPaths: ["/opt/tool"] },
      { backend: "bubblewrap", hiddenPaths: ["/opt/tools/elsewhere"] },
    ] as const) {
      expect(
        await analyzer(undefined, {}, probe, {}, context).analyze(
          "/opt/tools/records --read input",
        ),
      ).toMatchObject({ commandClass: "configured_command" });
    }
  });

  it.each(["/tmp/records", "/run/records", "/secret/records"])(
    "does not approve a basename whose file symlink resolves into a private or masked path: %s",
    async (target) => {
      const mapped = {
        ...probe,
        realpath: (path: string) => Promise.resolve(path === "/opt/tools/records" ? target : path),
      };
      expect(
        await analyzer(
          ["records"],
          { PATH: "/opt/tools:/usr/bin" },
          mapped,
          {},
          { backend: "bubblewrap", hiddenPaths: ["/secret"] },
        ).analyze("records --read input"),
      ).toMatchObject({ commandClass: "unclassified", issue: { code: "untrusted_executable" } });
    },
  );

  it.each([{}, { PATH: "" }, { PATH: ".:/usr/bin" }, { PATH: "/work/project:/usr/bin" }])(
    "does not perform PATH lookup for an explicit path: %j",
    async (environment) => {
      const configured = analyzer(undefined, environment);
      expect(await configured.analyze("/opt/tools/records --read input")).toMatchObject({
        commandClass: "configured_command",
      });
      expect(await configured.analyze("records --read input")).toMatchObject({
        commandClass: "unclassified",
        issue: { code: "unsafe_environment" },
      });
    },
  );

  it.each([
    { BASH_ENV: "/tmp/startup" },
    { LD_PRELOAD: "/tmp/library.so" },
    { "BASH_FUNC_/opt/tools/records%%": "() { echo replaced; }" },
    { "/opt/tools/records": "() { echo legacy; }" },
  ])("retains shared shell/loader and exact-name function checks: %j", async (environment) => {
    expect(
      await analyzer(undefined, environment).analyze("/opt/tools/records --read input"),
    ).toMatchObject({
      commandClass: "unclassified",
      issue: { code: "unsafe_environment" },
    });
  });

  it("keeps absolute builtin-named executables out of the builtin fast path", async () => {
    const options = { requiredFlags: [], operands: { min: 0, max: 0 } };
    expect(
      await analyzer(["/usr/bin/true"], {}, probe, options).analyze("/usr/bin/true"),
    ).toMatchObject({
      commandClass: "configured_command",
      stages: [{ command: "/usr/bin/true", knownReadOnly: false }],
    });
    const absent = { ...probe, isExecutableFile: () => Promise.resolve(false) };
    expect(
      await analyzer(["/usr/bin/true"], {}, absent, options).analyze("/usr/bin/true"),
    ).toMatchObject({
      commandClass: "unclassified",
      issue: { code: "executable_not_found" },
    });
    expect(await analyzer([]).analyze("/usr/bin/true")).toMatchObject({
      commandClass: "unclassified",
    });
  });

  it("retains program environment checks without granting a builtin classification", async () => {
    expect(
      await analyzer(["/usr/bin/grep"], { GREP_OPTIONS: "--extra" }).analyze(
        "/usr/bin/grep --read input",
      ),
    ).toMatchObject({
      commandClass: "unclassified",
      issue: { code: "unsafe_environment" },
    });
    const rg = analyzer(["/usr/bin/rg"], { RIPGREP_CONFIG_PATH: "/tmp/rc" }, probe, {
      optionalFlags: ["--no-config"],
    });
    expect(await rg.analyze("/usr/bin/rg --read input")).toMatchObject({
      commandClass: "unclassified",
    });
    expect(await rg.analyze("/usr/bin/rg --read --no-config input")).toMatchObject({
      commandClass: "configured_command",
      stages: [{ knownReadOnly: false }],
    });
  });

  it.each([
    ["/work/project/records", "/work/project/records", "/work/project"],
    ["/opt/tools/records", "/work/project/records", "/opt/tools"],
    ["/opt/tools/records", "/usr/bin/records", "/work/project"],
  ])(
    "rejects lexical, parent or target workspace placement: %s",
    async (command, target, parent) => {
      const mapped = {
        ...probe,
        realpath: (path: string) => Promise.resolve(path === command ? target : parent),
      };
      expect(
        await analyzer([command], {}, mapped).analyze(`${command} --read input`),
      ).toMatchObject({
        commandClass: "unclassified",
        issue: { code: "untrusted_executable" },
      });
    },
  );

  it("fails closed when either realpath query fails", async () => {
    for (const rejected of ["/opt/tools", "/opt/tools/records"]) {
      const failed = {
        ...probe,
        realpath: (path: string) => {
          if (path === rejected) return Promise.reject(new Error("unavailable"));
          return Promise.resolve(path);
        },
      };
      expect(
        await analyzer(undefined, {}, failed).analyze("/opt/tools/records --read input"),
      ).toMatchObject({
        commandClass: "unclassified",
        issue: { code: "untrusted_executable" },
      });
    }
  });

  it("snapshots alternatives before a caller can mutate them", async () => {
    const commands = ["records"];
    const configured = analyzer(commands);
    commands.push("/opt/tools/records");
    expect(await configured.analyze("/opt/tools/records --read input")).toMatchObject({
      commandClass: "unclassified",
    });
  });
});
