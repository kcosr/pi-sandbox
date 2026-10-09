import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import type { CompiledExtensionRecord, ManagedExtension, PiToolExtension } from "./contracts.js";
import { createManagedExtensionCatalog } from "./catalog.js";
import {
  defineManagedHostEnvironment,
  freezeExtensionConfig,
  instantiateManagedExtension,
} from "./sdk.js";
import gitCloneExtension from "./git-clone/index.js";

const DIGEST = "a".repeat(64);

function extension(overrides: Partial<ManagedExtension> = {}): ManagedExtension {
  return {
    kind: "managed",
    apiVersion: 3,
    id: "example-extension",
    version: "1.2.3",
    hostEnvironment: defineManagedHostEnvironment({ variables: [] }),
    parseConfig: (raw) => freezeExtensionConfig(raw as never),
    requiredHostExecutables: () => ["/usr/bin/example"],
    tools: [
      {
        name: "example_tool",
        label: "Example tool",
        description: "Run an example operation",
        diagnosticScope: "example-extension.example-tool",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        execute: vi.fn(() =>
          Promise.resolve({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
        ),
      },
    ],
    ...overrides,
  };
}

function record(module = extension()): CompiledExtensionRecord {
  return {
    manifest: {
      kind: "managed",
      apiVersion: 3,
      id: module.id,
      version: module.version,
      toolNames: module.tools.map((tool) => tool.name),
      digests: { manifestSha256: DIGEST, moduleSha256: DIGEST },
    },
    extension: module,
  };
}

describe("managed extension catalog", () => {
  it("validates and instantiates the shipped Git extension with its actual manifest and target metadata", async () => {
    const manifestSource = await readFile(
      new URL("./git-clone/pi-sandbox-extension.json", import.meta.url),
      "utf8",
    );
    const moduleSource = await readFile(new URL("./git-clone/index.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(manifestSource) as {
      kind: "managed";
      apiVersion: 3;
      id: string;
      version: string;
      tools: string[];
    };
    const catalog = createManagedExtensionCatalog([
      {
        manifest: {
          kind: manifest.kind,
          apiVersion: manifest.apiVersion,
          id: manifest.id,
          version: manifest.version,
          toolNames: manifest.tools,
          digests: {
            manifestSha256: createHash("sha256").update(manifestSource).digest("hex"),
            moduleSha256: createHash("sha256").update(moduleSource).digest("hex"),
          },
        },
        extension: gitCloneExtension,
      },
    ]);
    const selected = catalog.getExtension("git");
    if (selected?.kind !== "managed") throw new Error("missing Git extension");
    const instance = instantiateManagedExtension(
      selected,
      selected.parseConfig(
        { allowed_hosts: ["github.com"], allowed_schemes: ["https"] },
        "extensions.git",
      ),
    );
    expect(
      instance.extension.tools[0]?.auditTarget?.(
        { repository: "https://github.com/owner/project.git" },
        "/work",
      ),
    ).toEqual({ repository: "https://github.com/owner/project.git", path: "/work/project" });
  });

  it("rejects a non-function target metadata selector", () => {
    const base = extension();
    const tool = base.tools[0]!;
    expect(() =>
      createManagedExtensionCatalog([
        record({ ...base, tools: [{ ...tool, auditTarget: "invalid" as never }] }),
      ]),
    ).toThrow("auditTarget must be a function");
  });
  it("indexes a standard Pi tool-only extension", () => {
    const module: PiToolExtension = {
      kind: "pi-tool",
      apiVersion: 3,
      id: "standard-extension",
      version: "1.0.0",
      hostEnvironment: defineManagedHostEnvironment({ variables: [] }),
      parseConfig: () => freezeExtensionConfig({}),
      requiredHostExecutables: () => [],
      toolNames: ["standard_tool"],
      factory: () => undefined,
    };
    const compiled: CompiledExtensionRecord = {
      manifest: {
        kind: "pi-tool",
        apiVersion: 3,
        id: module.id,
        version: module.version,
        toolNames: module.toolNames,
        digests: { manifestSha256: DIGEST, moduleSha256: DIGEST },
      },
      extension: module,
    };
    const catalog = createManagedExtensionCatalog([compiled]);
    expect(catalog.toolNames).toEqual(["standard_tool"]);
    expect(catalog.getTool("standard_tool")).toEqual({
      extensionId: "standard-extension",
      definition: undefined,
    });
  });

  it("indexes a valid compiled extension and its static tools", () => {
    const compiled = record();
    const catalog = createManagedExtensionCatalog([compiled]);

    expect(catalog.extensions).toEqual([compiled.extension]);
    expect(catalog.toolNames).toEqual(["example_tool"]);
    expect(catalog.getExtension("example-extension")).toBe(compiled.extension);
    expect(catalog.getTool("example_tool")).toMatchObject({ extensionId: "example-extension" });
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it("accepts only function call formatters", () => {
    const base = extension();
    const tool = base.tools[0];
    if (tool === undefined) throw new Error("missing fixture tool");
    const formatCall = vi.fn(() => "visible summary");
    const definition = createManagedExtensionCatalog([
      record({ ...base, tools: [{ ...tool, formatCall }] }),
    ]).getTool("example_tool")?.definition;
    expect(definition?.formatCall?.({ value: "visible" })).toBe("visible summary");
    expect(() =>
      createManagedExtensionCatalog([
        record({ ...base, tools: [{ ...tool, formatCall: "invalid" as never }] }),
      ]),
    ).toThrow("formatCall must be a function");
  });

  it.each([
    "read",
    "grep",
    "find",
    "ls",
    "write",
    "edit",
    "bash",
    "user_shell",
    "codemode",
    "mcp__docs",
  ])("rejects reserved tool name %s", (name) => {
    const base = extension();
    const tool = base.tools[0];
    if (tool === undefined) throw new Error("missing fixture tool");
    expect(() =>
      createManagedExtensionCatalog([
        record({ ...base, tools: [{ ...tool, name, diagnosticScope: `test.${name}` }] }),
      ]),
    ).toThrow("collides with reserved tool");
  });

  it("rejects manifest/module mismatches, duplicate names, and duplicate scopes", () => {
    const mismatched = record();
    expect(() =>
      createManagedExtensionCatalog([
        { ...mismatched, manifest: { ...mismatched.manifest, id: "different" } },
      ]),
    ).toThrow("manifest and module ids differ");

    const first = record();
    const secondExtension = extension({ id: "second-extension", version: "2.0.0" });
    expect(() => createManagedExtensionCatalog([first, record(secondExtension)])).toThrow(
      "duplicate extension tool name",
    );

    const base = extension();
    const tool = base.tools[0];
    if (tool === undefined) throw new Error("missing fixture tool");
    expect(() =>
      createManagedExtensionCatalog([
        record({ ...base, tools: [tool, { ...tool, name: "other_tool" }] }),
      ]),
    ).toThrow("duplicate managed extension diagnostic scope");
  });

  it("rejects invalid metadata and malformed plain JSON schemas", () => {
    expect(() =>
      createManagedExtensionCatalog([
        {
          ...record(),
          manifest: { ...record().manifest, apiVersion: 2 } as never,
        },
      ]),
    ).toThrow("manifest.apiVersion must be 3");
    const invalidDigest = record();
    expect(() =>
      createManagedExtensionCatalog([
        {
          ...invalidDigest,
          manifest: {
            ...invalidDigest.manifest,
            digests: { ...invalidDigest.manifest.digests, moduleSha256: "ABC" },
          },
        },
      ]),
    ).toThrow("lowercase SHA-256");
    expect(() =>
      createManagedExtensionCatalog([
        {
          ...record(),
          manifest: { ...record().manifest, unexpected: true } as never,
        },
      ]),
    ).toThrow("unexpected is not a recognized field");

    const base = extension();
    const tool = base.tools[0];
    if (tool === undefined) throw new Error("missing fixture tool");
    expect(() =>
      createManagedExtensionCatalog([
        record({
          ...base,
          tools: [{ ...tool, parameters: { type: "object", required: ["value", "value"] } }],
        }),
      ]),
    ).toThrow("must not contain duplicates");
  });

  it("rejects malformed host environment policy", () => {
    expect(() =>
      createManagedExtensionCatalog([
        record(extension({ hostEnvironment: { variables: ["BAD-NAME"] } })),
      ]),
    ).toThrow("not a valid environment variable name");
    expect(() =>
      createManagedExtensionCatalog([
        record(
          extension({
            hostEnvironment: { variables: [], unexpected: [] } as never,
          }),
        ),
      ]),
    ).toThrow("unexpected is not a recognized field");
  });
});
