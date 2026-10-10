import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readlink, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBubblewrapExecutor, type SandboxExecutor } from "../../src/sandbox/index.js";
import { testSandboxWorkerCommand } from "../helpers/sandbox-worker.js";

const REQUIRE_REAL_BWRAP = process.env.PI_SANDBOX_REQUIRE_BWRAP === "1";
const BWRAP_PATH = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
const PYTHON = "/usr/bin/python3";
const AVAILABLE = process.platform === "linux" && existsSync(BWRAP_PATH);

describe.skipIf(!AVAILABLE)("real Bubblewrap local networking", () => {
  let directory: string;
  let workspace: string;
  const executors = new Map<"none" | "local" | "host", SandboxExecutor>();

  beforeAll(async () => {
    if (!existsSync(PYTHON))
      throw new Error("Real network-boundary tests require /usr/bin/python3");
    directory = await mkdtemp(
      path.join(process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp", "pi-local-network-"),
    );
    workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    for (const mode of ["none", "local", "host"] as const) {
      const executor = await createBubblewrapExecutor({
        cwd: workspace,
        bubblewrapPath: BWRAP_PATH,
        networkMode: mode,
        workerCommand: testSandboxWorkerCommand(),
      });
      executors.set(mode, executor);
      await executor.probe();
    }
  });

  afterAll(async () => {
    await Promise.all([...executors.values()].map((executor) => executor.close()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function python(mode: "none" | "local" | "host", script: string) {
    return executors.get(mode)!.execute({ argv: [PYTHON, "-c", script], timeoutMs: 5_000 });
  }

  it("permits local IPv4 TCP/UDP and IPv6 loopback when available", async () => {
    const result = await python(
      "local",
      `
import errno, socket
for family, address in [(socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')]:
    try:
        listener = socket.socket(family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
        listener.settimeout(1)
        listener.bind((address, 0))
    except OSError as error:
        if family == socket.AF_INET6 and error.errno in (errno.EAFNOSUPPORT, errno.EADDRNOTAVAIL):
            print('IPv6 unavailable on host kernel')
            continue
        raise
    with listener:
        listener.listen()
        with socket.socket(family, socket.SOCK_STREAM) as client:
            client.settimeout(1)
            client.connect(listener.getsockname())
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(1)
                client.sendall(b'tcp')
                assert connection.recv(3) == b'tcp'
    with socket.socket(family, socket.SOCK_DGRAM, socket.IPPROTO_UDP) as receiver:
        receiver.settimeout(1)
        receiver.bind((address, 0))
        with socket.socket(family, socket.SOCK_DGRAM) as sender:
            sender.sendto(b'udp', receiver.getsockname())
            assert receiver.recv(3) == b'udp'
    print(address + ': TCP/UDP succeeded')
`,
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("127.0.0.1: TCP/UDP succeeded");
    expect(result.stdout.toString()).toMatch(
      /::1: TCP\/UDP succeeded|IPv6 unavailable on host kernel/u,
    );
  });

  it("has only loopback, no external routes, and a distinct persistent network namespace", async () => {
    const result = await python(
      "local",
      `
import os
interfaces = [line.split(':')[0].strip() for line in open('/proc/net/dev').readlines()[2:]]
routes = open('/proc/net/route').read().splitlines()[1:]
try:
    ipv6 = open('/proc/net/ipv6_route').read().splitlines()
except FileNotFoundError:
    ipv6 = []
assert interfaces == ['lo'], interfaces
assert routes == [], routes
for route in ipv6:
    fields = route.split()
    assert fields[-1] == 'lo', route
    if fields[0] == '0' * 32 and fields[1] == '00':
        assert int(fields[-2], 16) & 0x200, route # default route must be unreachable
print(os.readlink('/proc/self/ns/net'))
`,
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const namespace = result.stdout.toString().trim();
    expect(namespace).not.toBe(await readlink("/proc/self/ns/net"));
    const next = await python("local", "import os; print(os.readlink('/proc/self/ns/net'))");
    expect(next.stdout.toString().trim()).toBe(namespace);
    const other = await python("none", "import os; print(os.readlink('/proc/self/ns/net'))");
    expect(other.stdout.toString().trim()).not.toBe(namespace);
  });

  it("cannot reach host TCP or pathname Unix listeners, while host mode can", async () => {
    let tcpConnections = 0;
    let unixConnections = 0;
    const tcp = createServer((socket) => {
      tcpConnections++;
      socket.end();
    });
    const unix = createServer((socket) => {
      unixConnections++;
      socket.end();
    });
    const unixPath = path.join(directory, "host-stream.sock");
    try {
      await listen(tcp, { host: "127.0.0.1", port: 0 });
      await listen(unix, unixPath);
      const address = tcp.address();
      if (!address || typeof address === "string") throw new Error("host_listener_missing");
      for (const mode of ["none", "local", "host"] as const) {
        const result = await python(
          mode,
          `
import errno, socket
expected = ${mode === "host" ? "True" : "False"}
for family, address in [(socket.AF_INET, ('127.0.0.1', ${address.port})), (socket.AF_UNIX, ${JSON.stringify(unixPath)})]:
    connected = False
    try:
        with socket.socket(family, socket.SOCK_STREAM) as connection:
            connection.settimeout(0.5)
            connection.connect(address)
            connected = True
    except OSError as error:
        if expected:
            raise
        assert error.errno in (errno.EACCES, errno.ECONNREFUSED, errno.ENETUNREACH), error
    assert connected == expected, (family, connected)
`,
        );
        expect(result.exitCode, `${mode}: ${result.stderr.toString()}`).toBe(0);
      }
      expect(tcpConnections).toBe(1);
      expect(unixConnections).toBe(1);
    } finally {
      await Promise.all([closeServer(tcp), closeServer(unix)]);
    }
  });

  it("blocks Unix datagram socketpair reassociation in none/local without breaking host mode", async () => {
    const socketPath = path.join(directory, "host-datagram.sock");
    const server = spawn(
      PYTHON,
      [
        "-u",
        "-c",
        `
import socket
with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as server:
    server.bind(${JSON.stringify(socketPath)})
    server.settimeout(10)
    print('ready', flush=True)
    print(server.recv(100).decode(), flush=True)
`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    server.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    server.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      server.once("error", reject);
      server.once("close", resolve);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("datagram_listener_timeout")), 2_000);
        server.stdout.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        server.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        server.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`datagram_listener_failed: ${stderr}`));
        });
      });
      for (const mode of ["none", "local", "host"] as const) {
        const result = await python(
          mode,
          `
import errno, socket
try:
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
except OSError as error:
    assert ${mode === "host" ? "False" : "True"} and error.errno == errno.EACCES, error
else:
    with a, b:
        a.connect(${JSON.stringify(socketPath)})
        a.send(b'host-mode-control')
    assert ${mode === "host" ? "True" : "False"}, 'Unix datagram pair escaped private network policy'
# Bun also needs connected anonymous stream pairs for ordinary child stdio.
a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
with a, b:
    a.send(b'stream-ok')
    assert b.recv(9) == b'stream-ok'
`,
        );
        expect(result.exitCode, `${mode}: ${result.stderr.toString()}`).toBe(0);
      }
      expect(await closed, stderr).toBe(0);
      expect(stdout).toBe("ready\nhost-mode-control\n");
    } finally {
      server.kill("SIGKILL");
      await closed;
    }
  });
});

if (REQUIRE_REAL_BWRAP && !AVAILABLE) {
  it("requires real Bubblewrap for network-boundary verification", () => {
    throw new Error(`Required Bubblewrap executable is unavailable: ${BWRAP_PATH}`);
  });
}

async function listen(
  server: Server,
  target: string | { host: string; port: number },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(target, resolve);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
