import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBubblewrapExecutor,
  type SandboxExecutionError,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";
import { testSandboxWorkerCommand } from "../helpers/sandbox-worker.js";

const REQUIRE_REAL_BWRAP = process.env.PI_SANDBOX_REQUIRE_BWRAP === "1";
const BWRAP_PATH = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
const REAL_BWRAP_AVAILABLE = process.platform === "linux" && existsSync(BWRAP_PATH);

describe.skipIf(!REAL_BWRAP_AVAILABLE)("real Bubblewrap boundary", () => {
  let baseDirectory: string;
  let workspace: string;
  let outsideFile: string;
  let executor: SandboxExecutor;

  beforeAll(async () => {
    const fixtureRoot = process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp";
    baseDirectory = await mkdtemp(path.join(fixtureRoot, "pi-sandbox-e2e-"));
    workspace = path.join(baseDirectory, "workspace");
    outsideFile = path.join(baseDirectory, "outside.txt");
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(outsideFile, "host-read-only\n", { mode: 0o600 });
    await writeFile(path.join(workspace, "input.txt"), "workspace-input\n", {
      mode: 0o600,
    });
    executor = await createBubblewrapExecutor({
      cwd: workspace,
      cwdWritable: true,
      bubblewrapPath: BWRAP_PATH,
      environment: { SANDBOX_CONFIGURED_VALUE: "configured" },
      workerCommand: testSandboxWorkerCommand(),
    });

    try {
      await executor.probe();
    } catch (error) {
      if (REQUIRE_REAL_BWRAP) throw error;
      throw new Error(
        "Bubblewrap is installed but cannot establish the required namespace boundary. " +
          "Set PI_SANDBOX_REQUIRE_BWRAP=1 in release CI to make this prerequisite explicit.",
        { cause: error },
      );
    }
  });

  afterAll(async () => {
    await executor?.close();
    if (baseDirectory) await rm(baseDirectory, { recursive: true, force: true });
  });

  it("preserves the launch CWD's exact path and makes only that subtree writable", async () => {
    const pwd = await executor.execute({ argv: ["/bin/pwd"] });
    expect(pwd.exitCode).toBe(0);
    expect(pwd.stdout.toString().trim()).toBe(workspace);

    const readOutside = await executor.execute({
      argv: ["/bin/cat", outsideFile],
    });
    expect(readOutside.exitCode).toBe(0);
    expect(readOutside.stdout.toString()).toBe("host-read-only\n");

    const writeWorkspace = await executor.execute({
      argv: ["/bin/bash", "-c", "printf sandbox-write > output.txt && chmod 600 output.txt"],
    });
    expect(writeWorkspace.exitCode).toBe(0);
    expect(await readFile(path.join(workspace, "output.txt"), "utf8")).toBe("sandbox-write");

    const writeOutside = await executor.execute({
      argv: ["/bin/bash", "-c", `printf changed > ${shellQuote(outsideFile)}`],
    });
    expect(writeOutside.exitCode).not.toBe(0);
    expect(await readFile(outsideFile, "utf8")).toBe("host-read-only\n");
  });

  it("rejects a read-only launch CWD at /tmp before it can mask private temporary storage", async () => {
    await expect(
      createBubblewrapExecutor({
        cwd: "/tmp",
        cwdWritable: false,
        bubblewrapPath: BWRAP_PATH,
        workerCommand: testSandboxWorkerCommand(),
      }),
    ).rejects.toMatchObject({
      code: "sandbox_start_failed",
      cause: { message: "sandbox_cwd_masks_private_tmp" },
    });
  });

  it("provides process-private persistent temporary and runtime storage", async () => {
    const createPrivate = await executor.execute({
      argv: [
        "/bin/bash",
        "-c",
        "printf secret > /tmp/pi-sandbox-marker && printf state > /run/pi-sandbox/state/marker",
      ],
    });
    expect(createPrivate.exitCode).toBe(0);

    const observeNextInvocation = await executor.execute({
      argv: [
        "/bin/bash",
        "-c",
        'test "$(cat /tmp/pi-sandbox-marker)" = secret && test "$(cat /run/pi-sandbox/state/marker)" = state',
      ],
    });
    expect(observeNextInvocation.exitCode).toBe(0);
    expect(existsSync("/tmp/pi-sandbox-marker")).toBe(false);
  });

  it("uses sandbox-owned process, network, and system views", async () => {
    const hostPidNamespace = await readlink("/proc/self/ns/pid");
    const hostNetworkNamespace = await readlink("/proc/self/ns/net");
    const result = await executor.execute({
      argv: [
        "/bin/bash",
        "-c",
        "readlink /proc/self/ns/pid; readlink /proc/self/ns/net; test ! -e /sys/kernel",
      ],
    });
    expect(result.exitCode).toBe(0);
    const [sandboxPidNamespace, sandboxNetworkNamespace] = result.stdout
      .toString()
      .trim()
      .split("\n");
    expect(sandboxPidNamespace).not.toBe(hostPidNamespace);
    expect(sandboxNetworkNamespace).not.toBe(hostNetworkNamespace);

    const next = await executor.execute({
      argv: ["/bin/bash", "-c", "readlink /proc/self/ns/pid; readlink /proc/self/ns/net"],
    });
    expect(next.stdout.toString().trim().split("\n")).toEqual([
      sandboxPidNamespace,
      sandboxNetworkNamespace,
    ]);
  });

  it("clears ambient credentials and constructs only the fixed environment", async () => {
    process.env.PI_SANDBOX_E2E_SECRET = "must-not-cross";
    process.env.PI_SANDBOX_INTERNAL_IDENTITY_TOKEN = "must-not-cross";
    process.env.SSH_AUTH_SOCK = "/tmp/fake-agent.sock";
    try {
      const result = await executor.execute({ argv: ["/usr/bin/env"] });
      expect(result.exitCode).toBe(0);
      const environment = parseEnvironment(result.stdout.toString());
      expect(environment.PI_SANDBOX_E2E_SECRET).toBeUndefined();
      expect(environment.PI_SANDBOX_INTERNAL_IDENTITY_TOKEN).toBeUndefined();
      expect(environment.SSH_AUTH_SOCK).toBeUndefined();
      expect(environment.SANDBOX_CONFIGURED_VALUE).toBe("configured");
      expect(environment.HOME).toBe("/run/pi-sandbox/home");
      expect(environment.PWD).toBe(workspace);
      expect(environment.TMPDIR).toBe("/tmp");
    } finally {
      delete process.env.PI_SANDBOX_E2E_SECRET;
      delete process.env.PI_SANDBOX_INTERNAL_IDENTITY_TOKEN;
      delete process.env.SSH_AUTH_SOCK;
    }
  });

  it("cannot connect to a listening host-loopback service", async () => {
    const server = createServer((socket) => socket.end("unexpected"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("bad_listener");
      const script = [
        "const net = require('node:net');",
        `const socket = net.createConnection({host:'127.0.0.1',port:${address.port}});`,
        "socket.setTimeout(1000);",
        "socket.on('connect', () => process.exit(0));",
        "socket.on('error', () => process.exit(23));",
        "socket.on('timeout', () => process.exit(24));",
      ].join("");
      const result = await executor.execute({
        argv: [process.execPath, "-e", script],
        timeoutMs: 5_000,
      });
      expect(result.exitCode).not.toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("can connect to a listening host-loopback service only in host network mode", async () => {
    const server = createServer((socket) => socket.end("host-network\n"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const hostNetworkExecutor = await createBubblewrapExecutor({
      cwd: workspace,
      bubblewrapPath: BWRAP_PATH,
      networkMode: "host",
      workerCommand: testSandboxWorkerCommand(),
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("bad_listener");
      const script = [
        "const net = require('node:net');",
        `const socket = net.createConnection({host:'127.0.0.1',port:${address.port}});`,
        "socket.setEncoding('utf8');",
        "socket.on('data', (chunk) => process.stdout.write(chunk));",
        "socket.on('end', () => process.exit(0));",
        "socket.on('error', () => process.exit(23));",
      ].join("");
      const result = await hostNetworkExecutor.execute({
        argv: [process.execPath, "-e", script],
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("host-network\n");
    } finally {
      await hostNetworkExecutor.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("kills sandbox descendants when an operation is cancelled", async () => {
    const started = path.join(workspace, "descendant-started");
    const escaped = path.join(workspace, "descendant-escaped");
    const controller = new AbortController();
    const execution = executor.execute(
      {
        argv: [
          "/bin/bash",
          "-c",
          `printf started > ${shellQuote(started)}; (sleep 1; printf escaped > ${shellQuote(escaped)}) & wait`,
        ],
        timeoutMs: 10_000,
      },
      { signal: controller.signal },
    );

    await waitForFile(started);
    controller.abort();
    await expect(execution).rejects.toMatchObject({
      code: "sandbox_aborted",
    } satisfies Partial<SandboxExecutionError>);
    await delay(1_250);
    expect(existsSync(escaped)).toBe(false);
  });

  it("kills active descendants when the executor closes", async () => {
    const childMarker = path.join(workspace, "close-descendant-escaped");
    const started = path.join(workspace, "close-descendant-started");
    const closingExecutor = await createBubblewrapExecutor({
      cwd: workspace,
      bubblewrapPath: BWRAP_PATH,
      workerCommand: testSandboxWorkerCommand(),
    });
    const execution = closingExecutor.execute({
      argv: [
        "/bin/bash",
        "-c",
        `printf started > ${shellQuote(started)}; (sleep 1; printf escaped > ${shellQuote(childMarker)}) & wait`,
      ],
      timeoutMs: 10_000,
    });
    await waitForFile(started);
    const closed = expect(execution).rejects.toMatchObject({
      code: "sandbox_closed",
    } satisfies Partial<SandboxExecutionError>);
    await closingExecutor.close();
    await closed;
    await delay(1_250);
    expect(existsSync(childMarker)).toBe(false);
  });
});

if (REQUIRE_REAL_BWRAP && !REAL_BWRAP_AVAILABLE) {
  it("requires real Bubblewrap on this verification host", () => {
    throw new Error(`Required Bubblewrap executable is unavailable: ${BWRAP_PATH}`);
  });
}

async function waitForFile(filename: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(filename)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for sandbox fixture: ${filename}`);
}

function parseEnvironment(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
