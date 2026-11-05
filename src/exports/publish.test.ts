import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserExportAuditEvent } from "./contracts.js";
import { entry, readerFixture } from "./fixtures.test-support.js";
import { inventoryExport } from "./manifest.js";
import { inspectExportDestination, publishExport } from "./publish.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof filesystem>();
  return { ...actual, link: vi.fn(actual.link) };
});

describe("sandbox export host publication", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "pi-user-export-")));
  });
  afterEach(async () => {
    vi.mocked(filesystem.link).mockReset();
    const actual = await vi.importActual<typeof filesystem>("node:fs/promises");
    vi.mocked(filesystem.link).mockImplementation(actual.link);
    await rm(directory, { recursive: true, force: true });
  });

  async function fixture(names = ["file"]) {
    const selected = names.map((name) => entry(name));
    const { reader } = readerFixture(selected);
    const manifest = await inventoryExport(reader, selected);
    const destination = await inspectExportDestination(manifest, join(directory, "output"), []);
    return { reader, manifest, destination, replaceListed: false, sessionId: "session" };
  }

  it("publishes fresh independent files with a bounded pull, digest and audit before writes", async () => {
    const options = await fixture();
    const events: UserExportAuditEvent[] = [];
    const result = await publishExport({
      ...options,
      audit: async (event) => {
        if (event.type === "export_intent") await expect(readdir(directory)).resolves.toEqual([]);
        events.push(event);
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.outcomes).toMatchObject([{ path: "file", status: "saved", bytes: 3 }]);
    expect(result.outcomes[0]!.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readFile(join(directory, "output/file"), "utf8")).toBe("abc");
    expect(await readdir(join(directory, "output"))).toEqual(["file"]);
    expect(events.map((value) => value.type)).toEqual(["export_intent", "export_complete"]);
  });

  it("does not write any host payload when required intent auditing fails", async () => {
    const options = await fixture();
    const result = await publishExport({
      ...options,
      audit: () => Promise.reject(new Error("audit unavailable")),
    });
    expect(result.error).toContain("audit unavailable");
    expect(result.outcomes).toMatchObject([{ status: "not_saved" }]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("merges directories and replaces a confirmed pathname without changing a hardlink alias", async () => {
    const selected = [entry("folder", { kind: "directory" }), entry("folder/file")];
    const { reader } = readerFixture(selected);
    const manifest = await inventoryExport(reader, [selected[0]!]);
    const output = join(directory, "output");
    await mkdir(join(output, "folder"), { recursive: true });
    await writeFile(join(output, "folder/file"), "original");
    await writeFile(join(output, "unselected"), "keep");
    const actual = await vi.importActual<typeof filesystem>("node:fs/promises");
    await actual.link(join(output, "folder/file"), join(directory, "alias"));
    const destination = await inspectExportDestination(manifest, output, []);
    expect(destination.conflicts.map((value) => value.path)).toEqual(["folder/file"]);
    const events: UserExportAuditEvent[] = [];
    const result = await publishExport({
      reader,
      manifest,
      destination,
      replaceListed: true,
      sessionId: "s",
      audit: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    });
    expect(result.error).toBeUndefined();
    expect(await readFile(join(directory, "alias"), "utf8")).toBe("original");
    expect(await readFile(join(output, "folder/file"), "utf8")).toBe("abc");
    expect(await readFile(join(output, "unselected"), "utf8")).toBe("keep");
    expect(events.map((value) => value.type)).toEqual([
      "export_intent",
      "export_replace_intent",
      "export_replace_complete",
      "export_complete",
    ]);
  });

  it("requires explicit replacement and detects changes after the conflict review", async () => {
    const options = await fixture();
    await mkdir(options.destination.path);
    await writeFile(join(options.destination.path, "file"), "original");
    const destination = await inspectExportDestination(
      options.manifest,
      options.destination.path,
      [],
    );
    const declined = await publishExport({ ...options, destination });
    expect(declined.error).toContain("not approved");
    const changed = await publishExport({
      ...options,
      destination,
      replaceListed: true,
      audit: async (event) => {
        if (event.type === "export_replace_intent")
          await writeFile(join(destination.path, "file"), "changed by host");
      },
    });
    expect(changed.error).toContain("changed");
    expect(await readFile(join(destination.path, "file"), "utf8")).toBe("changed by host");
  });

  it("uses atomic no-replace publication against an actual new-file race", async () => {
    const options = await fixture();
    const actual = await vi.importActual<typeof filesystem>("node:fs/promises");
    vi.mocked(filesystem.link).mockImplementationOnce(async (source, target) => {
      await writeFile(target, "host won race");
      return actual.link(source, target);
    });
    const result = await publishExport(options);
    expect(result.error).toContain("new destination conflict");
    expect(await readFile(join(options.destination.path, "file"), "utf8")).toBe("host won race");
    expect(await readdir(options.destination.path)).toEqual(["file"]);
  });

  it("fails without an overwrite fallback when no-replace links are unsupported", async () => {
    const options = await fixture();
    vi.mocked(filesystem.link).mockRejectedValueOnce(
      Object.assign(new Error("unsupported"), { code: "ENOTSUP" }),
    );
    const result = await publishExport(options);
    expect(result.error).toContain("does not support atomic no-replace");
    expect(await readdir(options.destination.path)).toEqual([]);
  });

  it("rejects destination symlinks, symlink ancestors, type mismatches and writable-source overlap", async () => {
    const options = await fixture();
    await mkdir(join(directory, "real"));
    await symlink(join(directory, "real"), join(directory, "alias"));
    await expect(
      inspectExportDestination(options.manifest, join(directory, "alias/output"), []),
    ).rejects.toThrow("symlink");
    await symlink(join(directory, "real"), join(directory, "real/file"));
    await expect(
      inspectExportDestination(options.manifest, join(directory, "real"), []),
    ).rejects.toThrow("file type");
    await expect(
      inspectExportDestination(options.manifest, join(directory, "scratch/output"), [
        join(directory, "scratch"),
      ]),
    ).rejects.toThrow("overlaps");
    await expect(
      inspectExportDestination(options.manifest, directory, [join(directory, "scratch")]),
    ).rejects.toThrow("overlaps");
  });

  it("rejects destination directory replacement observed after review", async () => {
    const options = await fixture();
    await mkdir(options.destination.path);
    const destination = await inspectExportDestination(
      options.manifest,
      options.destination.path,
      [],
    );
    await rm(destination.path, { recursive: true });
    await symlink(directory, destination.path);
    const result = await publishExport({ ...options, destination });
    expect(result.error).toContain("symlink");
    expect(await readdir(directory)).toEqual(["output"]);
  });

  it("cleans its own staging on source changes and reports exact partial outcomes", async () => {
    const options = await fixture(["a", "b", "c"]);
    const original = options.reader.openFile.bind(options.reader);
    options.reader.openFile = async (value) => {
      if (value.path === "b") throw new Error("source identity changed");
      await original(value);
    };
    const result = await publishExport(options);
    expect(result.outcomes.map((value) => [value.path, value.status])).toEqual([
      ["a", "saved"],
      ["b", "failed"],
      ["c", "not_saved"],
    ]);
    expect(await readdir(options.destination.path)).toEqual(["a"]);
  });

  it("rejects oversize chunks and preserves source on cancellation", async () => {
    const options = await fixture();
    options.reader.readChunk = () => Promise.resolve(Buffer.alloc(256 * 1024 + 1));
    const oversized = await publishExport(options);
    expect(oversized.error).toContain("chunk");
    expect(await readdir(options.destination.path)).toEqual([]);
    const controller = new AbortController();
    options.reader.readChunk = () => {
      controller.abort(new Error("cancel"));
      return Promise.resolve(Buffer.from("abc"));
    };
    const cancelled = await publishExport({ ...options, signal: controller.signal });
    expect(cancelled.cancelled).toBe(true);
    expect(await readdir(options.destination.path)).toEqual([]);
  });

  it("stops after a required replacement-outcome audit fails without denying its completed write", async () => {
    const options = await fixture(["a", "b"]);
    await mkdir(options.destination.path);
    await writeFile(join(options.destination.path, "a"), "old");
    const destination = await inspectExportDestination(
      options.manifest,
      options.destination.path,
      [],
    );
    const result = await publishExport({
      ...options,
      destination,
      replaceListed: true,
      audit: (event) =>
        event.type === "export_replace_complete"
          ? Promise.reject(new Error("required audit failed"))
          : Promise.resolve(),
    });
    expect(result.error).toContain("required audit");
    expect(result.outcomes.map((value) => [value.path, value.status])).toEqual([
      ["a", "saved"],
      ["b", "not_saved"],
    ]);
    expect(await readFile(join(destination.path, "a"), "utf8")).toBe("abc");
  });
});
