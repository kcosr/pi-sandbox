import type * as FsPromises from "node:fs/promises";
import type * as Cli from "./cli.js";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxExecutionOptions,
} from "../contracts.js";
import { createSmolvmExecutor } from "./packed.js";

const mocks = vi.hoisted(() => ({
  exec: undefined as
    | ((request: SandboxCommandRequest, options: SandboxExecutionOptions) => Promise<string>)
    | undefined,
  stop: undefined as (() => Promise<void>) | undefined,
  stopped: 0,
  alive: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof FsPromises>();
  return {
    ...actual,
    access: (file: Parameters<typeof actual.access>[0], mode?: number) =>
      file === "/dev/kvm" ? Promise.resolve() : actual.access(file, mode),
  };
});
vi.mock("./runtime-release.js", () => ({
  verifySmolvmRuntime: () => Promise.resolve("a".repeat(64)),
  SMOLVM_VERSION: "1.25.4",
}));
vi.mock("./pack.js", () => ({ validateSmolvmPack: async () => {} }));
vi.mock("./host-control-paths.js", () => ({ hostControlPaths: () => Promise.resolve([]) }));
vi.mock("./lifecycle.js", () => ({
  captureMachineIdentity: () =>
    Promise.resolve({
      pid: 123,
      start: "42",
      executable: "/trusted/smolvm",
      bootConfig: "/state/boot.json",
    }),
  assertMachineAlive: async () => {
    await mocks.alive?.();
  },
  stopMachine: async () => {
    mocks.stopped++;
    await mocks.stop?.();
  },
  deleteStoppedMachine: async () => {},
}));
vi.mock("./cli.js", async (importActual) => {
  const actual = await importActual<typeof Cli>();
  return {
    createStateEnvironment: actual.createStateEnvironment,
    SmolvmCli: class {
      readonly active = new Set<{ controller: AbortController; done: Promise<void> }>();
      async run(request: SandboxCommandRequest, options: SandboxExecutionOptions = {}) {
        let stdout = "";
        if (request.argv[0] === "--version") stdout = "smolvm 1.25.4";
        else if (request.argv[1] === "exec") {
          const guest = JSON.parse(
            Buffer.from(request.argv.at(-1)!, "base64").toString(),
          ) as SandboxCommandRequest;
          const controller = new AbortController();
          const abort = () => controller.abort();
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) controller.abort();
          let finish!: () => void;
          const done = new Promise<void>((resolve) => {
            finish = resolve;
          });
          const active = { controller, done };
          this.active.add(active);
          try {
            if (controller.signal.aborted) throw new SandboxExecutionError("sandbox_aborted");
            stdout = mocks.exec
              ? await mocks.exec(
                  {
                    ...guest,
                    ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
                    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
                  },
                  { ...options, signal: controller.signal },
                )
              : guest.argv[0] === "/bin/sh"
                ? "2097152\n2097152\n"
                : "ready";
          } finally {
            this.active.delete(active);
            options.signal?.removeEventListener("abort", abort);
            finish();
          }
          if (stdout) options.onStdout?.(Buffer.from(stdout));
        }
        return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode: 0, signal: null };
      }
      async cancelActive() {
        const active = [...this.active];
        for (const command of active) command.controller.abort();
        await Promise.all(active.map((command) => command.done));
      }
      async dispose() {
        await this.cancelActive();
      }
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  mocks.exec = undefined;
  mocks.stop = undefined;
  mocks.alive = undefined;
  mocks.stopped = 0;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp("/var/tmp/smol-exec-");
  directories.push(directory);
  const cwd = path.join(directory, "project");
  const stateDirectory = path.join(directory, "state");
  const imagePath = path.join(directory, "image");
  await mkdir(cwd);
  await mkdir(stateDirectory, { mode: 0o700 });
  await writeFile(imagePath, "fixture");
  return createSmolvmExecutor({
    cwd,
    stateDirectory,
    imagePath,
    imageSha256: "a".repeat(64),
    smolvmPath: await realpath("/usr/bin/true"),
    resources: { cpus: 1, memoryMiB: 512, storageGiB: 1, overlayGiB: 1 },
  });
}

const suite = process.platform === "linux" && process.arch === "x64" ? describe : describe.skip;
suite("packed smolvm parallel controller", () => {
  it("keeps four independent executions active while a queued deadline only removes its request", async () => {
    const executor = await fixture();
    const entered = deferred<void>();
    const releases = new Map<string, ReturnType<typeof deferred<string>>>();
    mocks.exec = (request) => {
      const name = request.argv[1]!;
      const gate = deferred<string>();
      releases.set(name, gate);
      if (releases.size === 4) entered.resolve();
      return gate.promise;
    };
    try {
      const active = Array.from({ length: 4 }, (_, i) =>
        executor.execute({ argv: ["/bin/echo", String(i)] }),
      );
      await entered.promise;
      await expect(
        executor.execute({ argv: ["/bin/echo", "queued"], timeoutMs: 20 }),
      ).rejects.toMatchObject({ code: "sandbox_timeout" });
      expect(releases.size).toBe(4);
      expect(mocks.stopped).toBe(0);
      for (const [name, gate] of releases) gate.resolve(name);
      expect((await Promise.all(active)).map((result) => result.stdout.toString())).toEqual([
        "0",
        "1",
        "2",
        "3",
      ]);
    } finally {
      await executor.close();
    }
  });

  it("interrupts peers and waits for VM retirement after an active failure", async () => {
    const executor = await fixture();
    const entered = deferred<void>();
    const cleanupStarted = deferred<void>();
    const finishCleanup = deferred<void>();
    let count = 0;
    mocks.exec = (_request, options) =>
      new Promise((_resolve, reject) => {
        if (++count === 4) entered.resolve();
        const abort = () => reject(new SandboxExecutionError("sandbox_aborted"));
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    mocks.stop = () => {
      cleanupStarted.resolve();
      return finishCleanup.promise;
    };
    const controller = new AbortController();
    let settled = 0;
    const active = Array.from({ length: 4 }, (_, i) =>
      executor
        .execute({ argv: ["/bin/sleep", "60"] }, i === 0 ? { signal: controller.signal } : {})
        .finally(() => {
          settled++;
        }),
    );
    const results = Promise.allSettled(active);
    await entered.promise;
    const queued = executor.execute({ argv: ["/bin/true"] });
    const rejected = expect(queued).rejects.toMatchObject({ code: "sandbox_closed" });
    controller.abort();
    await cleanupStarted.promise;
    expect(settled).toBe(0);
    expect(count).toBe(4);
    await rejected;
    finishCleanup.resolve();
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(mocks.stopped).toBe(1);
    await expect(executor.execute({ argv: ["/bin/true"] })).rejects.toMatchObject({
      code: "sandbox_closed",
    });
  });

  it.each(["shutdown", "abort", "timeout"])(
    "does not report success when %s occurs during the final identity check",
    async (mode) => {
      const executor = await fixture();
      const finalCheck = deferred<void>();
      const finishCheck = deferred<void>();
      let checks = 0;
      mocks.alive = async () => {
        if (++checks === 2) {
          finalCheck.resolve();
          await finishCheck.promise;
        }
      };
      const controller = new AbortController();
      const execution = executor.execute(
        { argv: ["/bin/true"], timeoutMs: 10000 },
        { signal: controller.signal },
      );
      const rejected = expect(execution).rejects.toMatchObject({
        code:
          mode === "shutdown"
            ? "sandbox_closed"
            : mode === "abort"
              ? "sandbox_aborted"
              : "sandbox_timeout",
      });
      await finalCheck.promise;
      const closing = mode === "shutdown" ? executor.close() : undefined;
      if (mode === "abort") controller.abort();
      if (mode === "timeout")
        vi.spyOn(performance, "now").mockReturnValue(performance.now() + 10001);
      finishCheck.resolve();
      await rejected;
      await closing;
      expect(mocks.stopped).toBe(1);
    },
  );

  it.each(["abort", "timeout"])(
    "retires an admitted request on %s during its initial identity check before guest execution",
    async (mode) => {
      const executor = await fixture();
      const initialCheck = deferred<void>();
      const finishCheck = deferred<void>();
      mocks.alive = () => {
        initialCheck.resolve();
        return finishCheck.promise;
      };
      const guestExecution = vi.fn(() => Promise.resolve("unexpected guest execution"));
      mocks.exec = guestExecution;
      const controller = new AbortController();
      const execution = executor.execute(
        { argv: ["/bin/true"], timeoutMs: 10000 },
        { signal: controller.signal },
      );
      const rejected = expect(execution).rejects.toMatchObject({
        code: mode === "abort" ? "sandbox_aborted" : "sandbox_timeout",
      });
      await initialCheck.promise;
      if (mode === "abort") controller.abort();
      else vi.spyOn(performance, "now").mockReturnValue(performance.now() + 10001);
      finishCheck.resolve();
      await rejected;
      expect(guestExecution).not.toHaveBeenCalled();
      expect(mocks.stopped).toBe(1);
      await expect(executor.execute({ argv: ["/bin/true"] })).rejects.toMatchObject({
        code: "sandbox_closed",
      });
    },
  );
});
