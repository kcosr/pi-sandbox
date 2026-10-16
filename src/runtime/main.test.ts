import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseSandboxArguments } from "./config-arguments.js";
import { DISPLAY_VERSION } from "../version.js";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { SandboxExecutionError } from "../../packages/sandbox-extension/src/runtime/contracts.js";

import { IDENTITY_BROKER_SOCKET_PATH } from "../domain/index.js";
import type { IdentityOverrides, SandboxConfig } from "../domain/index.js";
import { createManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import {
  defineManagedHostEnvironment,
  freezeExtensionConfig,
  instantiateManagedExtension,
} from "../managed-extensions/sdk.js";
import {
  createManagedModelRuntimeFactory,
  runPiSandbox,
  SYSTEM_CONFIG_PATH,
  assertExecutionPlatform,
  actionableErrorMessage,
  instantiateConfiguredManagedExtensions,
  resolveEffectiveAdministrativeConfiguration,
  resolveManagedExtensionHostEnvironments,
  validateAdministrativeConfiguration,
} from "./main.js";

const temporaryDirectories: string[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(async () => {
  Object.defineProperty(process, "platform", originalPlatform);
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createRoot(
  modelsFile = "/etc/pi-sandbox/models.json",
  platform: NodeJS.Platform = "linux",
): Promise<string> {
  // These policy fixtures exercise Linux Bubblewrap/broker rules without starting
  // an executor. Select their platform explicitly, independently of the test host.
  Object.defineProperty(process, "platform", { value: platform });
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-admin-config-"));
  temporaryDirectories.push(root);
  const configDirectory = join(root, "etc/pi-sandbox");
  await mkdir(configDirectory, { recursive: true });
  const fixture = await readFile(join(process.cwd(), "tests/fixtures/config.toml"), "utf8");
  await writeFile(
    join(configDirectory, "config.toml"),
    fixture.replace("/etc/pi-sandbox/models.json", modelsFile),
  );
  return root;
}

function rooted(root: string, absolutePath: string): string {
  return join(root, absolutePath.slice(1));
}

describe("execution startup diagnostics", () => {
  it("preserves the concrete nested failure and retained-state recovery context", () => {
    const failure = new SandboxExecutionError("sandbox_start_failed", {
      cause: new AggregateError(
        [
          new SandboxExecutionError("sandbox_process_failed", {
            cause: new Error("worker_command_failed: user namespace permission denied"),
          }),
          new Error("worker_cleanup_failed; inspect worker stderr", {
            cause: new Error("stop not confirmed"),
          }),
        ],
        "worker_start_failed; retained diagnostics: /private/worker-example",
      ),
    });
    const message = actionableErrorMessage(failure);
    expect(message).toContain("user namespace permission denied");
    expect(message).toContain("retained diagnostics: /private/worker-example");
    expect(message).toContain("worker stderr");
    expect(message).toContain("stop not confirmed");
  });

  it("deduplicates shared errors and terminates cyclic error graphs", () => {
    const detail = new Error("specific failure");
    const aggregate = new AggregateError([detail, detail, new Error(detail.message)], "startup");
    aggregate.cause = aggregate;
    detail.cause = aggregate;
    expect(actionableErrorMessage(aggregate)).toBe("startup; specific failure");
  });

  it("bounds noisy diagnostics and preserves the generic startup fallback", () => {
    const failure = new AggregateError(
      Array.from({ length: 100 }, (_, index) => new Error(`${index}: ${"x".repeat(10000)}`)),
      "retained diagnostics: /private/worker-example",
    );
    const message = actionableErrorMessage(failure);
    expect(message).toContain("retained diagnostics: /private/worker-example");
    expect(message.length).toBeLessThanOrEqual(4096);
    expect(actionableErrorMessage(new SandboxExecutionError("sandbox_start_failed"))).toBe(
      "sandbox_start_failed",
    );
  });
});

describe("administrative configuration", () => {
  it("reports the application version without reading policy or inspecting the probe workspace", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("probe has no workspace");
    });
    try {
      await runPiSandbox(
        parseSandboxArguments(["--version"], {
          configPath: "/nonexistent/config.toml",
          allowConfigOverride: false,
        }),
      );
      expect(write).toHaveBeenCalledWith(`${DISPLAY_VERSION}\n`);
      expect(cwd).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
      write.mockRestore();
    }
  });

  it("enforces the execution backend's platform contract", () => {
    const config = {
      configVersion: 13,
      codemode: { enabled: false, timeoutMs: 300000 },
      mcp: { servers: {} },
      sessions: { retentionDays: 0 },
      filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
      audit: { enabled: false, facility: "local0" },
      modelsFile: "/etc/pi-sandbox/models.json",
      execution: { backend: "bubblewrap" },
      identity: { mode: "disabled" },
      network: { mode: "none" },
      environment: { pi: {}, sandbox: {}, extensions: {} },
      extensions: {},
      tools: {},
    } satisfies SandboxConfig;
    expect(() => assertExecutionPlatform(config, "linux")).not.toThrow();
    const seatbelt = {
      ...config,
      execution: { backend: "seatbelt" },
      filesystem: { cwdWritable: false, hiddenPaths: [], deniedPaths: ["/Users/alice/private"] },
    } satisfies SandboxConfig;
    expect(() => assertExecutionPlatform(seatbelt, "darwin")).not.toThrow();
    expect(() => assertExecutionPlatform(seatbelt, "linux")).toThrow("only on macOS");
    expect(() =>
      assertExecutionPlatform({ ...seatbelt, network: { mode: "local" } }, "darwin"),
    ).toThrow("none or host");
    expect(() =>
      assertExecutionPlatform(
        { ...seatbelt, filesystem: { ...seatbelt.filesystem, hiddenPaths: ["/Users/private"] } },
        "darwin",
      ),
    ).toThrow("hidden_paths = []");
    expect(() =>
      assertExecutionPlatform({ ...seatbelt, identity: { mode: "broker" } }, "darwin"),
    ).toThrow("identity.mode = disabled");
    expect(() =>
      assertExecutionPlatform(
        { ...seatbelt, audit: { enabled: true, facility: "local0" } },
        "darwin",
      ),
    ).toThrow("audit.enabled = false");
    expect(() =>
      assertExecutionPlatform({ ...config, filesystem: seatbelt.filesystem }, "linux"),
    ).toThrow("denied_paths requires Seatbelt");
    expect(() =>
      assertExecutionPlatform(
        {
          ...config,
          network: { mode: "local" },
          execution: { backend: "bubblewrap" },
        },
        "linux",
      ),
    ).not.toThrow();
    expect(() =>
      assertExecutionPlatform(
        {
          ...config,
          network: { mode: "local" },
          execution: { backend: "direct" },
        },
        "linux",
      ),
    ).toThrow("Direct execution requires network.mode = host");
    expect(() =>
      assertExecutionPlatform(
        {
          ...config,
          execution: { backend: "direct" },
          network: { mode: "host" },
          filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: ["/srv/runs"] },
        },
        "linux",
      ),
    ).toThrow("Direct execution requires filesystem.hidden_paths = []");
    expect(() =>
      assertExecutionPlatform(
        {
          ...config,
          execution: { backend: "direct" },
          network: { mode: "host" },
          filesystem: { cwdWritable: false, deniedPaths: [], hiddenPaths: [] },
        },
        "linux",
      ),
    ).toThrow("Direct execution requires filesystem.cwd_writable = true");
    expect(() =>
      assertExecutionPlatform(
        { ...config, filesystem: { cwdWritable: false, deniedPaths: [], hiddenPaths: [] } },
        "linux",
      ),
    ).not.toThrow();

    expect(() => assertExecutionPlatform(config, "darwin")).toThrow(
      "Bubblewrap execution is supported only on Linux",
    );
    expect(() =>
      assertExecutionPlatform(
        {
          ...config,
          execution: { backend: "direct" },
          network: { mode: "host" },
        },
        "darwin",
      ),
    ).not.toThrow();
    expect(() =>
      assertExecutionPlatform(
        {
          ...config,
          execution: { backend: "direct" },
          network: { mode: "none" },
        },
        "linux",
      ),
    ).toThrow("Direct execution requires network.mode = host");
    expect(() =>
      assertExecutionPlatform(
        {
          ...config,
          execution: { backend: "direct" },
          identity: { mode: "broker" },
          network: { mode: "host" },
        },
        "darwin",
      ),
    ).toThrow("macOS requires identity.mode = disabled");
  });
  it("isolates Pi and extension variables across host executors", () => {
    const makeExtension = (
      id: string,
      hostEnvironment: ReturnType<typeof defineManagedHostEnvironment>,
    ) => ({
      kind: "managed" as const,
      apiVersion: 3 as const,
      id,
      version: "1.0.0",
      hostEnvironment,
      parseConfig: () => freezeExtensionConfig({}),
      requiredHostExecutables: () => [],
      tools: [],
    });
    const agent = makeExtension(
      "service-api",
      defineManagedHostEnvironment({ variables: ["SERVICE_API_TOKEN"], fixed: { FORCE: "1" } }),
    );
    const audit = makeExtension(
      "audit",
      defineManagedHostEnvironment({
        variables: ["AUDIT_TOKEN", "GIT_AUDIT_TOKEN"],
        removeInheritedPrefixes: ["GIT_"],
      }),
    );
    const records = [agent, audit].map((extension) => ({
      manifest: {
        kind: "managed" as const,
        apiVersion: 3 as const,
        id: extension.id,
        version: extension.version,
        toolNames: [],
        digests: { manifestSha256: "a".repeat(64), moduleSha256: "b".repeat(64) },
      },
      extension,
    }));
    const catalog = createManagedExtensionCatalog(records);
    const instances = records.map(({ extension }) =>
      instantiateManagedExtension(extension, freezeExtensionConfig({})),
    );
    const resolved = resolveManagedExtensionHostEnvironments(
      {
        KEEP: "ambient",
        MODEL_TOKEN: "ambient-model",
        SERVICE_API_TOKEN: "ambient-service",
        AUDIT_TOKEN: "ambient-audit",
        GIT_AUDIT_TOKEN: "ambient-git-audit",
        GIT_CONFIG_COUNT: "1",
      },
      {
        pi: { MODEL_TOKEN: "managed-model" },
        sandbox: { SANDBOX_ONLY: "managed-sandbox" },
        extensions: {
          "service-api": { SERVICE_API_TOKEN: "managed-service" },
          audit: { GIT_AUDIT_TOKEN: "managed-git-audit" },
        },
      },
      instances,
      catalog,
    );

    expect(resolved["service-api"]).toEqual({
      SERVICE_API_TOKEN: "managed-service",
      FORCE: "1",
      GIT_CONFIG_COUNT: "1",
      KEEP: "ambient",
    });
    expect(resolved.audit).toEqual({
      AUDIT_TOKEN: "ambient-audit",
      GIT_AUDIT_TOKEN: "managed-git-audit",
      KEEP: "ambient",
    });
    expect(() =>
      resolveManagedExtensionHostEnvironments(
        {},
        { pi: {}, sandbox: {}, extensions: { audit: { UNDECLARED: "value" } } },
        instances,
        catalog,
      ),
    ).toThrow("undeclared environment variable");
    expect(() =>
      resolveManagedExtensionHostEnvironments(
        {},
        { pi: {}, sandbox: {}, extensions: { missing: {} } },
        instances,
        catalog,
      ),
    ).toThrow("environment for unselected extension");
  });

  it("instantiates exactly the extensions selected by effective configuration", () => {
    const settings = freezeExtensionConfig({ executable: "/usr/bin/example" });
    const extension = {
      kind: "managed" as const,
      apiVersion: 3 as const,
      id: "example",
      version: "1.0.0",
      hostEnvironment: Object.freeze({ variables: Object.freeze([]) }),
      parseConfig: () => settings,
      requiredHostExecutables: () => ["/usr/bin/example"],
      tools: [],
    };
    const catalog = createManagedExtensionCatalog([
      {
        manifest: {
          kind: "managed",
          apiVersion: 3,
          id: "example",
          version: "1.0.0",
          toolNames: [],
          digests: { manifestSha256: "a".repeat(64), moduleSha256: "b".repeat(64) },
        },
        extension,
      },
    ]);
    const allow = { audit: false, mode: "allow", sessionGrant: "never" } as const;
    const config = {
      configVersion: 13,
      codemode: { enabled: false, timeoutMs: 300000 },
      mcp: { servers: {} },
      sessions: { retentionDays: 0 },
      filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
      audit: { enabled: false, facility: "local0" },
      modelsFile: "/etc/pi-sandbox/models.json",
      execution: { backend: "bubblewrap" },
      identity: { mode: "disabled" },
      network: { mode: "none" },
      environment: { pi: {}, sandbox: {}, extensions: {} },
      extensions: {
        example: { id: "example", settings, toolNames: [] },
      },
      tools: Object.fromEntries(
        ["read", "grep", "find", "ls", "write", "edit", "bash"].map((name) => [name, allow]),
      ),
    } as SandboxConfig;

    expect(instantiateConfiguredManagedExtensions(config, catalog)).toEqual([
      {
        extension,
        config: settings,
        hostEnvironment: extension.hostEnvironment,
        requiredHostExecutables: ["/usr/bin/example"],
      },
    ]);
  });

  it("accepts the packaged localhost model catalog", async () => {
    const modelsPath = join(process.cwd(), "config/default/models.json");
    const runtime = await createManagedModelRuntimeFactory(modelsPath)({ refreshOnCreate: false });

    expect(runtime.getError()).toBeUndefined();
    expect(runtime.getModel("local", "local-model")).toBeDefined();
  });

  it("loads the fixed config and its administrator-selected models file", async () => {
    const root = await createRoot("/srv/pi-models/managed.json");
    const modelsPath = rooted(root, "/srv/pi-models/managed.json");
    await mkdir(join(root, "srv/pi-models"), { recursive: true });
    await writeFile(modelsPath, JSON.stringify({ providers: {} }));

    await expect(validateAdministrativeConfiguration(root)).resolves.toMatchObject({
      modelsFile: "/srv/pi-models/managed.json",
    });
  });

  it("fails closed when the selected models file is missing", async () => {
    const root = await createRoot();

    await expect(validateAdministrativeConfiguration(root)).rejects.toThrow();
  });

  it("validates Darwin direct policy without launching host tools", async () => {
    const root = await createRoot(undefined, "darwin");
    const configPath = rooted(root, SYSTEM_CONFIG_PATH);
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source
        .replace('backend = "bubblewrap"', 'backend = "direct"')
        .replace('mode = "none"', 'mode = "host"'),
    );
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), '{"providers":{}}');
    await expect(validateAdministrativeConfiguration(root)).resolves.toMatchObject({
      execution: { backend: "direct" },
      network: { mode: "host" },
    });
    await writeFile(configPath, source);
    await expect(validateAdministrativeConfiguration(root)).rejects.toThrow(
      "Bubblewrap execution is supported only on Linux",
    );
  });

  it("keeps home-relative policy unresolved during installation validation", async () => {
    const root = await createRoot();
    const configPath = rooted(root, SYSTEM_CONFIG_PATH);
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source
        .replace("hidden_paths = []", 'hidden_paths = ["~/.ssh"]')
        .replace("[environment.pi]", '[environment.pi]\nPI_CODING_AGENT_DIR = "~/.pi/agent"'),
    );
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), '{"providers":{}}');

    const config = await validateAdministrativeConfiguration(root);
    expect(config.filesystem.hiddenPaths).toEqual(["~/.ssh"]);
    expect(config.environment.pi.PI_CODING_AGENT_DIR).toBe("~/.pi/agent");
  });

  it("uses the resolved account home for effective policy and preserves the caller environment", async () => {
    const root = await createRoot();
    const configPath = rooted(root, SYSTEM_CONFIG_PATH);
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source
        .replace("hidden_paths = []", 'hidden_paths = ["~/.ssh"]')
        .replace(
          "[environment.pi]",
          '[environment.pi]\nHOME = "/policy-home"\nPI_CODING_AGENT_DIR = "~/agent"',
        )
        .replace("[environment.sandbox]", '[environment.sandbox]\nCACHE = "~/cache"'),
    );
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), '{"providers":{}}');
    const callerEnvironment = { HOME: "/caller-home", INHERITED: "~/literal" };
    const account = userInfo();
    const home = account.homedir;

    const effective = await resolveEffectiveAdministrativeConfiguration(
      root,
      callerEnvironment,
      undefined,
      SYSTEM_CONFIG_PATH,
      () => ({ username: account.username, uid: account.uid, homeDirectory: home }),
    );
    expect(effective.config.filesystem.hiddenPaths).toEqual([join(home, ".ssh")]);
    expect(effective.accountHome).toBe(await realpath(home));
    expect(effective.identityEnvironment).toEqual({
      pi: { HOME: "/policy-home", PI_CODING_AGENT_DIR: join(home, "agent") },
      sandbox: { CACHE: join(home, "cache") },
      extensions: {},
    });
    expect(effective.config.environment).toBe(effective.identityEnvironment);
    expect(callerEnvironment).toEqual({ HOME: "/caller-home", INHERITED: "~/literal" });
  });

  it("keeps machine-ID macros symbolic during installation validation", async () => {
    const root = await createRoot();
    const configPath = rooted(root, SYSTEM_CONFIG_PATH);
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source
        .replace("hidden_paths = []", 'hidden_paths = ["/srv/{{machine_id}}"]')
        .replace("[environment.pi]", '[environment.pi]\nPI_MACHINE_ID = "{{machine_id}}"'),
    );
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), '{"providers":{}}');
    // The fixture selects Linux, where resolving this macro would fail.
    const config = await validateAdministrativeConfiguration(root);
    expect(config.configVersion).toBe(13);
    expect(config.filesystem.hiddenPaths).toEqual(["/srv/{{machine_id}}"]);
    expect(config.environment.pi.PI_MACHINE_ID).toBe("{{machine_id}}");
  });

  it("resolves one machine identity after broker merging and overrides ambient identity values", async () => {
    const root = await createRoot();
    const configPath = rooted(root, SYSTEM_CONFIG_PATH);
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source
        .replace('mode = "disabled"', 'mode = "broker"')
        .replace("hidden_paths = []", 'hidden_paths = ["/srv/{{machine_id}}"]')
        .replace("[environment.pi]", '[environment.pi]\nPI_MACHINE_ID = "{{machine_id}}"'),
    );
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), '{"providers":{}}');
    const machineId = "01234567-89AB-4CDE-8123-456789ABCDEF";
    const environment = { PI_MACHINE_ID: "ambient", MACHINE_ID: "spoofed", HOME: "/spoofed" };
    const getMachineId = vi.fn(() => machineId);
    const getAccount = vi.fn((): never => {
      throw new Error("machine identity does not require account identity");
    });
    const effective = await resolveEffectiveAdministrativeConfiguration(
      root,
      environment,
      () =>
        Promise.resolve({
          environment: {
            pi: { REPEATED: "{{machine_id}}/{{machine_id}}" },
            sandbox: { DEVICE: "{{machine_id}}" },
            extensions: { service: { DEVICE: "{{machine_id}}" } },
          },
          overrides: { tools: {} },
        }),
      SYSTEM_CONFIG_PATH,
      getAccount,
      getMachineId,
    );
    expect(effective.config.filesystem.hiddenPaths).toEqual([`/srv/${machineId}`]);
    expect(effective.identityEnvironment).toEqual({
      pi: { PI_MACHINE_ID: machineId, REPEATED: `${machineId}/${machineId}` },
      sandbox: { DEVICE: machineId },
      extensions: { service: { DEVICE: machineId } },
    });
    expect(getMachineId).toHaveBeenCalledOnce();
    expect(getAccount).toHaveBeenCalledOnce();
    expect(effective.accountHome).toBeUndefined();
    expect(environment).toEqual({
      PI_MACHINE_ID: "ambient",
      MACHINE_ID: "spoofed",
      HOME: "/spoofed",
    });
  });

  it("does not query a machine macro removed by broker merging", async () => {
    const root = await createRoot();
    const configPath = rooted(root, SYSTEM_CONFIG_PATH);
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source
        .replace('mode = "disabled"', 'mode = "broker"')
        .replace("[environment.pi]", '[environment.pi]\nDEVICE = "{{machine_id}}"'),
    );
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), '{"providers":{}}');
    const getMachineId = vi.fn((): never => {
      throw new Error("unused machine lookup must not run");
    });
    const effective = await resolveEffectiveAdministrativeConfiguration(
      root,
      {},
      () =>
        Promise.resolve({
          environment: { pi: { DEVICE: "literal" }, sandbox: {}, extensions: {} },
          overrides: { tools: {} },
        }),
      SYSTEM_CONFIG_PATH,
      undefined,
      getMachineId,
    );
    expect(effective.identityEnvironment.pi.DEVICE).toBe("literal");
    expect(getMachineId).not.toHaveBeenCalled();
  });

  it("fails before applying managed environment when requested machine identity is unavailable", async () => {
    const root = await createRoot();
    const configPath = rooted(root, SYSTEM_CONFIG_PATH);
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source.replace("[environment.pi]", '[environment.pi]\nPI_MACHINE_ID = "{{machine_id}}"'),
    );
    const environment = { PI_MACHINE_ID: "ambient" };
    await expect(
      resolveEffectiveAdministrativeConfiguration(
        root,
        environment,
        undefined,
        SYSTEM_CONFIG_PATH,
        undefined,
        () => {
          throw new Error("Machine identity unavailable");
        },
      ),
    ).rejects.toThrow("Machine identity unavailable");
    expect(environment).toEqual({ PI_MACHINE_ID: "ambient" });
    await expect(resolveEffectiveAdministrativeConfiguration(root, environment)).rejects.toThrow(
      "Unable to resolve the machine ID from the operating system",
    );
    expect(environment).toEqual({ PI_MACHINE_ID: "ambient" });
  });

  it("expands home and account macros after merging every broker environment scope", async () => {
    const root = await createRoot();
    const configPath = rooted(root, SYSTEM_CONFIG_PATH);
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source
        .replace('mode = "disabled"', 'mode = "broker"')
        .replace("hidden_paths = []", 'hidden_paths = ["~/private"]')
        .replace(
          "[environment.pi]",
          '[environment.pi]\nHOME = "/policy-home"\nFROM_BASE = "~/base/{{username}}/{{uid}}"\nREPLACED = "{{username}}"',
        ),
    );
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), '{"providers":{}}');
    const callerEnvironment = { HOME: "/caller-home", INHERITED: "{{username}}/{{uid}}" };
    const getHome = vi.fn(() => {
      expect(callerEnvironment.HOME).toBe("/caller-home");
      return { username: "alice", uid: 1001, homeDirectory: "/accounts/alice" };
    });
    const effective = await resolveEffectiveAdministrativeConfiguration(
      root,
      callerEnvironment,
      () =>
        Promise.resolve({
          environment: {
            pi: { REPLACED: "{{{{username}}}}", FROM_BROKER: "{{username}}/{{uid}}" },
            sandbox: { CACHE: "~/cache/{{uid}}" },
            extensions: { service: { CACHE: "~/service/{{username}}" } },
          },
          overrides: { filesystem: { cwdWritable: false }, tools: {} },
        }),
      SYSTEM_CONFIG_PATH,
      getHome,
    );
    expect(getHome).toHaveBeenCalledOnce();
    expect(effective.config.filesystem).toEqual({
      cwdWritable: false,
      deniedPaths: [],
      hiddenPaths: ["/accounts/alice/private"],
    });
    expect(effective.identityEnvironment).toEqual({
      pi: {
        HOME: "/policy-home",
        FROM_BASE: "/accounts/alice/base/alice/1001",
        REPLACED: "{{username}}",
        FROM_BROKER: "alice/1001",
      },
      sandbox: { CACHE: "/accounts/alice/cache/1001" },
      extensions: { service: { CACHE: "/accounts/alice/service/alice" } },
    });
    expect(callerEnvironment).toEqual({ HOME: "/caller-home", INHERITED: "{{username}}/{{uid}}" });
  });

  it("tolerates unavailable optional home context when broker overrides remove the last expansion", async () => {
    const root = await createRoot();
    const configPath = rooted(root, SYSTEM_CONFIG_PATH);
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source
        .replace('mode = "disabled"', 'mode = "broker"')
        .replace("[environment.pi]", '[environment.pi]\nCACHE = "~/unused"'),
    );
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), '{"providers":{}}');
    const getHome = vi.fn((): never => {
      throw new Error("account unavailable");
    });
    const effective = await resolveEffectiveAdministrativeConfiguration(
      root,
      {},
      () =>
        Promise.resolve({
          environment: { pi: { CACHE: "/var/cache/shared" }, sandbox: {}, extensions: {} },
          overrides: { tools: {} },
        }),
      SYSTEM_CONFIG_PATH,
      getHome,
    );
    expect(effective.identityEnvironment.pi.CACHE).toBe("/var/cache/shared");
    expect(getHome).toHaveBeenCalledOnce();
    expect(effective.accountHome).toBeUndefined();
  });

  it("resolves optional home context after broker merging and before scoped HOME applies", async () => {
    const root = await createRoot();
    const configPath = rooted(root, SYSTEM_CONFIG_PATH);
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source
        .replace('mode = "disabled"', 'mode = "broker"')
        .replace("[environment.pi]", '[environment.pi]\nHOME = "/configured-home"'),
    );
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), '{"providers":{}}');
    const environment = { HOME: "/spoofed/home", USER: "spoofed" };
    let merged = false;
    const getAccount = vi.fn(() => {
      expect(merged).toBe(true);
      expect(environment.HOME).toBe("/spoofed/home");
      return { username: "alice", uid: 1001, homeDirectory: root };
    });
    const effective = await resolveEffectiveAdministrativeConfiguration(
      root,
      environment,
      () => {
        merged = true;
        return Promise.resolve({
          environment: { pi: {}, sandbox: {}, extensions: {} },
          overrides: { tools: {} },
        });
      },
      SYSTEM_CONFIG_PATH,
      getAccount,
    );
    expect(getAccount).toHaveBeenCalledOnce();
    expect(effective.accountHome).toBe(await realpath(root));
    expect(effective.identityEnvironment.pi.HOME).toBe("/configured-home");
    expect(environment).toEqual({ HOME: "/spoofed/home", USER: "spoofed" });
  });

  it.each([false, true])(
    "skips optional home metadata in effective direct mode while preserving macros=%s",
    async (macros) => {
      const root = await createRoot();
      const configPath = rooted(root, SYSTEM_CONFIG_PATH);
      const source = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        source
          .replace('mode = "disabled"', 'mode = "broker"')
          .replace(
            "[environment.pi]",
            macros ? '[environment.pi]\nCACHE = "~/cache"' : "[environment.pi]",
          ),
      );
      await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), '{"providers":{}}');
      const getAccount = vi.fn(() => ({ username: "alice", uid: 1001, homeDirectory: root }));
      const effective = await resolveEffectiveAdministrativeConfiguration(
        root,
        {},
        () =>
          Promise.resolve({
            environment: { pi: {}, sandbox: {}, extensions: {} },
            overrides: { execution: { backend: "direct" }, network: { mode: "host" }, tools: {} },
          }),
        SYSTEM_CONFIG_PATH,
        getAccount,
      );
      expect(effective.config.execution.backend).toBe("direct");
      expect(effective.accountHome).toBeUndefined();
      expect(getAccount).toHaveBeenCalledTimes(macros ? 1 : 0);
      expect(effective.identityEnvironment.pi.CACHE).toBe(macros ? join(root, "cache") : undefined);
    },
  );

  it("fails before applying environment when account lookup or expanded paths are invalid", async () => {
    const root = await createRoot();
    const configPath = rooted(root, SYSTEM_CONFIG_PATH);
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source
        .replace("hidden_paths = []", 'hidden_paths = ["~"]')
        .replace("[environment.pi]", '[environment.pi]\nADDED = "configured"'),
    );
    const callerEnvironment = { KEEP: "original" };
    await expect(
      resolveEffectiveAdministrativeConfiguration(
        root,
        callerEnvironment,
        undefined,
        SYSTEM_CONFIG_PATH,
        () => {
          throw new Error("account unavailable");
        },
      ),
    ).rejects.toThrow("account unavailable");
    await expect(
      resolveEffectiveAdministrativeConfiguration(
        root,
        callerEnvironment,
        undefined,
        SYSTEM_CONFIG_PATH,
        () => ({ username: "alice", uid: 1001, homeDirectory: "/run/account-home" }),
      ),
    ).rejects.toThrow("private system paths");
    expect(callerEnvironment).toEqual({ KEEP: "original" });
  });

  it("loads the selected TOML and its model catalog without reading the compiled default", async () => {
    const root = await createRoot();
    const selectedPath = "/lab/custom.toml";
    const modelsFile = "/lab/selected-models.json";
    const fixture = await readFile(rooted(root, "/etc/pi-sandbox/config.toml"), "utf8");
    await mkdir(rooted(root, "/lab"));
    await writeFile(
      rooted(root, selectedPath),
      fixture.replace("/etc/pi-sandbox/models.json", modelsFile),
    );
    await writeFile(rooted(root, modelsFile), JSON.stringify({ providers: {} }));
    await writeFile(rooted(root, "/etc/pi-sandbox/config.toml"), "invalid default TOML");

    await expect(validateAdministrativeConfiguration(root, selectedPath)).resolves.toMatchObject({
      modelsFile,
    });
    await expect(
      resolveEffectiveAdministrativeConfiguration(root, {}, undefined, selectedPath),
    ).resolves.toMatchObject({
      modelsPath: rooted(root, modelsFile),
      config: { modelsFile },
    });
    await expect(validateAdministrativeConfiguration(root, "/lab/missing.toml")).rejects.toThrow();
    await writeFile(rooted(root, selectedPath), "invalid selected TOML");
    await expect(validateAdministrativeConfiguration(root, selectedPath)).rejects.toThrow();
  });

  it("fails closed when models.json is malformed", async () => {
    const root = await createRoot();
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), "{not-json");

    await expect(validateAdministrativeConfiguration(root)).rejects.toThrow(
      "Failed to parse models.json",
    );
  });

  it("loads only the broker-selected model catalog and applies its tool overrides", async () => {
    const root = await createRoot();
    const configPath = rooted(root, "/etc/pi-sandbox/config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config
        .replace('mode = "disabled"', 'mode = "broker"')
        .replace("[environment.pi]", '[environment.pi]\nGLOBAL_PI = "base"\nMODEL_TOKEN = "global"')
        .replace("[environment.sandbox]", '[environment.sandbox]\nGLOBAL_SANDBOX = "base"'),
    );
    const selectedPath = "/etc/pi-sandbox/models/alice.json";
    await mkdir(rooted(root, "/etc/pi-sandbox/models"), { recursive: true });
    await writeFile(rooted(root, selectedPath), JSON.stringify({ providers: {} }));
    const environment = { MODEL_TOKEN: "ambient", UNRELATED: "preserved" };

    const effective = await resolveEffectiveAdministrativeConfiguration(
      root,
      environment,
      (socketPath) => {
        expect(socketPath).toBe(IDENTITY_BROKER_SOCKET_PATH);
        return Promise.resolve({
          environment: {
            pi: { MODEL_TOKEN: "broker-token", ADDED_BY_BROKER: "temporary" },
            sandbox: { SANDBOX_FEATURE: "enabled" },
            extensions: {},
          },
          overrides: {
            modelsFile: selectedPath,
            execution: { backend: "direct" },
            network: { mode: "host" },
            tools: { write: { mode: "disabled", sessionGrant: "never" } },
          },
        });
      },
    );

    expect(effective.modelsPath).toBe(rooted(root, selectedPath));
    expect(effective.config.modelsFile).toBe(selectedPath);
    expect(effective.config.execution).toEqual({ backend: "direct" });
    expect(effective.config.network).toEqual({ mode: "host" });
    expect(effective.config.tools.write).toEqual({
      mode: "disabled",
      sessionGrant: "never",
      audit: true,
    });
    expect(effective.identityEnvironment).toEqual({
      pi: {
        GLOBAL_PI: "base",
        MODEL_TOKEN: "broker-token",
        ADDED_BY_BROKER: "temporary",
      },
      sandbox: { GLOBAL_SANDBOX: "base", SANDBOX_FEATURE: "enabled" },
      extensions: {},
    });
    expect(environment).toEqual({ MODEL_TOKEN: "ambient", UNRELATED: "preserved" });
  });

  it("fails closed when an execution override produces an invalid backend and network pair", async () => {
    const root = await createRoot();
    const configPath = rooted(root, "/etc/pi-sandbox/config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace('mode = "disabled"', 'mode = "broker"'));

    await expect(
      resolveEffectiveAdministrativeConfiguration(root, process.env, () =>
        Promise.resolve({
          environment: { pi: {}, sandbox: {}, extensions: {} },
          overrides: {
            execution: { backend: "direct" },
            tools: {},
          },
        }),
      ),
    ).rejects.toThrow("Direct execution requires network.mode = host");
  });

  it("validates the known read-only allow precondition on the effective broker policy", async () => {
    const root = await createRoot();
    const configPath = rooted(root, "/etc/pi-sandbox/config.toml");
    const source = await readFile(configPath, "utf8");
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), JSON.stringify({ providers: {} }));
    await writeFile(
      configPath,
      `${source.replace('mode = "disabled"', 'mode = "broker"')}\n[tools.bash.known_read_only]\nmode = "allow"\nsession_grant = "never"\n`,
    );
    const resolve = (tools: IdentityOverrides["tools"]) =>
      resolveEffectiveAdministrativeConfiguration(root, {}, () =>
        Promise.resolve({
          environment: { pi: {}, sandbox: {}, extensions: {} },
          overrides: { tools },
        }),
      );
    await expect(resolve({})).resolves.toHaveProperty(
      "config.tools.bash.commandClasses.known_read_only.mode",
      "allow",
    );
    await expect(resolve({ ls: { mode: "ask", sessionGrant: "never" } })).rejects.toThrow(
      'tools.bash.known_read_only.mode "allow" requires tools.ls.mode "allow" (it is "ask")',
    );
    await expect(
      resolve({ bash: { mode: "ask", sessionGrant: "never" } }),
    ).resolves.not.toHaveProperty("config.tools.bash.commandClasses");
  });

  it("preserves the base command timeout cap through broker backend selection", async () => {
    const root = await createRoot();
    const configPath = rooted(root, "/etc/pi-sandbox/config.toml");
    const source = await readFile(configPath, "utf8");
    await writeFile(rooted(root, "/etc/pi-sandbox/models.json"), JSON.stringify({ providers: {} }));
    await writeFile(
      configPath,
      source
        .replace('mode = "disabled"', 'mode = "broker"')
        .replace(
          'backend = "bubblewrap"',
          'backend = "bubblewrap"\nmax_command_timeout_seconds = 3600.25',
        ),
    );
    const direct = await resolveEffectiveAdministrativeConfiguration(root, {}, () =>
      Promise.resolve({
        environment: { pi: {}, sandbox: {}, extensions: {} },
        overrides: { execution: { backend: "direct" }, network: { mode: "host" }, tools: {} },
      }),
    );
    expect(direct.config.execution).toEqual({ backend: "direct", maximumTimeoutMs: 3_600_250 });
  });

  it("rejects read-only direct execution during installation validation", async () => {
    const root = await createRoot();
    const configPath = rooted(root, "/etc/pi-sandbox/config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config
        .replace('backend = "bubblewrap"', 'backend = "direct"')
        .replace('mode = "none"', 'mode = "host"')
        .replace("cwd_writable = true", "cwd_writable = false"),
    );
    await expect(validateAdministrativeConfiguration(root)).rejects.toThrow(
      'config.filesystem.cwd_writable must be true when config.execution.backend is "direct"',
    );
  });

  it.each(["/proc", "/tmp"])(
    "rejects the reserved hidden path %s during installation validation",
    async (hiddenPath) => {
      const root = await createRoot();
      const configPath = rooted(root, "/etc/pi-sandbox/config.toml");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        config.replace("hidden_paths = []", `hidden_paths = ["${hiddenPath}"]`),
      );
      await expect(validateAdministrativeConfiguration(root)).rejects.toThrow(
        "config.filesystem.hidden_paths must not overlap private system paths or hide /tmp",
      );
    },
  );

  it("rejects read-only direct execution after applying identity overrides", async () => {
    const root = await createRoot();
    const configPath = rooted(root, "/etc/pi-sandbox/config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace('mode = "disabled"', 'mode = "broker"'));
    await expect(
      resolveEffectiveAdministrativeConfiguration(root, {}, () =>
        Promise.resolve({
          environment: { pi: {}, sandbox: {}, extensions: {} },
          overrides: {
            execution: { backend: "direct" },
            network: { mode: "host" },
            filesystem: { cwdWritable: false },
            tools: {},
          },
        }),
      ),
    ).rejects.toThrow("Direct execution requires filesystem.cwd_writable = true");
  });

  it("restores the exact caller environment when a later administrative input fails", async () => {
    const root = await createRoot();
    const configPath = rooted(root, "/etc/pi-sandbox/config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace('mode = "disabled"', 'mode = "broker"'));
    const environment = { MODEL_TOKEN: "ambient", UNRELATED: "preserved" };

    await expect(
      resolveEffectiveAdministrativeConfiguration(root, environment, () =>
        Promise.resolve({
          environment: {
            pi: { MODEL_TOKEN: "broker-token", ADDED_BY_BROKER: "temporary" },
            sandbox: {},
            extensions: {},
          },
          overrides: {
            modelsFile: "/etc/pi-sandbox/models/missing.json",
            tools: {},
          },
        }),
      ),
    ).rejects.toThrow();
    expect(environment).toEqual({ MODEL_TOKEN: "ambient", UNRELATED: "preserved" });
  });

  it("keeps hidden paths when a broker changes CWD permission and rejects direct execution", async () => {
    const root = await createRoot();
    const configPath = rooted(root, "/etc/pi-sandbox/config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config
        .replace('mode = "disabled"', 'mode = "broker"')
        .replace("hidden_paths = []", 'hidden_paths = ["/srv/runs"]'),
    );
    await expect(
      resolveEffectiveAdministrativeConfiguration(root, {}, () =>
        Promise.resolve({
          environment: { pi: {}, sandbox: {}, extensions: {} },
          overrides: {
            execution: { backend: "direct" },
            network: { mode: "host" },
            filesystem: { cwdWritable: true },
            tools: {},
          },
        }),
      ),
    ).rejects.toThrow("Direct execution requires filesystem.hidden_paths = []");
  });

  it("overrides a caller-supplied user models path with the administrative path", async () => {
    const root = await createRoot();
    const managedModels = rooted(root, "/etc/pi-sandbox/models.json");
    const userModels = join(root, "user-models.json");
    const provider = (id: string) => ({
      providers: {
        [id]: {
          api: "openai-completions",
          apiKey: "test",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [{ id: `${id}-model` }],
        },
      },
    });
    await writeFile(managedModels, JSON.stringify(provider("managed")));
    await writeFile(userModels, JSON.stringify(provider("user")));

    const runtime = await createManagedModelRuntimeFactory(managedModels)({
      modelsPath: userModels,
      refreshOnCreate: false,
    });

    expect(runtime.getModel("managed", "managed-model")).toBeDefined();
    expect(runtime.getModel("user", "user-model")).toBeUndefined();
  });

  it("resolves a managed Pi variable through model apiKey and header substitutions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sandbox-model-identity-"));
    temporaryDirectories.push(root);
    const modelsPath = join(root, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          managed: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "$MODEL_TOKEN",
            headers: { "X-Managed-Identity": "$MODEL_TOKEN" },
            models: [{ id: "managed-model" }],
          },
        },
      }),
    );

    const previous = process.env.MODEL_TOKEN;
    process.env.MODEL_TOKEN = "broker-token";
    try {
      const runtime = await createManagedModelRuntimeFactory(modelsPath)({
        credentials: new InMemoryCredentialStore(),
        refreshOnCreate: false,
      });
      const model = runtime.getModel("managed", "managed-model");
      expect(model).toBeDefined();
      const auth = await runtime.getAuth(model!);
      expect(auth?.auth.apiKey).toBe("broker-token");
      expect(auth?.auth.headers).toMatchObject({ "X-Managed-Identity": "broker-token" });
    } finally {
      if (previous === undefined) delete process.env.MODEL_TOKEN;
      else process.env.MODEL_TOKEN = previous;
    }
  });
});
