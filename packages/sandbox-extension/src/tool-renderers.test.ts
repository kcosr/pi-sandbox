import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pathToolCallRenderers } from "./tool-renderers.js";

type PathTool = keyof typeof pathToolCallRenderers;
type RenderContext = Omit<
  Parameters<(typeof pathToolCallRenderers)["read"]>[2],
  "state" | "args"
> & {
  args: unknown;
  state: Record<string, unknown>;
};
const tools = Object.keys(pathToolCallRenderers) as PathTool[];
const capabilities = getCapabilities();
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Parameters<(typeof pathToolCallRenderers)["read"]>[1];

function render(tool: PathTool, args: unknown, overrides: Partial<RenderContext> = {}) {
  const context: RenderContext = Object.freeze({
    args,
    toolCallId: "historical-call",
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: Object.freeze({}),
    cwd: "/different/session/workspace",
    executionStarted: false,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
    ...overrides,
  });
  const component = pathToolCallRenderers[tool](args, theme, context);
  const output = component
    .render(1000)
    .map((line) => line.trimEnd())
    .join("\n");
  return { component, output, text: stripVTControlCharacters(output) };
}

beforeAll(() => initTheme("dark"));
beforeEach(() => setCapabilities({ images: null, trueColor: true, hyperlinks: false }));
afterEach(() => {
  setCapabilities(capabilities);
  vi.restoreAllMocks();
});

