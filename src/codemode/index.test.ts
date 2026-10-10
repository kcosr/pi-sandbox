import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createManagedCodemodeExtension } from "./index.js";

describe("managed code-mode composition", () => {
  it("does not invoke the upstream factory when the administrator disables code mode", () => {
    const factory = vi.fn(() => () => undefined);
    expect(
      createManagedCodemodeExtension({ enabled: false, timeoutMs: 300000 }, factory),
    ).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("bounds execution and disables provider access while leaving presentation to user settings", () => {
    const factory = vi.fn(() => () => undefined);
    createManagedCodemodeExtension({ enabled: true, timeoutMs: 1000 }, factory);
    expect(factory).toHaveBeenCalledWith({
      inlineBudget: 3000,
      models: false,
      executionLimits: {
        timeoutMs: 1000,
        maxSourceBytes: 262144,
        maxCalls: 256,
        maxConcurrentCalls: 16,
        maxOutputBytes: 16777216,
        inlineOnly: true,
      },
    });
  });

  it("honors the user's stock on/only mode while keeping nested tools callable", async () => {
    let mode: "on" | "only" = "only";
    let definition: ToolDefinition | undefined;
    const api = {
      getSettings: () => ({ codemode: { mode } }),
      registerTool: (tool: ToolDefinition) => {
        definition = tool;
      },
    } as unknown as ExtensionAPI;
    await createManagedCodemodeExtension({ enabled: true, timeoutMs: 1000 })!(api);
    expect(definition).toMatchObject({
      name: "codemode",
      defaultActive: false,
      exposure: "model-only",
    });
    const read = {
      name: "read",
      label: "read",
      description: "Read a file",
      parameters: { type: "object" },
      execute: () => Promise.resolve({ content: [], details: {} }),
    };
    const loadout = {
      declared: [read],
      callable: [read],
      registered: [read],
      getExposure: () => "direct" as const,
      getNamespace: () => undefined,
      getPromptGuidelines: () => [],
    };
    expect(definition!.prepareLoadout!(loadout)?.hiddenDeclarations).toEqual(["read"]);
    mode = "on";
    expect(definition!.prepareLoadout!(loadout)?.hiddenDeclarations).toEqual([]);
  });
});
