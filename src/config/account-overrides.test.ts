import { describe, expect, it } from "vitest";
import type { SandboxConfig } from "../domain/index.js";
import { parseMcpConfig } from "./mcp.js";
import { applyAccountOverrides, parseAccountOverrides } from "./account-overrides.js";
const mcpResponse = (servers: Record<string, unknown>) => ({ tools: {}, mcp: { servers } });

describe("account overrides", () => {
  it("atomically replaces selected tools and inherits all omitted values", () => {
    const basePolicy = { audit: true, mode: "allow", sessionGrant: "never" } as const;
    const base = {
      configVersion: 16,
      modelAuth: { personalProviders: [] },
      skills: { directories: [] },
      exports: { enabled: false },
      codemode: { enabled: false, timeoutMs: 300000 },
      mcp: { servers: {} },
      sessions: { retentionDays: 365 },
      filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: ["/srv/runs"] },
      audit: { enabled: false },

      execution: { backend: "bubblewrap" },

      network: { mode: "none" },
      environment: { pi: {}, sandbox: {}, extensions: {} },
      extensions: {
        git: { id: "git", settings: {}, toolNames: ["git_clone"] },
        "service-api": {
          id: "service-api",
          settings: {},
          toolNames: ["service_api"],
        },
      },
      tools: Object.fromEntries(
        ["read", "grep", "find", "ls", "write", "edit", "bash", "git_clone", "service_api"].map(
          (name) => [name, basePolicy],
        ),
      ) as SandboxConfig["tools"],
    } satisfies SandboxConfig;
    const effective = applyAccountOverrides(base, {
      execution: { backend: "direct" },
      network: { mode: "host" },
      tools: {
        write: { mode: "disabled", sessionGrant: "never" },
        git_clone: { mode: "disabled", sessionGrant: "never" },
        service_api: { mode: "deny", sessionGrant: "never" },
      },
    });
    expect(effective.execution).toEqual({ backend: "direct" });
    expect(effective.network).toEqual({ mode: "host" });
    expect(effective.tools.write).toEqual({ mode: "disabled", sessionGrant: "never", audit: true });
    expect(effective.tools.git_clone).toEqual({
      mode: "disabled",
      sessionGrant: "never",
      audit: true,
    });
    expect(effective.tools.service_api).toEqual({
      mode: "deny",
      sessionGrant: "never",
      audit: true,
    });
    expect(effective.tools.read).toBe(basePolicy);
    expect(effective.audit).toBe(base.audit);
    expect(effective.sessions).toBe(base.sessions);
    expect(effective.filesystem).toEqual(base.filesystem);
    const deniedBase = {
      ...base,
      filesystem: { ...base.filesystem, deniedPaths: ["/Users/alice/private"] },
    };
    expect(
      applyAccountOverrides(deniedBase, { filesystem: { cwdWritable: false }, tools: {} })
        .filesystem.deniedPaths,
    ).toBe(deniedBase.filesystem.deniedPaths);
    const restricted = applyAccountOverrides(base, {
      filesystem: { cwdWritable: false },
      tools: {},
    });
    expect(restricted.filesystem).toEqual({
      cwdWritable: false,
      deniedPaths: [],
      hiddenPaths: ["/srv/runs"],
    });
    expect(restricted.execution).toEqual(base.execution);
    const commandPathPrepend = Object.freeze(["/usr/libexec/pi-sandbox", "/opt/trusted tools"]);
    const capped = {
      ...base,
      execution: { ...base.execution, maximumTimeoutMs: 3_600_000, commandPathPrepend },
    };
    const patchedExecution = applyAccountOverrides(capped, {
      execution: { backend: "direct" },
      tools: {},
    }).execution;
    expect(patchedExecution).toEqual({
      backend: "direct",
      maximumTimeoutMs: 3_600_000,
      commandPathPrepend,
    });
    expect(patchedExecution.commandPathPrepend).toBe(commandPathPrepend);
    expect(applyAccountOverrides(capped, { tools: {} }).execution.commandPathPrepend).toBe(
      commandPathPrepend,
    );
    const direct = applyAccountOverrides(restricted, {
      execution: { backend: "direct" },
      network: { mode: "host" },
      filesystem: { cwdWritable: true },
      tools: {},
    });
    expect(direct.filesystem).toEqual({
      cwdWritable: true,
      deniedPaths: [],
      hiddenPaths: ["/srv/runs"],
    });
    expect(direct.execution).toEqual({ backend: "direct" });
    expect(effective.extensions).toBe(base.extensions);
    expect(() =>
      applyAccountOverrides(base, {
        tools: { unknown_tool: { mode: "deny", sessionGrant: "never" } },
      }),
    ).toThrow("override for unavailable tool: unknown_tool");
  });
});

