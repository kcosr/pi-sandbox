import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBubblewrapExecutor,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";
import { testSandboxWorkerCommand } from "../helpers/sandbox-worker.js";

const BWRAP_PATH = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
const AVAILABLE = process.platform === "linux" && existsSync(BWRAP_PATH);

describe.skipIf(!AVAILABLE)("parallel Bubblewrap completion protocol", () => {
  let directory: string;
  let cwd: string;
  let executor: SandboxExecutor | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp", "pi-completion-"),
    );
    cwd = path.join(directory, "workspace");
    await mkdir(cwd);
  });

  afterEach(async () => {
    await executor?.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function create(delayed: "accept" | "cancel" | "completed"): Promise<SandboxExecutor> {
    const worker = path.join(directory, "delayed-input-worker.mjs");
    // Hold a complete parent frame and everything behind it, preserving FIFO
    // order as a stalled pipe would. The worker's own peer timeout still runs.
    await writeFile(
      worker,
      `import { existsSync, writeFileSync } from "node:fs";
import { runSandboxWorker } from ${JSON.stringify(path.resolve("packages/sandbox-extension/src/runtime/worker.ts"))};
const write = process.stdout.write.bind(process.stdout);
let outputHeld;
process.stdout.write = (frame, callback) => {
  const response = JSON.parse(frame.subarray(4).toString());
  if (${JSON.stringify(delayed)} === "completed" && response.type === "completed" && !outputHeld) {
    outputHeld = [];
    writeFileSync("output-held", "ready");
    const timer = setInterval(() => {
      if (!existsSync("release-output")) return;
      clearInterval(timer);
      const frames = outputHeld;
      outputHeld = undefined;
      for (const buffered of frames) write(buffered);
    }, 5);
  }
  if (outputHeld) {
    outputHeld.push(Buffer.from(frame));
    if (response.type === "failure") writeFileSync("failure-held", "ready");
    queueMicrotask(() => callback?.());
    return true;
  }
  return write(frame, callback);
};
const on = process.stdin.on.bind(process.stdin);
let buffer = Buffer.alloc(0);
let held;
let delayed = false;
process.stdin.on = (event, listener) => {
  if (event !== "data") return on(event, listener);
  return on(event, chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const length = 4 + buffer.readUInt32BE(0);
      const frame = Buffer.from(buffer.subarray(0, length));
      buffer = buffer.subarray(length);
      const request = JSON.parse(frame.subarray(4).toString());
      if (!delayed && request.type === ${JSON.stringify(delayed)}) {
        delayed = true;
        held = [];
        writeFileSync("input-held", "ready");
        const timer = setInterval(() => {
          if (!existsSync("release-input")) return;
          clearInterval(timer);
          const frames = held;
          held = undefined;
          for (const buffered of frames) listener(buffered);
        }, 5);
      }
      if (held) held.push(frame);
      else listener(frame);
    }
  });
};
await runSandboxWorker();
`,
    );
    executor = await createBubblewrapExecutor({
      cwd,
      bubblewrapPath: BWRAP_PATH,
      processLifetime: "sandbox",
      workerCommand: [testSandboxWorkerCommand()[0], worker],
    });
    return executor;
  }

  it.each(["accept", "cancel"] as const)(
    "consumes a delayed %s after peer cleanup without touching newly admitted work",
    async (delayed) => {
      const sandbox = await create(delayed);
      const peer = sandbox.execute({
        argv: ["/bin/bash", "-c", "touch peer-started; sleep 100"],
        timeoutMs: 1_000,
      });
      const peerFailed = expect(peer).rejects.toMatchObject({ code: "sandbox_timeout" });
      await expect.poll(() => existsSync(path.join(cwd, "peer-started"))).toBe(true);
      const controller = new AbortController();
      const offered = sandbox.execute(
        { argv: ["/bin/bash", "-c", "touch offered-started; sleep 0.1; printf offered"] },
        { signal: controller.signal },
      );
      const offeredFailed = expect(offered).rejects.toMatchObject({ code: "sandbox_aborted" });
      if (delayed === "cancel") {
        await expect.poll(() => existsSync(path.join(cwd, "offered-started"))).toBe(true);
        controller.abort();
      }
      await expect.poll(() => existsSync(path.join(cwd, "input-held"))).toBe(true);
      await Promise.all([peerFailed, offeredFailed]);

      // Cleanup is done, but its terminal retirements still sit behind the old
      // accept/cancel. Reuse must wait until the worker consumes those frames.
      const next = sandbox.execute({
        argv: ["/bin/bash", "-c", "touch next-started; sleep 0.1; printf next"],
      });
      const nextSucceeded = expect(next).resolves.toMatchObject({
        exitCode: 0,
        stdout: Buffer.from("next"),
      });
      await delay(100);
      expect(existsSync(path.join(cwd, "next-started"))).toBe(false);
      await writeFile(path.join(cwd, "release-input"), "");
      await nextSucceeded;
      await expect(sandbox.execute({ argv: ["/bin/printf", "healthy"] })).resolves.toMatchObject({
        exitCode: 0,
        stdout: Buffer.from("healthy"),
      });
    },
  );

  it("preserves committed success when a peer fails before its final acknowledgement arrives", async () => {
    const sandbox = await create("completed");
    const peer = sandbox.execute({
      argv: ["/bin/bash", "-c", "touch peer-started; sleep 100"],
      timeoutMs: 1_000,
    });
    const peerFailed = expect(peer).rejects.toMatchObject({ code: "sandbox_timeout" });
    await expect.poll(() => existsSync(path.join(cwd, "peer-started"))).toBe(true);
    const committed = sandbox.execute({ argv: ["/bin/printf", "committed"] });
    const committedSucceeded = expect(committed).resolves.toMatchObject({
      exitCode: 0,
      stdout: Buffer.from("committed"),
    });
    await expect.poll(() => existsSync(path.join(cwd, "output-held"))).toBe(true);
    await expect.poll(() => existsSync(path.join(cwd, "failure-held"))).toBe(true);

    const next = sandbox.execute({ argv: ["/bin/bash", "-c", "touch next-started; printf next"] });
    const nextSucceeded = expect(next).resolves.toMatchObject({
      exitCode: 0,
      stdout: Buffer.from("next"),
    });
    await delay(100);
    expect(existsSync(path.join(cwd, "next-started"))).toBe(false);
    await writeFile(path.join(cwd, "release-output"), "");
    await Promise.all([committedSucceeded, peerFailed, nextSucceeded]);
  });
});
