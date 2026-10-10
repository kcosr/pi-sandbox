import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBubblewrapExecutor,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";
import { testSandboxWorkerCommand } from "../helpers/sandbox-worker.js";

const BWRAP_PATH = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
const AVAILABLE = process.platform === "linux" && existsSync(BWRAP_PATH);

describe.skipIf(!AVAILABLE)("Bubblewrap transport progress", () => {
  let directory: string;
  let cwd: string;
  let executor: SandboxExecutor | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp", "pi-transport-"),
    );
    cwd = path.join(directory, "workspace");
    await mkdir(cwd);
  });

  afterEach(async () => {
    await executor?.close();
    executor = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  it.each(["command", "sandbox"] as const)(
    "%s acknowledgements tolerate a slowly progressing input backlog",
    async (processLifetime) => {
      const worker = path.join(directory, "slow-input-worker.mjs");
      // Apply real pipe backpressure while delivering partial frames steadily.
      // A fixed 10s completion/retirement deadline would kill healthy work.
      await writeFile(
        worker,
        `import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runSandboxWorker } from ${JSON.stringify(path.resolve("packages/sandbox-extension/src/runtime/worker.ts"))};
const on = process.stdin.on.bind(process.stdin);
let throttleUntil;
process.stdin.on = (event, listener) => {
  if (event !== "data") return on(event, listener);
  return on(event, async chunk => {
    if (throttleUntil === undefined && existsSync("throttle")) {
      throttleUntil = Date.now() + 11500;
      writeFileSync("throttling", "ready");
    }
    if (throttleUntil === undefined || Date.now() >= throttleUntil) {
      listener(chunk);
      return;
    }
    process.stdin.pause();
    let offset = 0;
    while (offset < chunk.length && Date.now() < throttleUntil) {
      const end = Math.min(offset + 4096, chunk.length);
      listener(chunk.subarray(offset, end));
      offset = end;
      await delay(20);
    }
    if (offset < chunk.length) listener(chunk.subarray(offset));
    process.stdin.resume();
  });
};
await runSandboxWorker();
`,
      );
      executor = await createBubblewrapExecutor({
        cwd,
        bubblewrapPath: BWRAP_PATH,
        processLifetime,
        workerCommand: [testSandboxWorkerCommand()[0], worker],
      });
      const first = executor.execute({
        argv: [
          "/bin/sh",
          "-c",
          "touch first-started; while ! test -e release; do sleep 0.01; done; printf first",
        ],
        timeoutMs: 30_000,
      });
      const firstSucceeded = expect(first).resolves.toMatchObject({
        exitCode: 0,
        stdout: Buffer.from("first"),
      });
      await expect.poll(() => existsSync(path.join(cwd, "first-started"))).toBe(true);
      await writeFile(path.join(cwd, "throttle"), "");
      const started = Date.now();
      const second = executor.execute({
        argv: ["/usr/bin/wc", "-c"],
        stdin: Buffer.alloc(2 * 1024 * 1024, 97),
        timeoutMs: 30_000,
      });
      const secondSucceeded = expect(second).resolves.toMatchObject({
        exitCode: 0,
        stdout: Buffer.from("2097152\n"),
      });
      await expect.poll(() => existsSync(path.join(cwd, "throttling"))).toBe(true);
      await writeFile(path.join(cwd, "release"), "");
      await Promise.all([firstSucceeded, secondSucceeded]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(11_000);
      await expect(executor.execute({ argv: ["/bin/printf", "healthy"] })).resolves.toMatchObject({
        exitCode: 0,
        stdout: Buffer.from("healthy"),
      });
    },
    40_000,
  );
});
