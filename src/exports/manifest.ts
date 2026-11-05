import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
  SandboxExportEntry,
  SandboxExportReader,
} from "../../packages/sandbox-extension/src/runtime/export/contracts.js";
import { isExportEntry } from "../../packages/sandbox-extension/src/runtime/export/protocol.js";
import { checkCancelled, EXPORT_LIMITS } from "./limits.js";

export interface ExportManifestEntry {
  readonly source: SandboxExportEntry;
  readonly outputPath: string;
}

export interface ExportManifest {
  readonly selections: readonly SandboxExportEntry[];
  readonly entries: readonly ExportManifestEntry[];
  readonly roots: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly digest: string;
}

export function validateRelativeExportPath(path: string): void {
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    parts.length > EXPORT_LIMITS.depth ||
    parts.some(
      (part) => part === "" || part === "." || part === ".." || Buffer.byteLength(part) > 255,
    ) ||
    Buffer.byteLength(path) > 4096 ||
    Buffer.from(path).toString("utf8") !== path
  )
    throw new Error("Invalid sandbox export path");
}

export function selectionKey(entry: Pick<SandboxExportEntry, "rootId" | "path">): string {
  return `${entry.rootId}\0${entry.path}`;
}

export function selectionCovers(parent: SandboxExportEntry, child: SandboxExportEntry): boolean {
  return (
    parent.rootId === child.rootId &&
    (parent.path === child.path ||
      (parent.kind === "directory" && child.path.startsWith(`${parent.path}/`)))
  );
}

export function normalizeSelections(entries: readonly SandboxExportEntry[]): SandboxExportEntry[] {
  const unique = new Map(entries.map((entry) => [selectionKey(entry), entry]));
  return [...unique.values()]
    .filter((entry) => {
      const parts = entry.path.split("/");
      for (let length = 1; length < parts.length; length += 1) {
        if (
          unique.get(`${entry.rootId}\0${parts.slice(0, length).join("/")}`)?.kind === "directory"
        )
          return false;
      }
      return true;
    })
    .sort((left, right) => (selectionKey(left) < selectionKey(right) ? -1 : 1));
}

export function validateExportEntry(entry: SandboxExportEntry, roots: ReadonlySet<string>): void {
  if (
    !isExportEntry(entry) ||
    !roots.has(entry.rootId) ||
    entry.name !== posix.basename(entry.path)
  ) {
    throw new Error("Invalid sandbox export inventory entry");
  }
  // Unsupported entries use display-only placeholders, which can expand beyond
  // filesystem path limits. The wire bounds still apply; these cannot be saved.
  if (entry.kind !== "unsupported") validateRelativeExportPath(entry.path);
  if (entry.kind === "file" && entry.identity.size !== String(entry.size))
    throw new Error("Inconsistent sandbox export file size");
}

