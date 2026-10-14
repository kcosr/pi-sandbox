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

  async function create(): Promise<SandboxExecutor> {
    const worker = path.join(directory, "delayed-result-worker.mjs");
    // A complete worker result is already committed, but its bytes remain in
    // transport. Writes still acknowledge and every response keeps FIFO order.
    await writeFile(
      worker,
      `import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { runSandboxWorker } from ${JSON.stringify(path.resolve("packages/sandbox-extension/src/runtime/worker.ts"))};
const write = process.stdout.write.bind(process.stdout);
let held;
process.stdout.write = (frame, callback) => {
  const response = JSON.parse(frame.subarray(4).toString());
  if (!held && response.type === "result" && existsSync("hold-result")) {
    unlinkSync("hold-result");
    held = [];
    writeFileSync("result-held", "ready");
    const timer = setInterval(() => {
      if (!existsSync("release-result")) return;
      clearInterval(timer);
      const frames = held;
      held = undefined;
      for (const buffered of frames) write(buffered);
    }, 5);
  }
  if (held) {
    held.push(Buffer.from(frame));
    queueMicrotask(() => callback?.());
    return true;
  }
  return write(frame, callback);
};
await runSandboxWorker();
`,
    );
    executor = await createBubblewrapExecutor({
      cwd,
      bubblewrapPath: BWRAP_PATH,
      workerCommand: [testSandboxWorkerCommand()[0], worker],
    });
    return executor;
  }

  it("does not retroactively time out a completed command while its result is delayed", async () => {
    const sandbox = await create();
    await writeFile(path.join(cwd, "hold-result"), "");
    const result = sandbox.execute({ argv: ["/bin/printf", "committed"], timeoutMs: 200 });
    const succeeded = expect(result).resolves.toMatchObject({
      exitCode: 0,
      stdout: Buffer.from("committed"),
    });
    await expect.poll(() => existsSync(path.join(cwd, "result-held"))).toBe(true);
    await delay(500);
    await writeFile(path.join(cwd, "release-result"), "");
    await succeeded;
  });

  it("late cancellation is request-local and cannot signal a completed group or interrupt its peer", async () => {
    const sandbox = await create();
    const peer = sandbox.execute({
      argv: [
        "/bin/bash",
        "-c",
        "touch peer-started; while ! test -e release-peer; do sleep 0.01; done; printf peer",
      ],
    });
    const peerSucceeded = expect(peer).resolves.toMatchObject({
      exitCode: 0,
      stdout: Buffer.from("peer"),
    });
    await expect.poll(() => existsSync(path.join(cwd, "peer-started"))).toBe(true);
    await writeFile(path.join(cwd, "hold-result"), "");
    const controller = new AbortController();
    const completed = sandbox.execute({ argv: ["/bin/true"] }, { signal: controller.signal });
    const cancelled = expect(completed).rejects.toMatchObject({ code: "sandbox_aborted" });
    await expect.poll(() => existsSync(path.join(cwd, "result-held"))).toBe(true);
    controller.abort();
    await writeFile(path.join(cwd, "release-peer"), "");
    await writeFile(path.join(cwd, "release-result"), "");
    await Promise.all([cancelled, peerSucceeded]);
    await expect(sandbox.execute({ argv: ["/bin/printf", "healthy"] })).resolves.toMatchObject({
      exitCode: 0,
      stdout: Buffer.from("healthy"),
    });
  });

  it("a peer timeout cannot invalidate an already completed result in transport", async () => {
    const sandbox = await create();
    const peer = sandbox.execute({
      argv: ["/bin/bash", "-c", "touch peer-started; sleep 100"],
      timeoutMs: 500,
    });
    const peerTimedOut = expect(peer).rejects.toMatchObject({ code: "sandbox_timeout" });
    await expect.poll(() => existsSync(path.join(cwd, "peer-started"))).toBe(true);
    await writeFile(path.join(cwd, "hold-result"), "");
    const result = sandbox.execute({ argv: ["/bin/printf", "committed"] });
    const succeeded = expect(result).resolves.toMatchObject({
      exitCode: 0,
      stdout: Buffer.from("committed"),
    });
    await expect.poll(() => existsSync(path.join(cwd, "result-held"))).toBe(true);
    await delay(600);
    await writeFile(path.join(cwd, "release-result"), "");
    await Promise.all([succeeded, peerTimedOut]);
  });
});
