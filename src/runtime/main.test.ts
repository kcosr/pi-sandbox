import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseSandboxArguments } from "./config-arguments.js";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

import { IDENTITY_BROKER_SOCKET_PATH } from "../domain/index.js";
import type { SandboxConfig } from "../domain/index.js";
import { createManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import {
  defineManagedHostEnvironment,
  freezeExtensionConfig,
  instantiateManagedExtension,
} from "../managed-extensions/sdk.js";
import {
  createManagedModelRuntimeFactory,
  runPiSandbox,
  assertExecutionPlatform,
  instantiateConfiguredManagedExtensions,
  resolveEffectiveAdministrativeConfiguration,
  resolveManagedExtensionHostEnvironments,
  validateAdministrativeConfiguration,
} from "./main.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createRoot(modelsFile = "/etc/pi-sandbox/models.json"): Promise<string> {
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

describe("administrative configuration", () => {
  it("reports the pinned Pi version without reading policy or inspecting the probe workspace", async () => {
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
      expect(write).toHaveBeenCalledWith("1.0.2\n");
      expect(cwd).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
      write.mockRestore();
    }
  });

  it("enforces the execution backend's platform contract", () => {
    const config = {
      configVersion: 7,
      filesystem: { cwdWritable: true, hiddenPaths: [] },
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
    expect(() =>
      assertExecutionPlatform(
        {
          ...config,
          execution: { backend: "direct" },
          network: { mode: "host" },
          filesystem: { cwdWritable: true, hiddenPaths: ["/srv/runs"] },
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
          filesystem: { cwdWritable: false, hiddenPaths: [] },
        },
        "linux",
      ),
    ).toThrow("Direct execution requires filesystem.cwd_writable = true");
    expect(() =>
      assertExecutionPlatform(
        { ...config, filesystem: { cwdWritable: false, hiddenPaths: [] } },
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
        { ...config, execution: { backend: "direct" }, network: { mode: "none" } },
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
      configVersion: 7,
      filesystem: { cwdWritable: true, hiddenPaths: [] },
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
