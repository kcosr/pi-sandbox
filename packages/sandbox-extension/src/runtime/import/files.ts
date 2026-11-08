import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertImportPath, IMPORT_LIMITS, SandboxImportError } from "./contracts.js";
import type { ImportOperation, ImportReply } from "./protocol.js";

const OPEN_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
interface Directory {
  readonly relativePath: string;
  readonly handles: readonly FileHandle[];
  readonly identity: BigIntStats;
}
interface ImportSession {
  readonly file: FileHandle;
  transferred: number;
  finished: boolean;
  directory?: Directory;
}
function sameInode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SandboxImportError("import_aborted");
}
function descriptorPath(handle: FileHandle): string {
  return `/proc/${process.pid}/fd/${handle.fd}`;
}

/** Runs only inside the existing Linux worker. All filesystem walks stay anchored
 * to its startup HOME inode; imported data is unlinked while its FD is retained. */
export class ImportFileService {
  readonly #sessions = new Map<string, ImportSession>();
  readonly #busy = new Set<string>();
  #opening = 0;
  #closed = false;

  private constructor(
    private readonly rootPath: string,
    private readonly root: FileHandle,
    private readonly identity: BigIntStats,
  ) {}

  static async create(rootPath: string): Promise<ImportFileService> {
    const root = await open(rootPath, OPEN_DIRECTORY);
    try {
      const identity = await root.stat({ bigint: true });
      return new ImportFileService(rootPath, root, identity);
    } catch (error) {
      await root.close();
      throw error;
    }
  }

  async request(request: ImportOperation, signal?: AbortSignal): Promise<ImportReply> {
    if (this.#closed) throw new SandboxImportError("import_closed");
    aborted(signal);
    if (this.#busy.has(request.sessionId))
      throw new SandboxImportError("import_request_already_active");
    this.#busy.add(request.sessionId);
    try {
      if (request.operation === "begin") {
        await this.begin(request.sessionId, signal);
        return { operation: "begin" };
      }
      if (request.operation === "close") {
        await this.end(request.sessionId);
        return { operation: "close" };
      }
      const session = this.#sessions.get(request.sessionId);
      if (session === undefined) throw new SandboxImportError("import_session_unavailable");
      if (request.operation === "write") {
        if (session.finished) throw new SandboxImportError("import_finished");
        const data = Buffer.from(request.data, "base64");
        if (data.byteLength === 0 || data.byteLength > IMPORT_LIMITS.chunkBytes)
          throw new SandboxImportError("import_invalid_chunk");
        if (session.transferred + data.byteLength > IMPORT_LIMITS.maximumBytes)
          throw new SandboxImportError("import_size_limit");
        let offset = 0;
        while (offset < data.byteLength) {
          aborted(signal);
          const written = await session.file.write(
            data,
            offset,
            data.byteLength - offset,
            session.transferred,
          );
          if (written.bytesWritten === 0) throw new SandboxImportError("import_write_failed");
          offset += written.bytesWritten;
          session.transferred += written.bytesWritten;
        }
        aborted(signal);
        return { operation: "write" };
      }
      if (request.operation === "finish") {
        if (session.finished) throw new SandboxImportError("import_finished");
        session.finished = true;
        return { operation: "finish", path: descriptorPath(session.file) };
      }
      if (request.operation === "reserveDirectory") {
        if (session.directory !== undefined)
          throw new SandboxImportError("import_directory_already_reserved");
        session.directory = await this.reserve(request.path, signal);
        const directory = session.directory;
        return {
          operation: "reserveDirectory",
          directory: {
            path: descriptorPath(directory.handles[directory.handles.length - 1]!),
            displayPath: path.join(this.rootPath, directory.relativePath),
          },
        };
      }
      const directory = session.directory;
      if (directory === undefined) throw new SandboxImportError("import_directory_unavailable");
      await this.verify(directory, signal);
      return { operation: "verifyDirectory" };
    } catch (error) {
      if (error instanceof SandboxImportError) throw error;
      throw new SandboxImportError("import_filesystem_error");
    } finally {
      this.#busy.delete(request.sessionId);
    }
  }

  private async begin(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (this.#sessions.has(sessionId)) throw new SandboxImportError("import_session_exists");
    if (this.#sessions.size + this.#opening >= IMPORT_LIMITS.maximumSessions)
      throw new SandboxImportError("import_capacity_exceeded");
    this.#opening++;
    let file: FileHandle | undefined;
    const filename = `/proc/self/fd/${this.root.fd}/.pi-import-${randomUUID()}`;
    let linked = false;
    try {
      aborted(signal);
      file = await open(
        filename,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      linked = true;
      await unlink(filename);
      linked = false;
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.dev !== this.identity.dev)
        throw new SandboxImportError("import_filesystem_crossing");
      aborted(signal);
      this.#sessions.set(sessionId, { file, transferred: 0, finished: false });
      file = undefined;
    } finally {
      this.#opening--;
      if (linked) await unlink(filename).catch(() => undefined);
      await file?.close();
    }
  }

  private async rootVisible(): Promise<void> {
    const visible = await lstat(this.rootPath, { bigint: true });
    if (!visible.isDirectory() || !sameInode(visible, this.identity))
      throw new SandboxImportError("import_directory_changed");
  }

  private async reserve(relativePath: string, signal?: AbortSignal): Promise<Directory> {
    assertImportPath(relativePath);
    await this.rootVisible();
    const handles: FileHandle[] = [];
    let parent = this.root;
    try {
      const components = relativePath.split("/");
      for (const [index, component] of components.entries()) {
        aborted(signal);
        const child = `/proc/self/fd/${parent.fd}/${component}`;
        try {
          await mkdir(child, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (index === components.length - 1)
            throw new SandboxImportError("import_destination_exists");
        }
        const handle = await open(child, OPEN_DIRECTORY);
        handles.push(handle);
        const identity = await handle.stat({ bigint: true });
        if (!identity.isDirectory() || identity.dev !== this.identity.dev)
          throw new SandboxImportError("import_filesystem_crossing");
        parent = handle;
      }
      const directory = { relativePath, handles, identity: await parent.stat({ bigint: true }) };
      await this.verify(directory, signal);
      return directory;
    } catch (error) {
      await Promise.all(handles.map((handle) => handle.close()));
      throw error;
    }
  }

  private async verify(directory: Directory, signal?: AbortSignal): Promise<void> {
    await this.rootVisible();
    const handles: FileHandle[] = [];
    let parent = this.root;
    try {
      for (const component of directory.relativePath.split("/")) {
        aborted(signal);
        const handle = await open(`/proc/self/fd/${parent.fd}/${component}`, OPEN_DIRECTORY);
        handles.push(handle);
        const info = await handle.stat({ bigint: true });
        if (!info.isDirectory() || info.dev !== this.identity.dev)
          throw new SandboxImportError("import_directory_changed");
        parent = handle;
      }
      if (!sameInode(await parent.stat({ bigint: true }), directory.identity))
        throw new SandboxImportError("import_directory_changed");
      aborted(signal);
    } catch (error) {
      if (error instanceof SandboxImportError) throw error;
      throw new SandboxImportError("import_directory_changed");
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
    }
  }

  private async end(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    this.#sessions.delete(sessionId);
    await Promise.all([
      session.file.close(),
      ...(session.directory?.handles ?? []).map((handle) => handle.close()),
    ]);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await Promise.all([...this.#sessions.keys()].map((id) => this.end(id)));
    } finally {
      await this.root.close();
    }
  }
}
