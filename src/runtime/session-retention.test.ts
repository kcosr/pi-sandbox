import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSessionMaintenance,
  touchSessionFile,
  type SessionMaintenanceContext,
} from "./session-retention.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-07T12:00:00Z");
const roots: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-session-retention-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const sessions = join(agentDir, "sessions");
  const workspace = join(sessions, "--workspace--");
  await mkdir(workspace, { recursive: true });
  const context: SessionMaintenanceContext = {
    mode: "interactive",
    sessionDir: undefined,
    sessionManager: { getSessionFile: () => undefined },
  };
  return { root, agentDir, sessions, workspace, context };
}

async function session(directory: string, name: string, daysOld: number): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${name}.jsonl`);
  await writeFile(
    file,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: name,
      cwd: directory,
      timestamp: new Date(NOW - 900 * DAY).toISOString(),
    })}\nnot parsed as conversation content\n`,
  );
  await utimes(file, new Date(NOW - daysOld * DAY), new Date(NOW - daysOld * DAY));
  return file;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function stateFile(agentDir: string): Promise<string> {
  const dir = join(agentDir, "pi-sandbox", "retention");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  return join(dir, files[0]!);
}

describe("session retention", () => {
  it("uses last modification, preserves the cutoff, and visits all immediate workspace directories", async () => {
    const f = await fixture();
    const expired = await session(f.workspace, "expired", 366);
    const active = await session(f.workspace, "active", 1);
    const cutoff = await session(f.workspace, "cutoff", 365);
    const elsewhere = await session(join(f.sessions, "--other--"), "expired", 500);
    const nested = await session(join(f.workspace, "nested"), "leave-alone", 500);
    const rootFile = await session(f.sessions, "outside-layout", 500);
    const report = vi.fn();
    await createSessionMaintenance({
      agentDir: f.agentDir,
      retentionDays: 365,
      reportProgress: report,
    })(f.context);
    expect(await exists(expired)).toBe(false);
    expect(await exists(elsewhere)).toBe(false);
    for (const file of [active, cutoff, nested, rootFile]) expect(await exists(file)).toBe(true);
    expect(report).not.toHaveBeenCalled();
  });

  it("refreshes and protects the selected old session, including selection through a symlink", async () => {
    const f = await fixture();
    const current = await session(f.workspace, "current", 500);
    const cleanup = createSessionMaintenance({ agentDir: f.agentDir, retentionDays: 365 });
    await cleanup({ ...f.context, sessionManager: { getSessionFile: () => current } });
    expect((await stat(current)).mtimeMs).toBe(NOW);
    await utimes(current, new Date(NOW - 500 * DAY), new Date(NOW - 500 * DAY));
    const alias = join(f.root, "alias.jsonl");
    await symlink(current, alias);
    await rm(await stateFile(f.agentDir));
    await cleanup({ ...f.context, sessionManager: { getSessionFile: () => alias } });
    expect(await exists(current)).toBe(true);
  });

  it("does no maintenance or timestamp mutation when disabled", async () => {
    const f = await fixture();
    const old = await session(f.workspace, "old", 500);
    await createSessionMaintenance({ agentDir: f.agentDir, retentionDays: 0 })({
      ...f.context,
      sessionManager: { getSessionFile: () => old },
    });
    expect((await stat(old)).mtimeMs).toBe(NOW - 500 * DAY);
    expect(await exists(join(f.agentDir, "pi-sandbox"))).toBe(false);
  });

  it("records an attempt before traversal and skips further sweeps for 24 hours", async () => {
    const f = await fixture();
    const cleanup = createSessionMaintenance({ agentDir: f.agentDir, retentionDays: 365 });
    await cleanup(f.context);
    const file = await stateFile(f.agentDir);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      retentionDays: 365,
      lastAttemptAt: NOW,
    });
    const old = await session(f.workspace, "added-later", 500);
    const open = vi.spyOn(fs, "opendir");
    await cleanup(f.context);
    expect(open).not.toHaveBeenCalled();
    expect(await exists(old)).toBe(true);
    vi.setSystemTime(NOW + DAY);
    await cleanup(f.context);
    expect(await exists(old)).toBe(false);
  });

  it("handles corrupt state, policy changes, and clocks moving backwards", async () => {
    const f = await fixture();
    const cleanup = createSessionMaintenance({ agentDir: f.agentDir, retentionDays: 365 });
    await cleanup(f.context);
    const state = await stateFile(f.agentDir);
    await writeFile(state, "broken");
    const old = await session(f.workspace, "old", 500);
    await cleanup(f.context);
    expect(await exists(old)).toBe(false);
    const changedPolicy = await session(f.workspace, "shorter", 100);
    await createSessionMaintenance({ agentDir: f.agentDir, retentionDays: 90 })(f.context);
    expect(await exists(changedPolicy)).toBe(false);
    await writeFile(
      state,
      JSON.stringify({ version: 1, retentionDays: 365, lastAttemptAt: NOW + DAY }),
    );
    const rolledBack = await session(f.workspace, "clock", 500);
    await cleanup(f.context);
    expect(await exists(rolledBack)).toBe(false);
  });

  it("scans an explicitly selected flat directory with a separate daily record", async () => {
    const f = await fixture();
    const custom = join(f.root, "custom");
    const old = await session(custom, "old", 500);
    const nested = await session(join(custom, "nested"), "untouched", 500);
    const other = await session(f.workspace, "default", 500);
    const cleanup = createSessionMaintenance({ agentDir: f.agentDir, retentionDays: 365 });
    await cleanup({ ...f.context, sessionDir: custom });
    expect(await exists(old)).toBe(false);
    expect(await exists(nested)).toBe(true);
    expect(await exists(other)).toBe(true);
    await cleanup(f.context);
    expect(await exists(other)).toBe(false);
    expect(
      (await readdir(join(f.agentDir, "pi-sandbox", "retention"))).filter((x) =>
        x.endsWith(".json"),
      ),
    ).toHaveLength(2);
  });

  it("leaves symlinked workspaces, symlinked files, and unrelated or oversized JSONL headers alone", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    const outsideFile = await session(outside, "outside", 500);
    await symlink(outside, join(f.sessions, "--linked--"));
    await symlink(outsideFile, join(f.workspace, "linked.jsonl"));
    const contents = ["{bad json}\n", '{"type":"other"}\n', "{}", " ".repeat(5000) + "{}\n"];
    const preserved: string[] = [];
    for (const [i, content] of contents.entries()) {
      const file = join(f.workspace, `unrelated-${i}.jsonl`);
      await writeFile(file, content);
      await utimes(file, new Date(NOW - 500 * DAY), new Date(NOW - 500 * DAY));
      preserved.push(file);
    }
    const old = await session(f.workspace, "real", 500);
    await createSessionMaintenance({ agentDir: f.agentDir, retentionDays: 365 })(f.context);
    expect(await exists(old)).toBe(false);
    for (const file of [outsideFile, ...preserved]) expect(await exists(file)).toBe(true);
  });

  it("silently skips missing storage and symlinked roots", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    const old = await session(outside, "old", 500);
    const alias = join(f.root, "alias");
    await symlink(outside, alias);
    const cleanup = createSessionMaintenance({ agentDir: f.agentDir, retentionDays: 365 });
    await cleanup({ ...f.context, sessionDir: join(f.root, "missing") });
    await cleanup({ ...f.context, sessionDir: alias });
    expect(await exists(old)).toBe(true);
  });

  it("tolerates overlapping sweeps and does not fail startup when state cannot be stored", async () => {
    const f = await fixture();
    const old = await session(f.workspace, "old", 500);
    const cleanup = createSessionMaintenance({ agentDir: f.agentDir, retentionDays: 365 });
    await Promise.all(Array.from({ length: 4 }, () => cleanup(f.context)));
    expect(await exists(old)).toBe(false);
    await rm(join(f.agentDir, "pi-sandbox"), { recursive: true });
    await writeFile(join(f.agentDir, "pi-sandbox"), "not a directory");
    const kept = await session(f.workspace, "kept", 500);
    await expect(cleanup(f.context)).resolves.toBeUndefined();
    expect(await exists(kept)).toBe(true);
  });

  it.each(["interactive", "print", "json", "rpc"] as const)(
    "reports a slow sweep only for interactive mode (%s)",
    async (mode) => {
      const f = await fixture();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(NOW);
      let release!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const original = fs.opendir;
      vi.spyOn(fs, "opendir").mockImplementationOnce(async (...args) => {
        entered();
        await paused;
        return original(...args);
      });
      const report = vi.fn();
      const promise = createSessionMaintenance({
        agentDir: f.agentDir,
        retentionDays: 365,
        reportProgress: report,
      })({ ...f.context, mode });
      await started;
      expect(JSON.parse(await readFile(await stateFile(f.agentDir), "utf8"))).toMatchObject({
        lastAttemptAt: NOW,
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(report).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(report).toHaveBeenCalledTimes(mode === "interactive" ? 1 : 0);
      release();
      await promise;
      await vi.advanceTimersByTimeAsync(5000);
      expect(report).toHaveBeenCalledTimes(mode === "interactive" ? 1 : 0);
    },
  );
});

describe("last-use timestamps", () => {
  it("refreshes a resumed session without changing contents, and never creates a missing session", async () => {
    const f = await fixture();
    const file = await session(f.workspace, "resumed", 500);
    const before = await readFile(file, "utf8");
    await touchSessionFile(file);
    expect((await stat(file)).mtimeMs).toBe(NOW);
    expect(await readFile(file, "utf8")).toBe(before);
    const missing = join(f.workspace, "missing.jsonl");
    await touchSessionFile(missing);
    await touchSessionFile(undefined);
    expect(await exists(missing)).toBe(false);
  });
});