describe("sandbox tool call rendering", () => {
  it.each(tools)("keeps full %s paths including the host home and neighboring prefixes", (tool) => {
    for (const path of [homedir(), `${homedir()}/notes.txt`, `${homedir()}-other/notes.txt`]) {
      const args = Object.freeze({ path, pattern: "*.txt" });
      const { text } = render(tool, args);
      expect(text).toContain(path);
      expect(text).not.toContain("~");
    }
  });

  it.each(tools)("preserves relative and printable Unicode %s paths", (tool) => {
    expect(render(tool, { path: "../日本語/é😀 file.txt" }).text).toContain(
      "../日本語/é😀 file.txt",
    );
  });

  it.each(tools)("labels explicit %s tool-home paths without an invented host link", (tool) => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    for (const path of ["~", "~/file.txt", "@~", "@~/file.txt"]) {
      const { output } = render(tool, Object.freeze({ path }));
      expect(output).toContain(`${path} (tool home)`);
      expect(output).not.toContain("file://");
      expect(output).not.toContain(homedir());
      expect(output).not.toContain("/different/session");
    }
    expect(render(tool, { path: "~another/file.txt" }).text).not.toContain("(tool home)");
  });

  it.each(["read", "write", "ls"] as const)(
    "retains existing explicit absolute %s host-file links",
    (tool) => {
      setCapabilities({ images: null, trueColor: true, hyperlinks: true });
      const path = `${homedir()}/日本語/a #?.txt`;
      const { output, text } = render(tool, { path });
      expect(output).toContain(`\x1b]8;;${pathToFileURL(path).href}\x1b\\`);
      expect(text).toBe(`${tool} ${path}`);
      expect(render(tool, { path: "./notes.txt" }).output).not.toContain("file://");
      expect(render(tool, { path: "/unicode\u00a0space.txt" }).output).not.toContain("file://");
    },
  );

  it.each(tools)(
    "makes control characters visible in %s paths without changing arguments",
    (tool) => {
      const path = "/tmp/a\n\t\r\x1b[31m\u009b\u202e.txt";
      const args = Object.freeze({ path });
      const { output } = render(tool, args);
      expect(output).toContain('"/tmp/a\\n\\t\\r\\u001b[31m\\u009b\\u202e.txt"');
      expect(output).not.toContain("\n");
      expect(output).not.toContain("\x1b");
      expect(args.path).toBe(path);
    },
  );

  it("preserves read ranges and displays resource paths in full", () => {
    const path = `${homedir()}/skills/example/SKILL.md`;
    expect(render("read", { path, offset: 3, limit: 4 }).text).toBe(`read ${path}:3-6`);
    expect(render("read", { path, limit: 4 }).text).toBe(`read ${path}:1-4`);
    expect(render("read", { path, offset: 3 }).text).toBe(`read ${path}:3`);
  });

  it.each([
    ["25", "13", ":25-37"],
    [null, "13", ":1-13"],
    ["25", null, ":25"],
    [null, null, ""],
    [undefined, undefined, ""],
    ["abc", 13, ""],
    [25, "", ""],
    [25, "Infinity", ""],
    [false, 13, ""],
    [[], 13, ""],
  ])("formats raw read range %j, %j without changing path identity", (offset, limit, range) => {
    for (const path of [`${homedir()}/notes.txt`, "~/notes.txt"]) {
      const args = Object.freeze({ path, offset, limit });
      const label = path.startsWith("~/") ? " (tool home)" : "";
      expect(render("read", args, { argsComplete: false }).text).toBe(
        `read ${path}${label}${range}`,
      );
    }
  });

  it("preserves complete code points when escaping supplementary Unicode controls", () => {
    expect(render("read", { path: "/tmp/a\u{e0001}.txt" }).text).toBe(
      'read "/tmp/a\\u{e0001}.txt"',
    );
  });

  it("preserves search patterns, flags, context and limits", () => {
    expect(render("find", { pattern: "**/*.ts", path: ".", limit: 12 }).text).toBe(
      "find **/*.ts in . (limit 12)",
    );
    expect(render("ls", { limit: 12 }).text).toBe("ls . (limit 12)");
    expect(
      render("grep", {
        pattern: "hello|world",
        path: "src",
        glob: "*.ts",
        ignoreCase: true,
        literal: true,
        context: 2,
        limit: 12,
      }).text,
    ).toBe("grep /hello|world/ in src (*.ts) -i -F context 2 limit 12");
  });

  it("retains write syntax highlighting, streaming updates and expanded content", () => {
    const args = Object.freeze({ path: "/project/code.ts", content: "const answer = 1;\n" });
    const first = render("write", args, { argsComplete: false });
    expect(first.text).toBe("write /project/code.ts\n\nconst answer = 1;");
    expect(first.output).toContain("\x1b[");
    const content = Array.from(
      { length: 12 },
      (_, index) => `const line${index + 1} = ${index};`,
    ).join("\n");
    const next = render(
      "write",
      { ...args, content },
      { argsComplete: false, lastComponent: first.component },
    );
    expect(next.component).toBe(first.component);
    expect(next.text).toContain("const line10 = 9;");
    expect(next.text).not.toContain("const line11");
    expect(next.text).toContain("2 more lines, 12 total");
    const expanded = render(
      "write",
      { ...args, content },
      { expanded: true, lastComponent: next.component },
    );
    expect(expanded.text).toContain("const line12 = 11;");
    expect(expanded.text).not.toContain("more lines");
    expect(args.content).toBe("const answer = 1;\n");
    expect(render("write", { path: "/plain", content: "a\tb\r\n\n" }).text).toBe(
      "write /plain\n\na   b",
    );
  });

  it("handles invalid and streaming arguments without throwing or borrowing aliases", () => {
    for (const tool of tools) {
      for (const args of [undefined, null, [], {}, { path: 123 }, { path: "", pattern: false }]) {
        expect(() =>
          render(tool, args, { argsComplete: false, lastComponent: new Text() }),
        ).not.toThrow();
      }
      expect(render(tool, { path: 123 }).text).toContain("[invalid path]");
      expect(render(tool, { file_path: "/obsolete/alias" }).text).not.toContain("/obsolete/alias");
    }
    expect(render("write", { content: {} }).text).toContain("[invalid content arg");
    expect(render("grep", { pattern: {} }).text).toContain("[invalid pattern]");
  });

  it("does not inspect host files when rendering calls, including edit previews", () => {
    const read = vi.spyOn(fsPromises, "readFile");
    const readSync = vi.spyOn(fs, "readFileSync");
    const stat = vi.spyOn(fs, "statSync");
    const exists = vi.spyOn(fs, "existsSync");
    for (const tool of tools) {
      render(tool, { path: "/host/private.txt", edits: [{ oldText: "old", newText: "new" }] });
    }
    expect(read).not.toHaveBeenCalled();
    expect(readSync).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });
});
