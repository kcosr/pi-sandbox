import { describe, expect, it, vi } from "vitest";

import { LINUX_TOOL_COMMANDS, type SandboxExecutor } from "../sandbox/index.js";
import {
  executeEdit,
  executeFind,
  executeGrep,
  executeLs,
  executeRead,
  executeWrite,
} from "./executor-operations.js";

function scriptedExecutor(
  handler: Parameters<typeof createExecutor>[0],
): SandboxExecutor & { readonly calls: Parameters<typeof handler>[0][] } {
  return createExecutor(handler);
}

function createExecutor(
  handler: (
    request: Parameters<SandboxExecutor["execute"]>[0],
    options: Parameters<SandboxExecutor["execute"]>[1],
  ) => ReturnType<SandboxExecutor["execute"]>,
): SandboxExecutor & { readonly calls: Parameters<typeof handler>[0][] } {
  const calls: Parameters<typeof handler>[0][] = [];
  return {
    cwd: "/work/project",
    home: "/run/pi-sandbox/home",
    backend: "bubblewrap",
    commands: LINUX_TOOL_COMMANDS,
    calls,
    probe: () => Promise.resolve(),
    close: () => Promise.resolve(),
    execute(request, options) {
      calls.push(request);
      return handler(request, options);
    },
  };
}

function result(stdout: Buffer | string, exitCode = 0, stderr = "") {
  return Promise.resolve({
    exitCode,
    signal: null,
    stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout,
    stderr: Buffer.from(stderr),
  });
}