export async function listExportDirectory(
  reader: SandboxExportReader,
  rootId: string,
  path: string,
  signal?: AbortSignal,
): Promise<SandboxExportEntry[]> {
  if (path !== "") validateRelativeExportPath(path);
  const roots = new Set<string>(reader.roots.map((root) => root.id));
  if (!roots.has(rootId)) throw new Error("Unknown sandbox export root");
  const entries: SandboxExportEntry[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let inventoryBytes = 0;
  do {
    checkCancelled(signal);
    const page = await reader.list(rootId as "home" | "tmp", path, cursor);
    for (const entry of page.entries) {
      validateExportEntry(entry, roots);
      if (
        entry.rootId !== rootId ||
        posix.dirname(entry.path) !== (path || ".") ||
        names.has(entry.name)
      )
        throw new Error("Invalid or duplicated sandbox directory entry");
      names.add(entry.name);
      inventoryBytes += Buffer.byteLength(JSON.stringify(entry));
      if (entries.length >= EXPORT_LIMITS.entries || inventoryBytes > EXPORT_LIMITS.inventoryBytes)
        throw new Error("Sandbox directory inventory limit exceeded");
      entries.push(Object.freeze({ ...entry, identity: Object.freeze({ ...entry.identity }) }));
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (
        page.entries.length === 0 ||
        typeof cursor !== "string" ||
        Buffer.byteLength(cursor) > 256
      )
        throw new Error("Invalid sandbox export pagination");
      if (cursors.has(cursor)) throw new Error("Repeated sandbox export cursor");
      inventoryBytes += Buffer.byteLength(cursor);
      if (inventoryBytes > EXPORT_LIMITS.inventoryBytes)
        throw new Error("Sandbox directory inventory limit exceeded");
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return entries.sort((left, right) => {
    const order = Number(right.kind === "directory") - Number(left.kind === "directory");
    return order || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  });
}

export async function inventoryExport(
  reader: SandboxExportReader,
  selected: readonly SandboxExportEntry[],
  signal?: AbortSignal,
): Promise<ExportManifest> {
  const selections = normalizeSelections(selected);
  if (selections.length === 0) throw new Error("Select at least one file or directory");
  const roots = [...new Set(selections.map((entry) => entry.rootId))].sort();
  const available = new Set<string>(reader.roots.map((root) => root.id));
  const entries: ExportManifestEntry[] = [];
  const seen = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;
  let inventoryBytes = 0;
  const visit = async (entry: SandboxExportEntry): Promise<void> => {
    checkCancelled(signal);
    validateExportEntry(entry, available);
    if (entry.kind === "unsupported")
      throw new Error(`Cannot save selected entry: ${entry.problem ?? "unsupported file type"}`);
    const key = selectionKey(entry);
    if (seen.has(key)) throw new Error("Duplicate sandbox export entry");
    seen.add(key);
    inventoryBytes += Buffer.byteLength(JSON.stringify(entry));
    if (entries.length >= EXPORT_LIMITS.entries || inventoryBytes > EXPORT_LIMITS.inventoryBytes)
      throw new Error("Sandbox export inventory limit exceeded");
    const outputPath = roots.length > 1 ? `${entry.rootId}/${entry.path}` : entry.path;
    validateRelativeExportPath(outputPath);
    entries.push(Object.freeze({ source: entry, outputPath }));
    if (entry.kind === "file") {
      fileCount += 1;
      totalBytes += entry.size;
      if (totalBytes > EXPORT_LIMITS.bytes)
        throw new Error("Sandbox export exceeds the 4 GiB transfer limit");
    } else {
      for (const child of await listExportDirectory(reader, entry.rootId, entry.path, signal))
        await visit(child);
    }
  };
  for (const entry of selections) await visit(entry);
  entries.sort((left, right) => (left.outputPath < right.outputPath ? -1 : 1));
  const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return Object.freeze({
    selections: Object.freeze(selections),
    entries: Object.freeze(entries),
    roots: Object.freeze(roots),
    fileCount,
    totalBytes,
    digest,
  });
}

/** Check metadata only; hidden files count, empty folders and unsupported entries do not. */
export async function hasExportFiles(
  reader: SandboxExportReader,
  signal?: AbortSignal,
): Promise<boolean> {
  let entryCount = 0;
  let inventoryBytes = 0;
  const visit = async (rootId: string, path: string): Promise<boolean> => {
    const entries = await listExportDirectory(reader, rootId, path, signal);
    checkCancelled(signal);
    entryCount += entries.length;
    for (const entry of entries) inventoryBytes += Buffer.byteLength(JSON.stringify(entry));
    if (entryCount > EXPORT_LIMITS.entries || inventoryBytes > EXPORT_LIMITS.inventoryBytes)
      throw new Error("Sandbox export inventory limit exceeded");
    if (entries.some((entry) => entry.kind === "file")) return true;
    for (const entry of entries) {
      if (entry.kind === "directory" && (await visit(rootId, entry.path))) return true;
    }
    return false;
  };
  for (const root of reader.roots) {
    if (await visit(root.id, "")) return true;
  }
  return false;
}
