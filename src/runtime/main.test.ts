import { describe, expect, it } from "vitest";
import { SandboxExecutionError } from "../../packages/sandbox-extension/src/runtime/contracts.js";
import type { SandboxConfig } from "../domain/index.js";
import { createManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import {
  defineManagedHostEnvironment,
  freezeExtensionConfig,
  instantiateManagedExtension,
} from "../managed-extensions/sdk.js";
import {
  actionableErrorMessage,
  instantiateConfiguredManagedExtensions,
  resolveManagedExtensionHostEnvironments,
} from "./main.js";

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

describe("managed extension composition", () => {
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
      configVersion: 16,
      modelAuth: { personalProviders: [] },
      skills: { directories: [] },
      exports: { enabled: false },
      codemode: { enabled: false, timeoutMs: 300000 },
      mcp: { servers: {} },
      sessions: { retentionDays: 0 },
      filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
      audit: { enabled: false },

      execution: { backend: "bubblewrap" },

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
});
