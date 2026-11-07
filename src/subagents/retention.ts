import { lstat, opendir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SubagentStore } from "../../packages/subagents-extension/src/storage.js";
import { readBoundedFile } from "../../packages/subagents-extension/src/bounds.js";

const DAY_MS = 86_400_000;
const MAXIMUM_ROOTS = 4096;
const MAXIMUM_CHILDREN = 1024;
const ID = /^[a-zA-Z0-9_-]{1,128}$/u;

/** Expire transcripts and previews, retaining the small, monotonic admission ledger. */
export async function cleanExpiredSubagents(options: {
  readonly userStateDir: string;
  readonly retentionDays: number;
  readonly parentSessionId: string;
  readonly now?: number;
}): Promise<void> {
  if (options.retentionDays === 0) return;
  try {
    const root = join(await realpath(options.userStateDir), "subagents");
    if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root) return;
    const now = options.now ?? Date.now();
    const schedule = join(root, "retention.json");
    try {
      const info = await lstat(schedule);
      if (!info.isFile() || info.size > 1024) return;
      const prior = JSON.parse(readBoundedFile(schedule, 1024)) as {
        version?: unknown;
        days?: unknown;
        at?: unknown;
      };
      if (
        prior.version === 1 &&
        prior.days === options.retentionDays &&
        typeof prior.at === "number" &&
        now >= prior.at &&
        now - prior.at < DAY_MS
      )
        return;
    } catch {
      /* Missing or invalid scheduling records permit another attempt. */
    }
    await writeFile(
      schedule,
      JSON.stringify({ version: 1, days: options.retentionDays, at: now }),
      { mode: 0o600 },
    );
    const entries = await opendir(root);
    let inspected = 0;
    for await (const entry of entries) {
      if (++inspected > MAXIMUM_ROOTS) break;
      if (!entry.isDirectory() || !ID.test(entry.name) || entry.name === options.parentSessionId)
        continue;
      await expireRoot(root, entry.name, now - options.retentionDays * DAY_MS);
    }
  } catch {
    /* Optional cleanup must not prevent startup. */
  }
}

async function expireRoot(root: string, id: string, cutoff: number): Promise<void> {
  let store: SubagentStore | undefined;
  try {
    const directory = join(root, id);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.mtimeMs >= cutoff || (await realpath(directory)) !== directory)
      return;
    // Never reclaim an owner during cleanup. Even a stale or malformed owner may be
    // under recovery in another process; normal controller startup handles that.
    try {
      await lstat(join(directory, "owner.json"));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    store = new SubagentStore(root, id);
    const state = await lstat(join(directory, "state.json"));
    if (!state.isFile() || state.mtimeMs >= cutoff) return;
    const children: string[] = [];
    const entries = await opendir(directory);
    let inspected = 0;
    for await (const child of entries) {
      if (++inspected > MAXIMUM_CHILDREN + 4) return;
      if (child.isDirectory() && ID.test(child.name)) children.push(join(directory, child.name));
    }
    const saved = store.read();
    store.write(saved.used, []);
    for (const child of children) await rm(child, { recursive: true, force: true });
  } catch {
    /* Races, invalid state, and permission errors leave the state in place. */
  } finally {
    try {
      store?.close();
    } catch {
      /* Best effort. */
    }
  }
}
