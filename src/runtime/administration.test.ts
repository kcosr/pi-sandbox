import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, stringify } from "@iarna/toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationSource } from "../service/endpoint.js";
import type { OperationResults, ServiceOperation, ServiceTransport } from "../service/protocol.js";
import { inspectAdministrativePolicy, loadAdministrativeSnapshot } from "../config/source.js";
import { managedExtensionCatalog } from "../managed-extensions/registry.js";
import { parseConfig } from "../config/parse.js";
import { assertExecutionPlatform } from "./execution-platform.js";
import {
  formatWorkspaceModes,
  listWorkspaceModes,
  resolveEffectiveAdministrativeConfiguration,
  runAdministrativeCommand,
  validateAdministrativeConfiguration,
} from "./administration.js";
import { validateManagedModelConfiguration } from "./model-runtime.js";

// Native catalog/auth semantics have their own patched-Pi behavioral suite.
vi.mock("./model-runtime.js", () => ({ validateManagedModelConfiguration: vi.fn(async () => {}) }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const directories: string[] = [];
const account = () => ({ username: "fixture", uid: 1234, homeDirectory: "/home/fixture" });
const client = {
  platform: "linux",
  architecture: "x64",
  application_version: "test",
  build_id: "test",
} as const;
const template = await readFile(
  new URL("../../config/default/config.toml", import.meta.url),
  "utf8",
);
const empty = { pi: {}, sandbox: {}, extensions: {} };
const serviceConfiguration: ConfigurationSource = {
  source: "service",
  endpoint: { transport: "unix", socketPath: "/run/test/service.sock" },
};
function wire(
  policyText = template,
  overrides: Record<string, unknown> = { tools: {} },
  environment: Record<string, unknown> = empty,
) {
  const policy = { ...parseToml(policyText) };
  delete policy.models_file;
  return {
    policy,
    overrides,
    environment,
    models: { providers: {} },
    policy_revision: "a".repeat(32),
  };
}
function remote(result = wire()) {
  const requests: string[] = [];
  const service: ServiceTransport = {
    request<K extends ServiceOperation>(operation: K): Promise<OperationResults[K]> {
      requests.push(operation);
      return Promise.resolve(
        (operation === "bootstrap"
          ? result
          : {
              policy: result.policy,
              workspace_overrides: result.overrides.workspace ?? null,
            }) as OperationResults[K],
      );
    },
  };
  return { service, requests };
}
async function local(text = template) {
  Object.defineProperty(process, "platform", { value: "linux" });
  const directory = await mkdtemp(join(tmpdir(), "managed-source-"));
  directories.push(directory);
  const models = join(directory, "models.json"),
    configPath = join(directory, "config.toml");
  await writeFile(models, JSON.stringify({ providers: {} }));
  await writeFile(configPath, text.replace("/etc/pi-sandbox/models.json", models));
  const configuration: ConfigurationSource = {
    source: "local",
    configDir: directory,
    configPath,
    defaultModelsPath: models,
    allowConfigOverride: true,
  };
  return { directory, configuration, configPath, models };
}
afterEach(async () => {
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("shared administrative source pipeline", () => {
  it("resolves equivalent local and service snapshots to the same policy in every mode", async () => {
    const text = template
      .replace("[environment.pi]", '[environment.pi]\nTOKEN = "{{username}}-{{uid}}"')
      .replace("[environment.sandbox]", '[environment.sandbox]\nACCOUNT = "{{username}}"');
    const fixture = await local(text);
    const { service, requests } = remote(
      wire(
        text,
        { tools: {} },
        {
          pi: { TOKEN: "{{username}}-{{uid}}" },
          sandbox: { ACCOUNT: "{{username}}" },
          extensions: {},
        },
      ),
    );
    for (const workspaceMode of ["host", "sandbox"]) {
      const localResult = await resolveEffectiveAdministrativeConfiguration({
        configuration: fixture.configuration,
        workspaceMode,
        getAccountIdentity: account,
      });
      const serviceResult = await resolveEffectiveAdministrativeConfiguration({
        configuration: serviceConfiguration,
        service,
        workspaceMode,
        getAccountIdentity: account,
      });
      expect(serviceResult.config).toEqual(localResult.config);
      expect(serviceResult.models).toEqual(localResult.models);
      expect(serviceResult.workspaceSelection).toEqual(localResult.workspaceSelection);
      expect(serviceResult.accountHome).toEqual(localResult.accountHome);
      expect(localResult.provenance.source).toBe("local");
      expect(serviceResult.provenance.source).toBe("service");
    }
    expect(requests).toEqual(["bootstrap", "bootstrap"]);
  });
  it("captures policy, models and literal secret files once with ordinary local symlink semantics", async () => {
    const fixture = await local();
    const secret = join(fixture.directory, "secret"),
      alias = join(fixture.directory, "alias");
    await writeFile(secret, "$TOKEN {{username}} ~/opaque\n");
    await symlink(secret, alias);
    await writeFile(
      fixture.configPath,
      (await readFile(fixture.configPath, "utf8")).replace(
        "[environment.pi]",
        `[environment.pi]\nTOKEN = { file = ${JSON.stringify(alias)} }`,
      ),
    );
    const options = { catalog: managedExtensionCatalog, client, validatePolicy: () => {} };
    const snapshot = await loadAdministrativeSnapshot(fixture.configuration, options);
    await writeFile(secret, "changed");
    await writeFile(fixture.models, "bad JSON");
    await writeFile(fixture.configPath, "bad TOML");
    expect(snapshot.environment.pi.TOKEN).toEqual({ literal: "$TOKEN {{username}} ~/opaque" });
    expect(snapshot.models).toEqual({ providers: {} });
    expect(Object.isFrozen(snapshot.models)).toBe(true);
    expect(snapshot.provenance).toEqual({
      source: "local",
      configPath: fixture.configPath,
      modelsPath: fixture.models,
    });
  });
  it("keeps inspection independent of missing catalogs and secret files", async () => {
    const fixture = await local(
      template.replace(
        "[environment.pi]",
        '[environment.pi]\nTOKEN = { file = "/missing-secret" }',
      ),
    );
    await rm(fixture.models);
    const access = await listWorkspaceModes({ configuration: fixture.configuration });
    expect(formatWorkspaceModes(access)).toContain("host (default)");
    expect(formatWorkspaceModes(access)).toContain("sandbox");
    expect(validateManagedModelConfiguration).not.toHaveBeenCalled();
    const { service, requests } = remote(wire(template));
    await listWorkspaceModes({ configuration: serviceConfiguration, service });
    expect(requests).toEqual(["policy_inspect"]);
  });
  it("uses account access before the selected-mode overlay and retains shared fields", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { service } = remote(
      wire(template, {
        workspace: { allowed: ["sandbox"], default: "sandbox" },
        tools: { read: { mode: "deny", session_grant: "never" } },
      }),
    );
    const result = await resolveEffectiveAdministrativeConfiguration({
      configuration: serviceConfiguration,
      service,
      getAccountIdentity: account,
    });
    expect(result.workspaceSelection).toMatchObject({ name: "sandbox", source: "default" });
    expect(result.config.filesystem.cwdWritable).toBe(false);
    expect(result.config.tools.read!.mode).toBe("deny");
    expect(result.provenance).toMatchObject({
      source: "service",
      revision: "a".repeat(32),
      identitySource: "unix_peer",
    });
    await expect(
      resolveEffectiveAdministrativeConfiguration({
        configuration: serviceConfiguration,
        service,
        workspaceMode: "host",
      }),
    ).rejects.toThrow();
  });
  it("rejects an account overlay which invalidates exports or execution platform relationships", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    for (const overrides of [
      { workspace: { default: "sandbox" }, filesystem: { cwd_writable: true }, tools: {} },
      { execution: { backend: "direct" }, tools: {} },
    ]) {
      const { service } = remote(wire(template, overrides));
      await expect(
        resolveEffectiveAdministrativeConfiguration({
          configuration: serviceConfiguration,
          service,
        }),
      ).rejects.toThrow();
    }
  });
  it("validates every authored mode before local catalogs, secrets or identity lookup", async () => {
    const fixture = await local();
    const source = (await readFile(fixture.configPath, "utf8")).replace(
      'backend = "bubblewrap"',
      'backend = "seatbelt"',
    );
    await writeFile(fixture.configPath, source);
    await rm(fixture.models);
    const identity = vi.fn(account);
    await expect(
      resolveEffectiveAdministrativeConfiguration({
        configuration: fixture.configuration,
        getAccountIdentity: identity,
      }),
    ).rejects.toThrow("Seatbelt execution");
    await expect(listWorkspaceModes({ configuration: fixture.configuration })).rejects.toThrow(
      "Seatbelt execution",
    );
    await expect(
      validateAdministrativeConfiguration({ configuration: fixture.configuration }),
    ).rejects.toThrow("Seatbelt execution");
    expect(identity).not.toHaveBeenCalled();
  });
  it("rejects local audit without a compiled endpoint before any dynamic read", async () => {
    const fixture = await local(
      template.replace("[audit]\nenabled = false", "[audit]\nenabled = true"),
    );
    await rm(fixture.models);
    await expect(
      resolveEffectiveAdministrativeConfiguration({ configuration: fixture.configuration }),
    ).rejects.toThrow("no audit endpoint");
    await expect(listWorkspaceModes({ configuration: fixture.configuration })).rejects.toThrow(
      "no audit endpoint",
    );
    await expect(
      validateAdministrativeConfiguration({ configuration: fixture.configuration }),
    ).rejects.toThrow("no audit endpoint");
  });
  it("validates service bootstrap fixtures independently of the compiled local audit endpoint", async () => {
    const fixture = await local();
    const path = join(fixture.directory, "bootstrap.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        request_id: "a".repeat(32),
        operation: "bootstrap",
        result: wire(template.replace("[audit]\nenabled = false", "[audit]\nenabled = true")),
      }),
      { mode: 0o600 },
    );
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await expect(
        runAdministrativeCommand([
          "--validate-bootstrap",
          path,
          "--candidate-payload",
          fixture.directory,
        ]),
      ).resolves.toBe(true);
      expect(String(output.mock.calls[0]![0])).toContain('"status":"valid"');
    } finally {
      output.mockRestore();
    }
  });
  it("leaves secrets, account and machine macros symbolic during installation validation", async () => {
    const fixture = await local(
      template
        .replace(
          "[environment.pi]",
          '[environment.pi]\nTOKEN = { file = "/does-not-exist" }\nUSER = "{{username}}-{{machine_id}}"',
        )
        .replace("hidden_paths = []", 'hidden_paths = ["~/private"]'),
    );
    const result = await validateAdministrativeConfiguration({
      configuration: fixture.configuration,
    });
    expect(result.environment.pi.TOKEN).toEqual({ file: "/does-not-exist" });
    expect(result.filesystem.hiddenPaths).toEqual(["~/private"]);
    expect(validateManagedModelConfiguration).toHaveBeenCalledWith({ providers: {} }, []);
  });
  it("expands resolved environment once without reading overwritten source file references", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const payload = wire(
      template.replace(
        "[environment.pi]",
        '[environment.pi]\nTOKEN = { file = "/missing-base-secret" }',
      ),
      { tools: {} },
      {
        pi: {
          TOKEN: { literal: "{{username}} ~/literal" },
          USER: "{{username}}-{{uid}}",
          DEVICE: "{{machine_id}}",
        },
        sandbox: { ACCOUNT: "{{username}}" },
        extensions: {},
      },
    );
    const { service } = remote(payload),
      identity = vi.fn(account),
      machine = vi.fn(() => "AABBCCDD-0000-1111-2222-334455667788");
    const result = await resolveEffectiveAdministrativeConfiguration({
      configuration: serviceConfiguration,
      service,
      getAccountIdentity: identity,
      getMachineId: machine,
    });
    expect(result.config.environment.pi.TOKEN).toBe("{{username}} ~/literal");
    expect(result.config.environment.pi.USER).toBe("fixture-1234");
    expect(result.config.environment.sandbox.ACCOUNT).toBe("fixture");
    expect(identity).toHaveBeenCalledTimes(1);
    expect(machine).toHaveBeenCalledTimes(1);
  });
  it("rejects resolved file references, unknown macros and unadmitted extension scopes", async () => {
    for (const environment of [
      { pi: { TOKEN: { file: "/secret" } }, sandbox: {}, extensions: {} },
      { pi: { TOKEN: "{{unknown}}" }, sandbox: {}, extensions: {} },
      { pi: {}, sandbox: {}, extensions: { missing: { TOKEN: "value" } } },
    ]) {
      const { service } = remote(wire(template, { tools: {} }, environment));
      await expect(
        resolveEffectiveAdministrativeConfiguration({
          configuration: serviceConfiguration,
          service,
        }),
      ).rejects.toThrow();
    }
  });
  it("does not consult or mutate ambient identity and provider values on failure", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const old = { ...process.env };
    const { service } = remote(
      wire(
        template,
        { tools: {} },
        { pi: { HOME: "~/managed", TOKEN: "{{username}}" }, sandbox: {}, extensions: {} },
      ),
    );
    await expect(
      resolveEffectiveAdministrativeConfiguration({
        configuration: serviceConfiguration,
        service,
        getAccountIdentity: () => {
          throw new Error("no OS account");
        },
      }),
    ).rejects.toThrow("no OS account");
    expect(process.env).toEqual(old);
  });
  it("refuses local paths on the service source and never falls back after transport failure", async () => {
    const { service, requests } = remote();
    await expect(
      resolveEffectiveAdministrativeConfiguration({
        configuration: serviceConfiguration,
        service,
        configPath: "/tmp/config.toml",
      }),
    ).rejects.toThrow("do not permit local");
    expect(requests).toEqual([]);
    service.request = () => Promise.reject(new Error("unavailable"));
    await expect(
      listWorkspaceModes({ configuration: serviceConfiguration, service }),
    ).rejects.toThrow("unavailable");
  });
  it("remaps policy and model paths only for offline staged validation", async () => {
    const fixture = await local();
    const staging = join(fixture.directory, "stage");
    await mkdir(join(staging, fixture.directory), { recursive: true });
    await writeFile(join(staging, fixture.configPath), await readFile(fixture.configPath));
    await writeFile(join(staging, fixture.models), '{"providers":{}}');
    await rm(fixture.configPath);
    await rm(fixture.models);
    await expect(
      validateAdministrativeConfiguration({ configuration: fixture.configuration, root: staging }),
    ).resolves.toMatchObject({ configVersion: 16 });
    await expect(
      resolveEffectiveAdministrativeConfiguration({ configuration: fixture.configuration }),
    ).rejects.toThrow();
  });
  it("checks package-owned candidate skill roots while keeping external roots symbolic offline", async () => {
    const fixture = await local(
      template.replace(
        "directories = []",
        'directories = ["/usr/libexec/pi-sandbox/skills", "/external-missing"]',
      ),
    );
    const candidate = join(fixture.directory, "payload");
    await mkdir(candidate);
    await expect(
      validateAdministrativeConfiguration({
        configuration: fixture.configuration,
        candidatePayload: candidate,
      }),
    ).rejects.toThrow("skill root");
    await mkdir(join(candidate, "skills"));
    await expect(
      validateAdministrativeConfiguration({
        configuration: fixture.configuration,
        candidatePayload: candidate,
      }),
    ).resolves.toBeDefined();
  });
  it("validates strict catalog bytes in local loading", async () => {
    const fixture = await local();
    for (const text of [
      '{"providers":{},"providers":{}}',
      "\ufeff{}",
      '{"x":9007199254740992}',
      "{/*comment*/}",
      "[]",
    ]) {
      await writeFile(fixture.models, text);
      await expect(
        resolveEffectiveAdministrativeConfiguration({ configuration: fixture.configuration }),
      ).rejects.toThrow();
    }
  });
  it("accepts partial common source fields with every composed mode complete", async () => {
    const raw = parseToml(template);
    const filesystem = raw.filesystem as Record<string, unknown>;
    delete filesystem.cwd_writable;
    (
      raw.workspace as unknown as { modes: Record<string, Record<string, unknown>> }
    ).modes.host!.filesystem = { cwd_writable: true };
    const source = stringify(raw);
    expect(
      parseConfig(source, "partial", managedExtensionCatalog).policy.workspace.modes.host!.config
        .filesystem.cwdWritable,
    ).toBe(true);
    const { service } = remote(wire(source));
    expect(
      (
        await inspectAdministrativePolicy(serviceConfiguration, {
          catalog: managedExtensionCatalog,
          client,
          service,
          validatePolicy: () => {},
        })
      ).policy.workspace.default,
    ).toBe("host");
  });
});

