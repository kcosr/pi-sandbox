import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProcessLifetime } from "../../src/domain/index.js";
import {
  createBubblewrapExecutor,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";
import { testSandboxWorkerCommand } from "../helpers/sandbox-worker.js";

const BWRAP_PATH = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
const AVAILABLE = process.platform === "linux" && existsSync(BWRAP_PATH);

// HTTP plus a heartbeat makes both cross-call availability and shutdown visible
// from outside the private network namespace, without a host-side watcher.
const SERVER = `import http.server, pathlib, signal, threading, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"sandbox-server\\n")
server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
pathlib.Path("server.port").write_text(str(server.server_port))
def heartbeat():
    while True:
        pathlib.Path("server.heartbeat").write_text(str(time.monotonic_ns()))
        time.sleep(0.02)
threading.Thread(target=heartbeat, daemon=True).start()
server.serve_forever()
`;

describe.skipIf(!AVAILABLE)("Bubblewrap background process lifetime", () => {
  let directory: string;
  let cwd: string;
  let executors: SandboxExecutor[];

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp", "pi-lifetime-"),
    );
    cwd = path.join(directory, "workspace");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "server.py"), SERVER);
    executors = [];
  });

  afterEach(async () => {
    await Promise.all(executors.map((executor) => executor.close()));
    await rm(directory, { recursive: true, force: true });
  });

  async function create(
    processLifetime?: ProcessLifetime,
    workerCommand = testSandboxWorkerCommand(),
  ): Promise<SandboxExecutor> {
    const executor = await createBubblewrapExecutor({
      cwd,
      bubblewrapPath: BWRAP_PATH,
      networkMode: "local",
      ...(processLifetime === undefined ? {} : { processLifetime }),
      workerCommand,
    });
    executors.push(executor);
    return executor;
  }

  async function startServer(executor: SandboxExecutor, exitCode = 0): Promise<number> {
    const result = await executor.execute({
      argv: [
        "/bin/bash",
        "-c",
        [
          "setsid /usr/bin/python3 server.py >server.log 2>&1 </dev/null &",
          "for attempt in {1..200}; do test -s server.port -a -s server.heartbeat && break; sleep 0.01; done;",
          "test -s server.port -a -s server.heartbeat || exit 80;",
          `exit ${exitCode}`,
        ].join(" "),
      ],
    });
    expect(result.exitCode).toBe(exitCode);
    return Number(await readFile(path.join(cwd, "server.port"), "utf8"));
  }

  async function curl(executor: SandboxExecutor, port: number): Promise<string> {
    const result = await executor.execute({
      argv: [
        "/usr/bin/curl",
        "--silent",
        "--show-error",
        "--fail",
        "--noproxy",
        "*",
        "--max-time",
        "1",
        `http://127.0.0.1:${port}/`,
      ],
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  }

  async function expectServerStopped(executor: SandboxExecutor, port: number): Promise<void> {
    const result = await executor.execute({
      argv: [
        "/usr/bin/curl",
        "--silent",
        "--noproxy",
        "*",
        "--max-time",
        "1",
        `http://127.0.0.1:${port}/`,
      ],
    });
    expect(result.exitCode).not.toBe(0);
  }

  it.each([0, 7])(
    "keeps a redirected server across ordinary exit %i and later calls",
    async (exitCode) => {
      const executor = await create("sandbox");
      const port = await startServer(executor, exitCode);
      expect(await curl(executor, port)).toBe("sandbox-server\n");
      await expect(executor.execute({ argv: ["/bin/true"] })).resolves.toMatchObject({
        exitCode: 0,
      });
      expect(await curl(executor, port)).toBe("sandbox-server\n");

      // Neither the host nor a different sandbox shares this listener.
      expect(await hostCanReachSandboxServer(port)).toBe(false);
      await expectServerStopped(await create("sandbox"), port);
      expect(await curl(executor, port)).toBe("sandbox-server\n");
    },
  );

  it.each([undefined, "command"] as const)(
    "removes background servers in lifetime %s",
    async (lifetime) => {
      const executor = await create(lifetime);
      const port = await startServer(executor);
      await expectServerStopped(executor, port);
    },
  );

  it("closes quiet inherited pipes and ignores their late output during the next call", async () => {
    const executor = await create("sandbox");
    const first = await executor.execute({
      argv: ["/bin/bash", "-c", "(sleep 0.3; printf late; sleep 10) & printf foreground"],
      timeoutMs: 250,
    });
    expect(first.stdout.toString()).toBe("foreground");
    const next = await executor.execute({
      argv: ["/bin/bash", "-c", "sleep 0.4; printf next"],
      timeoutMs: 2_000,
    });
    expect(next).toMatchObject({ exitCode: 0, stdout: Buffer.from("next") });
  });

  it("continues draining active inherited output beyond the initial 100ms", async () => {
    const executor = await create("sandbox");
    const result = await executor.execute({
      argv: [
        "/bin/bash",
        "-c",
        '(for n in {1..12}; do printf "%s\\n" "$n"; sleep 0.03; done) & printf start\\n',
      ],
      timeoutMs: 3_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("12\n");
  });

  it("preserves complete foreground output larger than pipe buffers", async () => {
    const executor = await create("sandbox");
    const result = await executor.execute({
      argv: [
        "/usr/bin/python3",
        "-c",
        "import sys; sys.stdout.write('x' * 262144 + 'TAIL'); sys.stderr.write('e' * 131072 + 'END')",
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`${"x".repeat(262144)}TAIL`);
    expect(result.stderr.toString()).toBe(`${"e".repeat(131072)}END`);
  });

  it.each(["abort", "timeout", "output", "spawn"] as const)(
    "cleans previously started servers on %s failure",
    async (failure) => {
      const executor = await create("sandbox");
      const port = await startServer(executor);
      const controller = new AbortController();
      const request =
        failure === "spawn"
          ? { argv: ["/does-not-exist"] as const }
          : {
              argv: [
                "/bin/bash",
                "-c",
                failure === "output"
                  ? "(while true; do printf 1234567890; sleep 0.01; done) &"
                  : "(while true; do printf tick; sleep 0.01; done) &",
              ] as const,
              timeoutMs: failure === "timeout" ? 300 : 2_000,
              maxOutputBytes: failure === "output" ? 15 : 1_048_576,
            };
      const running = executor.execute(request, {
        signal: controller.signal,
        ...(failure === "abort" ? { onStdout: () => controller.abort() } : {}),
      });
      await expect(running).rejects.toMatchObject({
        code: {
          abort: "sandbox_aborted",
          timeout: "sandbox_timeout",
          output: "sandbox_output_limit_exceeded",
          spawn: "sandbox_process_failed",
        }[failure],
      });
      await expectServerStopped(executor, port);
    },
  );

  it.each(["abort", "timeout", "shutdown"] as const)(
    "cleans up when %s wins while a completed result is in transit",
    async (failure) => {
      const worker = path.join(directory, "delayed-result-worker.mjs");
      // Simulate a fully written result still buffered in the transport. Acknowledge
      // writes immediately, but preserve frame ordering until the test releases them.
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
    setImmediate(() => writeFileSync("result-held", "ready"));
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
      const executor = await create("sandbox", [testSandboxWorkerCommand()[0], worker]);
      const port = await startServer(executor);
      await writeFile(path.join(cwd, "hold-result"), "");
      const controller = new AbortController();
      const running = executor.execute(
        { argv: ["/bin/true"], timeoutMs: failure === "timeout" ? 1_000 : 5_000 },
        { signal: controller.signal },
      );
      const failed = expect(running).rejects.toMatchObject({
        code: {
          abort: "sandbox_aborted",
          timeout: "sandbox_timeout",
          shutdown: "sandbox_closed",
        }[failure],
      });
      await expect.poll(() => existsSync(path.join(cwd, "result-held"))).toBe(true);
      if (failure === "shutdown") {
        const closed = executor.close();
        await writeFile(path.join(cwd, "release-result"), "");
        await failed;
        await closed;
        const heartbeat = await readFile(path.join(cwd, "server.heartbeat"), "utf8");
        await delay(100);
        expect(await readFile(path.join(cwd, "server.heartbeat"), "utf8")).toBe(heartbeat);
        return;
      }
      const next = executor.execute({
        argv: ["/bin/bash", "-c", "touch next-started; sleep 0.1; printf next"],
      });
      const nextSucceeded = expect(next).resolves.toMatchObject({
        exitCode: 0,
        stdout: Buffer.from("next"),
      });
      await delay(100);
      expect(existsSync(path.join(cwd, "next-started"))).toBe(false);
      if (failure === "abort") controller.abort();
      else await delay(1_000);
      await writeFile(path.join(cwd, "release-result"), "");
      await failed;
      await nextSucceeded;
      await expectServerStopped(executor, port);
    },
  );

  it("cancels queued work without killing a server or the active call", async () => {
    const executor = await create("sandbox");
    const port = await startServer(executor);
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const active = executor.execute(
      { argv: ["/bin/bash", "-c", "printf ready; sleep 0.2; printf done"] },
      {
        onStdout: () => began(),
      },
    );
    await started;
    const controller = new AbortController();
    const queued = executor.execute(
      { argv: ["/bin/touch", "should-not-run"] },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "sandbox_aborted" });
    await expect(active).resolves.toMatchObject({ exitCode: 0 });
    expect(existsSync(path.join(cwd, "should-not-run"))).toBe(false);
    expect(await curl(executor, port)).toBe("sandbox-server\n");
  });

  it("kills an idle sandbox's detached signal-ignoring server on shutdown", async () => {
    const executor = await create("sandbox");
    await startServer(executor);
    await executor.close();
    const heartbeat = await readFile(path.join(cwd, "server.heartbeat"), "utf8");
    await delay(100);
    expect(await readFile(path.join(cwd, "server.heartbeat"), "utf8")).toBe(heartbeat);
    await expect(executor.execute({ argv: ["/bin/true"] })).rejects.toMatchObject({
      code: "sandbox_closed",
    });
  });

  it("closes active work and previously started servers together", async () => {
    const executor = await create("sandbox");
    await startServer(executor);
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const running = executor.execute(
      { argv: ["/bin/bash", "-c", "printf ready; sleep 100"] },
      {
        onStdout: () => began(),
      },
    );
    const failed = expect(running).rejects.toMatchObject({ code: "sandbox_closed" });
    await started;
    await executor.close();
    await failed;
    const heartbeat = await readFile(path.join(cwd, "server.heartbeat"), "utf8");
    await delay(100);
    expect(await readFile(path.join(cwd, "server.heartbeat"), "utf8")).toBe(heartbeat);
  });

  it("rejects an unknown process lifetime before starting a worker", async () => {
    await expect(create("session" as ProcessLifetime)).rejects.toMatchObject({
      code: "sandbox_start_failed",
      cause: { message: "sandbox_process_lifetime_invalid" },
    });
  });
});

if (!AVAILABLE && process.env.PI_SANDBOX_REQUIRE_BWRAP === "1") {
  it("requires Bubblewrap for process-lifetime verification", () => {
    throw new Error(`Required Bubblewrap executable is unavailable: ${BWRAP_PATH}`);
  });
}

function hostCanReachSandboxServer(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // The same port may independently belong to an unrelated host service.
    const request = get({ host: "127.0.0.1", port, path: "/" }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 1_024) finish(false);
      });
      response.once("end", () => finish(body === "sandbox-server\n"));
      response.once("error", () => finish(false));
    });
    const finish = (reachedSandbox: boolean): void => {
      request.destroy();
      resolve(reachedSandbox);
    };
    request.once("error", () => finish(false));
    request.setTimeout(1_000, () => finish(false));
  });
}
