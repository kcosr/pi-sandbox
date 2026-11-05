import { chmod, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExportFileService } from "./files.js";
import { EXPORT_LIMITS, type SandboxExportEntry } from "./contracts.js";

describe.skipIf(process.platform !== "linux")("private export descriptor traversal", () => {
  let fixture: string;
  let home: string;
  let service: ExportFileService;
  beforeEach(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), "pi-export-files-"));
    home = path.join(fixture, "home");
    await mkdir(home);
    await mkdir(path.join(fixture, "outside"));
    await writeFile(path.join(fixture, "outside", "secret"), "outside");
    service = await ExportFileService.create("linux", [{ id: "home", path: home }]);
    service.begin();
  });
  afterEach(async () => {
    await service?.close();
    await rm(fixture, { recursive: true, force: true });
  });

  async function entry(name: string): Promise<SandboxExportEntry> {
    const item = (await service.list("home", "")).entries.find(
      (candidate) => candidate.name === name,
    );
    expect(item).toBeDefined();
    return item!;
  }

  it("copies binary files in bounded pulls and includes dotfiles without hidden filtering", async () => {
    const content = Buffer.alloc(EXPORT_LIMITS.chunkBytes + 23, 0x93);
    await writeFile(path.join(home, ".report"), content);
    const selected = await entry(".report");
    await service.openFile(selected);
    const first = await service.readChunk();
    const second = await service.readChunk();
    expect(first.byteLength).toBe(EXPORT_LIMITS.chunkBytes);
    expect(second.byteLength).toBe(23);
    expect(await service.readChunk()).toEqual(Buffer.alloc(0));
    expect(Buffer.concat([first, second])).toEqual(content);
    await service.closeFile();
  });

  it("uses the startup root handle when its pathname is replaced by an external symlink", async () => {
    await writeFile(path.join(home, "ours"), "private");
    await rename(home, path.join(fixture, "original-home"));
    await symlink(path.join(fixture, "outside"), home);
    expect((await service.list("home", "")).entries.map((candidate) => candidate.name)).toEqual([
      "ours",
    ]);
    await service.openFile(await entry("ours"));
    expect((await service.readChunk()).toString()).toBe("private");
  });

  it("rejects symlinks as entries and as intermediate components", async () => {
    await symlink(path.join(fixture, "outside"), path.join(home, "redirect"));
    expect(await entry("redirect")).toMatchObject({
      kind: "unsupported",
      problem: "export_symlink",
    });
    await expect(service.list("home", "redirect")).rejects.toBeDefined();
    await expect(service.list("home", "../outside")).rejects.toThrow("export_invalid_path");
  });

  it("does not read a replacement file or a selected file changed during transfer", async () => {
    await writeFile(path.join(home, "report"), Buffer.alloc(EXPORT_LIMITS.chunkBytes + 2));
    const selected = await entry("report");
    await rename(path.join(home, "report"), path.join(home, "old"));
    await writeFile(path.join(home, "report"), "replacement");
    await expect(service.openFile(selected)).rejects.toThrow("export_source_changed");
    await service.openFile(await entry("old"));
    await service.readChunk();
    await writeFile(path.join(home, "old"), "changed");
    await expect(service.readChunk()).rejects.toThrow("export_source_changed");
  });

  it("reports names which cannot round-trip through UTF-8 rather than exporting a replacement spelling", async () => {
    await writeFile(Buffer.concat([Buffer.from(`${home}/`), Buffer.from([0xff])]), "invalid name");
    const entries = (await service.list("home", "")).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "unsupported", problem: "export_invalid_utf8_name" });
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports unreadable regular files during inventory before payload transfer",
    async () => {
      const target = path.join(home, "unreadable");
      await writeFile(target, "private");
      await chmod(target, 0);
      expect(await entry("unreadable")).toMatchObject({
        kind: "unsupported",
        problem: "export_entry_unavailable",
      });
    },
  );

  it("pages bounded directory inventories and rejects a cursor from another directory", async () => {
    for (let n = 0; n < EXPORT_LIMITS.maximumPageEntries + 1; n++)
      await writeFile(path.join(home, `file-${n}`), "");
    const first = await service.list("home", "");
    expect(first.entries).toHaveLength(EXPORT_LIMITS.maximumPageEntries);
    expect((await service.list("home", "", first.nextCursor)).entries).toHaveLength(1);
    await expect(service.list("home", "elsewhere", first.nextCursor)).rejects.toThrow(
      "export_invalid_cursor",
    );
  });

  it("excludes host CWD overlays and supports cancellation without losing the registered roots", async () => {
    await service.close();
    await mkdir(path.join(home, "host-cwd"));
    await writeFile(path.join(home, "host-cwd", "input"), "host");
    service = await ExportFileService.create("linux", [
      { id: "tmp", path: home, excludedPaths: ["host-cwd"] },
    ]);
    service.begin();
    expect((await service.list("tmp", "")).entries).toEqual([]);
    await expect(service.list("tmp", "host-cwd")).rejects.toThrow("export_host_overlay_excluded");
    service.cancel();
    await expect(service.list("tmp", "")).rejects.toThrow("export_aborted");
    await service.end();
    service.begin();
    expect((await service.list("tmp", "")).entries).toEqual([]);
  });
});
