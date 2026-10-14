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

  async function create() {
    executor = await createBubblewrapExecutor({
      cwd,
      bubblewrapPath: BWRAP,
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

  it("overlaps eight commands and keeps their input, output and exit status separate", async () => {
    const backend = await create();
    const outputs = Array.from({ length: 8 }, () => ({ out: "", err: "" }));
    const calls = Array.from({ length: 8 }, (_, index) =>
      backend.execute(
        {
          ...command(
            `touch started-${index}; for n in 0 1 2 3 4 5 6 7; do while ! test -e started-$n; do sleep 0.01; done; done; cat; printf err-${index} >&2; exit ${index}`,
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

  it("admits more than sixty-four simultaneous calls without a worker concurrency cap", async () => {
    const backend = await create();
    const calls = Array.from({ length: 72 }, (_, index) => backend.execute(held(index)));
    const finished = Promise.all(calls);
    await Promise.all(Array.from({ length: 72 }, (_, index) => marked(`started-${index}`)));
    await writeFile(path.join(cwd, "release"), "");
    expect((await finished).every((result) => result.exitCode === 0)).toBe(true);
  });

  it("a pre-aborted request never starts while peers continue", async () => {
    const backend = await create();
    const active = backend.execute(held(0));
    await marked("started-0");
    const controller = new AbortController();
    controller.abort();
    await expect(
      backend.execute(command("touch should-not-run"), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "sandbox_aborted" });
    expect(existsSync(path.join(cwd, "should-not-run"))).toBe(false);
    await writeFile(path.join(cwd, "release"), "");
    expect((await active).exitCode).toBe(0);
  });

  it.each(["abort", "timeout", "output", "callback", "spawn"] as const)(
    "%s affects only its own request while active peers and detached background work continue",
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
      const finishedPeers = Promise.all(peers);
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
      await writeFile(path.join(cwd, "release"), "");
      expect((await finishedPeers).every((outcome) => outcome.exitCode === 0)).toBe(true);
      await nextFinished;
      const heartbeat = await readFile(path.join(cwd, "heartbeat"), "utf8");
      await delay(80);
      expect(await readFile(path.join(cwd, "heartbeat"), "utf8")).not.toBe(heartbeat);
    },
  );

  it("does not treat a quiet unlimited command as a stalled transport", async () => {
    const backend = await create();
    await expect(backend.execute({ argv: ["/bin/sleep", "11"] })).resolves.toMatchObject({
      exitCode: 0,
    });
  }, 20_000);

  it("shutdown settles active calls and rejects new work", async () => {
    const backend = await create();
    const calls = Array.from({ length: 6 }, (_, index) => backend.execute(held(index)));
    const settled = Promise.allSettled(calls);
    await Promise.all([0, 1, 2, 3, 4, 5].map((index) => marked(`started-${index}`)));
    await backend.close();
    for (const outcome of await settled) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected")
        expect(outcome.reason).toMatchObject({ code: "sandbox_closed" });
    }
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
