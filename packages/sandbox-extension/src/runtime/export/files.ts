import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  assertExportPath,
  EXPORT_LIMITS,
  sameExportIdentity,
  SandboxExportError,
  type RegisteredExportRoot,
  type SandboxExportEntry,
  type SandboxExportIdentity,
  type SandboxExportPage,
  type SandboxExportRoot,
  type SandboxExportRootId,
} from "./contracts.js";

export function exportIdentity(info: BigIntStats): SandboxExportIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}

interface Root {
  readonly definition: RegisteredExportRoot;
  readonly handle: FileHandle;
  readonly identity: SandboxExportIdentity;
}

interface Directory {
  readonly path: string;
  readonly handles: readonly FileHandle[];
}

const OPEN_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const OPEN_FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Runs inside the existing confinement. Mac pathname checks detect observed links;
 * only Linux's anchored descriptor walk also rejects intermediate replacement races. */
export class ExportFileService {
  readonly #roots = new Map<SandboxExportRootId, Root>();
  #abort: AbortController | undefined;
  #listing:
    | {
        rootId: SandboxExportRootId;
        path: string;
        entries: SandboxExportEntry[];
        generation: number;
      }
    | undefined;
  #generation = 0;
  #file: { handle: FileHandle; identity: SandboxExportIdentity; offset: number } | undefined;
  #transferredBytes = 0;
  #closed = false;

  private constructor(private readonly backend: "linux" | "seatbelt") {}

