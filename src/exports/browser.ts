import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { posix } from "node:path";
import type {
  SandboxExportEntry,
  SandboxExportReader,
} from "../../packages/sandbox-extension/src/runtime/export/contracts.js";
import { displayPath, exportError, checkCancelled, EXPORT_LIMITS } from "./limits.js";
import {
  listExportDirectory,
  normalizeSelections,
  selectionCovers,
  selectionKey,
} from "./manifest.js";
import type { ExportResult } from "./contracts.js";
import {
  DialogText,
  dialogFrame,
  exportOverlay,
  fileSize,
  padded,
  saveSteps,
  type DialogTheme,
} from "./dialog.js";

export class ExportSelection {
  private readonly entries = new Map<string, SandboxExportEntry>();
  private cached: SandboxExportEntry[] | undefined;
  private bytes = 0;

  public values(): SandboxExportEntry[] {
    return (this.cached ??= normalizeSelections([...this.entries.values()]));
  }

  public coveredBy(entry: SandboxExportEntry): SandboxExportEntry | undefined {
    const exact = this.entries.get(selectionKey(entry));
    if (exact) return exact;
    const parts = entry.path.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      const parent = this.entries.get(`${entry.rootId}\0${parts.slice(0, length).join("/")}`);
      if (parent?.kind === "directory") return parent;
    }
    return undefined;
  }

  public toggle(entry: SandboxExportEntry): void {
    if (entry.kind === "unsupported")
      throw new Error(entry.problem ?? "Unsupported entry cannot be selected");
    const covering = this.coveredBy(entry);
    if (covering && covering.path !== entry.path)
      throw new Error(
        "Covered by a selected directory; deselect that directory to choose individual children",
      );
    this.cached = undefined;
    if (covering) {
      this.entries.delete(selectionKey(entry));
      this.bytes -= Buffer.byteLength(JSON.stringify(covering));
    } else {
      let removedBytes = 0;
      let removedCount = 0;
      for (const child of this.entries.values())
        if (selectionCovers(entry, child)) {
          removedBytes += Buffer.byteLength(JSON.stringify(child));
          removedCount += 1;
        }
      const addedBytes = Buffer.byteLength(JSON.stringify(entry));
      if (
        this.entries.size - removedCount + 1 > EXPORT_LIMITS.entries ||
        this.bytes - removedBytes + addedBytes > EXPORT_LIMITS.inventoryBytes
      )
        throw new Error("Selection inventory limit exceeded");
      for (const [key, child] of this.entries)
        if (selectionCovers(entry, child)) this.entries.delete(key);
      this.entries.set(selectionKey(entry), entry);
      this.bytes = this.bytes - removedBytes + addedBytes;
    }
  }

  public toggleVisible(entries: readonly SandboxExportEntry[]): void {
    const previous = new Map(this.entries);
    const eligible = entries.filter((entry) => entry.kind !== "unsupported");
    if (eligible.every((entry) => this.coveredBy(entry))) {
      for (const entry of eligible) this.entries.delete(selectionKey(entry));
    } else
      for (const entry of eligible)
        if (!this.coveredBy(entry)) this.entries.set(selectionKey(entry), entry);
    const normalized = normalizeSelections([...this.entries.values()]);
    const bytes = normalized.reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)),
      0,
    );
    this.entries.clear();
    if (normalized.length > EXPORT_LIMITS.entries || bytes > EXPORT_LIMITS.inventoryBytes) {
      for (const [key, entry] of previous) this.entries.set(key, entry);
      throw new Error("Selection inventory limit exceeded");
    }
    for (const entry of normalized) this.entries.set(selectionKey(entry), entry);
    this.cached = normalized;
    this.bytes = bytes;
  }

  public hiddenCount(): number {
    return this.values().filter((entry) =>
      entry.path.split("/").some((part) => part.startsWith(".")),
    ).length;
  }
}

