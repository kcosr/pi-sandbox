import { selectedTestToolBundle } from "../../../../tests/support/tool-bundle.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDirectExecutor,
  directCommandEnvironment,
  resolveDirectToolCommands,
} from "./direct-executor.js";

const toolBundle = selectedTestToolBundle();
const selectedTools = toolBundle === undefined ? {} : { toolBundle };

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryCwd(): Promise<string> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-direct-")));
  temporaryDirectories.push(cwd);
  return cwd;
}

describe("direct executor", () => {
  it("runs direct argv commands with inherited and scoped environment", async () => {
    const cwd = await temporaryCwd();
    const executor = await createDirectExecutor({
      cwd,
      ...selectedTools,
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
      expect(executor.home).toBe("/Users/alice");
    } finally {
      await executor.close();
    }
  });

  it("passes exactly the described command environment", async () => {
    const ambientEnvironment = {
      HOME: "/Users/alice",
      PATH: "/usr/bin:/bin",
      KEEP: "ambient",
      PI_SANDBOX_SECRET: "internal",
      UNSET: undefined,
    };
    const environment = { KEEP: "scoped" };
    const expected = directCommandEnvironment(ambientEnvironment, environment, toolBundle);
    expect(expected).not.toHaveProperty("PI_SANDBOX_SECRET");
    expect(expected).not.toHaveProperty("UNSET");
    expect(Object.isFrozen(expected)).toBe(true);
    const executor = await createDirectExecutor({
      cwd: await temporaryCwd(),
      ...selectedTools,
      ambientEnvironment,
      environment,
    });
    try {
      const result = await executor.execute({
        argv: [
          executor.commands.sh,
          "-c",
          'printf "%s|%s|%s" "$PATH" "$KEEP" "${PI_SANDBOX_SECRET-unset}"',
        ],
      });
      expect(result.stdout.toString()).toBe(`${expected.PATH}|scoped|unset`);
    } finally {
      await executor.close();
    }
    expect(
      directCommandEnvironment({ PATH: "/usr/bin" }, {}, { root: "/opt/tools", commands: {} }).PATH,
    ).toBe("/opt/tools/bin:/usr/bin");
    expect(directCommandEnvironment({}, {}, { root: "/opt/tools", commands: {} }).PATH).toBe(
      "/opt/tools/bin:/usr/bin:/bin",
    );
  });

  it("preserves bounded execution errors", async () => {
    const executor = await createDirectExecutor({ cwd: await temporaryCwd(), ...selectedTools });
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

  it("rejects per-command context overrides", async () => {
    const executor = await createDirectExecutor({ cwd: await temporaryCwd(), ...selectedTools });
    try {
      for (const context of [{ cwd: "/" }, { environment: { VALUE: "override" } }]) {
        await expect(
          executor.execute({ argv: [executor.commands.sh, "-c", "exit 0"], ...context }),
        ).rejects.toMatchObject({ code: "sandbox_invalid_request" });
      }
    } finally {
      await executor.close();
    }
  });
});
