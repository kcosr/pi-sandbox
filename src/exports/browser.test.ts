import { describe, expect, it, vi } from "vitest";
import { ExportBrowser, ExportSelection, reviewExport, showExportOutcome } from "./browser.js";
import { displayPath, exportError } from "./limits.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { dialogTheme, entry, readerFixture } from "./fixtures.test-support.js";

describe("sandbox file selection", () => {
  it("keeps hidden selections when visible select-all changes", () => {
    const selection = new ExportSelection();
    const hidden = entry(".hidden");
    const visible = entry("visible");
    selection.toggle(hidden);
    selection.toggleVisible([visible]);
    selection.toggleVisible([visible]);
    expect(selection.values()).toEqual([hidden]);
    expect(selection.hiddenCount()).toBe(1);
  });

  it("makes a selected directory cover descendants without ambiguous exclusions", () => {
    const selection = new ExportSelection();
    const parent = entry("folder", { kind: "directory" });
    const child = entry("folder/.nested");
    selection.toggle(child);
    selection.toggle(parent);
    expect(selection.values()).toEqual([parent]);
    expect(selection.coveredBy(child)).toEqual(parent);
    expect(() => selection.toggle(child)).toThrow("Covered");
    selection.toggle(parent);
    selection.toggle(child);
    expect(selection.values()).toEqual([child]);
  });

  it("preserves selection across hidden toggles, directory navigation and roots", async () => {
    const folder = entry("folder", { kind: "directory" });
    const { reader } = readerFixture([
      folder,
      entry(".hidden"),
      entry("folder/child"),
      entry("tmp-file", { rootId: "tmp" }),
    ]);
    const done = vi.fn();
    const browser = new ExportBrowser(reader, vi.fn(), done, dialogTheme, () => 24);
    await browser.load();
    expect(browser.visible()).toEqual([folder]);
    browser.handleInput(" ");
    browser.handleInput("h");
    expect(browser.selection.values()).toEqual([folder]);
    browser.handleInput("\u001b[C");
    await vi.waitFor(() => expect(browser.directory).toBe("folder"));
    await vi.waitFor(() => expect(browser.busy).toBe(false));
    expect(browser.selection.coveredBy(browser.visible()[0]!)).toEqual(folder);
    browser.handleInput("\t");
    await vi.waitFor(() => expect(browser.busy).toBe(false));
    expect(browser.rootId).toBe("tmp");
    expect(browser.selection.values()).toEqual([folder]);
    browser.dispose();
  });

  it("shows unsupported entries and escapes terminal controls and bidi filenames", async () => {
    const { reader } = readerFixture([entry("bad\u001b[31m\u202ename", { kind: "unsupported" })]);
    const browser = new ExportBrowser(reader, vi.fn(), vi.fn(), dialogTheme, () => 24);
    await browser.load();
    browser.handleInput(" ");
    expect(browser.selection.values()).toEqual([]);
    const output = browser.render(200).join("\n");
    expect(output).toContain("unsupported");
    expect(output).not.toContain("\u001b");
    expect(displayPath("a\u202eb")).toBe("a\\u{202e}b");
    expect(displayPath("a\nb")).not.toBe(displayPath("a\\u{a}b"));
    expect(displayPath("a\\u{a}b")).toBe("a\\\\u{a}b");
    browser.dispose();
  });

  it("bounds multiline error bytes without breaking UTF-8 and escapes reader labels", () => {
    expect(Buffer.byteLength(exportError("😀".repeat(1000)))).toBe(1024);
    expect(exportError("😀".repeat(1000))).not.toContain("\ufffd");
    const { reader } = readerFixture([]);
    const browser = new ExportBrowser(
      { ...reader, roots: [{ id: "home", label: "bad\u001b[31m" }] },
      vi.fn(),
      vi.fn(),
      dialogTheme,
      () => 24,
    );
    expect(browser.render(200).join("\n")).not.toContain("\u001b");
    browser.dispose();
  });

  it("keeps selection, focus and controls visible when the terminal shrinks", async () => {
    let height = 32;
    const { reader } = readerFixture(
      Array.from({ length: 40 }, (_, index) => entry(`文件-${String(index).padStart(2, "0")}.txt`)),
    );
    const browser = new ExportBrowser(reader, vi.fn(), vi.fn(), dialogTheme, () => height);
    await browser.load();
    browser.index = 30;
    browser.handleInput(" ");
    for (const [width, rows] of [
      [96, 32],
      [60, 24],
      [48, 20],
    ]) {
      height = rows!;
      const rendered = browser.render(width!);
      expect(rendered.length).toBeLessThanOrEqual(height - 2);
      expect(rendered.every((line) => visibleWidth(line) <= width!)).toBe(true);
      expect(rendered.join("\n")).toContain("▸ ☑ 文件-30.txt");
      expect(rendered.join("\n")).toContain("Esc  Cancel");
      expect(rendered.at(-1)).toContain("╯");
    }
    browser.dispose();
  });

  it.each([
    ["", "save"],
    ["\t", "destination"],
    ["\u001b[Z", undefined],
  ])("activates only the selected review action after %j", async (key, expected) => {
    let component: Component | undefined;
    const custom = vi.fn(
      (
        factory: (
          tui: unknown,
          theme: unknown,
          keys: unknown,
          done: (value: unknown) => void,
        ) => Component,
      ) =>
        new Promise((resolve) => {
          component = factory(
            { requestRender: vi.fn(), terminal: { rows: 24 } },
            dialogTheme,
            {},
            resolve,
          );
        }),
    );
    const ctx = { ui: { custom } } as unknown as ExtensionCommandContext;
    const pending = reviewExport(
      ctx,
      ["Existing files will be replaced:", "file.txt"],
      true,
      new AbortController().signal,
    );
    expect(component!.render(78).join("\n")).toContain("Replace listed files");
    if (key) component!.handleInput!(key);
    component!.handleInput!("\r");
    await expect(pending).resolves.toBe(expected);
    expect(custom.mock.calls[0]).toHaveLength(2);
  });

  it("keeps exact large partial results available through a bounded scrolling view", async () => {
    let component: Component | undefined;
    let finish: (() => void) | undefined;
    const ctx = {
      ui: {
        custom: vi.fn(
          (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Component) =>
            new Promise<void>((resolve) => {
              finish = resolve;
              component = factory(
                { requestRender: vi.fn(), terminal: { rows: 32 } },
                dialogTheme,
                {},
                resolve,
              );
            }),
        ),
      },
    } as unknown as ExtensionCommandContext;
    const pending = showExportOutcome(
      ctx,
      Array.from({ length: 1000 }, (_, index) => `saved file-${index}`),
      new AbortController().signal,
    );
    expect(component!.render(100).length).toBeLessThanOrEqual(30);
    component!.handleInput!("\u001b[6~");
    expect(component!.render(100).join("\n")).toContain("file-18");
    finish!();
    await pending;
  });

  it("lets a narrow terminal inspect differing replacement-path suffixes before consent", async () => {
    let component: Component | undefined;
    let finish: ((result: "save" | "destination" | undefined) => void) | undefined;
    const ctx = {
      ui: {
        custom: vi.fn(
          (
            factory: (
              tui: unknown,
              theme: unknown,
              keys: unknown,
              done: typeof finish,
            ) => Component,
          ) =>
            new Promise<"save" | "destination" | undefined>((resolve) => {
              finish = resolve;
              component = factory(
                { requestRender: vi.fn(), terminal: { rows: 32 } },
                dialogTheme,
                {},
                resolve,
              );
            }),
        ),
      },
    } as unknown as ExtensionCommandContext;
    const pending = reviewExport(
      ctx,
      [`${"a".repeat(100)}-first.txt`, `${"a".repeat(100)}-other.txt`],
      true,
      new AbortController().signal,
    );
    expect(component!.render(20).join("\n")).not.toContain("-first.txt");
    component!.handleInput!("\u001b[F");
    const final = component!.render(20).join("\n");
    expect(final).toContain("-first.txt");
    expect(final).toContain("-other.txt");
    finish!(undefined);
    await pending;
  });
});
