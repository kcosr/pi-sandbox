import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportFileService } from "./files.js";
import { IMPORT_LIMITS } from "./contracts.js";
import type { ImportReply } from "./protocol.js";

function finished(reply: ImportReply): string {
  if (reply.operation !== "finish") throw new Error("unexpected reply");
  return reply.path;
}
function directory(reply: ImportReply) {
  if (reply.operation !== "reserveDirectory") throw new Error("unexpected reply");
  return reply.directory;
}

describe.skipIf(process.platform !== "linux")("anchored scratch imports", () => {
  let root: string;
  let home: string;
  let service: ImportFileService;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "pi-import-files-"));
    home = path.join(root, "home");
    await mkdir(home);
    service = await ImportFileService.create(home);
  });
  afterEach(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  it("retains unlinked binary data until close and leaves reserved checkout files intact", async () => {
    const sessionId = randomUUID();
    await service.request({ operation: "begin", sessionId });
    const bytes = Buffer.from([0, 255, 128, 10, 13, 0, 65]);
    await service.request({ operation: "write", sessionId, data: bytes.toString("base64") });
    expect(await readdir(home)).toEqual([]);
    const file = finished(await service.request({ operation: "finish", sessionId }));
    expect(await readFile(file)).toEqual(bytes);
    await expect(service.request({ operation: "write", sessionId, data: "eA==" })).rejects.toThrow(
      "import_finished",
    );
    const target = directory(
      await service.request({ operation: "reserveDirectory", sessionId, path: "repos/demo" }),
    );
    expect(target.displayPath).toBe(path.join(home, "repos/demo"));
    await writeFile(`${target.path}/keep`, "partial checkout");
    await service.request({ operation: "verifyDirectory", sessionId });
    await service.request({ operation: "close", sessionId });
    expect(await readFile(path.join(home, "repos/demo/keep"), "utf8")).toBe("partial checkout");
    await expect(readFile(file)).rejects.toThrow();
    await service.request({ operation: "close", sessionId });
  });

  it("rejects existing directories, files, symlinks and symlink ancestors without writing outside HOME", async () => {
    const sessionId = randomUUID();
    await service.request({ operation: "begin", sessionId });
    await mkdir(path.join(home, "directory"));
    await writeFile(path.join(home, "file"), "keep");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(home, "link"));
    for (const target of ["directory", "file", "link"])
      await expect(
        service.request({ operation: "reserveDirectory", sessionId, path: target }),
      ).rejects.toThrow("import_destination_exists");
    await expect(
      service.request({ operation: "reserveDirectory", sessionId, path: "link/child" }),
    ).rejects.toThrow("import_filesystem_error");
    await expect(
      service.request({ operation: "reserveDirectory", sessionId, path: "../escape" }),
    ).rejects.toThrow("import_invalid_path");
    expect(await readdir(outside)).toEqual([]);
  });

  it("detects replaced destination and HOME while retained descriptors stay anchored", async () => {
    const sessionId = randomUUID();
    await service.request({ operation: "begin", sessionId });
    const target = directory(
      await service.request({ operation: "reserveDirectory", sessionId, path: "repos/demo" }),
    );
    await rename(target.displayPath, `${target.displayPath}-old`);
    await mkdir(target.displayPath);
    await writeFile(`${target.path}/anchored`, "old inode");
    expect(await readdir(target.displayPath)).toEqual([]);
    await expect(service.request({ operation: "verifyDirectory", sessionId })).rejects.toThrow(
      "import_directory_changed",
    );
    await rename(home, `${home}-old`);
    await symlink(root, home);
    await expect(service.request({ operation: "verifyDirectory", sessionId })).rejects.toThrow(
      "import_directory_changed",
    );
  });

  it("keeps concurrent imports separate, rejects duplicate targets, and closes all files on shutdown", async () => {
    const ids = [randomUUID(), randomUUID()];
    await Promise.all(ids.map((sessionId) => service.request({ operation: "begin", sessionId })));
    await Promise.all(
      ids.map((sessionId, index) =>
        service.request({
          operation: "write",
          sessionId,
          data: Buffer.from(`file-${index}`).toString("base64"),
        }),
      ),
    );
    const files = await Promise.all(
      ids.map(async (sessionId) =>
        finished(await service.request({ operation: "finish", sessionId })),
      ),
    );
    expect(await Promise.all(files.map((file) => readFile(file, "utf8")))).toEqual([
      "file-0",
      "file-1",
    ]);
    await service.request({
      operation: "reserveDirectory",
      sessionId: ids[0]!,
      path: "repos/same",
    });
    await expect(
      service.request({ operation: "reserveDirectory", sessionId: ids[1]!, path: "repos/same" }),
    ).rejects.toThrow("import_destination_exists");
    const cancelled = AbortSignal.abort();
    await expect(
      service.request({ operation: "verifyDirectory", sessionId: ids[0]! }, cancelled),
    ).rejects.toThrow("import_aborted");
    expect(await readFile(files[1]!, "utf8")).toBe("file-1");
    await service.close();
    for (const file of files) await expect(readFile(file)).rejects.toThrow();
    await expect(service.request({ operation: "begin", sessionId: randomUUID() })).rejects.toThrow(
      "import_closed",
    );
  });

  it("bounds held sessions and chunks independently of ordinary execution", async () => {
    const ids = Array.from({ length: IMPORT_LIMITS.maximumSessions }, () => randomUUID());
    await Promise.all(ids.map((sessionId) => service.request({ operation: "begin", sessionId })));
    await expect(service.request({ operation: "begin", sessionId: randomUUID() })).rejects.toThrow(
      "import_capacity_exceeded",
    );
    await expect(
      service.request({
        operation: "write",
        sessionId: ids[0]!,
        data: Buffer.alloc(IMPORT_LIMITS.chunkBytes + 1).toString("base64"),
      }),
    ).rejects.toThrow("import_invalid_chunk");
    await service.request({ operation: "close", sessionId: ids[0]! });
    await service.request({ operation: "begin", sessionId: randomUUID() });
  });
});
