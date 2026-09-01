import { describe, expect, it } from "vitest";

import type { ManagedExtension } from "./contracts.js";
import {
  defineManagedTool,
  defineManagedHostEnvironment,
  freezeExtensionConfig,
  instantiateManagedExtension,
  parseManagedExtensionConfig,
} from "./sdk.js";

function extension(overrides: Partial<ManagedExtension> = {}): ManagedExtension {
  return {
    kind: "managed",
    apiVersion: 3,
    id: "example",
    version: "1.0.0",
    hostEnvironment: defineManagedHostEnvironment({ variables: [] }),
    parseConfig: (raw) => freezeExtensionConfig(raw as never),
    requiredHostExecutables: () => ["/usr/bin/example"],
    tools: [],
    ...overrides,
  };
}

describe("managed extension SDK", () => {
  it("clones and deeply freezes parsed configuration", () => {
    const source = { endpoint: "https://example.test", nested: { enabled: true }, values: [1, 2] };
    const config = freezeExtensionConfig(source);

    expect(config).toEqual(source);
    expect(config).not.toBe(source);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.nested)).toBe(true);
    expect(Object.isFrozen(config.values)).toBe(true);
  });

  it("rejects values outside JSON and cycles", () => {
    expect(() => freezeExtensionConfig({ value: Number.NaN })).toThrow("finite JSON numbers");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => freezeExtensionConfig(cyclic as never)).toThrow("must not contain cycles");
  });

  it("requires extension parsers to return deeply frozen JSON", () => {
    const parsed = parseManagedExtensionConfig(extension(), { enabled: true }, "config.example");
    expect(parsed).toEqual({ enabled: true });

    expect(() =>
      parseManagedExtensionConfig(
        extension({ parseConfig: () => ({ enabled: true }) }),
        {},
        "config.example",
      ),
    ).toThrow("must be deeply frozen");
  });

  it("instantiates extensions with unique normalized absolute executable paths", () => {
    const config = freezeExtensionConfig({});
    const instance = instantiateManagedExtension(
      extension({ requiredHostExecutables: () => ["/usr/bin/git", "/opt/bin/service-api"] }),
      config,
    );
    expect(instance.requiredHostExecutables).toEqual(["/usr/bin/git", "/opt/bin/service-api"]);
    expect(instance.hostEnvironment).toEqual({ variables: [] });
    expect(Object.isFrozen(instance.requiredHostExecutables)).toBe(true);

    expect(() =>
      instantiateManagedExtension(extension({ requiredHostExecutables: () => ["git"] }), config),
    ).toThrow("normalized absolute path");
    expect(() =>
      instantiateManagedExtension(
        extension({ requiredHostExecutables: () => ["/usr/bin/git", "/usr/bin/git"] }),
        config,
      ),
    ).toThrow("duplicate host executable");
  });

  it("validates and freezes strict host environment declarations", () => {
    const policy = defineManagedHostEnvironment({
      variables: ["SERVICE_API_TOKEN"],
      removeInherited: ["GIT_CONFIG_GLOBAL"],
      removeInheritedPrefixes: ["GIT_CONFIG_"],
      fixed: { GIT_TERMINAL_PROMPT: "0" },
    });
    expect(policy).toEqual({
      variables: ["SERVICE_API_TOKEN"],
      removeInherited: ["GIT_CONFIG_GLOBAL"],
      removeInheritedPrefixes: ["GIT_CONFIG_"],
      fixed: { GIT_TERMINAL_PROMPT: "0" },
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.variables)).toBe(true);
    expect(Object.isFrozen(policy.removeInherited)).toBe(true);
    expect(Object.isFrozen(policy.removeInheritedPrefixes)).toBe(true);
    expect(Object.isFrozen(policy.fixed)).toBe(true);

    expect(() => defineManagedHostEnvironment({ variables: ["A", "A"] })).toThrow(
      "must not contain duplicates",
    );
    expect(() =>
      defineManagedHostEnvironment({ variables: ["PI_SANDBOX_INTERNAL_IDENTITY_TOKEN"] }),
    ).toThrow("reserved internal variable");
    expect(() =>
      defineManagedHostEnvironment({ variables: [], fixed: { BAD: "nul\0value" } }),
    ).toThrow("without NUL bytes");
    expect(() =>
      defineManagedHostEnvironment({
        variables: [],
        removeInheritedPrefixes: ["BAD-PREFIX"],
      }),
    ).toThrow("not a valid environment variable name");
    expect(() =>
      defineManagedHostEnvironment({
        variables: [],
        removeInherited: ["HOME", "HOME"],
      }),
    ).toThrow("must not contain duplicates");
    expect(() =>
      defineManagedHostEnvironment({
        variables: [],
        fixed: { PI_SANDBOX_INTERNAL_OVERRIDE: "bad" },
      }),
    ).toThrow("must not set a reserved internal variable");
    expect(() => defineManagedHostEnvironment({ variables: [], extra: [] } as never)).toThrow(
      "not a recognized field",
    );
  });

  it("exposes only host execution to tools and returns mutable Pi-compatible content", async () => {
    const tool = defineManagedTool({
      name: "example_tool",
      label: "Example",
      description: "Example",
      diagnosticScope: "example.tool",
      parameters: { type: "object", additionalProperties: false },
      async execute(_arguments, context) {
        const command = await context.host.execute(
          { argv: ["/usr/bin/example"] },
          { signal: context.signal },
        );
        return {
          content: [{ type: "text", text: String(command.exitCode) }],
          details: undefined,
        };
      },
    });
    const signal = new AbortController().signal;
    const result = await tool.execute(
      {},
      {
        cwd: "/work",
        config: freezeExtensionConfig({}),
        signal,
        host: {
          execute: (_request, options) => {
            expect(options?.signal).toBe(signal);
            return Promise.resolve({
              exitCode: 0,
              signal: null,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
            });
          },
        },
      },
    );
    result.content.push({ type: "text", text: "second" });
    expect(result.content).toHaveLength(2);
  });
});
