import { lstat, opendir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SubagentStore } from "../../packages/subagents-extension/src/storage.js";
import { readBoundedFile } from "../../packages/subagents-extension/src/bounds.js";

const DAY_MS = 86_400_000;
const MAXIMUM_ROOTS = 4096;
const MAXIMUM_CHILDREN = 1024;
const ID = /^[a-zA-Z0-9_-]{1,128}$/u;

/** Keep the first page by name in bounded memory, regardless of filesystem entry order. */
function retainNext(page: string[], name: string): void {
  if (page.length === MAXIMUM_ROOTS && name >= page[0]!) return;
  if (page.length < MAXIMUM_ROOTS) {
    page.push(name);
    let child = page.length - 1;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (page[parent]! >= page[child]!) break;
      [page[parent], page[child]] = [page[child]!, page[parent]!];
      child = parent;
    }
    return;
  }
  page[0] = name;
  let parent = 0;
  while (parent * 2 + 1 < page.length) {
    let child = parent * 2 + 1;
    if (child + 1 < page.length && page[child + 1]! > page[child]!) child++;
    if (page[parent]! >= page[child]!) break;
    [page[parent], page[child]] = [page[child]!, page[parent]!];
    parent = child;
  }
}

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
    let cursor = "";
    try {
      const info = await lstat(schedule);
      if (!info.isFile() || info.size > 1024) return;
      const prior = JSON.parse(readBoundedFile(schedule, 1024)) as {
        version?: unknown;
        days?: unknown;
        at?: unknown;
        cursor?: unknown;
      };
      if (
        prior.version === 2 &&
        prior.days === options.retentionDays &&
        typeof prior.at === "number" &&
        Number.isFinite(prior.at) &&
        typeof prior.cursor === "string" &&
        (prior.cursor === "" || ID.test(prior.cursor))
      ) {
        if (now >= prior.at && now - prior.at < DAY_MS) return;
        cursor = prior.cursor;
      }
    } catch {
      /* Missing or invalid scheduling records permit another attempt. */
    }
    // Listing is a streamed shallow scan. State reads and cleanup are bounded to
    // one page, and the persisted cursor eventually visits roots beyond that page.
    const entries = await opendir(root);
    const first: string[] = [];
    const next: string[] = [];
    let afterCursor = 0;
    let total = 0;
    for await (const entry of entries) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      total++;
      retainNext(first, entry.name);
      if (entry.name > cursor) {
        afterCursor++;
        retainNext(next, entry.name);
      }
    }
    const page = (next.length ? next : first).sort();
    // When the final page is reached, the next due pass begins at the first name.
    const remaining = next.length ? afterCursor : total;
    const nextCursor = remaining > MAXIMUM_ROOTS ? page.at(-1)! : "";
    await writeFile(
      schedule,
      JSON.stringify({ version: 2, days: options.retentionDays, at: now, cursor: nextCursor }),
      { mode: 0o600 },
    );
    for (const name of page) {
      if (name === options.parentSessionId) continue;
      await expireRoot(root, name, now - options.retentionDays * DAY_MS);
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