describe("execution platform guards", () => {
  const config = {
    execution: { backend: "direct" as const },
    network: { mode: "host" as const },
    filesystem: { cwdWritable: true, hiddenPaths: [], deniedPaths: [] },
  };
  it("supports direct execution on either host and never silently substitutes backends", () => {
    expect(() => assertExecutionPlatform(config, "linux")).not.toThrow();
    expect(() => assertExecutionPlatform(config, "darwin")).not.toThrow();
    expect(() =>
      assertExecutionPlatform({ ...config, execution: { backend: "bubblewrap" } }, "darwin"),
    ).toThrow("only on Linux");
    expect(() =>
      assertExecutionPlatform({ ...config, execution: { backend: "seatbelt" } }, "linux"),
    ).toThrow("only on macOS");
    expect(() =>
      assertExecutionPlatform({ ...config, network: { mode: "none" } }, "linux"),
    ).toThrow("network.mode = host");
    expect(() =>
      assertExecutionPlatform(
        { ...config, filesystem: { ...config.filesystem, cwdWritable: false } },
        "linux",
      ),
    ).toThrow("cwd_writable = true");
    expect(() =>
      assertExecutionPlatform(
        { ...config, filesystem: { ...config.filesystem, hiddenPaths: ["/secret"] } },
        "linux",
      ),
    ).toThrow("hidden_paths");
  });
});
