import { describe, expect, it, vi } from "vitest";
import { createManagedCodemodeExtension } from "./index.js";

describe("managed code-mode composition", () => {
  it("does not invoke the upstream factory when the administrator disables code mode", () => {
    const factory = vi.fn(() => () => undefined);
    expect(
      createManagedCodemodeExtension({ enabled: false, timeoutMs: 300000 }, factory),
    ).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("pins presentation and disables provider access independently of user settings", () => {
    const factory = vi.fn(() => () => undefined);
    createManagedCodemodeExtension({ enabled: true, timeoutMs: 1000 }, factory);
    expect(factory).toHaveBeenCalledWith({
      mode: "on",
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
});
