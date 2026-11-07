import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadExtensionPreferences, type ExtensionDescriptor } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "extension-preferences-"));
  directories.push(path);
  return path;
}
const descriptors: readonly ExtensionDescriptor[] = [
  {
    id: "subagents",
    label: "Subagents",
    toolNames: ["spawn_agent", "resume_agent"],
    adminEnabled: true,
  },
  { id: "git", label: "Git", toolNames: ["git_clone"], adminEnabled: true },
];

describe("optional extension preferences", () => {
  it("persists availability for every owned tool and calls back after the live state changes", async () => {
    const agentDir = await directory();
    const changes: [string, boolean, boolean][] = [];
    const preferences = await loadExtensionPreferences({
      agentDir,
      descriptors,
      onChange(id, enabled) {
        changes.push([id, enabled, preferences.permitsTool("spawn_agent")]);
      },
    });
    expect(preferences.enabled("subagents")).toBe(true);
    await preferences.setEnabled("subagents", false);
    expect(changes).toEqual([["subagents", false, false]]);
    expect(preferences.permitsTool("resume_agent")).toBe(false);
    expect(preferences.permitsTool("read")).toBe(true);
    expect(preferences.permitsTool("git_clone")).toBe(true);
    expect((await loadExtensionPreferences({ agentDir, descriptors })).enabled("subagents")).toBe(
      false,
    );
    expect((await stat(join(agentDir, "extensions.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(agentDir)).toEqual(["extensions.json"]);
    await preferences.setEnabled("subagents", false);
    expect(changes).toHaveLength(1);
  });

  it.each([
    {
      adminEnabled: false,
      cliEnabled: true,
      saved: true,
      effective: false,
      source: "administrator",
    },
    {
      adminEnabled: false,
      cliEnabled: undefined,
      saved: true,
      effective: false,
      source: "administrator",
    },
    {
      adminEnabled: true,
      cliEnabled: false,
      saved: true,
      effective: false,
      source: "command-line",
    },
    { adminEnabled: true, cliEnabled: true, saved: false, effective: true, source: "command-line" },
  ])(
    "applies the policy and CLI ceilings: $source / $effective",
    async ({ adminEnabled, cliEnabled, saved, effective, source }) => {
      const agentDir = await directory();
      await writeFile(
        join(agentDir, "extensions.json"),
        JSON.stringify({ version: 1, extensions: { subagents: { enabled: saved } } }),
      );
      const preferences = await loadExtensionPreferences({
        agentDir,
        descriptors: [
          {
            ...descriptors[0]!,
            adminEnabled,
            ...(cliEnabled === undefined ? {} : { cliEnabled }),
          },
        ],
      });
      expect(preferences.snapshot()[0]).toMatchObject({
        enabled: effective,
        editable: false,
        source,
      });
      await expect(preferences.setEnabled("subagents", !effective)).rejects.toThrow();
      expect(JSON.parse(await readFile(join(agentDir, "extensions.json"), "utf8"))).toEqual({
        version: 1,
        extensions: { subagents: { enabled: saved } },
      });
    },
  );

  it("keeps unknown saved IDs inert and handles own-property names correctly", async () => {
    const agentDir = await directory();
    await writeFile(
      join(agentDir, "extensions.json"),
      JSON.stringify({ version: 1, extensions: { unknown: { enabled: true } } }),
    );
    const preferences = await loadExtensionPreferences({
      agentDir,
      descriptors: [
        ...descriptors,
        { id: "constructor", label: "Constructor", toolNames: [], adminEnabled: true },
      ],
    });
    expect(preferences.enabled("unknown")).toBe(false);
    await expect(preferences.setEnabled("unknown", true)).rejects.toThrow(
      "Unknown optional extension",
    );
    expect(preferences.snapshot().find((entry) => entry.id === "constructor")).toMatchObject({
      enabled: true,
      source: "default",
    });
    await preferences.setEnabled("constructor", false);
    expect(preferences.enabled("constructor")).toBe(false);
    expect(preferences.snapshot()).toHaveLength(3);
  });

  it("merges concurrent saves without silently adopting other sessions' live choices", async () => {
    const agentDir = await directory();
    const firstChanged = vi.fn();
    const secondChanged = vi.fn();
    const first = await loadExtensionPreferences({ agentDir, descriptors, onChange: firstChanged });
    const second = await loadExtensionPreferences({
      agentDir,
      descriptors,
      onChange: secondChanged,
    });
    await Promise.all([first.setEnabled("subagents", false), second.setEnabled("git", false)]);
    const reloaded = await loadExtensionPreferences({ agentDir, descriptors });
    expect(reloaded.enabled("subagents")).toBe(false);
    expect(reloaded.enabled("git")).toBe(false);
    expect(first.enabled("git")).toBe(true);
    expect(second.enabled("subagents")).toBe(true);
    expect(firstChanged.mock.calls).toEqual([["subagents", false]]);
    expect(secondChanged.mock.calls).toEqual([["git", false]]);
  });

  it.each([
    "not-json-secret",
    JSON.stringify({ version: 2, extensions: {} }),
    JSON.stringify({ version: 1, extensions: {}, factory: "untrusted" }),
    JSON.stringify({ version: 1, extensions: { git: { enabled: "true" } } }),
    JSON.stringify({ version: 1, extensions: { git: { enabled: true, module: "untrusted" } } }),
    JSON.stringify({ version: 1, extensions: { "../other": { enabled: true } } }),
    " ".repeat(64 * 1024 + 1),
    Buffer.from([0xff]),
  ])("rejects malformed or unbounded state without exposing its contents", async (content) => {
    const agentDir = await directory();
    const path = join(agentDir, "extensions.json");
    await writeFile(path, content);
    await expect(loadExtensionPreferences({ agentDir, descriptors })).rejects.toThrow(
      new Error(`Invalid user extension preferences at ${JSON.stringify(path)}`),
    );
  });

  it("does not update live state or overwrite a corrupt replacement on failed save", async () => {
    const agentDir = await directory();
    const onChange = vi.fn();
    const preferences = await loadExtensionPreferences({ agentDir, descriptors, onChange });
    await writeFile(join(agentDir, "extensions.json"), "corrupt");
    await expect(preferences.setEnabled("git", false)).rejects.toThrow(
      "Invalid user extension preferences",
    );
    expect(preferences.enabled("git")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(await readFile(join(agentDir, "extensions.json"), "utf8")).toBe("corrupt");
  });

  it("does not follow symlinked preferences", async () => {
    const agentDir = await directory();
    const target = join(agentDir, "target");
    await writeFile(target, JSON.stringify({ version: 1, extensions: {} }));
    await symlink(target, join(agentDir, "extensions.json"));
    await expect(loadExtensionPreferences({ agentDir, descriptors })).rejects.toThrow(
      new Error(
        `Cannot read user extension preferences at ${JSON.stringify(join(agentDir, "extensions.json"))}`,
      ),
    );
  });

  it("rejects duplicate feature ownership of tools", async () => {
    const agentDir = await directory();
    await expect(
      loadExtensionPreferences({
        agentDir,
        descriptors: [descriptors[0]!, { ...descriptors[1]!, toolNames: ["spawn_agent"] }],
      }),
    ).rejects.toThrow("Invalid optional extension tool inventory");
  });
});
