import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const DAY_MS = 86_400_000;
const HEADER_BYTES = 4096;
const SWEEP_CONCURRENCY = 16;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface SessionMaintenanceContext {
  readonly mode: "interactive" | "print" | "json" | "rpc";
  readonly sessionManager: { getSessionFile(): string | undefined };
  /** Undefined selects Pi's default, workspace-grouped session tree. */
  readonly sessionDir: string | undefined;
}

interface RetentionOptions {
  readonly agentDir: string;
  readonly retentionDays: number;
  readonly reportProgress?: () => void;
}

/** Best-effort last-use tracking; never creates a transcript or opens a final symlink. */
export async function touchSessionFile(file: string | undefined): Promise<void> {
  if (file === undefined) return;
  try {
    const handle = await open(file, READ_FLAGS);
    try {
      const stats = await handle.stat();
      if (stats.isFile()) await handle.utimes(stats.atime, new Date());
    } finally {
      await handle.close();
    }
  } catch {
    // Missing, read-only, and concurrently removed sessions do not block startup.
  }
}

/** Awaited by Pi before starting its UI or processing a noninteractive prompt. */
export function createSessionMaintenance(options: RetentionOptions) {
  return async (context: SessionMaintenanceContext): Promise<void> => {
    if (options.retentionDays === 0) return;
    const selected = context.sessionManager.getSessionFile();
    await touchSessionFile(selected);
    let progressTimer: NodeJS.Timeout | undefined;
    try {
      const agentDir = await realpath(options.agentDir);
      const grouped = context.sessionDir === undefined;
      const root = resolve(context.sessionDir ?? join(agentDir, "sessions"));
      // Follow the explicitly selected agent directory, but no symlinks within
      // the session tree (including a redirected sessions root).
      if (!(await canonicalDirectory(root))) return;
      const now = Date.now();
      if (!(await recordAttempt(agentDir, root, grouped, options.retentionDays, now))) return;
      if (context.mode === "interactive" && options.reportProgress !== undefined) {
        progressTimer = setTimeout(() => {
          try {
            options.reportProgress?.();
          } catch {
            // Closed stderr must not turn optional maintenance into a failure.
          }
        }, 1000);
      }
      const protectedFile =
        selected === undefined
          ? undefined
          : await realpath(selected).catch(() => resolve(selected));
      const cutoff = now - options.retentionDays * DAY_MS;
      if (grouped) {
        const directories = await opendir(root);
        for await (const entry of directories) {
          if (!entry.isDirectory()) continue;
          const directory = join(root, entry.name);
          if (await canonicalDirectory(directory)) {
            await sweepDirectory(directory, cutoff, protectedFile);
          }
        }
      } else {
        await sweepDirectory(root, cutoff, protectedFile);
      }
    } catch {
      // A failed attempt is retried on a later day, without user-facing errors.
    } finally {
      if (progressTimer !== undefined) clearTimeout(progressTimer);
    }
  };
}

async function canonicalDirectory(directory: string): Promise<boolean> {
  try {
    return (await lstat(directory)).isDirectory() && (await realpath(directory)) === directory;
  } catch {
    return false;
  }
}

/** One small scheduling record per storage root; duplicate concurrent sweeps are harmless. */
async function recordAttempt(
  agentDir: string,
  root: string,
  grouped: boolean,
  retentionDays: number,
  now: number,
): Promise<boolean> {
  const stateDirectory = join(agentDir, "pi-sandbox", "retention");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  if (!(await canonicalDirectory(stateDirectory))) return false;
  const key = createHash("sha256")
    .update(`${grouped ? "grouped" : "flat"}\0${root}`)
    .digest("hex");
  const file = join(stateDirectory, `${key}.json`);
  try {
    const handle = await open(file, READ_FLAGS);
    try {
      const buffer = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const record: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (
        typeof record === "object" &&
        record !== null &&
        "version" in record &&
        record.version === 1 &&
        "retentionDays" in record &&
        record.retentionDays === retentionDays &&
        "lastAttemptAt" in record &&
        typeof record.lastAttemptAt === "number" &&
        Number.isFinite(record.lastAttemptAt) &&
        now >= record.lastAttemptAt &&
        now - record.lastAttemptAt < DAY_MS
      ) {
        return false;
      }
    } finally {
      await handle.close();
    }
  } catch {
    // Missing or invalid scheduling records cause a fresh sweep.
  }
  const temporary = join(stateDirectory, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, retentionDays, lastAttemptAt: now }));
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    return true;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function sweepDirectory(
  directory: string,
  cutoff: number,
  protectedFile: string | undefined,
): Promise<void> {
  const batch: Promise<void>[] = [];
  try {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = join(directory, entry.name);
      if (file === protectedFile) continue;
      batch.push(deleteExpiredSession(file, cutoff));
      if (batch.length === SWEEP_CONCURRENCY) {
        await Promise.all(batch);
        batch.length = 0;
      }
    }
  } catch {
    // Continue with other workspace directories if this one cannot be scanned.
  } finally {
    await Promise.all(batch);
  }
}

async function deleteExpiredSession(file: string, cutoff: number): Promise<void> {
  try {
    const candidate = await lstat(file);
    if (!candidate.isFile() || candidate.mtimeMs >= cutoff) return;
    const handle = await open(file, READ_FLAGS);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.mtimeMs >= cutoff) return;
      // Read only a bounded header for expired candidates, never a transcript.
      // This also protects unrelated JSONL files in custom session directories.
      const buffer = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const newline = buffer.subarray(0, bytesRead).indexOf(10);
      if (newline < 0) return;
      const header: unknown = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      if (
        typeof header !== "object" ||
        header === null ||
        !("type" in header) ||
        header.type !== "session" ||
        !("id" in header) ||
        typeof header.id !== "string" ||
        header.id.length === 0 ||
        !("cwd" in header) ||
        typeof header.cwd !== "string" ||
        !("timestamp" in header) ||
        typeof header.timestamp !== "string" ||
        !Number.isFinite(Date.parse(header.timestamp))
      ) {
        return;
      }
      const current = await lstat(file);
      if (
        current.isFile() &&
        current.dev === opened.dev &&
        current.ino === opened.ino &&
        current.mtimeMs < cutoff
      ) {
        await unlink(file);
      }
    } finally {
      await handle.close();
    }
  } catch {
    // Races with another sweeper, invalid headers, and permissions are nonfatal.
  }
}