export class ExportBrowser implements Component {
  public readonly selection = new ExportSelection();
  public rootId: "home" | "tmp";
  public directory = "";
  public showHidden = false;
  public index = 0;
  public entries: readonly SandboxExportEntry[] = [];
  public busy = false;
  public message = "";
  private disposed = false;
  private pageSize = 6;

  public constructor(
    private readonly reader: SandboxExportReader,
    private readonly renderAgain: () => void,
    private readonly done: (result: readonly SandboxExportEntry[] | undefined) => void,
    private readonly theme: DialogTheme,
    private readonly terminalRows: () => number,
    private readonly signal?: AbortSignal,
  ) {
    this.rootId = reader.roots.some((root) => root.id === "home") ? "home" : reader.roots[0]!.id;
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  private readonly abort = (): void => {
    this.done(undefined);
  };

  public visible(): readonly SandboxExportEntry[] {
    return this.entries.filter((entry) => this.showHidden || !entry.name.startsWith("."));
  }

  public async load(): Promise<void> {
    this.busy = true;
    this.message = "Loading directory…";
    this.renderAgain();
    try {
      const entries = await listExportDirectory(
        this.reader,
        this.rootId,
        this.directory,
        this.signal,
      );
      if (!this.disposed) {
        this.entries = entries;
        this.index = 0;
        this.message = "";
      }
    } catch (error) {
      if (!this.disposed) {
        this.entries = [];
        this.message = exportError(error);
      }
    } finally {
      this.busy = false;
      if (!this.disposed) this.renderAgain();
    }
  }

  public handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done(undefined);
      return;
    }
    if (this.busy || this.disposed) return;
    const visible = this.visible();
    const entry = visible[this.index];
    try {
      if (matchesKey(data, "up")) this.index = Math.max(0, this.index - 1);
      else if (matchesKey(data, "down"))
        this.index = Math.min(Math.max(0, visible.length - 1), this.index + 1);
      else if (matchesKey(data, "pageUp")) this.index = Math.max(0, this.index - this.pageSize);
      else if (matchesKey(data, "pageDown"))
        this.index = Math.min(Math.max(0, visible.length - 1), this.index + this.pageSize);
      else if (matchesKey(data, "space") && entry) this.selection.toggle(entry);
      else if (data === "a") this.selection.toggleVisible(visible);
      else if (data === "h") {
        this.showHidden = !this.showHidden;
        this.index = 0;
      } else if (matchesKey(data, "right") && entry?.kind === "directory") {
        this.directory = entry.path;
        void this.load();
        return;
      } else if (matchesKey(data, "left") && this.directory !== "") {
        const parent = posix.dirname(this.directory);
        this.directory = parent === "." ? "" : parent;
        void this.load();
        return;
      } else if (matchesKey(data, "tab")) {
        const current = this.reader.roots.findIndex((root) => root.id === this.rootId);
        this.rootId = this.reader.roots[(current + 1) % this.reader.roots.length]!.id;
        this.directory = "";
        void this.load();
        return;
      } else if (matchesKey(data, "enter")) {
        if (this.selection.values().length === 0)
          this.message = "Select at least one file or directory";
        else this.done(this.selection.values());
      }
    } catch (error) {
      this.message = exportError(error);
    }
    this.renderAgain();
  }

  public render(width: number): string[] {
    const theme = this.theme;
    const visible = this.visible();
    const contentWidth = Math.max(0, width - 4);
    this.pageSize = Math.max(1, Math.min(12, this.terminalRows() - 19));
    const start = Math.max(
      0,
      Math.min(this.index - Math.floor(this.pageSize / 2), visible.length - this.pageSize),
    );
    const rows = visible.slice(start, start + this.pageSize).map((entry, offset) => {
      const covering = this.selection.coveredBy(entry);
      const focused = start + offset === this.index;
      const mark = covering ? (covering.path === entry.path ? "☑" : "▣") : "☐";
      const name = displayPath(entry.name) + (entry.kind === "directory" ? "/" : "");
      const detail =
        entry.kind === "directory"
          ? "folder  ›"
          : entry.kind === "unsupported"
            ? "unsupported"
            : fileSize(entry.size);
      const prefix = `${focused ? "▸" : " "} ${mark} `;
      const nameWidth = Math.max(0, contentWidth - visibleWidth(prefix) - visibleWidth(detail) - 2);
      const row = prefix + padded(name, nameWidth) + "  " + detail;
      if (focused) return theme.inverse(theme.bold(padded(row, contentWidth)));
      return theme.fg(
        covering
          ? "success"
          : entry.kind === "directory"
            ? "accent"
            : entry.kind === "unsupported"
              ? "dim"
              : "text",
        row,
      );
    });
    const tabs = this.reader.roots
      .map((root) =>
        root.id === this.rootId
          ? theme.inverse(` ${displayPath(root.label)} `)
          : theme.fg("muted", ` ${displayPath(root.label)} `),
      )
      .join("   ");
    const count = this.selection.values().length;
    const hidden = this.selection.hiddenCount();
    const position =
      visible.length === 0 ? "0 items" : `${this.index + 1} / ${visible.length} items`;
    const controls = ["↑↓ Move", "Space Select"];
    if (!this.busy && visible[this.index]?.kind === "directory") controls.push("→ Open");
    if (this.directory !== "") controls.push("← Back");
    controls.push("a All");
    return dialogFrame(
      width,
      "Save sandbox files",
      [
        [
          "",
          saveSteps(1, theme, contentWidth),
          "",
          `${tabs}    ${theme.fg("dim", "Tab: switch")}`,
          theme.fg("muted", `Folder  ${this.rootId}:/${displayPath(this.directory)}`),
          theme.fg("dim", `Hidden files: ${this.showHidden ? "shown" : "hidden"}  ·  h: toggle`),
        ],
        [
          "",
          ...(rows.length
            ? rows
            : [
                theme.fg("muted", this.busy ? "Loading files…" : "No visible files in this folder"),
              ]),
          "",
          theme.fg(
            count ? "success" : "muted",
            `${count} selected${hidden ? ` (${hidden} hidden)` : ""}  ·  ${position}`,
          ),
        ],
        [
          this.message
            ? theme.fg("warning", displayPath(this.message))
            : theme.fg("dim", "Selecting a folder includes its hidden files."),
          "",
          theme.fg("muted", controls.join("  ")),
          theme.fg("accent", "Enter  Continue") + theme.fg("muted", "    Esc  Cancel"),
        ],
      ],
      theme,
    );
  }

  public invalidate(): void {}
  public dispose(): void {
    this.disposed = true;
    this.signal?.removeEventListener("abort", this.abort);
  }
}

