import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { beforeManagedQuit } from "./quit.js";

function fixture(canSave = true) {
  const select = vi.fn<ExtensionCommandContext["ui"]["select"]>(() => Promise.resolve(undefined));
  const ctx = { mode: "tui", hasUI: true, ui: { select } } as unknown as ExtensionCommandContext;
  const abort = new AbortController();
  const options = {
    quiesce: vi.fn<() => Promise<void>>(() => Promise.reject(new Error("still stopping"))),
    canSave: () => canSave,
    beforeQuit: vi.fn(() => Promise.resolve(true)),
  };
  return { ctx, abort, options, select };
}

describe("managed quit with subagents", () => {
  it.each([true, false])(
    "preserves normal export/exit decision %s after children settle",
    async (answer) => {
      const f = fixture();
      f.options.quiesce.mockResolvedValue(undefined);
      f.options.beforeQuit.mockResolvedValue(answer);
      expect(await beforeManagedQuit(f.ctx, f.abort.signal, f.options)).toBe(answer);
      expect(f.options.beforeQuit).toHaveBeenCalledWith(f.ctx, f.abort.signal);
      expect(f.select).not.toHaveBeenCalled();
    },
  );

  it("allows explicit exit without ever capturing unsettled private files", async () => {
    const f = fixture();
    f.select.mockResolvedValue("Exit without saving");
    expect(await beforeManagedQuit(f.ctx, f.abort.signal, f.options)).toBe(true);
    expect(f.select).toHaveBeenCalledWith(
      expect.stringContaining("cannot be safely saved"),
      ["Keep session open", "Exit without saving"],
      { signal: f.abort.signal },
    );
    expect(f.options.beforeQuit).not.toHaveBeenCalled();
  });

  it.each([undefined, "Keep session open"])("keeps the session open after %s", async (answer) => {
    const f = fixture();
    f.select.mockResolvedValue(answer);
    expect(await beforeManagedQuit(f.ctx, f.abort.signal, f.options)).toBe(false);
    expect(f.options.beforeQuit).not.toHaveBeenCalled();
  });

  it("does not imply saving is available when exports are not admitted", async () => {
    const f = fixture(false);
    f.select.mockResolvedValue("Exit anyway");
    expect(await beforeManagedQuit(f.ctx, f.abort.signal, f.options)).toBe(true);
    expect(f.select.mock.calls[0]?.[0]).not.toMatch(/sav|private files/i);
    expect(f.select.mock.calls[0]?.[1]).toEqual(["Keep session open", "Exit anyway"]);
    expect(f.options.beforeQuit).not.toHaveBeenCalled();
  });

  it("stops waiting promptly when the quit signal aborts", async () => {
    const f = fixture();
    f.options.quiesce.mockReturnValue(new Promise(() => undefined));
    const pending = beforeManagedQuit(f.ctx, f.abort.signal, f.options);
    f.abort.abort();
    expect(await pending).toBe(false);
    expect(f.select).not.toHaveBeenCalled();
    expect(f.options.beforeQuit).not.toHaveBeenCalled();
  });

  it("ignores a dialog answer after signal cancellation", async () => {
    const f = fixture();
    f.select.mockImplementation(() => {
      f.abort.abort();
      return Promise.resolve("Exit without saving");
    });
    expect(await beforeManagedQuit(f.ctx, f.abort.signal, f.options)).toBe(false);
    expect(f.options.beforeQuit).not.toHaveBeenCalled();
  });
});
