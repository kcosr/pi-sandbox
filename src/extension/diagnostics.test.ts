import { describe, expect, it } from "vitest";

import { TOOL_NAMES, type SandboxConfig } from "../domain/index.js";
import { formatSandboxMounts, formatSandboxPolicy, formatSandboxSummary } from "./diagnostics.js";

function diagnosticConfig(): SandboxConfig {
  return {
    configVersion: 6,
    audit: { enabled: false, facility: "local0" },
    modelsFile: "/etc/pi-sandbox/models.json",
    filesystem: { cwdWritable: true },
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
  it("formats the concise process summary without reading configuration again", () => {
    expect(
      formatSandboxSummary({
        initialized: true,
        cwd: "/work/project",
        configPath: "/etc/pi-sandbox/config.toml",
        modelsFile: "/etc/pi-sandbox/models.json",
        filesystem: { cwdWritable: true },
        execution: { backend: "bubblewrap" },
        identity: { mode: "disabled" },
        network: { mode: "none" },
        extensions: [],
        userStateDir: "/home/alice/.pi/agent",
      }),
    ).toBe(`Pi Sandbox: initialized

Launch CWD:  /work/project
CWD access:  read/write
Lifetime:    pi-sandbox process
Execution:   Bubblewrap sandbox
Network:     disabled (private namespace)
Config:      /etc/pi-sandbox/config.toml
Models:      /etc/pi-sandbox/models.json
Extensions:  none
Identity:    disabled
User state:  /home/alice/.pi/agent

Use /sandbox mounts or /sandbox policy for details.`);
  });

  it("escapes terminal controls and line separators in displayed paths", () => {
    const output = formatSandboxSummary({
      initialized: true,
      cwd: "/work/project\nNetwork: enabled",
      configPath: "/etc/pi-sandbox/config.toml",
      modelsFile: "/etc/pi-sandbox/models\u001b[31m.json",
      filesystem: { cwdWritable: true },
      execution: { backend: "bubblewrap" },
      identity: { mode: "broker" },
      network: { mode: "host" },
      extensions: ["git", "service-api"],
      userStateDir: "/home/alice\u2028forged",
    });
    expect(output).toContain("/work/project\\u000aNetwork: enabled");
    expect(output).toContain("models\\u001b[31m.json");
    expect(output).toContain("broker via /run/pi-sandbox-identity/broker.sock");
    expect(output).toContain("Extensions:  git, service-api");
    expect(output).toContain("/home/alice\\u2028forged");
    expect(output).not.toContain("/work/project\nNetwork: enabled");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u2028");
  });

  it("formats the semantic mount policy instead of raw mountinfo", () => {
    const output = formatSandboxMounts(
      "/work/project",
      { backend: "bubblewrap" },
      { cwdWritable: true },
    );
    expect(output).toContain("Sandbox mounts");
    expect(output).toContain("/              read-only   host filesystem");
    expect(output).toContain("/work/project  read/write  host launch directory");
    expect(output).toContain("HOME: /run/pi-sandbox/home");
    expect(output).not.toContain("mount ID");
  });

  it("reports read-only CWD and keeps managed host tools outside that restriction", () => {
    const config = { ...diagnosticConfig(), filesystem: { cwdWritable: false } };
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
    expect(host).toContain("Is not restricted by the Bubblewrap boundary, its filesystem setting");
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
    expect(summary).toContain("Network:     host (unrestricted)");

    const detail = formatSandboxPolicy(
      { config, hasSessionGrant: () => false, isToolActive: () => true },
      "bash",
    );
    expect(detail).toContain("host loopback, LAN, and Internet services");
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
    expect(summary).toContain("Execution:   direct host execution (uncontained)");
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
    expect(detail).toContain("not restricted by the Bubblewrap boundary");
    expect(detail).not.toContain("Has no network access");
  });
});
