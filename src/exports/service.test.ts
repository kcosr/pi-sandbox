import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialogTheme, entry, readerFixture } from "./fixtures.test-support.js";
import { createUserExportController, resolveExportDestination } from "./service.js";
import type { UserExportAuditEvent } from "./contracts.js";

function context(mode = "tui", responses: unknown[] = []) {
  const waitForIdle = vi.fn(() => Promise.resolve());
  const notify = vi.fn();
  let copyComponent: Component | undefined;
  const custom = vi.fn(
    (
      factory: (
        tui: unknown,
        theme: unknown,
        keys: unknown,
        done: (result: unknown) => void,
      ) => Component,
    ) => {
      const response = responses.shift();
      if (typeof response === "object" && response !== null && "copy" in response) {
        return new Promise<unknown>((resolve) => {
          copyComponent = factory(
            { requestRender: vi.fn(), terminal: { rows: 24 } },
            dialogTheme,
            {},
            resolve,
          );
        });
      }
      return Promise.resolve(response);
    },
  );
  const ctx = {
    mode,
    hasUI: true,
    waitForIdle,
    sessionManager: { getSessionId: () => "session" },
    ui: { notify, custom },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    waitForIdle,
    notify,
    custom,
    get copyComponent() {
      return copyComponent;
    },
  };
}

