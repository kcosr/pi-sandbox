import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDirectExecutor, resolveDirectToolCommands } from "./direct-executor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-direct-"));
  temporaryDirectories.push(cwd);
  return cwd;
}

describe("direct executor", () => {
  it("runs direct argv commands with inherited and scoped environment", async () => {
    const cwd = await temporaryCwd();
    const executor = await createDirectExecutor({
      cwd,
      ambientEnvironment: {
        HOME: "/Users/alice",
        AMBIENT_VALUE: "ambient",
        OVERRIDE_ME: "ambient",
      },
      environment: { SCOPED_VALUE: "scoped", OVERRIDE_ME: "scoped" },
    });
    try {
      await executor.probe();
      const result = await executor.execute({
        argv: [
          executor.commands.sh,
          "-c",
          'printf "%s:%s:%s" "$AMBIENT_VALUE" "$SCOPED_VALUE" "$OVERRIDE_ME"',
        ],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("ambient:scoped:scoped");
      expect(executor.backend).toBe("direct");
      expect(executor.home).toBe("/Users/alice");
    } finally {
      await executor.close();
    }
  });

  it("preserves bounded execution errors", async () => {
    const executor = await createDirectExecutor({ cwd: await temporaryCwd() });
    try {
      await expect(
        executor.execute({
          argv: [executor.commands.sh, "-c", "printf 12345"],
          maxOutputBytes: 4,
        }),
      ).rejects.toMatchObject({ code: "sandbox_output_limit_exceeded" });
    } finally {
      await executor.close();
    }
  });

  it("rejects unsupported platforms without falling back", async () => {
    await expect(resolveDirectToolCommands("win32")).rejects.toMatchObject({
      code: "sandbox_start_failed",
    });
  });
});
