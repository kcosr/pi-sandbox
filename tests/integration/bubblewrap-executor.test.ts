import { execFile } from "node:child_process";
import { createServer, type Server } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBubblewrapExecutor,
  SandboxExecutionError,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";
import {
  executeFind,
  executeGrep,
  executeLs,
  executeRead,
} from "../../packages/sandbox-extension/src/tools/executor-operations.js";
import { testSandboxWorkerCommand } from "../helpers/sandbox-worker.js";

const BWRAP_PATH = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
const realBubblewrapAvailable = process.platform === "linux" && existsSync(BWRAP_PATH);
const systemGitAvailable = existsSync("/usr/bin/git");
const realBubblewrapRequired = process.env.PI_SANDBOX_REQUIRE_BWRAP === "1";
const execFileAsync = promisify(execFile);

if (realBubblewrapRequired && !realBubblewrapAvailable) {
  it("requires the selected Bubblewrap executable for release integration tests", () => {
    throw new Error(`PI_SANDBOX_REQUIRE_BWRAP=1 but ${BWRAP_PATH} is unavailable`);
  });
}

describe.skipIf(!realBubblewrapAvailable)("real Bubblewrap executor", () => {
  let root: string;
  let cwd: string;
  let outsideFile: string;
  let executor: SandboxExecutor;

  beforeAll(async () => {
    root = await mkdtemp("/var/tmp/pi-sandbox-test-");
    cwd = path.join(root, "workspace");
    await mkdir(cwd);
    outsideFile = path.join(root, "outside.txt");
    await writeFile(outsideFile, "host-read-only", "utf8");
    executor = await createBubblewrapExecutor({
      cwd,
      bubblewrapPath: BWRAP_PATH,
      environment: { SANDBOX_TEST_VISIBLE: "configured" },
      workerCommand: testSandboxWorkerCommand(),
    });
    await executor.probe();
  });

  afterAll(async () => {
    await executor?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("starts at the identical absolute CWD", async () => {
    const result = await executor.execute({ argv: ["/bin/pwd"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(cwd);
  });

  it.skipIf(!systemGitAvailable)(
    "exposes the ordinary Git executable for repository work inside the sandbox",
    async () => {
      const result = await executor.execute({ argv: ["/usr/bin/git", "--version"] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toMatch(/^git version /u);
    },
  );

  it("fails startup when the sandbox worker exits before its handshake", async () => {
    await expect(
      createBubblewrapExecutor({
        cwd,
        bubblewrapPath: BWRAP_PATH,
        workerCommand: ["/bin/true"],
      }),
    ).rejects.toMatchObject({ code: "sandbox_start_failed" });
  });

  it("fails closed without hanging when the configured environment is invalid", async () => {
    await expect(
      createBubblewrapExecutor({
        cwd,
        bubblewrapPath: BWRAP_PATH,
        environment: { PI_SANDBOX_RESERVED: "value" },
        workerCommand: testSandboxWorkerCommand(),
      }),
    ).rejects.toMatchObject({ code: "sandbox_start_failed" });
  });

  it("rejects new work after the sandbox worker dies", async () => {
    const crashedExecutor = await createBubblewrapExecutor({
      cwd,
      bubblewrapPath: BWRAP_PATH,
      workerCommand: testSandboxWorkerCommand(),
    });
    try {
      await expect(
        crashedExecutor.execute({ argv: ["/bin/bash", "-c", 'kill -KILL "$PPID"'] }),
      ).rejects.toMatchObject({ code: "sandbox_process_failed" });
      await expect(crashedExecutor.execute({ argv: ["/bin/true"] })).rejects.toMatchObject({
        code: "sandbox_process_failed",
      });
    } finally {
      await crashedExecutor.close();
    }
  });

  it("reads the host root but only writes beneath the launch CWD", async () => {
    const read = await executor.execute({
      argv: ["/bin/cat", "--", outsideFile],
    });
    expect(read.stdout.toString()).toBe("host-read-only");

    const denied = await executor.execute({
      argv: ["/bin/bash", "-c", 'printf changed > "$1"', "bash", outsideFile],
    });
    expect(denied.exitCode).not.toBe(0);
    expect(await readFile(outsideFile, "utf8")).toBe("host-read-only");

    const writableFile = path.join(cwd, "written.txt");
    const write = await executor.execute({
      argv: ["/bin/bash", "-c", 'printf written > "$1"', "bash", writableFile],
    });
    expect(write.exitCode).toBe(0);
    expect(await readFile(writableFile, "utf8")).toBe("written");
  });

  it("reads beyond pipe buffers and intentionally capped long lines without SIGPIPE failure", async () => {
    const manyLines = path.join(cwd, "many-lines.txt");
    await writeFile(manyLines, `${"line\n".repeat(40_000)}`, "utf8");
    const limited = await executeRead(executor, { path: manyLines, limit: 10 }, cwd);
    const limitedText = limited.content[0];
    expect(limitedText?.type).toBe("text");
    if (limitedText?.type === "text")
      expect(limitedText.text).toContain("Use offset=11 to continue");

    const longLine = path.join(cwd, "long-line.txt");
    await writeFile(longLine, "x".repeat(120 * 1024), "utf8");
    const bounded = await executeRead(executor, { path: longLine }, cwd);
    const boundedText = bounded.content[0];
    expect(boundedText?.type).toBe("text");
    if (boundedText?.type === "text") expect(boundedText.text).toContain("exceeds 50.0KB limit");
  });

  it("sorts and bounds listing and filters find matches before its cap", async () => {
    const search = path.join(cwd, "bounded-search");
    await mkdir(search);
    await writeFile(path.join(search, "z.txt"), "z", "utf8");
    await writeFile(path.join(search, "not-matching.bin"), "n", "utf8");
    await writeFile(path.join(search, "a.txt"), "a", "utf8");

    const listed = await executeLs(executor, { path: search, limit: 1 }, cwd);
    expect(listed.content[0].text).toContain("a.txt");
    expect(listed.details).toMatchObject({ entryLimitReached: 1 });

    const found = await executeFind(executor, { path: search, pattern: "*.txt", limit: 1 }, cwd);
    expect(found.content[0].text).toMatch(/^[az]\.txt$/u);
    expect(found.content[0].text).not.toContain("not-matching.bin");
    expect(found.details).toMatchObject({ resultLimitReached: 1 });

    const grepFile = path.join(search, "many-matches.txt");
    await writeFile(grepFile, "match\n".repeat(30_000), "utf8");
    const grepped = await executeGrep(executor, { path: search, pattern: "match", limit: 1 }, cwd);
    expect(grepped.content[0].text.split("\n")).toHaveLength(1);
    expect(grepped.details).toMatchObject({ matchLimitReached: 1 });
  });

  it("preserves private temp and runtime state for the executor lifetime", async () => {
    const first = await executor.execute({
      argv: [
        "/bin/bash",
        "-c",
        'printf temp > /tmp/private-marker; printf run > "$XDG_STATE_HOME/marker"',
      ],
    });
    expect(first.exitCode).toBe(0);

    const second = await executor.execute({
      argv: [
        "/bin/bash",
        "-c",
        'test "$(cat /tmp/private-marker)" = temp && test "$(cat "$XDG_STATE_HOME/marker")" = run',
      ],
    });
    expect(second.exitCode).toBe(0);
  });

  it("serializes concurrent operations through the persistent worker", async () => {
    const marker = path.join(cwd, "serialized-marker");
    const first = executor.execute({
      argv: ["/bin/bash", "-c", 'sleep 0.1; printf ready > "$1"', "pi-sandbox-serialize", marker],
    });
    const second = executor.execute({ argv: ["/bin/cat", marker] });

    await expect(first).resolves.toMatchObject({ exitCode: 0 });
    await expect(second).resolves.toMatchObject({ exitCode: 0, stdout: Buffer.from("ready") });
  });

  it("clears ambient environment and presents an empty host sysfs", async () => {
    const result = await executor.execute({
      argv: [
        "/bin/bash",
        "-c",
        'printf "%s\\n%s\\n%s\\n%s" "$HOME" "${SSH_AUTH_SOCK-unset}" "$SANDBOX_TEST_VISIBLE" "$(find /sys -mindepth 1 -print -quit)"',
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().split("\n")).toEqual([
      "/run/pi-sandbox/home",
      "unset",
      "configured",
      "",
    ]);
  });

  it("cannot connect to a host-loopback service", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("bad address");
      const script = [
        "const net = require('node:net');",
        `const socket = net.createConnection({host:'127.0.0.1',port:${address.port}});`,
        "socket.on('connect', () => process.exit(0));",
        "socket.on('error', error => process.exit(error.code === 'EACCES' ? 23 : 25));",
        "setTimeout(() => process.exit(24), 1000);",
      ].join("");
      const result = await executor.execute({
        argv: [process.execPath, "-e", script],
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(23);
    } finally {
      await closeServer(server);
    }
  });

  it.each(["outside", "workspace"] as const)(
    "cannot create an AF_UNIX connection to a socket in the %s tree",
    async (location) => {
      const socketPath = path.join(location === "outside" ? root : cwd, `${location}.sock`);
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      try {
        const script = [
          "const net = require('node:net');",
          `const socket = net.createConnection(${JSON.stringify(socketPath)});`,
          "socket.on('connect', () => process.exit(0));",
          "socket.on('error', error => process.exit(error.code === 'EACCES' ? 23 : 25));",
          "setTimeout(() => process.exit(24), 1000);",
        ].join("");
        const result = await executor.execute({
          argv: [process.execPath, "-e", script],
          timeoutMs: 5_000,
        });
        expect(result.exitCode).toBe(23);
      } finally {
        await closeServer(server);
      }
    },
  );

  it("allows only anonymous socket pairs needed for worker child execution", async () => {
    const result = await executor.execute({
      argv: [
        "/usr/bin/python3",
        "-c",
        [
          "import socket, sys",
          "try:",
          "  left, right = socket.socketpair()",
          "  left.close(); right.close()",
          "except OSError: sys.exit(25)",
          "sys.exit(0)",
        ].join("\n"),
      ],
    });
    expect(result.exitCode).toBe(0);
  });

  it("denies io_uring setup when the host kernel permits it", async (context) => {
    const setupScript = [
      "import ctypes, errno, os, sys",
      "libc = ctypes.CDLL(None, use_errno=True)",
      "params = (ctypes.c_ubyte * 120)()",
      "result = libc.syscall(425, 2, ctypes.byref(params))",
      "error = ctypes.get_errno()",
      "if result >= 0: os.close(result); sys.exit(0)",
      "sys.exit(23 if error == errno.EACCES else 25)",
    ].join("\n");
    try {
      await execFileAsync("/usr/bin/python3", ["-c", setupScript]);
    } catch {
      context.skip();
      return;
    }

    const result = await executor.execute({
      argv: ["/usr/bin/python3", "-c", setupScript],
    });
    expect(result.exitCode).toBe(23);
  });

  it("denies creation of a hard link after a clean probe", async () => {
    const alias = path.join(cwd, "outside-hard-link.txt");
    const script = [
      "import errno, os, sys",
      "try: os.link(sys.argv[1], sys.argv[2])",
      "except PermissionError as error: sys.exit(23 if error.errno == errno.EACCES else 25)",
      "sys.exit(0)",
    ].join("\n");
    const result = await executor.execute({
      argv: ["/usr/bin/python3", "-c", script, outsideFile, alias],
    });
    expect(result.exitCode).toBe(23);
    expect(existsSync(alias)).toBe(false);
    expect((await stat(outsideFile)).nlink).toBe(1);
  });

  it("streams output while retaining a bounded result", async () => {
    const streamed: string[] = [];
    const result = await executor.execute(
      { argv: ["/bin/bash", "-c", "printf out; printf err >&2"] },
      {
        onStdout: (chunk) => streamed.push(`o:${chunk.toString()}`),
        onStderr: (chunk) => streamed.push(`e:${chunk.toString()}`),
      },
    );
    expect(result.stdout.toString()).toBe("out");
    expect(result.stderr.toString()).toBe("err");
    expect(streamed).toEqual(expect.arrayContaining(["o:out", "e:err"]));
  });

  it("kills the sandbox tree on cancellation", async () => {
    const controller = new AbortController();
    let sawReady = false;
    const execution = executor.execute(
      {
        argv: ["/bin/bash", "-c", "sleep 1000 & echo READY; wait", "pi-sandbox-descendant-test"],
      },
      {
        signal: controller.signal,
        onStdout: (chunk) => {
          if (chunk.includes("READY")) {
            sawReady = true;
            controller.abort();
          }
        },
      },
    );
    await expect(execution).rejects.toMatchObject({ code: "sandbox_aborted" });
    expect(sawReady).toBe(true);
  });

  it.each(["abort", "close"] as const)(
    "kills a detached, stdio-closed, signal-ignoring descendant on %s",
    async (mode) => {
      const isolatedExecutor =
        mode === "close"
          ? await createBubblewrapExecutor({
              cwd,
              bubblewrapPath: BWRAP_PATH,
              workerCommand: testSandboxWorkerCommand(),
            })
          : executor;
      const controller = new AbortController();
      const started = path.join(cwd, `detached-${mode}-started`);
      const escaped = path.join(cwd, `detached-${mode}-escaped`);
      const script = [
        "setsid /bin/bash -c",
        '\'trap "" TERM HUP; exec </dev/null >/dev/null 2>&1; sleep 1; printf escaped > "$1"\'',
        'pi-sandbox-detached "$1" &',
        'printf started > "$2"; wait',
      ].join(" ");
      const execution = isolatedExecutor.execute(
        {
          argv: ["/bin/bash", "-c", script, "pi-sandbox-parent", escaped, started],
          timeoutMs: 10_000,
        },
        { signal: controller.signal },
      );
      await waitForFile(started);

      const failed = expect(execution).rejects.toMatchObject({
        code: mode === "abort" ? "sandbox_aborted" : "sandbox_closed",
      });
      if (mode === "abort") controller.abort();
      else await isolatedExecutor.close();
      await failed;
      await delay(1_250);
      expect(existsSync(escaped)).toBe(false);
    },
  );

  it("enforces timeout, input, and combined output limits", async () => {
    await expect(
      executor.execute({ argv: ["/bin/sleep", "10"], timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "sandbox_timeout" });

    await expect(
      executor.execute({
        argv: ["/bin/bash", "-c", "printf 123456789"],
        maxOutputBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "sandbox_output_limit_exceeded" });

    const bounded = await createBubblewrapExecutor({
      cwd,
      bubblewrapPath: BWRAP_PATH,
      limits: { maximumInputBytes: 4 },
      workerCommand: testSandboxWorkerCommand(),
    });
    await expect(bounded.execute({ argv: ["/bin/cat"], stdin: "12345" })).rejects.toBeInstanceOf(
      SandboxExecutionError,
    );
    await bounded.close();
  });

  it("rejects work after close and terminates active work during close", async () => {
    const closingExecutor = await createBubblewrapExecutor({
      cwd,
      bubblewrapPath: BWRAP_PATH,
      workerCommand: testSandboxWorkerCommand(),
    });
    const active = closingExecutor.execute({ argv: ["/bin/sleep", "1000"] });
    const closed = expect(active).rejects.toMatchObject({ code: "sandbox_closed" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await closingExecutor.close();
    await closed;
    await expect(closingExecutor.execute({ argv: ["/bin/true"] })).rejects.toMatchObject({
      code: "sandbox_closed",
    });
  });
});

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForFile(filename: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(filename)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filename}`);
}
