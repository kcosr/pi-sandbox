import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadExtensionPreferences, registerExtensionPreferencesCommand } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(mode: "tui" | "rpc" = "tui", cliEnabled?: boolean) {
  const agentDir = await mkdtemp(join(tmpdir(), "extensions-menu-"));
  directories.push(agentDir);
  const preferences = await loadExtensionPreferences({
    agentDir,
    descriptors: [
      {
        id: "subagents",
        label: "Subagents",
        toolNames: ["spawn_agent"],
        adminEnabled: true,
        ...(cliEnabled === undefined ? {} : { cliEnabled }),
      },
    ],
  });
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const pi = {
    registerCommand: vi.fn(
      (name: string, value: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
        expect(name).toBe("extensions");
        command = value;
      },
    ),
  } as unknown as ExtensionAPI;
  const select = vi
    .fn<(title: string, choices: string[]) => Promise<string | undefined>>()
    .mockResolvedValue(undefined);
  const notify = vi.fn();
  const ctx = { mode, hasUI: true, ui: { select, notify } } as unknown as ExtensionCommandContext;
  registerExtensionPreferencesCommand(pi, preferences);
  return { preferences, command: command!, ctx, select, notify };
}

describe("optional extensions command", () => {
  it("toggles an item in a native menu and refreshes its displayed state", async () => {
    const f = await fixture();
    f.select
      .mockImplementationOnce((_title, choices) => Promise.resolve(choices[0]))
      .mockResolvedValueOnce("Close");
    await f.command.handler("", f.ctx);
    expect(f.preferences.enabled("subagents")).toBe(false);
    expect(f.select.mock.calls[0]![1][0]).toMatch(/^On {2}Subagents/);
    expect(f.select.mock.calls[1]![1][0]).toMatch(/^Off {2}Subagents/);
    expect(f.select.mock.calls[0]![0]).toContain("Use /mcp for MCP servers.");
  });

  it("Escape closes the menu without changing availability", async () => {
    const f = await fixture();
    await f.command.handler("", f.ctx);
    expect(f.preferences.enabled("subagents")).toBe(true);
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it("explains a CLI-controlled item and leaves it unchanged", async () => {
    const f = await fixture("tui", false);
    f.select.mockImplementationOnce((_title, choices) => Promise.resolve(choices[0]));
    await f.command.handler("", f.ctx);
    expect(f.select.mock.calls[0]![1][0]).toContain("command line");
    expect(f.notify).toHaveBeenCalledWith("Subagents is controlled by the command line", "error");
    expect(f.preferences.enabled("subagents")).toBe(false);
  });

  it("supports RPC text listing and explicit toggles without opening a native dialog", async () => {
    const f = await fixture("rpc");
    await f.command.handler("", f.ctx);
    expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("On  Subagents"), "info");
    await f.command.handler("disable subagents", f.ctx);
    expect(f.preferences.enabled("subagents")).toBe(false);
    expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("Off  Subagents"), "info");
    await f.command.handler("enable subagents", f.ctx);
    expect(f.preferences.enabled("subagents")).toBe(true);
    expect(f.select).not.toHaveBeenCalled();
  });

  it("rejects unknown IDs and extra arguments without changing available code", async () => {
    const f = await fixture();
    await f.command.handler("enable arbitrary", f.ctx);
    expect(f.notify).toHaveBeenLastCalledWith("Unknown optional extension", "error");
    await f.command.handler("disable subagents now", f.ctx);
    expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage:"), "warning");
    expect(f.preferences.enabled("subagents")).toBe(true);
    expect(f.select).not.toHaveBeenCalled();
    expect(f.command.getArgumentCompletions?.("disable ")).toEqual([
      { value: "disable subagents", label: "disable subagents" },
    ]);
  });
});
