import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readBoundedFile } from "./bounds.js";

it("rejects a FIFO without blocking the application event loop", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagents-fifo-"));
  try {
    const path = join(directory, "config.json");
    execFileSync("mkfifo", [path]);
    expect(() => readBoundedFile(path, 4096)).toThrow("file limit");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
