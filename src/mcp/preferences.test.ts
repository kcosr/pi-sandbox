import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpPreferences } from "./preferences.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "managed-mcp-preferences-"));
  directories.push(path);
  return path;
}
describe("managed MCP preferences", () => {
  it("persists stock presentation fields while preserving inert connection data and other servers", async () => {
    const dir = await directory();
    const path = join(dir, "mcp.json");
    await writeFile(
      path,
      JSON.stringify({
        autoEnableCodemode: false,
        mcpServers: {
          docs: {
            url: "https://untrusted.example",
            enabled: false,
            exposure: "hidden",
            toolExposure: { search: "direct" },
          },
          rogue: { command: "/bin/false" },
        },
      }),
    );
    const preferences = await loadMcpPreferences(dir);
    expect(preferences.autoEnableCodemode).toBe(false);
    expect(preferences.server("docs")).toEqual({ enabled: false, exposure: "hidden" });
    expect(preferences.server("rogue")).toEqual({});
    await preferences.update("docs", { enabled: true, exposure: "codemode" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      autoEnableCodemode: false,
      mcpServers: {
        docs: { url: "https://untrusted.example", enabled: true, exposure: "codemode" },
        rogue: { command: "/bin/false" },
      },
    });
    expect((await loadMcpPreferences(dir)).server("docs")).toEqual({
      enabled: true,
      exposure: "codemode",
    });
  });
  it("creates user preferences and reads latest contents before saving", async () => {
    const dir = await directory();
    const preferences = await loadMcpPreferences(dir);
    expect(preferences.autoEnableCodemode).toBe(true);
    await preferences.update("docs", { exposure: "direct" });
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { other: { enabled: false } } }),
    );
    await preferences.update("docs", { enabled: false });
    expect(JSON.parse(await readFile(join(dir, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { other: { enabled: false }, docs: { enabled: false } },
    });
  });
  it("rejects malformed or oversized preferences without echoing their content", async () => {
    const dir = await directory();
    await writeFile(join(dir, "mcp.json"), "secret not json");
    await expect(loadMcpPreferences(dir)).rejects.toThrow(/^Invalid user MCP preferences$/);
    await writeFile(join(dir, "mcp.json"), " ".repeat(1024 * 1024 + 1));
    await expect(loadMcpPreferences(dir)).rejects.toThrow(/^Invalid user MCP preferences$/);
  });
  it("does not follow a symlink or overwrite corrupt preferences on save", async () => {
    const dir = await directory();
    const preferences = await loadMcpPreferences(dir);
    await writeFile(join(dir, "target"), "{}");
    await symlink(join(dir, "target"), join(dir, "mcp.json"));
    await expect(preferences.update("docs", { enabled: false })).rejects.toThrow("Cannot read");
    expect(await readFile(join(dir, "target"), "utf8")).toBe("{}");
  });
});
