import { describe, expect, it } from "vitest";

import { TOOL_NAMES, type SandboxConfig } from "../domain/index.js";
import { formatSandboxMounts, formatSandboxPolicy, formatSandboxSummary } from "./diagnostics.js";

function diagnosticConfig(): SandboxConfig {
  return {
    configVersion: 13,
    codemode: { enabled: false, timeoutMs: 300000 },
    mcp: { servers: {} },
    sessions: { retentionDays: 0 },
    audit: { enabled: false, facility: "local0" },
    modelsFile: "/etc/pi-sandbox/models.json",
    filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
    execution: { backend: "bubblewrap" },
    identity: { mode: "disabled" },
    network: { mode: "none" },
    environment: { pi: {}, sandbox: {}, extensions: {} },
    extensions: {},
    tools: Object.fromEntries(
      TOOL_NAMES.map((subject) => [
        subject,
        {
          mode: subject === "write" || subject === "edit" ? "ask" : "allow",
          sessionGrant: subject === "write" ? "offer" : "never",
          audit: false,
        },
      ]),
    ),
  };
}

describe("sandbox diagnostics", () => {
  it("describes Seatbelt denials, host scratch and best-effort lifecycle without namespace claims", () => {
    const config = {
      ...diagnosticConfig(),
      execution: { backend: "seatbelt" },
      filesystem: { cwdWritable: false, hiddenPaths: [], deniedPaths: ["/Users/alice/private"] },
    } satisfies SandboxConfig;
    const mounts = formatSandboxMounts("/Users/alice/work", config.execution, config.filesystem);
    expect(mounts).toContain("Seatbelt filesystem policy");
    expect(mounts).toContain("read-only");
    expect(mounts).toContain("/Users/alice/private");
    expect(mounts).toContain("real host scratch");
    expect(mounts).toContain("no private /tmp or mount namespace");
    expect(mounts).toContain("foreground exit can leave background descendants alive");
    expect(mounts).not.toContain("private tmpfs");
    const policy = formatSandboxPolicy(
      { config, hasSessionGrant: () => false, isToolActive: () => true },
      "bash",
    );
    expect(policy).toContain("owner death with their original grants");
    expect(policy).toContain("does not create a private network namespace");
    expect(policy).not.toContain("Missing paths are skipped");
  });
  it("formats the concise process summary without reading configuration again", () => {
    expect(
      formatSandboxSummary({
        initialized: true,
        cwd: "/work/project",
        configPath: "/etc/pi-sandbox/config.toml",
        modelsFile: "/etc/pi-sandbox/models.json",
        filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
        execution: { backend: "bubblewrap" },
        identity: { mode: "disabled" },
        network: { mode: "none" },
        extensions: [],
        userStateDir: "/home/alice/.pi/agent",
      }),
    ).toBe(`Pi Sandbox: initialized

Launch CWD:    /work/project
Hidden paths:  none
Denied paths:  none
CWD access:    read/write
Lifetime:      pi-sandbox process
Timeout cap:   none
Processes:     independent commands; background descendants remain until sandbox shutdown
Code mode:     disabled
MCP servers:   0
Execution:     Bubblewrap sandbox
Network:       disabled (private namespace)
Config:        /etc/pi-sandbox/config.toml
Models:        /etc/pi-sandbox/models.json
Extensions:    none
Identity:      disabled
User state:    /home/alice/.pi/agent

Use /sandbox mounts or /sandbox policy for details.`);
  });

  it("escapes terminal controls and line separators in displayed paths", () => {
    const output = formatSandboxSummary({
      initialized: true,
      cwd: "/work/project\nNetwork: enabled",
      configPath: "/etc/pi-sandbox/config.toml",
      modelsFile: "/etc/pi-sandbox/models\u001b[31m.json",
      filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
      execution: { backend: "bubblewrap" },
      identity: { mode: "broker" },
      network: { mode: "host" },
      extensions: ["git", "service-api"],
      userStateDir: "/home/alice\u2028forged",
    });
    expect(output).toContain("/work/project\\u000aNetwork: enabled");
    expect(output).toContain("models\\u001b[31m.json");
    expect(output).toContain("broker via /run/pi-sandbox-identity/broker.sock");
    expect(output).toContain("Extensions:    git, service-api");
    expect(output).toContain("/home/alice\\u2028forged");
    expect(output).not.toContain("/work/project\nNetwork: enabled");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u2028");
  });

  it("formats the semantic mount policy instead of raw mountinfo", () => {
    const output = formatSandboxMounts(
      "/work/project",
      { backend: "bubblewrap" },
      { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
    );
    expect(output).toContain("Sandbox mounts");
    expect(output).toContain("/              read-only   host filesystem");
    expect(output).toContain("/work/project  read/write  host launch directory");
    expect(output).toContain("HOME: /run/pi-sandbox/home");
    expect(output).not.toContain("mount ID");
  });

  it("reports read-only CWD and keeps managed host tools outside that restriction", () => {
    const config = {
      ...diagnosticConfig(),
      filesystem: { cwdWritable: false, deniedPaths: [], hiddenPaths: [] },
    };
    const mounts = formatSandboxMounts("/work/project", config.execution, config.filesystem);
    expect(mounts).toContain("/work/project  read-only");
    expect(mounts).toContain("Only private temporary/runtime storage is writable");
    for (const subject of ["write", "edit", "bash", "user_shell"]) {
      const detail = formatSandboxPolicy(
        { config, hasSessionGrant: () => false, isToolActive: () => true },
        subject,
      );
      expect(detail).toContain("including the launch directory, is read-only");
      expect(detail).not.toContain("write inside the launch directory");
    }
    const host = formatSandboxPolicy(
      {
        config,
        hasSessionGrant: () => false,
        isToolActive: () => true,
        hostToolScopes: { write: "test-host-tool" },
      },
      "write",
    );
    expect(host).toContain(
      "Is not restricted by the selected sandbox boundary, its filesystem setting",
    );
  });

  it("reports configured masks as conditional on presence at startup", () => {
    const config = {
      ...diagnosticConfig(),
      filesystem: {
        cwdWritable: true,
        deniedPaths: [],
        hiddenPaths: ["/work", "/work/project/private"],
      },
    };
    const mounts = formatSandboxMounts("/work/project", config.execution, config.filesystem);
    expect(mounts).toContain("/work");
    expect(mounts).toContain("/work/project/private");
    expect(mounts).toContain("Sandbox mounts (configured policy)");
    expect(mounts).toContain("hidden host path (mask if present at startup)");
    expect(
      formatSandboxPolicy(
        { config, hasSessionGrant: () => false, isToolActive: () => true },
        "bash",
      ),
    ).toContain("Missing paths are skipped.");
  });

  it("reports configured modes, session options, and memory-only active grants", () => {
    const config = diagnosticConfig();
    const output = formatSandboxPolicy({
      config,
      hasSessionGrant: (subject) => subject === "write",
      isToolActive: (subject) => subject !== "write",
    });
    expect(output).toContain("write       sandbox    ask    offer");
    expect(output).toContain("user_shell  sandbox    allow");
    expect(output).toMatch(/write\s+sandbox\s+ask\s+offer\s+yes/u);
    expect(output).toContain("Network: disabled (private namespace).");

    const detail = formatSandboxPolicy(
      {
        config,
        hasSessionGrant: () => false,
        isToolActive: () => true,
      },
      "user_shell",
    );
    expect(detail).toContain("Advertised:      not a model tool");
    expect(detail).toContain("Approval:        not required");
    expect(detail).toContain("Session option:  never");
    expect(detail).toContain("Runs user-invoked ! shell commands");
    expect(detail).toContain("Has no network access.");
  });

  it("reports unrestricted host networking in summary and subject scope", () => {
    const config = { ...diagnosticConfig(), network: { mode: "host" } } satisfies SandboxConfig;
    const summary = formatSandboxSummary({
      initialized: true,
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      modelsFile: config.modelsFile,
      execution: config.execution,
      filesystem: config.filesystem,
      identity: config.identity,
      network: config.network,
      extensions: [],
      userStateDir: "/home/alice/.pi/agent",
    });
    expect(summary).toContain("Network:       host (unrestricted)");

    const detail = formatSandboxPolicy(
      { config, hasSessionGrant: () => false, isToolActive: () => true },
      "bash",
    );
    expect(detail).toContain("host loopback, LAN, and Internet services");
  });

  it("reports local networking and persistent sandbox processes", () => {
    const config = {
      ...diagnosticConfig(),
      execution: { backend: "bubblewrap" },
      network: { mode: "local" },
    } satisfies SandboxConfig;
    const summary = formatSandboxSummary({
      initialized: true,
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      modelsFile: config.modelsFile,
      execution: config.execution,
      filesystem: config.filesystem,
      identity: config.identity,
      network: config.network,
      extensions: [],
      userStateDir: "/home/alice/.pi/agent",
    });
    expect(summary).toContain("local (sandbox loopback only)");
    expect(summary).toContain("background descendants remain until sandbox shutdown");
    const detail = formatSandboxPolicy(
      { config, hasSessionGrant: () => false, isToolActive: () => true },
      "bash",
    );
    expect(detail).toContain("sandbox-local TCP/UDP");
    expect(detail).not.toContain("Can access host loopback");
  });

  it("makes the lack of containment explicit in direct mode", () => {
    const config = {
      ...diagnosticConfig(),
      execution: { backend: "direct" },
      network: { mode: "host" },
    } satisfies SandboxConfig;
    const summary = formatSandboxSummary({
      initialized: true,
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      modelsFile: config.modelsFile,
      execution: config.execution,
      filesystem: config.filesystem,
      identity: config.identity,
      network: config.network,
      extensions: [],
      userStateDir: "/Users/alice/.pi/agent",
    });
    expect(summary).toContain("Execution:     direct host execution (uncontained)");
    expect(formatSandboxMounts("/work/project", config.execution, config.filesystem)).toContain(
      "no mount namespace or filesystem containment boundary",
    );

    const output = formatSandboxPolicy({
      config,
      hasSessionGrant: () => false,
      isToolActive: () => true,
    });
    expect(output).toMatch(/bash\s+direct\s+allow/u);
    expect(output).toMatch(/user_shell\s+direct\s+allow/u);
    const detail = formatSandboxPolicy(
      { config, hasSessionGrant: () => false, isToolActive: () => true },
      "user_shell",
    );
    expect(detail).toContain("not a model tool");
    expect(detail).toContain("ordinary host filesystem and process authority");
  });

  it("enumerates configured extension policies and identifies host execution", () => {
    const base = diagnosticConfig();
    const config = {
      ...base,
      extensions: {
        example: { id: "example", settings: {}, toolNames: ["host_echo"] },
      },
      tools: {
        ...base.tools,
        host_echo: { mode: "ask", sessionGrant: "never", audit: false },
      },
    } satisfies SandboxConfig;
    const input = {
      config,
      hasSessionGrant: () => false,
      isToolActive: () => true,
      hostToolScopes: { host_echo: "example.echo" },
    };

    expect(formatSandboxPolicy(input)).toMatch(/host_echo\s+host\s+ask/u);
    const detail = formatSandboxPolicy(input, "host_echo");
    expect(detail).toContain("Execution:       host");
    expect(detail).toContain("operation example.echo directly on the host");
    expect(detail).toContain("not restricted by the selected sandbox boundary");
    expect(detail).not.toContain("Has no network access");
  });

  it("lists administrator command shapes separately from reviewed profiles", () => {
    const base = diagnosticConfig();
    const config = {
      ...base,
      tools: {
        ...base.tools,
        bash: {
          mode: "ask",
          sessionGrant: "offer",
          audit: false,
          commandSets: {
            Utility_Read: {
              commands: ["utility", "/usr/libexec/pi-sandbox/utility", '/opt/tool "suite"/utility'],
              mode: "allow",
              sessionGrant: "never",
              requiredFlags: ["--read"],
              optionalFlags: ["--verbose"],
              options: {
                "--format": { kind: "values", values: ["json", "text"] },
                "-m": { kind: "any_literal" },
              },
              operands: { min: 1, max: 1 },
            },
          },
        },
      },
    } satisfies SandboxConfig;
    const detail = formatSandboxPolicy(
      { config, hasSessionGrant: () => false, isToolActive: () => true },
      "bash",
    );
    expect(detail).toContain("Utility_Read");
    expect(detail).toContain("utility");
    expect(detail).toContain('"utility", "/usr/libexec/pi-sandbox/utility"');
    expect(detail).toContain(JSON.stringify('/opt/tool "suite"/utility'));
    expect(detail).toContain("--read");
    expect(detail).toContain("--format");
    expect(detail).toContain('"--format":["json","text"]');
    expect(detail).toContain('"-m":{"any_literal":true}');
    expect(detail).not.toContain('"kind"');
    expect(detail).toContain("1..1");
  });

  it("reports Bash command-class policies, active class grants, and the registry", () => {
    const base = diagnosticConfig();
    const config = {
      ...base,
      tools: {
        ...base.tools,
        bash: {
          mode: "deny",
          sessionGrant: "never",
          audit: false,
          commandClasses: { known_read_only: { mode: "ask", sessionGrant: "offer" } },
        },
      },
    } satisfies SandboxConfig;
    const input = {
      config,
      hasSessionGrant: (_subject: string, scope?: string) => scope === "known_read_only",
      isToolActive: () => true,
      commandAnalyzer: {
        version: 2,
        commands: [
          { name: "pwd", kind: "shell_builtin", summary: "pwd" },
          { name: "cd", kind: "shell_builtin", summary: "cd [DIR]" },
          { name: "wc\u001b", kind: "executable", summary: "wc" },
        ],
      },
    } as const;
    const overview = formatSandboxPolicy(input);
    expect(overview).toMatch(/\nbash\s+sandbox\s+deny\s+never\s+-\n/u);
    expect(overview).toMatch(/\nbash \(known read-only\)\s+sandbox\s+ask\s+offer\s+yes\n/u);

    expect(formatSandboxPolicy(input, "bash")).toBe(`Policy: bash

Execution:         sandbox
Mode:              deny
Advertised:        yes
Approval:          always denied
Session option:    never
Active grant:      -
Known read-only:   ask
  Approval:        session grant active
  Session option:  offer
  Active grant:    yes

Known read-only commands (registry version 2):
  Shell builtins: pwd, cd
  Executables: wc\\u001b

Scope:
  Runs model-requested Bash inside the same sandbox.
  May read visible host paths and write inside the launch directory and private runtime filesystems.
  Structured tool policies do not further restrict an approved Bash command.
  Has no network access.
  Command classification selects only the approval policy; an approved command runs unchanged within the same boundary.`);

    const withoutAnalyzer = {
      config,
      hasSessionGrant: input.hasSessionGrant,
      isToolActive: input.isToolActive,
    };
    expect(formatSandboxPolicy(withoutAnalyzer, "bash")).toContain(
      "Known read-only commands:\n  registry unavailable",
    );
    const unconfigured = {
      config: base,
      hasSessionGrant: () => false,
      isToolActive: () => true,
      commandAnalyzer: input.commandAnalyzer,
    };
    expect(formatSandboxPolicy(unconfigured, "bash")).toBe(`Policy: bash

Execution:       sandbox
Mode:            allow
Advertised:      yes
Approval:        not required
Session option:  never
Active grant:    -

Scope:
  Runs model-requested Bash inside the same sandbox.
  May read visible host paths and write inside the launch directory and private runtime filesystems.
  Structured tool policies do not further restrict an approved Bash command.
  Has no network access.`);
    expect(formatSandboxPolicy(unconfigured)).not.toContain("known read-only");
    expect(formatSandboxPolicy(unconfigured, "write")).not.toContain("Known read-only");
  });
});
