import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatReadLineRange,
  getLanguageFromPath,
  highlightCode,
  keyHint,
  type Theme,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { normalizeSandboxPath } from "./tools/executor-operations.js";

type PathTool = "read" | "write" | "edit" | "ls" | "find" | "grep";
type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;

function stringArgument(value: unknown): string | null {
  return value == null ? "" : typeof value === "string" ? value : null;
}

// Quote control-bearing arguments so they cannot alter the terminal or disguise path boundaries.
// Printable Unicode and ordinary path spelling are preserved.
function inlineText(value: string): string {
  const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
  if (!controls.test(value)) return value;
  return JSON.stringify(value).replace(controls, (character) => {
    const code = character.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function renderPath(value: unknown, tool: PathTool, theme: Theme): string {
  const rawPath = stringArgument(value);
  if (rawPath === null) return theme.fg("error", "[invalid path]");
  const path = rawPath || (["ls", "find", "grep"].includes(tool) ? "." : "");
  if (!path) return theme.fg("toolOutput", "...");
  const text = theme.fg("accent", inlineText(path));
  // A row may belong to an old session whose executor home no longer exists. Never resolve a
  // historical ~ against the current executor, or Pi's host home, merely to draw its header.
  const executionPath = path.startsWith("@") ? path.slice(1) : path;
  if (executionPath === "~" || executionPath.startsWith("~/")) {
    return `${text}${theme.fg("muted", " (tool home)")}`;
  }
  // Retain the stock file links for explicit absolute read/write/ls paths. Relative paths and
  // executor-home paths have no recorded host target and must not acquire an invented one.
  if (
    ["read", "write", "ls"].includes(tool) &&
    isAbsolute(path) &&
    normalizeSandboxPath("/", path) === path &&
    getCapabilities().hyperlinks
  ) {
    return hyperlink(text, pathToFileURL(path).href);
  }
  return text;
}

function numberArgument(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function writePreview(args: Record<string, unknown>, theme: Theme, expanded: boolean): string {
  const content = stringArgument(args.content);
  if (content === null)
    return `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
  if (!content) return "";
  const lines = content.replace(/\r/g, "").replace(/\t/g, "   ").split("\n");
  while (lines.at(-1) === "") lines.pop();
  const displayed = expanded ? lines : lines.slice(0, 10);
  const language = typeof args.path === "string" ? getLanguageFromPath(args.path) : undefined;
  // Highlight the visible prefix as a unit, retaining multiline syntax and bounded work while
  // collapsed arguments stream in. Expanded calls show the complete supplied content.
  const preview = language
    ? highlightCode(displayed.join("\n"), language).join("\n")
    : theme.fg("toolOutput", displayed.join("\n"));
  const remaining = lines.length - displayed.length;
  const hint =
    remaining > 0
      ? `${theme.fg("muted", `\n... (${remaining} more lines, ${lines.length} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
      : "";
  return `\n\n${preview}${hint}`;
}

function createCallRenderer(tool: PathTool): CallRenderer {
  return (rawArgs: unknown, theme, context) => {
    const args =
      typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const title = theme.fg("toolTitle", theme.bold(tool));
    const path = renderPath(args.path, tool, theme);
    let text = `${title} ${path}`;
    if (tool === "read") text += theme.fg("warning", formatReadLineRange(args.offset, args.limit));
    if (tool === "find" || tool === "grep") {
      const pattern = stringArgument(args.pattern);
      const patternText =
        pattern === null
          ? theme.fg("error", "[invalid pattern]")
          : theme.fg("accent", tool === "grep" ? `/${inlineText(pattern)}/` : inlineText(pattern));
      text = `${title} ${patternText}${theme.fg("toolOutput", " in ")}${path}`;
    }
    if (tool === "grep") {
      const glob = stringArgument(args.glob);
      if (glob) text += theme.fg("toolOutput", ` (${inlineText(glob)})`);
      if (args.ignoreCase === true) text += theme.fg("toolOutput", " -i");
      if (args.literal === true) text += theme.fg("toolOutput", " -F");
      if (numberArgument(args.context)) text += theme.fg("toolOutput", ` context ${args.context}`);
      if (numberArgument(args.limit)) text += theme.fg("toolOutput", ` limit ${args.limit}`);
    } else if ((tool === "ls" || tool === "find") && numberArgument(args.limit)) {
      text += theme.fg("toolOutput", ` (limit ${args.limit})`);
    }
    if (tool === "write") text += writePreview(args, theme, context.expanded);
    // In particular, never invoke Pi's edit call renderer: its diff preview reads host files
    // before authorization, including for disabled tools displayed in historical sessions.
    const component =
      context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    component.setText(text);
    return component;
  };
}

export const pathToolCallRenderers: Readonly<Record<PathTool, CallRenderer>> = {
  read: createCallRenderer("read"),
  write: createCallRenderer("write"),
  edit: createCallRenderer("edit"),
  ls: createCallRenderer("ls"),
  find: createCallRenderer("find"),
  grep: createCallRenderer("grep"),
};

export function pathToolCallRenderer(tool: string): CallRenderer | undefined {
  return Object.hasOwn(pathToolCallRenderers, tool)
    ? pathToolCallRenderers[tool as PathTool]
    : undefined;
}
