import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBubblewrapExecutor,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";
import { testSandboxWorkerCommand } from "../helpers/sandbox-worker.js";

const BWRAP = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
const AVAILABLE = process.platform === "linux" && existsSync(BWRAP);

describe.skipIf(!AVAILABLE)("parallel Bubblewrap execution", () => {
  let root: string;
  let cwd: string;
  let executor: SandboxExecutor | undefined;

  beforeEach(async () => {
    root = await mkdtemp(
      path.join(process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp", "pi-parallel-"),
    );
    cwd = path.join(root, "workspace");
    await mkdir(cwd);
  });
  afterEach(async () => {
    await executor?.close();
    executor = undefined;
    await rm(root, { recursive: true, force: true });
  });

  async function create(processLifetime: "command" | "sandbox" = "sandbox") {
    executor = await createBubblewrapExecutor({
      cwd,
      bubblewrapPath: BWRAP,
      processLifetime,
      workerCommand: testSandboxWorkerCommand(),
    });
    return executor;
  }
  async function marked(name: string) {
    await expect.poll(() => existsSync(path.join(cwd, name))).toBe(true);
  }
  function command(source: string, timeoutMs = 10_000, maxOutputBytes = 1_048_576) {
    return { argv: ["/bin/bash", "-c", source] as const, timeoutMs, maxOutputBytes };
  }
  function held(index: number) {
    return command(
      `touch started-${index}; while ! test -e release; do sleep 0.01; done; printf done-${index}`,
    );
  }

  it("overlaps four commands and keeps their input, output and exit status separate", async () => {
    const backend = await create();
    const outputs = Array.from({ length: 4 }, () => ({ out: "", err: "" }));
    const calls = Array.from({ length: 4 }, (_, index) =>
      backend.execute(
        {
          ...command(
            `touch started-${index}; for n in 0 1 2 3; do while ! test -e started-$n; do sleep 0.01; done; done; cat; printf err-${index} >&2; exit ${index}`,
          ),
          stdin: `input-${index}`,
        },
        {
          onStdout: (chunk) => {
            outputs[index]!.out += chunk.toString();
          },
          onStderr: (chunk) => {
            outputs[index]!.err += chunk.toString();
          },
        },
      ),
    );
    const results = await Promise.all(calls);
    for (const [index, result] of results.entries()) {
      expect(result).toMatchObject({
        exitCode: index,
        stdout: Buffer.from(`input-${index}`),
        stderr: Buffer.from(`err-${index}`),
      });
      expect(outputs[index]).toEqual({ out: `input-${index}`, err: `err-${index}` });
    }
  });

  it("bounds active commands and outstanding requests without killing admitted work", async () => {
    const backend = await create();
    const calls = Array.from({ length: 64 }, (_, index) => backend.execute(held(index)));
    const finished = Promise.all(calls);
    await Promise.all([0, 1, 2, 3].map((index) => marked(`started-${index}`)));
    await delay(50);
    expect(existsSync(path.join(cwd, "started-4"))).toBe(false);
    await expect(backend.execute(command("touch overflow"))).rejects.toMatchObject({
      code: "sandbox_queue_full",
    });
    expect(existsSync(path.join(cwd, "overflow"))).toBe(false);
    await writeFile(path.join(cwd, "release"), "");
    expect((await finished).every((result) => result.exitCode === 0)).toBe(true);
  });

  it("keeps command lifetime serial", async () => {
    const backend = await create("command");
    const first = backend.execute(held(0));
    const second = backend.execute(held(1));
    const finished = Promise.all([first, second]);
    await marked("started-0");
    await delay(50);
    expect(existsSync(path.join(cwd, "started-1"))).toBe(false);
    await writeFile(path.join(cwd, "release"), "");
    expect((await finished).map((result) => result.exitCode)).toEqual([0, 0]);
  });

  it.each(["abort", "timeout"] as const)(
    "%s of queued work leaves active commands running",
    async (reason) => {
      const backend = await create();
      const active = Promise.all([0, 1, 2, 3].map((index) => backend.execute(held(index))));
      await Promise.all([0, 1, 2, 3].map((index) => marked(`started-${index}`)));
      const controller = new AbortController();
      const queued = backend.execute(
        command("touch should-not-run", reason === "timeout" ? 100 : 5_000),
        { signal: controller.signal },
      );
      const failed = expect(queued).rejects.toMatchObject({
        code: reason === "abort" ? "sandbox_aborted" : "sandbox_timeout",
      });
      if (reason === "abort") controller.abort();
      await failed;
      expect(existsSync(path.join(cwd, "should-not-run"))).toBe(false);
      await writeFile(path.join(cwd, "release"), "");
      expect((await active).every((result) => result.exitCode === 0)).toBe(true);
    },
  );

  it.each(["abort", "timeout", "output", "callback", "spawn"] as const)(
    "%s interrupts active peers and background processes before admitting new work",
    async (reason) => {
      const backend = await create();
      await backend.execute(
        command(
          "setsid /bin/bash -c 'trap \"\" TERM; while :; do date +%s%N > heartbeat; sleep 0.02; done' </dev/null >background.log 2>&1 &",
        ),
      );
      await marked("heartbeat");
      const controller = new AbortController();
      const peers = [0, 1, 2].map((index) => backend.execute(held(index)));
      const settledPeers = Promise.allSettled(peers);
      await Promise.all([0, 1, 2].map((index) => marked(`started-${index}`)));
      const trigger = backend.execute(
        reason === "spawn"
          ? { argv: ["/does-not-exist"] }
          : command(
              "touch trigger; while ! test -e fail-now; do sleep 0.01; done; printf trigger; sleep 100",
              reason === "timeout" ? 500 : 5_000,
              reason === "output" ? 1 : 1_048_576,
            ),
        {
          signal: controller.signal,
          ...(reason === "callback"
            ? {
                onStdout: () => {
                  throw new Error("consumer_failed");
                },
              }
            : {}),
        },
      );
      const triggerFailed = expect(trigger).rejects.toMatchObject({
        code: {
          abort: "sandbox_aborted",
          timeout: "sandbox_timeout",
          output: "sandbox_output_limit_exceeded",
          callback: "sandbox_process_failed",
          spawn: "sandbox_process_failed",
        }[reason],
      });
      if (reason !== "spawn") await marked("trigger");
      const next = backend.execute(command("touch next-started; sleep 0.1; printf next"));
      const nextFinished = expect(next).resolves.toMatchObject({
        exitCode: 0,
        stdout: Buffer.from("next"),
      });
      if (reason === "abort") controller.abort();
      else await writeFile(path.join(cwd, "fail-now"), "");
      await triggerFailed;
      const outcomes = await settledPeers;
      expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
      await nextFinished;
      const heartbeat = await readFile(path.join(cwd, "heartbeat"), "utf8");
      await delay(80);
      expect(await readFile(path.join(cwd, "heartbeat"), "utf8")).toBe(heartbeat);
    },
  );

  it("shutdown settles active and queued calls and rejects new work", async () => {
    const backend = await create();
    const calls = Array.from({ length: 6 }, (_, index) => backend.execute(held(index)));
    const settled = Promise.allSettled(calls);
    await Promise.all([0, 1, 2, 3].map((index) => marked(`started-${index}`)));
    await backend.close();
    for (const outcome of await settled) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected")
        expect(outcome.reason).toMatchObject({ code: "sandbox_closed" });
    }
    expect(existsSync(path.join(cwd, "started-4"))).toBe(false);
    await expect(backend.execute(command("true"))).rejects.toMatchObject({
      code: "sandbox_closed",
    });
  });
});

if (!AVAILABLE && process.env.PI_SANDBOX_REQUIRE_BWRAP === "1") {
  it("requires Bubblewrap for parallel execution verification", () => {
    throw new Error(`Required Bubblewrap executable is unavailable: ${BWRAP}`);
  });
}
