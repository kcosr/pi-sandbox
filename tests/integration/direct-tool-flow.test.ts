import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executeEdit,
  executeFind,
  executeGrep,
  executeLs,
  executeRead,
  executeWrite,
} from "../../packages/sandbox-extension/src/tools/executor-operations.js";
import {
  createDirectExecutor,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";

describe("typed tools through direct execution", () => {
  let cwd: string;
  let executor: SandboxExecutor;

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-direct-tools-"));
    executor = await createDirectExecutor({ cwd, ambientEnvironment: { HOME: cwd } });
    await executor.probe();
  });

  afterAll(async () => {
    await executor?.close();
    await rm(cwd, { recursive: true, force: true });
  });

  it("runs the complete typed read/search/mutation flow", async () => {
    await executeWrite(executor, { path: "nested/example.txt", content: "alpha\nbeta\n" }, cwd);
    expect(await readFile(join(cwd, "nested/example.txt"), "utf8")).toBe("alpha\nbeta\n");

    const read = await executeRead(executor, { path: "nested/example.txt" }, cwd);
    expect(read.content[0]).toMatchObject({ type: "text", text: "alpha\nbeta\n" });

    await executeEdit(
      executor,
      { path: "nested/example.txt", edits: [{ oldText: "beta", newText: "gamma" }] },
      cwd,
    );
    expect(await readFile(join(cwd, "nested/example.txt"), "utf8")).toBe("alpha\ngamma\n");

    const listing = await executeLs(executor, { path: "nested" }, cwd);
    expect(listing.content[0].text).toContain("example.txt");
    const found = await executeFind(executor, { path: ".", pattern: "*.txt" }, cwd);
    expect(found.content[0].text).toContain("nested/example.txt");
    const matches = await executeGrep(executor, { path: ".", pattern: "gamma" }, cwd);
    expect(matches.content[0].text).toContain("nested/example.txt:2:gamma");
  });

  it("resolves tilde paths against the real direct-execution home", async () => {
    await executeWrite(executor, { path: "~/home.txt", content: "home\n" }, cwd);
    expect(await readFile(join(cwd, "home.txt"), "utf8")).toBe("home\n");
  });

  it("rejects a write over a directory and cleans its temporary sibling", async () => {
    const parent = join(cwd, "failed-write");
    const target = join(parent, "directory");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "unchanged\n");

    await expect(
      executeWrite(executor, { path: target, content: "replacement\n" }, cwd),
    ).rejects.toThrow(/directory/i);

    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("unchanged\n");
    expect(await readdir(target)).toEqual(["keep.txt"]);
    expect(await readdir(parent)).toEqual(["directory"]);
  });

  it("reports edit rename failure without changing the target or leaving a temporary sibling", async () => {
    const parent = join(cwd, "failed-edit");
    const target = join(parent, "target.txt");
    const rejectMove = join(cwd, "reject-move");
    await mkdir(parent);
    await writeFile(target, "before\n");
    await writeFile(rejectMove, "#!/bin/sh\nprintf 'fixture rename failed\\n' >&2\nexit 61\n", {
      mode: 0o700,
    });
    const failingMoveExecutor: SandboxExecutor = {
      cwd: executor.cwd,
      home: executor.home,
      backend: executor.backend,
      commands: { ...executor.commands, mv: rejectMove },
      probe: executor.probe.bind(executor),
      execute: executor.execute.bind(executor),
      close: executor.close.bind(executor),
    };

    await expect(
      executeEdit(
        failingMoveExecutor,
        { path: target, edits: [{ oldText: "before", newText: "after" }] },
        cwd,
      ),
    ).rejects.toThrow("fixture rename failed");

    expect(await readFile(target, "utf8")).toBe("before\n");
    expect(await readdir(parent)).toEqual(["target.txt"]);
  });
});
