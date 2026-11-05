import { describe, expect, it, vi } from "vitest";
import { entry, readerFixture } from "./fixtures.test-support.js";
import {
  hasExportFiles,
  inventoryExport,
  listExportDirectory,
  validateRelativeExportPath,
} from "./manifest.js";
import { EXPORT_LIMITS } from "./limits.js";

describe("sandbox save manifest", () => {
  it("checks later inventory pages and stops before scanning remaining directories or roots", async () => {
    const { reader } = readerFixture([]);
    const list = vi
      .spyOn(reader, "list")
      .mockResolvedValueOnce({
        entries: [entry("empty", { kind: "directory" })],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({ entries: [entry(".file")] });
    expect(await hasExportFiles(reader)).toBe(true);
    expect(list.mock.calls).toEqual([
      ["home", "", undefined],
      ["home", "", "next"],
    ]);
  });

  it("includes hidden descendants and preserves root-relative paths independent of navigation", async () => {
    const directory = entry("project", { kind: "directory" });
    const entries = [directory, entry("project/report.txt"), entry("project/.secret")];
    const { reader } = readerFixture(entries);
    const manifest = await inventoryExport(reader, [directory, entries[1]!]);
    expect(manifest.selections).toEqual([directory]);
    expect(manifest.entries.map((value) => value.outputPath)).toEqual([
      "project",
      "project/.secret",
      "project/report.txt",
    ]);
    expect(manifest.fileCount).toBe(2);
    expect(manifest.totalBytes).toBe(6);
    expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses explicit namespaces for mixed roots", async () => {
    const selections = [entry("same"), entry("same", { rootId: "tmp" })];
    const { reader } = readerFixture(selections);
    const manifest = await inventoryExport(reader, selections);
    expect(manifest.entries.map((value) => value.outputPath)).toEqual(["home/same", "tmp/same"]);
  });

  it.each([
    "",
    "/absolute",
    "../escape",
    "a/../escape",
    "a//b",
    "a/./b",
    "a\0b",
    "a/",
    "a".repeat(256),
    "\ud800",
  ])("rejects unrepresentable or unsafe path %j", (path) => {
    expect(() => validateRelativeExportPath(path)).toThrow();
  });

  it("fails on unsupported descendants instead of silently omitting them", async () => {
    const directory = entry("project", { kind: "directory" });
    const { reader } = readerFixture([directory, entry("project/link", { kind: "unsupported" })]);
    await expect(inventoryExport(reader, [directory])).rejects.toThrow("unsupported");
  });

  it("rejects injected descendants and repeated pagination cursors", async () => {
    const { reader } = readerFixture([]);
    reader.list = vi.fn().mockResolvedValue({ entries: [entry("elsewhere/file")] });
    await expect(listExportDirectory(reader, "home", "")).rejects.toThrow("directory entry");
    reader.list = vi.fn().mockResolvedValue({ entries: [], nextCursor: "again" });
    await expect(listExportDirectory(reader, "home", "")).rejects.toThrow("pagination");
    reader.list = vi
      .fn()
      .mockResolvedValueOnce({ entries: [entry("a")], nextCursor: "again" })
      .mockResolvedValueOnce({ entries: [entry("b")], nextCursor: "again" });
    await expect(listExportDirectory(reader, "home", "")).rejects.toThrow("Repeated");
  });

  it("rejects duplicate entries, excessive aggregate bytes and depth", async () => {
    const { reader } = readerFixture([]);
    reader.list = vi.fn().mockResolvedValue({ entries: [entry("a"), entry("a")] });
    await expect(listExportDirectory(reader, "home", "")).rejects.toThrow("duplicated");
    await expect(
      inventoryExport(reader, [entry("large", { size: EXPORT_LIMITS.bytes + 1 })]),
    ).rejects.toThrow("4 GiB");
    expect(() =>
      validateRelativeExportPath(Array.from({ length: 65 }, () => "a").join("/")),
    ).toThrow();
  });

  it("stops a scan on cancellation", async () => {
    const { reader } = readerFixture([]);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(inventoryExport(reader, [entry("a")], controller.signal)).rejects.toThrow(
      "cancelled",
    );
  });
});