describe("user-only sandbox save coordinator", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-export-ui-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(["rpc", "print", "json"])(
    "denies %s before source access even when hasUI is true",
    async (mode) => {
      const getSource = vi.fn();
      const controller = createUserExportController({
        cwd: directory,
        getSource,
        admitted: () => true,
      });
      const fixture = context(mode);
      await controller.run(fixture.ctx);
      expect(getSource).not.toHaveBeenCalled();
      expect(fixture.waitForIdle).not.toHaveBeenCalled();
      expect(fixture.custom).not.toHaveBeenCalled();
      expect(fixture.notify).toHaveBeenCalledWith(
        expect.stringContaining("interactive TUI"),
        "warning",
      );
    },
  );

  it("denies disabled or unsupported configurations before opening private storage", async () => {
    const getSource = vi.fn();
    const controller = createUserExportController({
      cwd: directory,
      getSource,
      admitted: () => false,
    });
    await controller.run(context().ctx);
    expect(getSource).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("inventories and inspects without writes when final confirmation is cancelled", async () => {
    const selected = entry("file");
    const { reader, source } = readerFixture([selected]);
    const close = vi.spyOn(reader, "close");
    const controller = createUserExportController({
      cwd: directory,
      getSource: () => source,
      admitted: () => true,
    });
    const fixture = context("tui", [[selected], join(directory, "new-destination"), undefined]);
    await controller.run(fixture.ctx);
    expect(fixture.waitForIdle).toHaveBeenCalledOnce();
    expect(fixture.custom).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });

  it("allows choosing another directory without changing the original selection or writing", async () => {
    const selected = entry("file");
    const { source } = readerFixture([selected]);
    const controller = createUserExportController({
      cwd: directory,
      getSource: () => source,
      admitted: () => true,
    });
    const fixture = context("tui", [
      [selected],
      join(directory, "first"),
      "destination",
      join(directory, "second"),
      undefined,
    ]);
    await controller.run(fixture.ctx);
    expect(fixture.custom).toHaveBeenCalledTimes(5);
    expect(await readdir(directory)).toEqual([]);
  });

  it("publishes only after the user's final Save and closes its reader", async () => {
    const selected = entry("file");
    const { source, reader } = readerFixture([selected]);
    const close = vi.spyOn(reader, "close");
    const destination = join(directory, "saved");
    const controller = createUserExportController({
      cwd: directory,
      getSource: () => source,
      admitted: () => true,
    });
    const fixture = context("tui", [[selected], destination, "save", { copy: true }, undefined]);
    await controller.run(fixture.ctx);
    expect(await readFile(join(destination, "file"), "utf8")).toBe("abc");
    expect(close).toHaveBeenCalledOnce();
    expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining("Saved: 1 files"), "info");
  });

  it("lets the user cancel copying while retaining completed files and the partial-results viewer", async () => {
    const selected = [entry("a"), entry("b")];
    const { source, reader } = readerFixture(selected);
    const destination = join(directory, "saved");
    const fixture = context("tui", [selected, destination, "save", { copy: true }, undefined]);
    const originalOpen = reader.openFile.bind(reader);
    reader.openFile = (value) => {
      if (value.path === "b") fixture.copyComponent!.handleInput!("\u001b");
      return originalOpen(value);
    };
    const events: UserExportAuditEvent[] = [];
    const openSource = vi.spyOn(source, "open");
    const controller = createUserExportController({
      cwd: directory,
      getSource: () => source,
      admitted: () => true,
      audit: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    });
    await controller.run(fixture.ctx);
    expect(openSource.mock.calls[0]![0]!.aborted).toBe(true);
    expect(await readdir(destination)).toEqual(["a"]);
    expect(fixture.notify).toHaveBeenCalledWith(
      expect.stringContaining("Save cancelled: 1 files"),
      "warning",
    );
    expect(fixture.custom).toHaveBeenCalledTimes(5);
    expect(events.at(-1)).toMatchObject({
      type: "export_complete",
      savedFiles: 1,
      failedFiles: 1,
      cancelled: true,
    });
  });

  it("cancels an idle wait promptly on process/session shutdown", async () => {
    const getSource = vi.fn();
    const controller = createUserExportController({
      cwd: directory,
      getSource,
      admitted: () => true,
    });
    const fixture = context();
    vi.mocked(fixture.waitForIdle).mockImplementation(() => new Promise(() => undefined));
    const running = controller.run(fixture.ctx);
    await controller.close();
    await running;
    expect(getSource).not.toHaveBeenCalled();
  });

  it("resolves user destinations against host CWD and OS account home", () => {
    expect(resolveExportDestination("relative", "/launch", "/account")).toBe("/launch/relative");
    expect(resolveExportDestination("~/saved", "/launch", "/account")).toBe("/account/saved");
    expect(() => resolveExportDestination("~", "/launch")).toThrow("OS account home");
  });

  it.each(["rpc", "print", "json"])("skips the exit prompt in %s mode", async (mode) => {
    const getSource = vi.fn();
    const controller = createUserExportController({
      cwd: directory,
      getSource,
      admitted: () => true,
    });
    const fixture = context(mode);
    expect(await controller.beforeQuit(fixture.ctx, new AbortController().signal)).toBe(true);
    expect(fixture.custom).not.toHaveBeenCalled();
    expect(getSource).not.toHaveBeenCalled();
  });

  it("skips the exit prompt when saving is disabled", async () => {
    const fixture = context();
    const controller = createUserExportController({
      cwd: directory,
      getSource: vi.fn(),
      admitted: () => false,
    });
    expect(await controller.beforeQuit(fixture.ctx, new AbortController().signal)).toBe(true);
    expect(fixture.custom).not.toHaveBeenCalled();
  });

  it.each([
    ["exit", true],
    [undefined, false],
  ])("handles exit confirmation %s without reading file contents", async (choice, expected) => {
    const { source, reader } = readerFixture([entry("file")]);
    const close = vi.spyOn(reader, "close");
    const openFile = vi.spyOn(reader, "openFile");
    const fixture = context("tui", [choice]);
    const controller = createUserExportController({
      cwd: directory,
      getSource: () => source,
      admitted: () => true,
    });
    expect(await controller.beforeQuit(fixture.ctx, new AbortController().signal)).toBe(expected);
    expect(close).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [entry("empty", { kind: "directory" }), entry("empty/.cache", { kind: "directory" })],
    [entry("link", { kind: "unsupported" })],
  ])("exits without prompting when no regular files exist: %j", async (...entries) => {
    const { source, reader } = readerFixture(entries);
    const close = vi.spyOn(reader, "close");
    const fixture = context();
    const controller = createUserExportController({
      cwd: directory,
      getSource: () => source,
      admitted: () => true,
    });
    expect(await controller.beforeQuit(fixture.ctx, new AbortController().signal)).toBe(true);
    expect(fixture.custom).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["home", "tmp"] as const)("prompts for nested hidden files in %s", async (rootId) => {
    const { source } = readerFixture([
      entry(".hidden", { rootId, kind: "directory" }),
      entry(".hidden/empty-file", { rootId, size: 0 }),
    ]);
    const fixture = context("tui", ["exit"]);
    const controller = createUserExportController({
      cwd: directory,
      getSource: () => source,
      admitted: () => true,
    });
    expect(await controller.beforeQuit(fixture.ctx, new AbortController().signal)).toBe(true);
    expect(fixture.custom).toHaveBeenCalledOnce();
  });

  it("still offers saving when the file check fails", async () => {
    const { source, reader } = readerFixture([]);
    vi.spyOn(reader, "list").mockRejectedValue(new Error("cannot inspect directory"));
    const close = vi.spyOn(reader, "close");
    const fixture = context("tui", [undefined]);
    const controller = createUserExportController({
      cwd: directory,
      getSource: () => source,
      admitted: () => true,
    });
    expect(await controller.beforeQuit(fixture.ctx, new AbortController().signal)).toBe(false);
    expect(fixture.custom).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds the file check and offers saving after a timeout", async () => {
    vi.useFakeTimers();
    try {
      const { source, reader } = readerFixture([]);
      let started!: () => void;
      const scanning = new Promise<void>((resolve) => {
        started = resolve;
      });
      vi.spyOn(source, "open").mockImplementation((signal) => {
        reader.list = () =>
          new Promise((_resolve, reject) => {
            signal!.addEventListener("abort", () => reject(new Error("scan cancelled")), {
              once: true,
            });
            started();
          });
        return Promise.resolve(reader);
      });
      const close = vi.spyOn(reader, "close");
      const fixture = context("tui", ["exit"]);
      const controller = createUserExportController({
        cwd: directory,
        getSource: () => source,
        admitted: () => true,
      });
      const pending = controller.beforeQuit(fixture.ctx, new AbortController().signal);
      await scanning;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toBe(true);
      expect(fixture.custom).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes saving before allowing exit", async () => {
    const selected = entry("file");
    const { source } = readerFixture([selected]);
    const destination = join(directory, "saved");
    const fixture = context("tui", [
      "save",
      [selected],
      destination,
      "save",
      { copy: true },
      undefined,
    ]);
    const controller = createUserExportController({
      cwd: directory,
      getSource: () => source,
      admitted: () => true,
    });
    expect(await controller.beforeQuit(fixture.ctx, new AbortController().signal)).toBe(true);
    expect(await readFile(join(destination, "file"), "utf8")).toBe("abc");
  });

  it("keeps the session open when the exit picker is cancelled or saving fails", async () => {
    const { source, reader } = readerFixture([entry("file")]);
    const close = vi.spyOn(reader, "close");
    const controller = createUserExportController({
      cwd: directory,
      getSource: () => source,
      admitted: () => true,
    });
    expect(
      await controller.beforeQuit(
        context("tui", ["save", undefined]).ctx,
        new AbortController().signal,
      ),
    ).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
    vi.spyOn(source, "open").mockRejectedValue(new Error("reader unavailable"));
    expect(
      await controller.beforeQuit(context("tui", ["save"]).ctx, new AbortController().signal),
    ).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  it("aborts an exit save waiting for foreground activity", async () => {
    const fixture = context("tui", ["save"]);
    fixture.waitForIdle.mockImplementation(() => new Promise(() => undefined));
    const getSource = vi.fn();
    const controller = createUserExportController({
      cwd: directory,
      getSource,
      admitted: () => true,
    });
    const signal = new AbortController();
    const pending = controller.beforeQuit(fixture.ctx, signal.signal);
    await vi.waitFor(() => expect(fixture.waitForIdle).toHaveBeenCalled());
    signal.abort();
    expect(await pending).toBe(false);
    expect(getSource).not.toHaveBeenCalled();
  });

  it("cancels an in-flight exit check on shutdown without prompting", async () => {
    const { source, reader } = readerFixture([]);
    let started!: () => void;
    const scanning = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(source, "open").mockImplementation((signal) => {
      reader.list = () =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("scan cancelled")), {
            once: true,
          });
          started();
        });
      return Promise.resolve(reader);
    });
    const close = vi.spyOn(reader, "close");
    const fixture = context();
    const controller = createUserExportController({
      cwd: directory,
      getSource: () => source,
      admitted: () => true,
    });
    const pending = controller.beforeQuit(fixture.ctx, new AbortController().signal);
    await scanning;
    await controller.close();
    expect(await pending).toBe(false);
    expect(fixture.custom).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
