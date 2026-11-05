import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type DialogTheme = Pick<Theme, "fg" | "bold" | "inverse">;

export const exportOverlay = {
  overlay: true,
  overlayOptions: { width: 96, margin: 1, anchor: "center" as const },
};

export function padded(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width));
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** All variable text is escaped by callers before theme sequences are added. */
export function dialogFrame(
  width: number,
  title: string,
  sections: readonly (readonly string[])[],
  theme: DialogTheme,
): string[] {
  const inside = Math.max(0, width - 2);
  const content = Math.max(0, width - 4);
  const label = truncateToWidth(` ${title} `, inside);
  const border = (text: string): string => theme.fg("borderAccent", text);
  const lines = [
    border("╭") +
      theme.fg("accent", theme.bold(label)) +
      border("─".repeat(Math.max(0, inside - visibleWidth(label))) + "╮"),
  ];
  for (const [index, section] of sections.entries()) {
    if (index > 0) lines.push(border(`├${"─".repeat(inside)}┤`));
    for (const line of section)
      lines.push(border("│") + ` ${padded(line, content)} ` + border("│"));
  }
  lines.push(border(`╰${"─".repeat(inside)}╯`));
  return lines.map((line) => truncateToWidth(line, width));
}

export function saveSteps(step: number, theme: DialogTheme, width: number): string {
  const steps =
    width < 56
      ? ["1 Files", "2 Destination", "3 Save"]
      : ["1  Choose files", "2  Destination", "3  Review & save"];
  return steps
    .map((label, index) =>
      index + 1 === step ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label),
    )
    .join(theme.fg("dim", "   ›   "));
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Keeps every line and full path available, including after terminal resizes. */
export class DialogText {
  private offset = 0;
  private column = 0;
  private pageSize = 1;
  private width = 1;
  private readonly longest: number;

  public constructor(private readonly lines: readonly string[]) {
    this.longest = lines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
  }

  public render(width: number, rows: number): string[] {
    this.width = Math.max(1, width);
    this.pageSize = Math.max(1, rows);
    this.offset = Math.min(this.offset, Math.max(0, this.lines.length - this.pageSize));
    return this.lines
      .slice(this.offset, this.offset + this.pageSize)
      .map((line) => sliceByColumn(line, this.column, this.width));
  }

  public get position(): string {
    return `${Math.min(this.offset + 1, this.lines.length)}–${Math.min(this.lines.length, this.offset + this.pageSize)} of ${this.lines.length} lines  ·  column ${this.column + 1}`;
  }

  public handleInput(data: string): void {
    if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "down"))
      this.offset = Math.min(Math.max(0, this.lines.length - this.pageSize), this.offset + 1);
    else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - this.pageSize);
    else if (matchesKey(data, "pageDown"))
      this.offset = Math.min(
        Math.max(0, this.lines.length - this.pageSize),
        this.offset + this.pageSize,
      );
    else if (matchesKey(data, "left")) this.column = Math.max(0, this.column - 16);
    else if (matchesKey(data, "right"))
      this.column = Math.min(Math.max(0, this.longest - 1), this.column + 16);
    else if (matchesKey(data, "home")) this.column = 0;
    else if (matchesKey(data, "end")) this.column = Math.max(0, this.longest - this.width);
  }
}
