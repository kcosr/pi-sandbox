import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TOOL_NAMES, type SandboxConfig } from "../domain/index.js";
import { ConfigError, loadConfig, parseConfig as parseConfigWithCatalog } from "./index.js";
import {
  createManagedExtensionCatalog,
  type ManagedExtensionCatalog,
} from "../managed-extensions/catalog.js";

const temporaryDirectories: string[] = [];
const EMPTY_EXTENSION_CATALOG = createManagedExtensionCatalog([]);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function completeConfig(
  overrides: Partial<Record<(typeof TOOL_NAMES)[number], string>> = {},
): string {
  const sections = TOOL_NAMES.map(
    (toolName) =>
      `[tools.${toolName}]\naudit = false\n${overrides[toolName] ?? 'mode = "allow"\nsession_grant = "never"'}`,
  );
  return `config_version = 8\nmodels_file = "/etc/pi-sandbox/models.json"\n\n[sessions]\nretention_days = 0\n\n[audit]\nenabled = false\nfacility = "local0"\n\n[filesystem]\ncwd_writable = true\nhidden_paths = []\n\n[execution]\nbackend = "bubblewrap"\n\n[identity]\nmode = "disabled"\n\n[network]\nmode = "none"\n\n[environment.pi]\n\n[environment.sandbox]\n\n[environment.extensions]\n\n[extensions]\n\n${sections.join("\n\n")}\n`;
}

function parseConfig(
  sourceText: string,
  source = "<string>",
  catalog: ManagedExtensionCatalog = EMPTY_EXTENSION_CATALOG,
): SandboxConfig {
  return parseConfigWithCatalog(sourceText, source, catalog);
}