export async function selectExportFiles(
  ctx: ExtensionCommandContext,
  reader: SandboxExportReader,
  signal: AbortSignal,
): Promise<readonly SandboxExportEntry[] | undefined> {
  checkCancelled(signal);
  return ctx.ui.custom((tui, theme, _keys, done) => {
    const browser = new ExportBrowser(
      reader,
      () => tui.requestRender(),
      done,
      theme,
      () => tui.terminal.rows,
      signal,
    );
    void browser.load();
    return browser;
  }, exportOverlay);
}

export async function inputExportDestination(
  ctx: ExtensionCommandContext,
  initial: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  checkCancelled(signal);
  return ctx.ui.custom((tui, theme, _keys, done) => {
    const input = new Input({ prompt: "› " });
    input.setValue(initial);
    input.handleInput("\u0005"); // Start at the end of the suggested destination.
    input.focused = true;
    input.onSubmit = (value) => done(value);
    input.onEscape = () => done(undefined);
    const abort = (): void => done(undefined);
    signal.addEventListener("abort", abort, { once: true });
    return {
      focused: true,
      render: (width) =>
        dialogFrame(
          width,
          "Save destination",
          [
            ["", saveSteps(2, theme, width - 4), ""],
            [
              "",
              theme.bold("Host directory"),
              "",
              ...input.render(Math.max(1, width - 4)),
              "",
              theme.fg("muted", "Relative paths start in your launch directory."),
              theme.fg("muted", "~ refers to your account home."),
              "",
            ],
            [
              theme.fg("accent", "Enter  Review save") +
                theme.fg("muted", "    Ctrl+u  Clear    Esc  Cancel"),
              "",
            ],
          ],
          theme,
        ),
      handleInput: (data) => {
        input.handleInput(data);
        tui.requestRender();
      },
      invalidate: () => input.invalidate(),
      dispose: () => signal.removeEventListener("abort", abort),
    };
  }, exportOverlay);
}