describe("account MCP overrides", () => {
  const codemode = { enabled: false, timeoutMs: 300000 };
  const policy = { mode: "ask", session_grant: "offer", audit: true };
  const mcp = parseMcpConfig(
    {
      servers: {
        docs: {
          enabled: false,
          transport: "http",
          url: "https://docs.example/mcp",
          bearer_token_from_env: "DOCS_TOKEN",
          exposure: "direct",
          default_policy: policy,
          tool_rules: [{ match: "search_*", ...policy }],
        },
        local: {
          enabled: true,
          transport: "stdio",
          command: "/opt/mcp/server",
          args: ["--tools"],
          env: { CACHE: "~/.cache/mcp" },
          env_from_env: { TOKEN: "LOCAL_TOKEN" },
          exposure: "direct",
          default_policy: policy,
        },
      },
    },
    codemode,
  );
  const base: SandboxConfig = {
    configVersion: 16,
    modelAuth: { personalProviders: [] },
    skills: { directories: [] },
    exports: { enabled: false },
    codemode,
    mcp,
    sessions: { retentionDays: 365 },
    filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
    audit: { enabled: false },

    execution: { backend: "bubblewrap" },

    network: { mode: "none" },
    environment: { pi: {}, sandbox: {}, extensions: {} },
    extensions: {},
    tools: {},
  };

  it("preserves shared roots through identity overlays and rejects broker skill overrides", () => {
    const configured = { ...base, skills: { directories: ["/srv/shared/skills"] } };
    expect(applyAccountOverrides(configured, { tools: {}, network: { mode: "host" } }).skills).toBe(
      configured.skills,
    );
    expect(() => parseAccountOverrides({ tools: {}, skills: { directories: [] } })).toThrow();
  });

  it("preserves main-only subagent admission while applying only the shared management policy", () => {
    const configured: SandboxConfig = {
      ...base,
      subagents: { enabled: true, maxConcurrent: 2, maxTotal: 17 },
      extensionGuidance: { subagents: "Delegate bounded tasks." },
      tools: { subagents: { mode: "ask", sessionGrant: "never", audit: true } },
    };
    const effective = applyAccountOverrides(configured, {
      tools: { subagents: { mode: "allow", sessionGrant: "never" } },
    });
    expect(effective.subagents).toBe(configured.subagents);
    expect(effective.extensionGuidance).toBe(configured.extensionGuidance);
    expect(() =>
      parseAccountOverrides({ tools: {}, extensionGuidance: { subagents: "Replacement" } }),
    ).toThrow();
    expect(effective.tools.subagents).toEqual({
      mode: "allow",
      sessionGrant: "never",
      audit: true,
    });
    for (const name of [
      "spawn_agent",
      "steer_agent",
      "cancel_agent",
      "resume_agent",
      "inspect_agent",
    ]) {
      expect(() =>
        applyAccountOverrides(configured, {
          tools: { [name]: { mode: "allow", sessionGrant: "never" } },
        }),
      ).toThrow("unavailable tool");
    }
    expect(() =>
      applyAccountOverrides(base, {
        tools: { subagents: { mode: "allow", sessionGrant: "never" } },
      }),
    ).toThrow("unavailable tool");
    expect(() => parseAccountOverrides({ subagents: { enabled: true }, tools: {} })).toThrow();
  });

  it("keeps export admission main-only while allowing confined CWD writability overrides", () => {
    const exporting = {
      ...base,
      exports: { enabled: true },
      filesystem: { ...base.filesystem, cwdWritable: false },
    };
    expect(applyAccountOverrides(exporting, { tools: {} }).exports).toBe(exporting.exports);
    const writable = applyAccountOverrides(exporting, {
      tools: {},
      filesystem: { cwdWritable: true },
    });
    expect(writable.exports).toBe(exporting.exports);
    expect(writable.filesystem.cwdWritable).toBe(true);
    expect(
      applyAccountOverrides(writable, { tools: {}, filesystem: { cwdWritable: false } }).exports,
    ).toBe(exporting.exports);
    expect(
      applyAccountOverrides(base, { tools: {}, filesystem: { cwdWritable: true } }).exports.enabled,
    ).toBe(false);
    expect(() =>
      applyAccountOverrides(exporting, { tools: {}, execution: { backend: "direct" } }),
    ).toThrow("exports.enabled");
    expect(() => parseAccountOverrides({ tools: {}, exports: { enabled: true } })).toThrow();
  });

  it("inherits omitted MCP admission and immutably overlays enabled flags only", () => {
    expect(applyAccountOverrides(base, { tools: {} }).mcp).toBe(mcp);
    for (const [id, enabled] of [
      ["docs", true],
      ["local", false],
    ] as const) {
      const other = id === "docs" ? "local" : "docs";
      const patch = Object.freeze({ enabled });
      const effective = applyAccountOverrides(base, {
        mcp: { servers: { [id]: patch } },
        tools: {},
      });
      expect(effective.mcp.servers[id]).toEqual({ ...mcp.servers[id], enabled });
      expect(effective.mcp.servers[id]).not.toBe(mcp.servers[id]);
      expect(effective.mcp.servers[id]!.defaultPolicy).toBe(mcp.servers[id]!.defaultPolicy);
      expect(effective.mcp.servers[id]!.toolRules).toBe(mcp.servers[id]!.toolRules);
      expect(effective.mcp.servers[other]).toBe(mcp.servers[other]);
      expect(effective.codemode).toBe(base.codemode);
      expect(Object.isFrozen(effective.mcp)).toBe(true);
      expect(Object.isFrozen(effective.mcp.servers)).toBe(true);
      expect(Object.isFrozen(effective.mcp.servers[id])).toBe(true);
      expect(mcp.servers[id]!.enabled).toBe(!enabled);
      expect(patch).toEqual({ enabled });
    }
  });

  it("applies policy-only layers without enabling the server or replacing global audit/connection fields", () => {
    const response = parseAccountOverrides(
      mcpResponse({
        docs: {
          policy_layers: [
            {
              default_policy: { mode: "allow", session_grant: "never" },
              tool_rules: [],
            },
          ],
        },
      }),
    );
    const effective = applyAccountOverrides(base, response);
    expect(effective.mcp.servers.docs).toEqual({
      ...mcp.servers.docs,
      policyLayers: response.mcp!.servers.docs!.policyLayers,
    });
    expect(effective.mcp.servers.docs!.enabled).toBe(false);
    expect(effective.mcp.servers.docs!.defaultPolicy).toBe(mcp.servers.docs!.defaultPolicy);
    expect(effective.mcp.servers.docs!.toolRules).toBe(mcp.servers.docs!.toolRules);
    expect(effective.mcp.servers.local).toBe(mcp.servers.local);
    expect(base.mcp.servers.docs!.policyLayers).toBeUndefined();
  });

  it.each(["missing", "constructor"])("rejects the undefined server %s", (id) => {
    expect(() =>
      applyAccountOverrides(base, { mcp: { servers: { [id]: { enabled: false } } }, tools: {} }),
    ).toThrow(`override for unavailable MCP server: ${id}`);
  });

  it("requires Code Mode when an override enables a dormant Code Mode exposure", () => {
    const dormant: SandboxConfig = {
      ...base,
      mcp: {
        servers: {
          docs: { ...mcp.servers.docs!, enabled: false, exposure: "codemode" },
        },
      },
    };
    expect(applyAccountOverrides(dormant, { tools: {} }).mcp).toBe(dormant.mcp);
    expect(() =>
      applyAccountOverrides(dormant, { mcp: { servers: { docs: { enabled: true } } }, tools: {} }),
    ).toThrow("config.mcp.servers.docs.exposure requires codemode.enabled");
    const permitted = applyAccountOverrides(
      { ...dormant, codemode: { ...codemode, enabled: true } },
      { mcp: { servers: { docs: { enabled: true } } }, tools: {} },
    );
    expect(permitted.mcp.servers.docs).toMatchObject({ enabled: true, exposure: "codemode" });
    expect(dormant.mcp.servers.docs!.enabled).toBe(false);
  });
});

