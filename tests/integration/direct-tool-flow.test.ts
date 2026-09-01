import { mkdtemp, readFile, rm } from "node:fs/promises";
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
} from "../../src/extension/executor-operations.js";
import { createDirectExecutor, type SandboxExecutor } from "../../src/sandbox/index.js";

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
});