export async function confirmSaveBeforeQuit(
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
): Promise<"save" | "exit" | undefined> {
  if (signal.aborted) return undefined;
  return ctx.ui.custom((tui, theme, _keys, done) => {
    let save = true;
    const abort = (): void => done(undefined);
    signal.addEventListener("abort", abort, { once: true });
    const button = (label: string, selected: boolean): string =>
      selected ? theme.inverse(theme.bold(` ${label} `)) : theme.fg("muted", ` ${label} `);
    return {
      render: (width) =>
        dialogFrame(
          width,
          "Save before exiting?",
          [
            [
              "",
              theme.bold("Would you like to save your sandbox files?"),
              "",
              theme.fg("muted", "Unsaved scratch work may be lost when you exit."),
              "",
            ],
            [
              "",
              `${button("Yes, choose files", save)}   ${button("No, exit", !save)}`,
              "",
              theme.fg("muted", "y / n  Choose    Tab / ←→  Switch    Enter  Confirm"),
              theme.fg("dim", "Ctrl+c  Exit without saving    Esc  Return to session"),
            ],
          ],
          theme,
        ),
      handleInput(data) {
        if (matchesKey(data, "ctrl+c")) done("exit");
        else if (matchesKey(data, "escape")) done(undefined);
        else if (data.toLowerCase() === "y") done("save");
        else if (data.toLowerCase() === "n") done("exit");
        else if (matchesKey(data, "enter")) done(save ? "save" : "exit");
        else if (
          matchesKey(data, "tab") ||
          matchesKey(data, "shift+tab") ||
          matchesKey(data, "left") ||
          matchesKey(data, "right")
        )
          save = !save;
        tui.requestRender();
      },
      invalidate() {},
      dispose: () => signal.removeEventListener("abort", abort),
    };
  }, exportOverlay);
}

export async function reviewExport(
  ctx: ExtensionCommandContext,
  lines: readonly string[],
  replace: boolean,
  signal: AbortSignal,
): Promise<"save" | "destination" | undefined> {
  checkCancelled(signal);
  return ctx.ui.custom((tui, theme, _keys, done) => {
    const text = new DialogText(lines.map(displayPath));
    let selected = 0;
    const actions = [replace ? "Replace listed files" : "Save files", "Change directory", "Cancel"];
    const abort = (): void => done(undefined);
    signal.addEventListener("abort", abort, { once: true });
    return {
      render(width) {
        const buttons = actions.map((label, index) =>
          index === selected
            ? theme.inverse(theme.bold(` ${label} `))
            : theme.fg("muted", ` ${label} `),
        );
        const joined = buttons.join("   ");
        const actionRows = visibleWidth(joined) <= width - 4 ? [joined] : buttons;
        const viewport = text.render(
          Math.max(1, width - 4),
          Math.min(18, tui.terminal.rows - 16 - actionRows.length),
        );
        const formatted = viewport.map((line) =>
          /replaced|replace:/i.test(line)
            ? theme.fg(replace ? "warning" : "success", line)
            : line.endsWith(":")
              ? theme.fg("accent", theme.bold(line))
              : line,
        );
        return dialogFrame(
          width,
          "Review sandbox save",
          [
            ["", saveSteps(3, theme, width - 4), ""],
            [...formatted, "", theme.fg("dim", text.position)],
            [
              "",
              ...actionRows,
              "",
              theme.fg("muted", "Tab Action   Enter Confirm   Esc Cancel"),
              theme.fg("dim", "↑↓/PgUp/PgDn Scroll  ←→/Home/End Paths"),
            ],
          ],
          theme,
        );
      },
      handleInput(data) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done(undefined);
        else if (matchesKey(data, "tab")) selected = (selected + 1) % actions.length;
        else if (matchesKey(data, "shift+tab"))
          selected = (selected + actions.length - 1) % actions.length;
        else if (matchesKey(data, "enter"))
          done(selected === 0 ? "save" : selected === 1 ? "destination" : undefined);
        else if (data === "d") done("destination");
        else text.handleInput(data);
        tui.requestRender();
      },
      invalidate() {},
      dispose: () => signal.removeEventListener("abort", abort),
    };
  }, exportOverlay);
}