describe("account command-class overrides", () => {
  const allow = { audit: true, mode: "allow", sessionGrant: "never" } as const;
  const base = {
    configVersion: 16,
    modelAuth: { personalProviders: [] },
    skills: { directories: [] },
    exports: { enabled: false },
    codemode: { enabled: false, timeoutMs: 300000 },
    mcp: { servers: {} },
    sessions: { retentionDays: 365 },
    filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
    audit: { enabled: false },

    execution: { backend: "bubblewrap" },

    network: { mode: "none" },
    environment: { pi: {}, sandbox: {}, extensions: {} },
    extensions: {},
    tools: {
      read: allow,
      grep: allow,
      find: allow,
      ls: allow,
      write: allow,
      edit: allow,
      bash: {
        audit: true,
        mode: "deny",
        sessionGrant: "never",
        commandClasses: { known_read_only: { mode: "allow", sessionGrant: "never" } },
      },
    },
  } satisfies SandboxConfig;

  it("preserves only the main command-set definitions across ordinary policy overrides", () => {
    const commandSets = {
      utility_read: {
        commands: ["utility", "/usr/libexec/pi-sandbox/utility"],
        mode: "allow",
        sessionGrant: "never",
        requiredFlags: ["--read"],
        optionalFlags: [],
        options: {},
        operands: { min: 1, max: 1 },
      },
    } as const;
    const configured = {
      ...base,
      tools: { ...base.tools, bash: { ...base.tools.bash, commandSets } },
    };
    for (const mode of ["allow", "ask", "deny", "disabled"] as const) {
      const selected = applyAccountOverrides(configured, {
        tools: { bash: { mode, sessionGrant: "never" } },
      });
      expect(selected.tools.bash!.commandSets).toBe(commandSets);
      expect(selected.tools.bash!.mode).toBe(mode);
      expect(selected.tools.bash).not.toHaveProperty("commandClasses");
    }
    const untrustedOverride = { mode: "ask", sessionGrant: "never", commandSets } as const;
    expect(
      applyAccountOverrides(base, { tools: { bash: untrustedOverride } }).tools.bash,
    ).not.toHaveProperty("commandSets");
  });

  it("rejects command-set definitions in broker tool policy responses", () => {
    for (const field of ["command_sets", "commandSets"]) {
      const source = { tools: { bash: { mode: "ask", session_grant: "never", [field]: {} } } };
      expect(() => parseAccountOverrides(source)).toThrow();
    }
  });

  it("replaces the whole Bash policy, including an absent class policy", () => {
    expect(applyAccountOverrides(base, { tools: {} }).tools.bash).toBe(base.tools.bash);
    const withoutClass = applyAccountOverrides(base, {
      tools: { bash: { mode: "ask", sessionGrant: "never" } },
    });
    expect(withoutClass.tools.bash).toEqual({ mode: "ask", sessionGrant: "never", audit: true });
    const withClass = applyAccountOverrides(base, {
      tools: {
        bash: {
          mode: "ask",
          sessionGrant: "never",
          commandClasses: { known_read_only: { mode: "ask", sessionGrant: "offer" } },
        },
      },
    });
    expect(withClass.tools.bash).toEqual({
      mode: "ask",
      sessionGrant: "never",
      audit: true,
      commandClasses: { known_read_only: { mode: "ask", sessionGrant: "offer" } },
    });
  });

  it("fails closed when overlays leave a class allow without allowed read tools", () => {
    expect(() =>
      applyAccountOverrides(base, {
        tools: { grep: { mode: "ask", sessionGrant: "never" } },
      }),
    ).toThrow(
      'effective tool policy after account overrides is invalid: tools.bash.known_read_only.mode "allow" requires tools.grep.mode "allow" (it is "ask"); allow read, grep, find, ls or use a stricter bash.known_read_only mode in the base configuration or configuration service rules',
    );
    expect(() =>
      applyAccountOverrides(
        { ...base, tools: { ...base.tools, bash: { ...allow, mode: "deny" } } },
        {
          tools: {
            read: { mode: "deny", sessionGrant: "never" },
            bash: {
              mode: "deny",
              sessionGrant: "never",
              commandClasses: { known_read_only: { mode: "allow", sessionGrant: "never" } },
            },
          },
        },
      ),
    ).toThrow('requires tools.read.mode "allow" (it is "deny")');
    expect(
      applyAccountOverrides(base, {
        tools: {
          grep: { mode: "ask", sessionGrant: "never" },
          bash: {
            mode: "deny",
            sessionGrant: "never",
            commandClasses: { known_read_only: { mode: "ask", sessionGrant: "never" } },
          },
        },
      }).tools.bash?.commandClasses,
    ).toEqual({ known_read_only: { mode: "ask", sessionGrant: "never" } });
  });
});

