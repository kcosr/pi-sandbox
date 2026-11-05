import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SandboxExportReader } from "../../packages/sandbox-extension/src/runtime/export/contracts.js";
import type {
  ExportAudit,
  ExportFileIdentity,
  ExportFileOutcome,
  ExportResult,
} from "./contracts.js";
import { checkCancelled, exportError, EXPORT_LIMITS } from "./limits.js";
import { validateRelativeExportPath, type ExportManifest } from "./manifest.js";

export interface ExportConflict {
  readonly path: string;
  readonly prior: ExportFileIdentity;
}

export interface ExportDestination {
  readonly path: string;
  readonly conflicts: readonly ExportConflict[];
  readonly directories: ReadonlyMap<string, ExportFileIdentity>;
}

function identity(stat: BigIntStats): ExportFileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameIdentity(left: ExportFileIdentity, right: ExportFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch {
    /* Directory fsync is unavailable on some destination filesystems. */
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

function overlaps(left: string, right: string): boolean {
  const within = (parent: string, child: string): boolean => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  return within(left, right) || within(right, left);
}

async function directoryChain(
  path: string,
  directories: Map<string, ExportFileIdentity>,
  create: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const components = resolve(path).split(sep).filter(Boolean);
  let current: string = sep;
  let missing = false;
  for (const component of components) {
    checkCancelled(signal);
    current = join(current, component);
    let stat = missing ? undefined : await statIfPresent(current);
    if (!stat && create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      stat = await statIfPresent(current);
    }
    if (!stat) {
      if (directories.has(current)) throw new Error("Destination directory changed since review");
      missing = true;
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Destination traversal contains a symlink or non-directory");
    const previous = directories.get(current);
    if (previous && (previous.dev !== String(stat.dev) || previous.ino !== String(stat.ino)))
      throw new Error("Destination directory changed since review");
    directories.set(current, identity(stat));
  }
}

export async function inspectExportDestination(
  manifest: ExportManifest,
  destination: string,
  writableHostPaths: readonly string[],
  signal?: AbortSignal,
): Promise<ExportDestination> {
  if (!isAbsolute(destination) || destination.includes("\0"))
    throw new Error("Destination must be an absolute host path");
  const path = resolve(destination);
  if (writableHostPaths.some((grant) => overlaps(path, resolve(grant))))
    throw new Error("Destination overlaps writable sandbox storage");
  const directories = new Map<string, ExportFileIdentity>();
  const conflicts: ExportConflict[] = [];
  const mapped = new Set<string>();
  await directoryChain(path, directories, false, signal);
  for (const entry of manifest.entries) {
    checkCancelled(signal);
    validateRelativeExportPath(entry.outputPath);
    if (mapped.has(entry.outputPath)) throw new Error("Duplicate export destination mapping");
    mapped.add(entry.outputPath);
    const target = join(path, entry.outputPath);
    await directoryChain(dirname(target), directories, false, signal);
    const stat = await statIfPresent(target);
    if (entry.source.kind === "directory") {
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new Error(
          `Directory destination conflicts with another file type: ${entry.outputPath}`,
        );
      if (stat) directories.set(target, identity(stat));
    } else if (entry.source.kind === "file") {
      if (stat && (!stat.isFile() || stat.isSymbolicLink()))
        throw new Error(`File destination conflicts with another file type: ${entry.outputPath}`);
      if (stat) conflicts.push({ path: entry.outputPath, prior: identity(stat) });
    } else throw new Error("Unsupported export manifest entry");
  }
  if (conflicts.length > EXPORT_LIMITS.replacements)
    throw new Error("More than 1,000 replacements; select fewer files or another destination");
  return Object.freeze({ path, conflicts: Object.freeze(conflicts), directories });
}

/** Check name equivalence using the destination filesystem before writing any payload. */
async function verifyFilesystemMapping(
  manifest: ExportManifest,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const staging = join(destination, `.pi-sandbox-save-names-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const directories = new Set<string>();
    const ensure = async (path: string): Promise<void> => {
      if (path === staging || directories.has(path)) return;
      await ensure(dirname(path));
      // Never merge in this private probe tree: EEXIST exposes case/normalization collisions.
      await mkdir(path, { mode: 0o700 });
      directories.add(path);
    };
    for (const entry of manifest.entries) {
      checkCancelled(signal);
      const target = join(staging, entry.outputPath);
      await ensure(dirname(target));
      if (entry.source.kind === "directory") await ensure(target);
      else {
        const file = await open(target, "wx", 0o600);
        await file.close();
      }
    }
  } catch (error) {
    if (errorCode(error) === "EEXIST")
      throw new Error("Export names collide on the destination filesystem");
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function publishExport(options: {
  readonly reader: SandboxExportReader;
  readonly manifest: ExportManifest;
  readonly destination: ExportDestination;
  readonly replaceListed: boolean;
  readonly sessionId: string;
  readonly audit?: ExportAudit;
  readonly signal?: AbortSignal;
}): Promise<ExportResult> {
  const { reader, manifest, destination, signal } = options;
  const operationId = randomUUID();
  const base = { operationId, sessionId: options.sessionId, destination: destination.path };
  const outcomes: ExportFileOutcome[] = [];
  const replacements = new Map(destination.conflicts.map((entry) => [entry.path, entry.prior]));
  const directories = new Map(destination.directories);
  let failure: string | undefined;
  let cancelled = false;
  let intent = false;
  let activePath: string | undefined;
  let replacementIntent: { path: string; prior: ExportFileIdentity } | undefined;
  try {
    checkCancelled(signal);
    if (replacements.size > 0 && !options.replaceListed)
      throw new Error("Existing files were not approved for replacement");
    await options.audit?.({
      ...base,
      type: "export_intent",
      roots: manifest.roots,
      entryCount: manifest.entries.length,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      manifestDigest: manifest.digest,
    });
    intent = true;
    await directoryChain(destination.path, directories, true, signal);
    await verifyFilesystemMapping(manifest, destination.path, signal);
    for (const entry of manifest.entries) {
      checkCancelled(signal);
      const target = join(destination.path, entry.outputPath);
      await directoryChain(dirname(target), directories, true, signal);
      if (entry.source.kind === "directory") {
        await directoryChain(target, directories, true, signal);
        continue;
      }
      activePath = entry.outputPath;
      const temporary = join(dirname(target), `.pi-sandbox-save-${operationId}-${randomUUID()}`);
      let file: Awaited<ReturnType<typeof open>> | undefined;
      let sourceOpen = false;
      let committed = false;
      try {
        file = await open(temporary, "wx", 0o600);
        sourceOpen = true;
        await reader.openFile(entry.source);
        let received = 0;
        const hash = createHash("sha256");
        while (true) {
          checkCancelled(signal);
          const chunk = await reader.readChunk();
          if (!(chunk instanceof Uint8Array) || chunk.byteLength > EXPORT_LIMITS.chunkBytes)
            throw new Error("Invalid sandbox export chunk");
          if (chunk.byteLength === 0) break;
          received += chunk.byteLength;
          if (received > entry.source.size || received > EXPORT_LIMITS.bytes)
            throw new Error("Sandbox file exceeded its reviewed size");
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            checkCancelled(signal);
            const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
            if (bytesWritten === 0) throw new Error("Destination write made no progress");
            offset += bytesWritten;
          }
        }
        await reader.closeFile();
        sourceOpen = false;
        if (received !== entry.source.size)
          throw new Error("Sandbox file size changed since review");
        await file.sync();
        await file.close();
        file = undefined;
        checkCancelled(signal);
        await directoryChain(dirname(target), directories, false, signal);
        const prior = replacements.get(entry.outputPath);
        if (prior) {
          const current = await statIfPresent(target);
          if (!current?.isFile() || !sameIdentity(prior, identity(current)))
            throw new Error("Destination file changed since replacement review; review again");
          replacementIntent = { path: entry.outputPath, prior };
          await options.audit?.({ ...base, type: "export_replace_intent", ...replacementIntent });
          const revalidated = await statIfPresent(target);
          if (!revalidated?.isFile() || !sameIdentity(prior, identity(revalidated)))
            throw new Error(
              "Destination file changed during replacement confirmation; review again",
            );
          checkCancelled(signal);
          // Atomic pathname replacement; concurrent trusted host writers are not a CAS boundary.
          await rename(temporary, target);
        } else {
          try {
            await link(temporary, target);
          } catch (error) {
            if (errorCode(error) === "EEXIST")
              throw new Error("A new destination conflict requires review again");
            if (["EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error) ?? ""))
              throw new Error(
                "Destination does not support atomic no-replace publication; choose another directory",
                { cause: error },
              );
            throw error;
          }
        }
        committed = true;
        outcomes.push({
          path: entry.outputPath,
          status: "saved",
          bytes: received,
          sha256: hash.digest("hex"),
        });
        activePath = undefined;
        await syncDirectory(dirname(target));
        if (replacementIntent) {
          const event = replacementIntent;
          replacementIntent = undefined;
          await options.audit?.({
            ...base,
            type: "export_replace_complete",
            ...event,
            outcome: "saved",
          });
        }
      } finally {
        if (sourceOpen) await reader.closeFile().catch(() => undefined);
        await file?.close().catch(() => undefined);
        // A replacement rename consumed the temporary name; unlink only our uncommitted/new-link inode.
        if (!committed || !replacements.has(entry.outputPath))
          await unlink(temporary).catch(() => undefined);
      }
    }
  } catch (error) {
    cancelled = signal?.aborted === true;
    failure = cancelled ? "Save cancelled" : exportError(error);
    if (activePath) outcomes.push({ path: activePath, status: "failed", bytes: 0, error: failure });
    if (replacementIntent) {
      try {
        await options.audit?.({
          ...base,
          type: "export_replace_complete",
          ...replacementIntent,
          outcome: "failed",
          error: failure,
        });
      } catch {
        failure = exportError(`${failure}; replacement audit failed`);
      }
    }
  }
  const completed = new Set(outcomes.map((entry) => entry.path));
  for (const entry of manifest.entries) {
    if (entry.source.kind === "file" && !completed.has(entry.outputPath))
      outcomes.push({ path: entry.outputPath, status: "not_saved", bytes: 0 });
  }
  if (intent) {
    try {
      await options.audit?.({
        ...base,
        type: "export_complete",
        savedFiles: outcomes.filter((entry) => entry.status === "saved").length,
        savedBytes: outcomes.reduce((sum, entry) => sum + entry.bytes, 0),
        failedFiles: outcomes.filter((entry) => entry.status === "failed").length,
        notSavedFiles: outcomes.filter((entry) => entry.status === "not_saved").length,
        cancelled,
        ...(failure === undefined ? {} : { error: failure }),
      });
    } catch (error) {
      failure = exportError(`Save completion audit failed: ${exportError(error)}`);
    }
  }
  return {
    operationId,
    destination: destination.path,
    outcomes,
    cancelled,
    ...(failure === undefined ? {} : { error: failure }),
  };
}