describe("parseConfig", () => {
  it("parses a complete policy for every model tool", () => {
    const config = parseConfig(
      completeConfig({
        read: 'mode = "allow"\nsession_grant = "never"',
        grep: 'mode = "ask"\nsession_grant = "offer"',
        find: 'mode = "deny"\nsession_grant = "never"',
        ls: 'mode = "disabled"\nsession_grant = "never"',
      }),
    );

    expect(config).toEqual({
      configVersion: 8,
      sessions: { retentionDays: 0 },
      filesystem: { cwdWritable: true, hiddenPaths: [] },
      audit: { enabled: false, facility: "local0" },
      modelsFile: "/etc/pi-sandbox/models.json",
      execution: { backend: "bubblewrap" },
      identity: { mode: "disabled" },
      network: { mode: "none" },
      environment: { pi: {}, sandbox: {}, extensions: {} },
      extensions: {},
      tools: {
        read: { mode: "allow", sessionGrant: "never", audit: false },
        grep: { mode: "ask", sessionGrant: "offer", audit: false },
        find: { mode: "deny", sessionGrant: "never", audit: false },
        ls: { mode: "disabled", sessionGrant: "never", audit: false },
        write: { mode: "allow", sessionGrant: "never", audit: false },
        edit: { mode: "allow", sessionGrant: "never", audit: false },
        bash: { mode: "allow", sessionGrant: "never", audit: false },
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.tools)).toBe(true);
    expect(Object.isFrozen(config.tools.read)).toBe(true);
  });

  it("requires a strict bounded session retention policy", () => {
    const source = completeConfig();
    for (const retentionDays of [0, 1, 365, 36_500]) {
      const config = parseConfig(
        source.replace("retention_days = 0", `retention_days = ${retentionDays}`),
      );
      expect(config.sessions).toEqual({ retentionDays });
      expect(Object.isFrozen(config.sessions)).toBe(true);
    }
    for (const retentionDays of ["-1", "36501", "1.5", '"365"', "false", "[]", "inf", "nan"]) {
      expect(() =>
        parseConfig(source.replace("retention_days = 0", `retention_days = ${retentionDays}`)),
      ).toThrow("config.sessions.retention_days must be an integer between 0 and 36500");
    }
    expect(() => parseConfig(source.replace("[sessions]\nretention_days = 0\n\n", ""))).toThrow(
      "config.sessions is required",
    );
    expect(() => parseConfig(source.replace("retention_days = 0", ""))).toThrow(
      "config.sessions.retention_days is required",
    );
    expect(() =>
      parseConfig(source.replace("[sessions]\nretention_days = 0", "sessions = false")),
    ).toThrow("config.sessions must be a table");
    expect(() =>
      parseConfig(source.replace("retention_days = 0", "retention_days = 0\nextra = true")),
    ).toThrow("config.sessions.extra is not a recognized field");
  });

  it("requires a strict filesystem policy and rejects unenforceable direct access", () => {
    const source = completeConfig();
    const readonly = source.replace("cwd_writable = true", "cwd_writable = false");
    expect(parseConfig(readonly).filesystem).toEqual({ cwdWritable: false, hiddenPaths: [] });
    expect(Object.isFrozen(parseConfig(readonly).filesystem)).toBe(true);
    for (const invalid of [
      source.replace("[filesystem]\ncwd_writable = true\nhidden_paths = []\n\n", ""),
      source.replace("cwd_writable = true", ""),
      source.replace("cwd_writable = true", 'cwd_writable = "false"'),
      source.replace("cwd_writable = true", "cwd_writable = 0"),
      source.replace("cwd_writable = true", "cwd_writable = true\nextra = true"),
    ])
      expect(() => parseConfig(invalid)).toThrow(ConfigError);
    expect(() =>
      parseConfig(
        readonly
          .replace('backend = "bubblewrap"', 'backend = "direct"')
          .replace('mode = "none"', 'mode = "host"'),
      ),
    ).toThrow("config.filesystem.cwd_writable must be true");
  });

  it("requires strict global and per-tool audit settings", () => {
    const source = completeConfig();
    expect(parseConfig(source.replace("enabled = false", "enabled = true")).audit).toEqual({
      enabled: true,
      facility: "local0",
    });
    for (const facility of [
      "local0",
      "local1",
      "local2",
      "local3",
      "local4",
      "local5",
      "local6",
      "local7",
    ]) {
      expect(
        parseConfig(source.replace('facility = "local0"', `facility = "${facility}"`)).audit
          .facility,
      ).toBe(facility);
    }
    for (const [before, after, issue] of [
      ['[audit]\nenabled = false\nfacility = "local0"\n\n', "", "config.audit is required"],
      ["enabled = false", 'enabled = "false"', "config.audit.enabled must be a boolean"],
      ['facility = "local0"', 'facility = "user"', "config.audit.facility must be one of"],
      [
        'facility = "local0"',
        'facility = "local0"\npath = "/tmp/events"',
        "config.audit.path is not a recognized field",
      ],
      ["audit = false\n", "", "config.tools.read.audit is required"],
      ["audit = false", 'audit = "false"', "config.tools.read.audit must be a boolean"],
    ]) {
      expect(() => parseConfig(source.replace(before!, after!))).toThrow(issue);
    }
  });

  it("requires explicit unique normalized hidden paths and rejects direct mode", () => {
    const source = completeConfig();
    for (const replacement of [
      "",
      'hidden_paths = "path"',
      'hidden_paths = ["relative"]',
      'hidden_paths = ["/"]',
      'hidden_paths = ["/a/../b"]',
      'hidden_paths = ["/a/"]',
      'hidden_paths = ["/a", "/a"]',
      "hidden_paths = [1]",
    ]) {
      expect(() => parseConfig(source.replace("hidden_paths = []", replacement))).toThrow(
        ConfigError,
      );
    }
    const configured = source.replace(
      "hidden_paths = []",
      'hidden_paths = ["/srv/runs", "/srv/transcripts"]',
    );
    expect(parseConfig(configured).filesystem.hiddenPaths).toEqual([
      "/srv/runs",
      "/srv/transcripts",
    ]);
    expect(Object.isFrozen(parseConfig(configured).filesystem.hiddenPaths)).toBe(true);
    expect(() =>
      parseConfig(
        configured
          .replace('backend = "bubblewrap"', 'backend = "direct"')
          .replace('mode = "none"', 'mode = "host"'),
      ),
    ).toThrow("config.filesystem.hidden_paths must be empty");
    expect(() => parseConfig(source.replace("config_version = 8", "config_version = 7"))).toThrow(
      "integer 8",
    );
  });

  it.each([
    "/proc",
    "/proc/self",
    "/sys",
    "/sys/kernel",
    "/dev",
    "/dev/shm",
    "/run",
    "/run/private",
    "/tmp",
  ])("rejects a reserved hidden path during configuration validation: %s", (target) => {
    expect(() =>
      parseConfig(completeConfig().replace("hidden_paths = []", `hidden_paths = ["${target}"]`)),
    ).toThrow("config.filesystem.hidden_paths must not overlap private system paths or hide /tmp");
  });

  it("permits private-path name lookalikes and /tmp descendants without probing the host", () => {
    const paths = ["/devices", "/process", "/runner", "/systems", "/tmp/runs"];
    const config = parseConfig(
      completeConfig().replace("hidden_paths = []", `hidden_paths = ${JSON.stringify(paths)}`),
    );
    expect(config.filesystem.hiddenPaths).toEqual(paths);
  });

  it("rejects malformed TOML without returning a partial policy", () => {
    expect(() => parseConfig("config_version = [", "broken.toml")).toThrowError(
      new ConfigError("broken.toml", ["TOML syntax is invalid"]),
    );
  });

  it("rejects unsupported config versions and types", () => {
    expect(() =>
      parseConfig(completeConfig().replace("config_version = 8", 'config_version = "8"')),
    ).toThrow("config.config_version must be the integer 8");
    expect(() =>
      parseConfig(completeConfig().replace("config_version = 8", "config_version = 4")),
    ).toThrow("config.config_version must be the integer 8");
  });

  it("requires models_file to be a normalized absolute file path", () => {
    expect(() =>
      parseConfig(completeConfig().replace('models_file = "/etc/pi-sandbox/models.json"\n', "")),
    ).toThrow("config.models_file is required");
    expect(() =>
      parseConfig(
        completeConfig().replace(
          'models_file = "/etc/pi-sandbox/models.json"',
          'models_file = "models.json"',
        ),
      ),
    ).toThrow("config.models_file must be a normalized absolute file path");
    expect(() =>
      parseConfig(
        completeConfig().replace('models_file = "/etc/pi-sandbox/models.json"', "models_file = 42"),
      ),
    ).toThrow("config.models_file must be a normalized absolute file path");
    expect(() =>
      parseConfig(
        completeConfig().replace(
          'models_file = "/etc/pi-sandbox/models.json"',
          'models_file = "/etc/pi-sandbox/../models.json"',
        ),
      ),
    ).toThrow("config.models_file must be a normalized absolute file path");
  });

  it("rejects unknown fields at every schema level", () => {
    expect(() =>
      parseConfig(
        completeConfig().replace("config_version = 8", "config_version = 8\nunexpected = true"),
      ),
    ).toThrow("config.unexpected is not a recognized field");
    expect(() =>
      parseConfig(
        completeConfig().replace(
          'models_file = "/etc/pi-sandbox/models.json"',
          'models_file = "/etc/pi-sandbox/models.json"\nunexpected = true',
        ),
      ),
    ).toThrow("config.unexpected is not a recognized field");
    expect(() =>
      parseConfig(completeConfig().replace("[tools.read]", '[tools.read]\nunexpected = "x"')),
    ).toThrow("config.tools.read.unexpected is not a recognized field");
    expect(() =>
      parseConfig(
        `${completeConfig()}\n[tools.download]\nmode = "allow"\nsession_grant = "never"\n`,
      ),
    ).toThrow("config.tools.download is not a recognized field");
  });

  it("selects compiled extensions by table presence and requires their tool policies", () => {
    const extension = {
      kind: "managed",
      id: "git",
      tools: [{ name: "git_clone" }],
      hostEnvironment: { variables: ["GIT_TOKEN"] },
      parseConfig(value: unknown) {
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          Object.keys(value).join(",") !== "allowed_hosts" ||
          !Array.isArray((value as { allowed_hosts?: unknown }).allowed_hosts)
        ) {
          throw new Error("must contain only allowed_hosts");
        }
        return { allowedHosts: (value as { allowed_hosts: unknown[] }).allowed_hosts };
      },
    };
    const catalog = {
      extensions: [extension],
      tools: [{ extensionId: "git", definition: extension.tools[0] }],
      toolNames: ["git_clone"],
      getExtension: (id: string) => (id === "git" ? extension : undefined),
      getTool: () => undefined,
    } as unknown as ManagedExtensionCatalog;
    const source = `${completeConfig().replace(
      "[environment.extensions]",
      '[environment.extensions.git]\nGIT_TOKEN = "configured"',
    )}\n[extensions.git]\nallowed_hosts = ["github.com"]\n\n[tools.git_clone]\naudit = false\nmode = "ask"\nsession_grant = "never"\n`;
    const config = parseConfig(source, "managed.toml", catalog);
    expect(config.extensions).toEqual({
      git: { id: "git", settings: { allowedHosts: ["github.com"] }, toolNames: ["git_clone"] },
    });
    expect(config.tools.git_clone).toEqual({ mode: "ask", sessionGrant: "never", audit: false });
    expect(config.environment.extensions.git).toEqual({ GIT_TOKEN: "configured" });
    expect(() =>
      parseConfig(
        source.replace("[extensions.git]", "[extensions.unknown]"),
        "managed.toml",
        catalog,
      ),
    ).toThrow("config.extensions.unknown is not a recognized field");
    expect(() =>
      parseConfig(
        source.replace(
          '[extensions.git]\nallowed_hosts = ["github.com"]',
          "[extensions.git]\nunexpected = true",
        ),
        "managed.toml",
        catalog,
      ),
    ).toThrow("config.extensions.git must contain only allowed_hosts");
    expect(() =>
      parseConfig(
        source.replace(
          '[tools.git_clone]\naudit = false\nmode = "ask"\nsession_grant = "never"',
          "",
        ),
        "managed.toml",
        catalog,
      ),
    ).toThrow("config.tools.git_clone is required");
    expect(() =>
      parseConfig(
        source.replace("[environment.extensions.git]", "[environment.extensions.audit]"),
        "managed.toml",
        catalog,
      ),
    ).toThrow("config.environment.extensions.audit requires config.extensions.audit");
    expect(() =>
      parseConfig(source.replace("GIT_TOKEN", "UNDECLARED"), "managed.toml", catalog),
    ).toThrow(
      "config.environment.extensions.git.UNDECLARED is not declared by the compiled extension",
    );
  });

  it("requires the extensions table", () => {
    expect(() => parseConfig(completeConfig().replace("[extensions]\n\n", ""))).toThrow(
      "config.extensions is required",
    );
  });

  it("parses strict scoped global environment defaults", () => {
    const config = parseConfig(
      completeConfig()
        .replace("[environment.pi]", '[environment.pi]\nMODEL_TOKEN = "global"')
        .replace("[environment.sandbox]", '[environment.sandbox]\nPROJECT_MODE = "managed"'),
    );
    expect(config.environment).toEqual({
      pi: { MODEL_TOKEN: "global" },
      sandbox: { PROJECT_MODE: "managed" },
      extensions: {},
    });
    expect(() => parseConfig(completeConfig().replace("[environment.pi]\n\n", ""))).toThrow(
      "config.environment must contain only valid pi, sandbox, and extensions tables",
    );
    expect(() =>
      parseConfig(completeConfig().replace("[environment.pi]", '[environment.pi]\nHOME = "/tmp"')),
    ).not.toThrow();
    expect(() =>
      parseConfig(
        completeConfig().replace("[environment.sandbox]", '[environment.sandbox]\nHOME = "/tmp"'),
      ),
    ).toThrow("config.environment must contain only valid pi, sandbox, and extensions tables");
  });

  it("rejects every missing tool policy", () => {
    for (const toolName of TOOL_NAMES) {
      const section = `[tools.${toolName}]\naudit = false\nmode = "allow"\nsession_grant = "never"`;
      expect(() => parseConfig(completeConfig().replace(section, ""))).toThrow(
        `config.tools.${toolName} is required`,
      );
    }
  });

  it("rejects missing root fields and tables with the wrong shape", () => {
    expect(() => parseConfig(completeConfig().replace("config_version = 8\n", ""))).toThrow(
      "config.config_version is required",
    );
    expect(() =>
      parseConfig(
        'config_version = 8\nmodels_file = "/etc/pi-sandbox/models.json"\nexecution = "direct"\nidentity = "disabled"\nnetwork = "none"\nextensions = "none"\ntools = "all"\n',
      ),
    ).toThrow("config.tools must be a table");
    expect(() =>
      parseConfig(
        completeConfig().replace(
          '[tools.read]\naudit = false\nmode = "allow"\nsession_grant = "never"',
          'tools.read = "allow"',
        ),
      ),
    ).toThrow("config.tools.read must be a table");
  });

  it("parses strict disabled and broker identity modes", () => {
    expect(parseConfig(completeConfig()).identity).toEqual({ mode: "disabled" });
    expect(
      parseConfig(
        completeConfig().replace('[identity]\nmode = "disabled"', '[identity]\nmode = "broker"'),
      ).identity,
    ).toEqual({ mode: "broker" });
  });

  it("requires an explicit execution backend and host networking for direct execution", () => {
    expect(parseConfig(completeConfig()).execution).toEqual({ backend: "bubblewrap" });
    const direct = completeConfig()
      .replace('backend = "bubblewrap"', 'backend = "direct"')
      .replace('[network]\nmode = "none"', '[network]\nmode = "host"');
    expect(parseConfig(direct).execution).toEqual({ backend: "direct" });
    expect(() =>
      parseConfig(completeConfig().replace('backend = "bubblewrap"', 'backend = "direct"')),
    ).toThrow('config.network.mode must be "host" when config.execution.backend is "direct"');
    expect(() =>
      parseConfig(
        completeConfig().replace(
          '[audit]\nenabled = false\nfacility = "local0"\n\n[filesystem]\ncwd_writable = true\nhidden_paths = []\n\n[execution]\nbackend = "bubblewrap"\n\n',
          "",
        ),
      ),
    ).toThrow("config.execution is required");
    expect(() =>
      parseConfig(completeConfig().replace('backend = "bubblewrap"', 'backend = "container"')),
    ).toThrow("config.execution.backend must be one of: bubblewrap, direct");
  });

  it("rejects incomplete or ambiguous identity configuration", () => {
    expect(() =>
      parseConfig(completeConfig().replace('[identity]\nmode = "disabled"\n\n', "")),
    ).toThrow("config.identity is required");
    expect(() =>
      parseConfig(completeConfig().replace('mode = "disabled"', 'mode = "optional"')),
    ).toThrow("config.identity.mode must be one of: disabled, broker");
    expect(() =>
      parseConfig(
        completeConfig().replace(
          'mode = "disabled"',
          'mode = "disabled"\nsocket_path = "/run/pi-sandbox-identity/broker.sock"',
        ),
      ),
    ).toThrow("config.identity.socket_path is not a recognized field");
  });

  it("parses only explicit none and host network modes", () => {
    expect(parseConfig(completeConfig()).network).toEqual({ mode: "none" });
    expect(
      parseConfig(completeConfig().replace('[network]\nmode = "none"', '[network]\nmode = "host"'))
        .network,
    ).toEqual({ mode: "host" });
    expect(() => parseConfig(completeConfig().replace('[network]\nmode = "none"\n\n', ""))).toThrow(
      "config.network is required",
    );
    expect(() =>
      parseConfig(completeConfig().replace('mode = "none"', 'mode = "filtered"')),
    ).toThrow("config.network.mode must be one of: none, host");
    expect(() =>
      parseConfig(
        completeConfig().replace('mode = "none"', 'mode = "none"\nallow = ["127.0.0.1"]'),
      ),
    ).toThrow("config.network.allow is not a recognized field");
  });

  it("rejects the obsolete user_shell policy table", () => {
    expect(() =>
      parseConfig(`${completeConfig()}\n[user_shell]\nmode = "ask"\nsession_grant = "never"\n`),
    ).toThrow("config.user_shell is not a recognized field");
  });

  it("rejects invalid mode and session-grant values", () => {
    expect(() =>
      parseConfig(completeConfig({ bash: 'mode = "sometimes"\nsession_grant = "never"' })),
    ).toThrow("config.tools.bash.mode must be one of: allow, ask, deny, disabled");
    expect(() =>
      parseConfig(completeConfig({ write: 'mode = "ask"\nsession_grant = "always"' })),
    ).toThrow("config.tools.write.session_grant must be one of: never, offer");
  });

  it("rejects offering session grants when there is no approval prompt", () => {
    for (const mode of ["allow", "deny", "disabled"]) {
      expect(() =>
        parseConfig(completeConfig({ read: `mode = "${mode}"\nsession_grant = "offer"` })),
      ).toThrow('config.tools.read.session_grant may be "offer" only when mode is "ask"');
    }
  });
});

describe("loadConfig", () => {
  it("loads and validates a UTF-8 configuration file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-sandbox-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.toml");
    await writeFile(path, completeConfig(), "utf8");

    await expect(loadConfig(path, EMPTY_EXTENSION_CATALOG)).resolves.toMatchObject({
      configVersion: 8,
      sessions: { retentionDays: 0 },
      filesystem: { cwdWritable: true, hiddenPaths: [] },
      audit: { enabled: false, facility: "local0" },
    });
  });

  it("fails closed when the configuration file cannot be read", async () => {
    const missingPath = join(tmpdir(), "pi-sandbox-config-does-not-exist", "config.toml");

    await expect(loadConfig(missingPath, EMPTY_EXTENSION_CATALOG)).rejects.toThrow(
      "configuration file could not be read",
    );
  });
});