  static async create(
    backend: "linux" | "seatbelt",
    definitions: readonly RegisteredExportRoot[],
  ): Promise<ExportFileService> {
    const service = new ExportFileService(backend);
    try {
      for (const definition of definitions) {
        if (
          service.#roots.has(definition.id) ||
          !["home", "tmp"].includes(definition.id) ||
          !path.isAbsolute(definition.path) ||
          path.normalize(definition.path) !== definition.path
        )
          throw new SandboxExportError("export_invalid_root");
        for (const excluded of definition.excludedPaths ?? []) assertExportPath(excluded, false);
        const handle = await open(definition.path, OPEN_DIRECTORY);
        try {
          const info = await handle.stat({ bigint: true });
          const identity = exportIdentity(info);
          if (
            !info.isDirectory() ||
            (definition.identity !== undefined &&
              (identity.dev !== definition.identity.dev ||
                identity.ino !== definition.identity.ino))
          )
            throw new SandboxExportError("export_root_changed");
          service.#roots.set(definition.id, { definition, handle, identity });
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      return service;
    } catch (error) {
      await service.close();
      throw error;
    }
  }

  begin(): readonly SandboxExportRoot[] {
    if (this.#closed || this.#abort !== undefined)
      throw new SandboxExportError("export_unavailable");
    this.#abort = new AbortController();
    this.#transferredBytes = 0;
    return [...this.#roots.keys()].map((id) => ({
      id,
      label: id === "home" ? "Home" : "Temporary files",
    }));
  }

  cancel(): void {
    this.#abort?.abort();
  }

  private check(): void {
    if (this.#closed || this.#abort === undefined) throw new SandboxExportError("export_closed");
    if (this.#abort.signal.aborted) throw new SandboxExportError("export_aborted");
  }

  private root(id: SandboxExportRootId, relative: string): Root {
    this.check();
    assertExportPath(relative);
    const root = this.#roots.get(id);
    if (root === undefined) throw new SandboxExportError("export_invalid_root");
    if (this.excluded(root, relative)) throw new SandboxExportError("export_host_overlay_excluded");
    return root;
  }

  private excluded(root: Root, relative: string): boolean {
    return (root.definition.excludedPaths ?? []).some(
      (excluded) => relative === excluded || relative.startsWith(`${excluded}/`),
    );
  }

  private childPath(directory: Directory, name: string): string {
    return this.backend === "linux"
      ? `/proc/self/fd/${directory.handles[directory.handles.length - 1]!.fd}/${name}`
      : path.join(directory.path, name);
  }

  private async directory(root: Root, relative: string): Promise<Directory> {
    const handles: FileHandle[] = [root.handle];
    let current = root.definition.path;
    try {
      if (this.backend === "seatbelt") {
        const info = await lstat(current, { bigint: true });
        if (
          !info.isDirectory() ||
          String(info.dev) !== root.identity.dev ||
          String(info.ino) !== root.identity.ino
        )
          throw new SandboxExportError("export_root_changed");
      }
      for (const component of relative ? relative.split("/") : []) {
        this.check();
        const target = this.childPath({ path: current, handles }, component);
        const handle = await open(target, OPEN_DIRECTORY);
        handles.push(handle);
        const info = await handle.stat({ bigint: true });
        if (!info.isDirectory() || String(info.dev) !== root.identity.dev)
          throw new SandboxExportError("export_filesystem_crossing");
        current = path.join(current, component);
      }
      return { path: current, handles };
    } catch (error) {
      await Promise.all(handles.slice(1).map((handle) => handle.close()));
      throw error;
    }
  }

  private async release(directory: Directory): Promise<void> {
    await Promise.all(directory.handles.slice(1).map((handle) => handle.close()));
  }

  async list(
    rootId: SandboxExportRootId,
    relative: string,
    cursor?: string,
  ): Promise<SandboxExportPage> {
    const root = this.root(rootId, relative);
    let offset = 0;
    if (cursor !== undefined) {
      const match = /^(\d+):(\d+)$/u.exec(cursor);
      if (
        !match ||
        this.#listing?.rootId !== rootId ||
        this.#listing.path !== relative ||
        Number(match[1]) !== this.#listing.generation ||
        !Number.isSafeInteger(Number(match[2])) ||
        Number(match[2]) >= this.#listing.entries.length
      )
        throw new SandboxExportError("export_invalid_cursor");
      offset = Number(match[2]);
    } else {
      const directory = await this.directory(root, relative);
      const entries: SandboxExportEntry[] = [];
      let bytes = 0;
      try {
        const directoryPath =
          this.backend === "linux"
            ? `/proc/self/fd/${directory.handles[directory.handles.length - 1]!.fd}`
            : directory.path;
        const stream = await opendir(directoryPath, {
          encoding: "buffer" as BufferEncoding,
          bufferSize: 32,
        });
        for await (const raw of stream) {
          this.check();
          if (entries.length >= EXPORT_LIMITS.maximumEntries)
            throw new SandboxExportError("export_entry_limit");
          // Bun 1.3's buffer-encoded Dir iterator yields the name bytes directly;
          // Node yields a Dirent whose name contains those bytes. This adapts the
          // two supported runtime primitives, not the authored/wire contract.
          const value: unknown = raw;
          const rawName: Buffer = ArrayBuffer.isView(value)
            ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
            : Buffer.isBuffer(raw.name)
              ? raw.name
              : Buffer.from(raw.name);
          const decoded = rawName.toString("utf8");
          const validName = Buffer.from(decoded).equals(rawName);
          const name = validName ? decoded : `[invalid UTF-8: ${rawName.toString("hex")} ]`;
          const childRelative = relative ? `${relative}/${name}` : name;
          if (this.excluded(root, childRelative)) continue;
          let entry: SandboxExportEntry;
          try {
            if (!validName) throw new SandboxExportError("export_invalid_utf8_name");
            assertExportPath(childRelative, false);
            const target = this.childPath(directory, name);
            const info = await lstat(target, { bigint: true });
            const identity = exportIdentity(info);
            const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : "unsupported";
            const problem = info.isSymbolicLink()
              ? "export_symlink"
              : kind === "unsupported"
                ? "export_special_file"
                : identity.dev !== root.identity.dev
                  ? "export_filesystem_crossing"
                  : undefined;
            if (kind === "file" && problem === undefined) {
              const readable = await open(target, OPEN_FILE);
              try {
                const opened = await readable.stat({ bigint: true });
                if (!opened.isFile() || !sameExportIdentity(exportIdentity(opened), identity))
                  throw new SandboxExportError("export_source_changed");
              } finally {
                await readable.close();
              }
            }
            entry = {
              rootId,
              path: childRelative,
              name,
              kind: problem === undefined ? kind : "unsupported",
              size:
                info.isFile() && info.size <= BigInt(Number.MAX_SAFE_INTEGER)
                  ? Number(info.size)
                  : 0,
              identity,
              ...(problem === undefined ? {} : { problem }),
            };
          } catch (error) {
            entry = {
              rootId,
              path: childRelative,
              name,
              kind: "unsupported",
              size: 0,
              identity: { dev: "0", ino: "0", size: "0", mtimeNs: "0", ctimeNs: "0" },
              problem:
                error instanceof SandboxExportError ? error.code : "export_entry_unavailable",
            };
          }
          bytes += Buffer.byteLength(JSON.stringify(entry));
          if (bytes > EXPORT_LIMITS.maximumInventoryBytes)
            throw new SandboxExportError("export_inventory_limit");
          entries.push(entry);
        }
      } finally {
        await this.release(directory);
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      this.#listing = { rootId, path: relative, entries, generation: ++this.#generation };
    }
    const listing = this.#listing;
    const entries: SandboxExportEntry[] = [];
    let bytes = 0;
    while (offset < listing.entries.length && entries.length < EXPORT_LIMITS.maximumPageEntries) {
      const entry = listing.entries[offset]!;
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + size > EXPORT_LIMITS.maximumPageBytes) break;
      entries.push(entry);
      bytes += size;
      offset++;
    }
    return {
      entries,
      ...(offset < listing.entries.length ? { nextCursor: `${listing.generation}:${offset}` } : {}),
    };
  }

  async openFile(entry: SandboxExportEntry): Promise<void> {
    if (this.#file !== undefined) throw new SandboxExportError("export_file_already_open");
    const root = this.root(entry.rootId, entry.path);
    assertExportPath(entry.path, false);
    if (entry.kind !== "file" || entry.problem !== undefined)
      throw new SandboxExportError("export_not_regular_file");
    const components = entry.path.split("/");
    const name = components.pop()!;
    const directory = await this.directory(root, components.join("/"));
    try {
      const handle = await open(this.childPath(directory, name), OPEN_FILE);
      try {
        const info = await handle.stat({ bigint: true });
        const identity = exportIdentity(info);
        if (
          !info.isFile() ||
          identity.dev !== root.identity.dev ||
          !sameExportIdentity(identity, entry.identity) ||
          String(entry.size) !== identity.size
        )
          throw new SandboxExportError("export_source_changed");
        this.#file = { handle, identity, offset: 0 };
      } catch (error) {
        await handle.close();
        throw error;
      }
    } finally {
      await this.release(directory);
    }
  }

  async readChunk(): Promise<Buffer> {
    this.check();
    const file = this.#file;
    if (file === undefined) throw new SandboxExportError("export_no_file_open");
    const validate = async () => {
      if (
        !sameExportIdentity(exportIdentity(await file.handle.stat({ bigint: true })), file.identity)
      )
        throw new SandboxExportError("export_source_changed");
    };
    await validate();
    const remaining = Number(file.identity.size) - file.offset;
    if (remaining === 0) return Buffer.alloc(0);
    const length = Math.min(EXPORT_LIMITS.chunkBytes, remaining);
    if (this.#transferredBytes + length > EXPORT_LIMITS.maximumBytes)
      throw new SandboxExportError("export_byte_limit");
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.handle.read(buffer, 0, length, file.offset);
    this.check();
    await validate();
    if (bytesRead === 0) throw new SandboxExportError("export_source_changed");
    file.offset += bytesRead;
    this.#transferredBytes += bytesRead;
    return buffer.subarray(0, bytesRead);
  }

  async closeFile(): Promise<void> {
    const file = this.#file;
    this.#file = undefined;
    await file?.handle.close();
  }

  async end(): Promise<void> {
    this.cancel();
    await this.closeFile();
    this.#listing = undefined;
    this.#abort = undefined;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.end();
    await Promise.all([...this.#roots.values()].map(({ handle }) => handle.close()));
    this.#roots.clear();
  }
}