describe("strict service account patches", () => {
  it("requires a tool patch and rejects source, secret, audit and main-only authority", () => {
    for (const value of [
      {},
      { tools: [] },
      { tools: {}, models_file: "/elsewhere" },
      { tools: {}, environment: { pi: { TOKEN: "value" } } },
      { tools: {}, identity: { mode: "disabled" } },
      { tools: {}, audit: { enabled: false } },
      { tools: {}, skills: { directories: [] } },
      { tools: {}, model_auth: { personal_providers: ["all"] } },
    ])
      expect(() => parseAccountOverrides(value)).toThrow();
    expect(parseAccountOverrides({ tools: {} })).toEqual({ tools: {} });
  });
  it("preserves omission and canonical workspace admission without selecting a mode", () => {
    for (const workspace of [
      { allowed: [] },
      { allowed: ["host", "sandbox"] },
      { default: "sandbox" },
    ]) {
      const parsed = parseAccountOverrides({ tools: {}, workspace });
      expect(parsed.workspace).toEqual(workspace);
      expect(Object.isFrozen(parsed.workspace)).toBe(true);
    }
    for (const workspace of [
      {},
      { allowed: ["sandbox", "host"] },
      { allowed: ["host", "host"] },
      { allowed: ["Bad"] },
      { default: "" },
      { default: "host", extra: true },
    ])
      expect(() => parseAccountOverrides({ tools: {}, workspace })).toThrow();
  });
  it("permits only complete transport-specific invocation pairs and narrow operational patches", () => {
    for (const backend of ["direct", "bubblewrap", "seatbelt"])
      expect(parseAccountOverrides({ tools: {}, execution: { backend } }).execution).toEqual({
        backend,
      });
    for (const patch of [
      { execution: {} },
      { execution: { backend: "smolvm" } },
      { execution: { backend: "direct", max_command_timeout_seconds: 1 } },
      { filesystem: { cwd_writable: false, hidden_paths: [] } },
      { filesystem: { cwd_writable: "false" } },
      { network: { mode: "other" } },
      { tools: { read: { mode: "allow" } } },
      { tools: { read: { mode: "allow", session_grant: "offer" } } },
      { tools: { read: { mode: "allow", session_grant: "never", audit: false } } },
      {
        tools: {
          read: {
            mode: "allow",
            session_grant: "never",
            known_read_only: { mode: "allow", session_grant: "never" },
          },
        },
      },
    ])
      expect(() => parseAccountOverrides({ tools: {}, ...patch })).toThrow();
    for (const cwd_writable of [true, false])
      expect(parseAccountOverrides({ tools: {}, filesystem: { cwd_writable } }).filesystem).toEqual(
        { cwdWritable: cwd_writable },
      );
  });
  it("rejects malformed MCP patches and attempts to replace connections or audit", () => {
    for (const mcp of [
      null,
      false,
      [],
      {},
      { servers: null },
      { servers: [] },
      { servers: {} },
      { servers: { docs: { enabled: true } }, extra: true },
      {
        servers: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`s${i}`, { enabled: true }]),
        ),
      },
      ...["", "Docs", "a-b", "_docs", "a".repeat(33)].map((id) => ({
        servers: { [id]: { enabled: true } },
      })),
      ...[
        null,
        [],
        {},
        { enabled: null },
        { enabled: 0 },
        { enabled: "false" },
        { enabled: true, extra: true },
        { enabled: true, url: "https://other.invalid" },
        { enabled: true, exposure: "direct" },
        { default_policy: { mode: "allow", session_grant: "never", audit: false } },
      ].map((entry) => ({ servers: { docs: entry } })),
    ])
      expect(() => parseAccountOverrides({ tools: {}, mcp })).toThrow();
  });
  it("preserves independent MCP layer order without defaulting admission", () => {
    const layer = {
      default_policy: { mode: "ask", session_grant: "offer" },
      tool_rules: [{ match: "search_*", mode: "allow", session_grant: "never" }],
    };
    const patch = parseAccountOverrides(mcpResponse({ docs: { policy_layers: [layer] } })).mcp!
      .servers.docs!;
    expect(patch).not.toHaveProperty("enabled");
    expect(patch.policyLayers).toEqual([
      {
        defaultPolicy: { mode: "ask", sessionGrant: "offer" },
        toolRules: [{ match: "search_*", mode: "allow", sessionGrant: "never" }],
      },
    ]);
    for (const value of [
      patch,
      patch.policyLayers,
      patch.policyLayers![0],
      patch.policyLayers![0]!.toolRules,
      patch.policyLayers![0]!.toolRules[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });
  it("rejects malformed, duplicate or excessive MCP layers and retains aggregate limits", () => {
    const pair = { mode: "ask", session_grant: "offer" },
      rule = { match: "search_*", ...pair },
      layer = { tool_rules: [rule] };
    for (const policy_layers of [
      null,
      {},
      [],
      [null],
      [{}],
      [{ tool_rules: [] }],
      [{ default_policy: pair }],
      [{ ...layer, audit: false }],
      [layer, layer],
      [{ tool_rules: [rule, rule] }],
      ...[
        {},
        null,
        { mode: "allow" },
        { session_grant: "never" },
        { mode: "allow", session_grant: "offer" },
        { ...pair, audit: true },
      ].map((default_policy) => [{ default_policy, tool_rules: [] }]),
      ...["", "x?", "x[", "x\\", "x ", "x\ufeff", "x\u0000", "x\ud800", "é".repeat(65)].map(
        (match) => [{ tool_rules: [{ ...rule, match }] }],
      ),
      [{ tool_rules: [{ ...rule, audit: false }] }],
      Array.from({ length: 257 }, (_, n) => ({ tool_rules: [{ ...rule, match: `tool${n}` }] })),
      [{ tool_rules: Array.from({ length: 257 }, (_, n) => ({ ...rule, match: `tool${n}` })) }],
    ])
      expect(() => parseAccountOverrides(mcpResponse({ docs: { policy_layers } }))).toThrow();
    const rules = Array.from({ length: 256 }, (_, n) => ({ ...rule, match: `tool${n}` }));
    const servers = Object.fromEntries(
      Array.from({ length: 4 }, (_, n) => [`s${n}`, { policy_layers: [{ tool_rules: rules }] }]),
    );
    expect(() => parseAccountOverrides(mcpResponse(servers))).not.toThrow();
    expect(() =>
      parseAccountOverrides(mcpResponse({ ...servers, fifth: { policy_layers: [layer] } })),
    ).toThrow();
    const large = {
      policy_layers: Array.from({ length: 256 }, (_, n) => ({
        default_policy: { mode: "disabled", session_grant: "never" },
        tool_rules: [
          { mode: "disabled", session_grant: "never", match: `${n}_${"x".repeat(124)}` },
        ],
      })),
    };
    expect(() =>
      parseAccountOverrides(
        mcpResponse(Object.fromEntries(Array.from({ length: 4 }, (_, n) => [`s${n}`, large]))),
      ),
    ).toThrow();
  });
});
