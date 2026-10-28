import { selectedTestToolBundle } from "../support/tool-bundle.js";
import { mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBashCommandAnalyzer } from "../../src/permissions/bash/analyzer.js";
import { seatbeltCommandEnvironment } from "../../packages/sandbox-extension/src/runtime/seatbelt-executor.js";

import {
  executeEdit,
  executeFind,
  executeGrep,
  executeLs,
  executeRead,
  executeWrite,
} from "../../packages/sandbox-extension/src/tools/executor-operations.js";
import {
  createSeatbeltExecutor,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";

const toolBundle = selectedTestToolBundle();
const selectedTools = toolBundle === undefined ? {} : { toolBundle };

describe.skipIf(process.platform !== "darwin")("typed tools through Seatbelt", () => {
  let cwd: string;
  let executor: SandboxExecutor;

  beforeAll(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-seatbelt-tools-")));
    executor = await createSeatbeltExecutor({ cwd, ...selectedTools });
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

  it("resolves tilde paths against the private Seatbelt home", async () => {
    await executeWrite(executor, { path: "~/home.txt", content: "home\n" }, cwd);
    expect(await readFile(join(executor.home, "home.txt"), "utf8")).toBe("home\n");
  });

  it("classifies symbolic cd without consulting the later-created scratch HOME", async () => {
    const environment = seatbeltCommandEnvironment({}, toolBundle);
    expect(environment.HOME).toBeUndefined();
    const analyzer = createBashCommandAnalyzer({ backend: "seatbelt", cwd, environment });
    await mkdir(join(executor.home, "read-only-child"));
    await writeFile(join(executor.home, "read-only-child", "marker"), "home-marker\n");
    const command = "cd ~/read-only-child && pwd && cat marker; sleep 0";
    expect(await analyzer.analyze(command)).toMatchObject({
      commandClass: "known_read_only",
      version: 2,
    });
    const result = await executor.execute({ argv: ["/bin/bash", "-c", command], timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`${executor.home}/read-only-child\nhome-marker\n`);
    expect(result.stderr.toString()).toBe("");
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
