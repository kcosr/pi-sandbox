import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SmolvmCli, createStateEnvironment } from "./cli.js";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(smolvmPath = process.execPath) {
  const stateDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), "smol-cli-")));
  directories.push(stateDirectory);
  return new SmolvmCli({ smolvmPath, stateDirectory });
}

describe("bounded in-process smolvm CLI", () => {
  it("uses only its private environment and preserves binary streams", async () => {
    const cli = await fixture();
    // Observe the launch environment before Node initializes platform libraries.
    const envCli = await fixture("/usr/bin/env");
    try {
      const result = await cli.run({
        argv: ["-e", "process.stdin.pipe(process.stdout)"],
        stdin: Uint8Array.of(0, 255, 42),
      });
      expect(result.stdout).toEqual(Buffer.from([0, 255, 42]));
      const env = await envCli.run({ argv: ["--"] });
      expect(env.stdout.toString().trimEnd().split("\n").sort()).toEqual(
        Object.entries(createStateEnvironment(envCli.stateDirectory))
          .map(([key, value]) => `${key}=${value}`)
          .sort(),
      );
    } finally {
      await cli.dispose();
      await envCli.dispose();
    }
  });
  it("cancels running commands but still permits a subsequent cleanup command", async () => {
    const cli = await fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const command = cli.run(
      { argv: ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"] },
      { onStdout: started },
    );
    const rejected = expect(command).rejects.toMatchObject({ code: "sandbox_aborted" });
    await ready;
    await cli.cancelActive();
    await rejected;
    expect(
      (await cli.run({ argv: ["-e", "process.stdout.write('cleanup')"] })).stdout.toString(),
    ).toBe("cleanup");
    await cli.dispose();
    await expect(cli.run({ argv: ["-e", ""] })).rejects.toMatchObject({ code: "sandbox_closed" });
  });
  it("enforces timeouts and output limits and rejects host-context overrides", async () => {
    const cli = await fixture();
    try {
      await expect(
        cli.run({ argv: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 25 }),
      ).rejects.toMatchObject({ code: "sandbox_timeout" });
      await expect(
        cli.run({ argv: ["-e", "process.stdout.write('too much')"], maxOutputBytes: 3 }),
      ).rejects.toMatchObject({ code: "sandbox_output_limit_exceeded" });
      await expect(cli.run({ argv: ["-e", ""], cwd: "/" })).rejects.toMatchObject({
        code: "sandbox_invalid_request",
      });
      await expect(readFile(path.join(cli.stateDirectory, "unexpected"))).rejects.toBeDefined();
    } finally {
      await cli.dispose();
    }
  });
});