describe("extension-owned tool semantics", () => {
  it("translates structured operation commands through the executor profile", async () => {
    const executor = createExecutor((request) => result(request.argv.join("\n")));
    const portableCommands = Object.fromEntries(
      Object.keys(LINUX_TOOL_COMMANDS).map((name) => [name, `/portable/${name}`]),
    ) as SandboxExecutor["commands"];
    Object.assign(executor, { commands: portableCommands });

    await executeWrite(executor, { path: "a.txt", content: "value" }, executor.cwd);
    const request = executor.calls[0];
    expect(request?.argv[0]).toBe("/portable/sh");
    expect(request?.argv[2]).toContain("/portable/mkdir");
    expect(request?.argv[2]).toContain("/portable/chmod");
    expect(request?.argv[2]).toContain("/portable/mv");
    expect(request?.argv[2]).not.toMatch(/\/(?:bin|usr\/bin)\/(?:mkdir|chmod|mv)/u);

    const editExecutor = createExecutor((editRequest) =>
      editRequest.argv[0] === "/portable/cat" ? result("old\n") : result(""),
    );
    Object.assign(editExecutor, { commands: portableCommands });
    await executeEdit(
      editExecutor,
      { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] },
      editExecutor.cwd,
    );
    const editRequest = editExecutor.calls.find(
      (call) => call.argv[0] === "/portable/sh" && call.argv.includes("-c"),
    );
    expect(editRequest?.argv[2]).toContain("/portable/sha256sum");
    expect(editRequest?.argv[2]).not.toContain("/usr/portable/sha256sum");
  });

  it("reads offsets without transferring the whole file and supports images larger than 8 MiB", async () => {
    const textExecutor = scriptedExecutor((request) =>
      request.argv[0] === "/usr/bin/file"
        ? result("text/plain\n")
        : result("two\nthree\n", 0, "PI_SANDBOX_TOTAL_LINES=4\nPI_SANDBOX_FIRST_LINE_BYTES=4\n"),
    );
    const text = await executeRead(
      textExecutor,
      { path: "large.txt", offset: 2, limit: 2 },
      textExecutor.cwd,
    );
    expect(text.content[0]).toMatchObject({
      type: "text",
      text: "two\nthree\n\n[1 more lines in file. Use offset=4 to continue.]",
    });
    expect(textExecutor.calls.at(-1)?.argv).toContain("2");

    // A decoder must safely reject an invalid oversized image rather than returning its raw
    // multi-megabyte payload to the model. The sandbox transfer ceiling still permits images
    // beyond the text preview limit so valid images can be resized in extension memory.
    const imageBytes = Buffer.alloc(9 * 1024 * 1024, 7);
    const imageExecutor = scriptedExecutor((request) =>
      request.argv[0] === "/usr/bin/file" ? result("image/png\n") : result(imageBytes),
    );
    const image = await executeRead(imageExecutor, { path: "large.png" }, imageExecutor.cwd);
    expect(image.content).toEqual([
      {
        type: "text",
        text: "Read image file [image/png]\nImage could not be safely resized for the model.",
      },
    ]);
    expect(imageExecutor.calls.at(-1)?.maxOutputBytes).toBe(64 * 1024 * 1024);
  });

  it("writes in one cancellable sandbox child with normalized absolute paths", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const executor = scriptedExecutor((request, options) => {
      if (request.argv[0] === "/bin/rm") return result("");
      receivedSignal = options?.signal;
      expect(request.stdin).toBe("contents");
      expect(request.argv).toContain("/work/project/nested");
      expect(request.argv).toContain("/work/project/nested/a.txt");
      expect(request.argv.at(-1)).toMatch(/^\/work\/project\/nested\/\.a\.txt\.pi-sandbox-write-/u);
      return result("");
    });
    await executeWrite(
      executor,
      { path: "nested/a.txt", content: "contents" },
      executor.cwd,
      controller.signal,
    );
    expect(receivedSignal).toBe(controller.signal);
    expect(executor.calls[0]?.argv[2]).toContain("/bin/mv -fT");
  });

  it("fails rather than moving a file into an existing directory target", async () => {
    const executor = scriptedExecutor((request) =>
      request.argv[0] === "/bin/rm" ? result("") : result("", 1, "cannot overwrite directory"),
    );
    await expect(
      executeWrite(executor, { path: "existing-directory", content: "value" }, executor.cwd),
    ).rejects.toThrow("cannot overwrite directory");
    expect(executor.calls[0]?.argv[2]).toContain("/bin/mv -fT");
    expect(executor.calls.at(-1)?.argv[0]).toBe("/bin/rm");
  });

  it("normalizes stock path syntax using the sandbox home without host probes", async () => {
    const observed: string[] = [];
    const executor = scriptedExecutor((request) => {
      if (request.argv[0] === "/bin/rm") return result("");
      observed.push(...request.argv);
      return result("");
    });
    await executeWrite(
      executor,
      { path: "@~/folder\u202Fname/a.txt", content: "value" },
      executor.cwd,
    );
    expect(observed).toContain("/run/pi-sandbox/home/folder name/a.txt");
  });

  it("serializes same-path mutations while allowing different paths in parallel", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const executor = scriptedExecutor((request) => {
      if (request.argv[0] === "/bin/rm") return result("");
      const target = request.argv.at(-2) ?? "";
      started.push(target);
      return new Promise((resolveResult) => {
        releases.set(target, () =>
          resolveResult({
            exitCode: 0,
            signal: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
          }),
        );
      });
    });
    const first = executeWrite(executor, { path: "same.txt", content: "one" }, executor.cwd);
    await vi.waitFor(() => expect(started).toContain("/work/project/same.txt"));
    const second = executeWrite(executor, { path: "same.txt", content: "two" }, executor.cwd);
    const other = executeWrite(executor, { path: "other.txt", content: "other" }, executor.cwd);
    await vi.waitFor(() => expect(started).toContain("/work/project/other.txt"));
    expect(started.filter((path) => path === "/work/project/same.txt")).toHaveLength(1);
    releases.get("/work/project/other.txt")?.();
    releases.get("/work/project/same.txt")?.();
    await first;
    await vi.waitFor(() =>
      expect(started.filter((path) => path === "/work/project/same.txt")).toHaveLength(2),
    );
    releases.get("/work/project/same.txt")?.();
    await Promise.all([second, other]);
  });

  it("uses the same normalized-path queue for edit and write", async () => {
    let releaseEdit = (): void => undefined;
    let editCommitStarted = false;
    let writeStarted = false;
    const executor = scriptedExecutor((request) => {
      if (request.argv[0] === "/bin/cat") return result("old\n");
      if (request.argv[0] === "/bin/rm") return result("");
      if (request.argv.includes("pi-sandbox-edit")) {
        editCommitStarted = true;
        return new Promise((resolveResult) => {
          releaseEdit = () =>
            resolveResult({
              exitCode: 0,
              signal: null,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
            });
        });
      }
      writeStarted = true;
      return result("");
    });
    const edit = executeEdit(
      executor,
      { path: "@same\u202Ffile.txt", edits: [{ oldText: "old", newText: "new" }] },
      executor.cwd,
    );
    await vi.waitFor(() => expect(editCommitStarted).toBe(true));
    const write = executeWrite(
      executor,
      { path: "same file.txt", content: "replacement" },
      executor.cwd,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeStarted).toBe(false);
    releaseEdit();
    await edit;
    await write;
    expect(writeStarted).toBe(true);
  });

  it("reports read offsets beyond EOF", async () => {
    const executor = scriptedExecutor((request) =>
      request.argv[0] === "/usr/bin/file"
        ? result("text/plain\n")
        : result("", 0, "PI_SANDBOX_TOTAL_LINES=3\nPI_SANDBOX_FIRST_LINE_BYTES=0\n"),
    );
    await expect(executeRead(executor, { path: "a.txt", offset: 4 }, executor.cwd)).rejects.toThrow(
      "beyond end of file (3 lines total)",
    );
  });

  it("rejects missing paths and directories before reading", async () => {
    for (const stderr of ["No such file", "not a regular file"]) {
      const executor = scriptedExecutor((request) =>
        request.argv[0] === "/usr/bin/test" ? result("", 1, stderr) : result("unexpected"),
      );
      await expect(executeRead(executor, { path: "bad" }, executor.cwd)).rejects.toThrow(stderr);
      expect(executor.calls).toHaveLength(1);
    }
  });

  it("handles BMP as an image and emits the stock first-line continuation guidance", async () => {
    const bmp = scriptedExecutor((request) => {
      if (request.argv[0] === "/usr/bin/test") return result("");
      if (request.argv[0] === "/usr/bin/file") return result("image/bmp\n");
      return result(Buffer.alloc(1024, 1));
    });
    const image = await executeRead(bmp, { path: "image.bmp" }, bmp.cwd);
    const imageNote = image.content[0];
    expect(imageNote?.type).toBe("text");
    if (imageNote?.type === "text") expect(imageNote.text).toContain("Read image file [image/bmp]");

    const longLine = "x".repeat(60 * 1024);
    const text = scriptedExecutor((request) => {
      if (request.argv[0] === "/usr/bin/test") return result("");
      if (request.argv[0] === "/usr/bin/file") return result("text/plain\n");
      return result(
        longLine,
        0,
        `PI_SANDBOX_TOTAL_LINES=1\nPI_SANDBOX_FIRST_LINE_BYTES=${longLine.length}\n`,
      );
    });
    const read = await executeRead(text, { path: "long.txt" }, text.cwd);
    const note = read.content[0];
    expect(note?.type).toBe("text");
    if (note?.type === "text") {
      expect(note.text).toContain("[Line 1 is 60.0KB, exceeds 50.0KB limit.");
      expect(note.text).toContain("Use bash: sed -n '1p'");
    }
  });

  it("applies unique non-overlapping edits, preserves BOM/CRLF, and performs a stale-file hash check", async () => {
    let written: string | Uint8Array | undefined;
    const executor = scriptedExecutor((request) => {
      if (request.argv[0] === "/bin/cat") return result(Buffer.from("\uFEFFold\r\nline\r\n"));
      if (request.argv[0] === "/bin/rm") return result("");
      written = request.stdin;
      expect(request.argv[2]).toContain("sha256sum");
      expect(request.argv.at(-2)).toMatch(/^[a-f0-9]{64}$/u);
      expect(request.argv.at(-1)).toMatch(/^\/work\/project\/\.a\.txt\.pi-sandbox-edit-/u);
      return result("");
    });
    await executeEdit(
      executor,
      { path: "a.txt", edits: [{ oldText: "old\nline", newText: "new\nline" }] },
      executor.cwd,
    );
    expect(written).toBe("\uFEFFnew\r\nline\r\n");

    const ambiguous = scriptedExecutor(() => result("same same"));
    await expect(
      executeEdit(
        ambiguous,
        { path: "a.txt", edits: [{ oldText: "same", newText: "new" }] },
        ambiguous.cwd,
      ),
    ).rejects.toThrow("not unique");
    expect(ambiguous.calls).toHaveLength(1);
  });

  it("lists directories truthfully and preserves directory suffixes", async () => {
    const executor = scriptedExecutor(() => result("Dir\td\0z.txt\tf\0"));
    const listed = await executeLs(executor, { path: "." }, executor.cwd);
    expect(listed.content[0].text).toBe("Dir/\nz.txt");

    const regularFile = scriptedExecutor(() => result("", 20, "Not a directory: /work/a.txt"));
    await expect(executeLs(regularFile, { path: "/work/a.txt" }, regularFile.cwd)).rejects.toThrow(
      "Not a directory",
    );
  });

  it("finds files using basename and path-aware GNU find glob semantics", async () => {
    const executor = scriptedExecutor((request) =>
      request.argv.includes("src/*.ts")
        ? result("/work/project/src/a.ts\0")
        : result("/work/project/src/a.ts\0/work/project/root.ts\0"),
    );
    const basename = await executeFind(executor, { pattern: "*.ts" }, executor.cwd);
    expect(basename.content[0].text).toBe("src/a.ts\nroot.ts");
    const pathMatch = await executeFind(executor, { pattern: "src/*.ts" }, executor.cwd);
    expect(pathMatch.content[0].text).toBe("src/a.ts");
    const limited = await executeFind(executor, { pattern: "*.ts", limit: 1 }, executor.cwd);
    expect(limited.details).toEqual({ resultLimitReached: 1 });
    expect(executor.calls.at(-1)?.argv).toEqual(expect.arrayContaining(["base", "*.ts", "2"]));
  });

  it("sizes ls capture for limit plus one maximum-length names", async () => {
    const executor = scriptedExecutor(() => result("a\tf\0"));
    await executeLs(executor, { path: ".", limit: 500 }, executor.cwd);
    expect(executor.calls[0]?.maxOutputBytes).toBe(501 * 258);
  });

  it("limits grep by matches while retaining context lines", async () => {
    const executor = scriptedExecutor(() =>
      result("a:1:first\na-2-context\n--\na:3:second\na-4-context\n--\na:5:third\n"),
    );
    const grepped = await executeGrep(
      executor,
      { pattern: "x", context: 1, limit: 2 },
      executor.cwd,
    );
    expect(grepped.content[0].text).toBe("a:1:first\na-2-context\n--\na:3:second\na-4-context\n--");
    expect(grepped.details).toEqual({ matchLimitReached: 2 });
  });
});