export async function showExportOutcome(
  ctx: ExtensionCommandContext,
  lines: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const text = new DialogText(lines.map(displayPath));
    const abort = (): void => done();
    signal.addEventListener("abort", abort, { once: true });
    return {
      render(width) {
        const viewport = text.render(Math.max(1, width - 4), Math.min(18, tui.terminal.rows - 13));
        const formatted = viewport.map((line) =>
          theme.fg(
            line.startsWith("saved:") || line.startsWith("Saved:")
              ? "success"
              : line.startsWith("failed:")
                ? "error"
                : "text",
            line,
          ),
        );
        return dialogFrame(
          width,
          "Sandbox save result",
          [
            ["", ...formatted, "", theme.fg("dim", text.position)],
            [
              "",
              theme.inverse(theme.bold(" Close ")),
              "",
              theme.fg("muted", "Enter / Esc  Close    ↑↓ / PgUp / PgDn  Scroll"),
              theme.fg("dim", "←→ / Home / End  Inspect long paths"),
            ],
          ],
          theme,
        );
      },
      handleInput(data) {
        if (matchesKey(data, "enter") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
          done();
        else text.handleInput(data);
        tui.requestRender();
      },
      invalidate() {},
      dispose: () => signal.removeEventListener("abort", abort),
    };
  }, exportOverlay);
}

/** Keep the copy UI alive until publication has settled, including cancellation cleanup. */
export async function copyExportWithProgress(
  ctx: ExtensionCommandContext,
  copy: () => Promise<ExportResult>,
  cancel: () => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  checkCancelled(signal);
  type Completion =
    | { readonly ok: true; readonly result: ExportResult }
    | { readonly ok: false; readonly error: unknown };
  const completion = await ctx.ui.custom<Completion>((tui, theme, _keys, done) => {
    let cancelling = false;
    const abort = (): void => {
      cancelling = true;
      cancel();
      tui.requestRender();
    };
    signal.addEventListener("abort", abort, { once: true });
    void copy().then(
      (result) => done({ ok: true, result }),
      (error: unknown) => done({ ok: false, error }),
    );
    return {
      render: (width) =>
        dialogFrame(
          width,
          "Save sandbox files",
          [
            [
              "",
              theme.fg(
                "accent",
                theme.bold(cancelling ? "Cancelling save…" : "Copying selected files…"),
              ),
              "",
              theme.fg("muted", "Completed files are kept if you cancel."),
              "",
            ],
            [theme.fg("muted", "Esc  Cancel save"), ""],
          ],
          theme,
        ),
      handleInput(data) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) abort();
      },
      invalidate() {},
      dispose: () => signal.removeEventListener("abort", abort),
    };
  }, exportOverlay);
  if (!completion.ok)
    throw completion.error instanceof Error
      ? completion.error
      : new Error(exportError(completion.error));
  return completion.result;
}
