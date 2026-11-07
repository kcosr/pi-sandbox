import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentSnapshot } from "../../packages/subagents-extension/src/contracts.js";
import { SubagentStore } from "../../packages/subagents-extension/src/storage.js";
import { cleanExpiredSubagents } from "./retention.js";

const DAY = 86_400_000;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(id = "parent", alias = false) {
  const temporary = await mkdtemp(join(tmpdir(), "pi-child-retention-"));
  directories.push(temporary);
  let directory = temporary;
  if (alias) {
    const target = join(temporary, "state");
    directory = join(temporary, "alias");
    await mkdir(target);
    await symlink(target, directory, "dir");
  }
  const root = join(directory, "subagents");
  const store = new SubagentStore(root, id);
  const sessionFile = store.sessionFile("a-child");
  await writeFile(sessionFile, "private transcript\n");
  store.write(17, [
    {
      id: "a-child",
      taskId: "task",
      parentSessionId: id,
      task: "review",
      extended: false,
      status: "completed",
      activity: "completed",
      tools: [],
      startedAt: 1,
      updatedAt: 2,
      assistant: "result",
      thinking: "",
      assistantTruncated: false,
      thinkingTruncated: false,
      callback: "acknowledged",
      sessionFile,
      provider: "offline",
      model: "fixture",
      reasoning: "off",
    } satisfies SubagentSnapshot,
  ]);
  store.close();
  await utimes(join(root, id), new Date(0), new Date(0));
  await utimes(join(root, id, "state.json"), new Date(0), new Date(0));
  return { directory, root, id, sessionFile, parent: join(root, id), now: 30 * DAY };
}
describe("managed subagent retention", () => {
  it.each(["authored", "canonical"])(
    "expires aliased state through its %s path without refunding quota",
    async (path) => {
      const f = await fixture("parent", true);
      await cleanExpiredSubagents({
        userStateDir: path === "authored" ? f.directory : await realpath(f.directory),
        retentionDays: 7,
        parentSessionId: "other",
        now: f.now,
      });
      await expect(stat(f.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
      const reopened = new SubagentStore(await realpath(f.root), f.id);
      try {
        expect(reopened.read()).toEqual({ version: 2, used: 17, records: [] });
      } finally {
        reopened.close();
      }
    },
  );

  it("advances past a full page of retained roots instead of starving later transcripts", async () => {
    const f = await fixture("zz-last");
    await Promise.all(
      Array.from({ length: 4096 }, (_, index) =>
        mkdir(join(f.root, `a-${String(index).padStart(4, "0")}`)),
      ),
    );
    await cleanExpiredSubagents({
      userStateDir: f.directory,
      retentionDays: 7,
      parentSessionId: "other",
      now: f.now,
    });
    expect(await readFile(f.sessionFile, "utf8")).toBe("private transcript\n");
    expect(JSON.parse(await readFile(join(f.root, "retention.json"), "utf8"))).toMatchObject({
      version: 2,
      cursor: "a-4095",
    });
    await cleanExpiredSubagents({
      userStateDir: f.directory,
      retentionDays: 7,
      parentSessionId: "other",
      now: f.now + DAY,
    });
    await expect(stat(f.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(f.parent, "state.json"), "utf8"))).toEqual({
      version: 2,
      used: 17,
      records: [],
    });
    expect(JSON.parse(await readFile(join(f.root, "retention.json"), "utf8"))).toMatchObject({
      version: 2,
      cursor: "",
    });
  }, 15000);
  it("expires transcript and preview data while permanently preserving the consumed quota", async () => {
    const f = await fixture();
    await cleanExpiredSubagents({
      userStateDir: f.directory,
      retentionDays: 7,
      parentSessionId: "other",
      now: f.now,
    });
    await expect(stat(f.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(f.parent, "state.json"), "utf8"))).toEqual({
      version: 2,
      used: 17,
      records: [],
    });
    const resumed = new SubagentStore(f.root, f.id);
    try {
      expect(resumed.read().used).toBe(17);
    } finally {
      resumed.close();
    }
  });
  it.each(["current", "owned", "stale-owner", "disabled"])("protects %s roots", async (kind) => {
    const f = await fixture();
    let owner: SubagentStore | undefined;
    if (kind === "owned") owner = new SubagentStore(f.root, f.id);
    if (kind === "stale-owner") await writeFile(join(f.parent, "owner.json"), "malformed owner");
    await utimes(f.parent, new Date(0), new Date(0));
    try {
      await cleanExpiredSubagents({
        userStateDir: f.directory,
        retentionDays: kind === "disabled" ? 0 : 7,
        parentSessionId: kind === "current" ? f.id : "other",
        now: f.now,
      });
      expect(await readFile(f.sessionFile, "utf8")).toBe("private transcript\n");
    } finally {
      owner?.close();
    }
  });
  it("never traverses a linked child directory", async () => {
    const f = await fixture();
    const outside = join(f.directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "retained"), "value");
    await symlink(outside, join(f.parent, "linked"), "dir");
    await utimes(f.parent, new Date(0), new Date(0));
    await cleanExpiredSubagents({
      userStateDir: f.directory,
      retentionDays: 7,
      parentSessionId: "other",
      now: f.now,
    });
    expect(await readFile(join(outside, "retained"), "utf8")).toBe("value");
  });
  it("rechecks the state age after obtaining ownership", async () => {
    const f = await fixture();
    await utimes(join(f.parent, "state.json"), new Date(f.now), new Date(f.now));
    await cleanExpiredSubagents({
      userStateDir: f.directory,
      retentionDays: 7,
      parentSessionId: "other",
      now: f.now,
    });
    expect(await readFile(f.sessionFile, "utf8")).toBe("private transcript\n");
  });
});
