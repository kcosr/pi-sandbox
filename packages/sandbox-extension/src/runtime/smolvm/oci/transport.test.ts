import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { SandboxExecutionError } from "../../contracts.js";
import { attachSmolvmOciMachine, serveOciFamily } from "./transport.js";
import type { SmolvmOciAttachment, SmolvmOciFamily } from "./types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("OCI attachment capability", () => {
  it.each([false, true])(
    "preserves 70000 alternating tiny writes with drain opportunities=%s",
    async (paced) => {
      const dir = await mkdtemp("/var/tmp/oci-tiny-");
      const descriptor: SmolvmOciAttachment = {
        version: 1,
        socketPath: path.join(dir, "control.sock"),
        token: "a".repeat(64),
        machineId: "candidate",
        cwd: "/workspace",
        home: "/root",
      };
      let producing = false;
      let signal: AbortSignal | undefined;
      const family: SmolvmOciFamily = {
        sourceId: "candidate",
        statePath: dir,
        attachment: () => descriptor,
        execute: async (_id, request, options) => {
          if (!request.argv.includes("/bin/tiny")) {
            const ready = Buffer.from("ready");
            options?.onStdout?.(ready);
            return { exitCode: 0, signal: null, stdout: ready, stderr: Buffer.alloc(0) };
          }
          signal = options?.signal;
          producing = true;
          const byte = Buffer.alloc(1);
          for (let i = 0; i < 70000; i++) {
            byte[0] = i % 256;
            (i % 2 === 0 ? options?.onStdout : options?.onStderr)?.(byte);
            if (paced && i % 128 === 0) await immediate();
          }
          producing = false;
          return { exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
        branch: () => Promise.reject(Error("not used")),
        removeMachine: () => Promise.reject(Error("not used")),
        retainForColdReopen: () => Promise.reject(Error("not used")),
        close: async () => {},
      };
      const stop = await serveOciFamily(descriptor.socketPath, family);
      const client = await attachSmolvmOciMachine(descriptor);
      try {
        const callbackBytes = Buffer.alloc(70000);
        const callbackStreams = Buffer.alloc(70000);
        let offset = 0;
        let streamedBeforeCompletion = false;
        const onOutput = (bytes: Buffer, stream: number) => {
          bytes.copy(callbackBytes, offset);
          callbackStreams.fill(stream, offset, offset + bytes.length);
          offset += bytes.length;
          streamedBeforeCompletion ||= producing;
        };
        const result = await client.execute(
          { argv: ["/bin/tiny"] },
          {
            onStdout: (bytes) => onOutput(bytes, 0),
            onStderr: (bytes) => onOutput(bytes, 1),
          },
        );
        const expected = (parity: number) =>
          Buffer.from(Array.from({ length: 35000 }, (_, i) => (2 * i + parity) % 256));
        expect(result.stdout.equals(expected(0))).toBe(true);
        expect(result.stderr.equals(expected(1))).toBe(true);
        expect(offset).toBe(70000);
        expect(callbackBytes.every((byte, index) => byte === index % 256)).toBe(true);
        expect(callbackStreams.every((stream, index) => stream === index % 2)).toBe(true);
        expect(signal?.aborted).toBe(false);
        if (paced) expect(streamedBeforeCompletion).toBe(true);
      } finally {
        await client.close();
        await stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("accepts 70000 small wire frames within the byte allowance", async () => {
    const dir = await mkdtemp("/var/tmp/oci-wire-");
    const descriptor: SmolvmOciAttachment = {
      version: 1,
      socketPath: path.join(dir, "control.sock"),
      token: "a".repeat(64),
      machineId: "candidate",
      cwd: "/workspace",
      home: "/root",
    };
    const sockets = new Set<Socket>();
    const frame = (stream: string, data: Buffer) =>
      JSON.stringify({ type: "output", stream, data: data.toString("base64") }) + "\n";
    const result = JSON.stringify({ type: "result", exitCode: 0, signal: null }) + "\n";
    const wire = (frame("stdout", Buffer.from([1])) + frame("stderr", Buffer.from([2]))).repeat(
      35000,
    );
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.trim()) as { request: { argv: string[] } };
        socket.end(
          (request.request.argv.includes("/bin/wire")
            ? wire
            : frame("stdout", Buffer.from("ready"))) + result,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(descriptor.socketPath, resolve));
    await chmod(descriptor.socketPath, 0o600);
    const client = await attachSmolvmOciMachine(descriptor);
    try {
      let count = 0;
      const onOutput = () => {
        count++;
      };
      const output = await client.execute(
        { argv: ["/bin/wire"] },
        { onStdout: onOutput, onStderr: onOutput },
      );
      expect(count).toBe(70000);
      expect(output.stdout.equals(Buffer.alloc(35000, 1))).toBe(true);
      expect(output.stderr.equals(Buffer.alloc(35000, 2))).toBe(true);
    } finally {
      await client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["cancel", "disconnect"])("still aborts an active request on %s", async (action) => {
    const dir = await mkdtemp("/var/tmp/oci-cancel-");
    const descriptor: SmolvmOciAttachment = {
      version: 1,
      socketPath: path.join(dir, "control.sock"),
      token: "a".repeat(64),
      machineId: "candidate",
      cwd: "/workspace",
      home: "/root",
    };
    const started = deferred();
    const aborted = deferred();
    const family: SmolvmOciFamily = {
      sourceId: "candidate",
      statePath: dir,
      attachment: () => descriptor,
      execute: (_id, _request, options) =>
        new Promise<never>((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new SandboxExecutionError("sandbox_aborted"));
            },
            { once: true },
          );
          started.resolve();
        }),
      branch: () => Promise.reject(Error("not used")),
      removeMachine: () => Promise.reject(Error("not used")),
      retainForColdReopen: () => Promise.reject(Error("not used")),
      close: async () => {},
    };
    const stop = await serveOciFamily(descriptor.socketPath, family);
    const socket = createConnection(descriptor.socketPath);
    socket.on("error", () => {});
    socket.resume();
    try {
      socket.once("connect", () =>
        socket.write(
          JSON.stringify({
            version: 1,
            machineId: "candidate",
            token: descriptor.token,
            request: { argv: ["/bin/sleep", "120"] },
          }) + "\n",
        ),
      );
      await started.promise;
      if (action === "cancel") socket.write('{"cancel":true}\n');
      else socket.destroy();
      await aborted.promise;
    } finally {
      socket.destroy();
      await stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["result", "failure"])(
    "preserves cross-stream callback order and %s through a temporarily paused reader",
    async (completion) => {
      const dir = await mkdtemp("/var/tmp/oci-slow-");
      const descriptor: SmolvmOciAttachment = {
        version: 1,
        socketPath: path.join(dir, "control.sock"),
        token: "a".repeat(64),
        machineId: "candidate",
        cwd: "/workspace",
        home: "/root",
      };
      const produced = deferred();
      const finish = deferred();
      let requestSignal: AbortSignal | undefined;
      const writes: ["stdout" | "stderr", Buffer][] = [
        ["stdout", Buffer.alloc(4 * 1048576 + 1, 0xa5)],
        ["stderr", Buffer.alloc(2 * 1048576 + 1, 0xff)],
        ["stdout", Buffer.from("A")],
        ["stderr", Buffer.from("B")],
        ["stdout", Buffer.from("C")],
        ["stderr", Buffer.alloc(65540, 0x12)],
        ["stdout", Buffer.from("D")],
        ["stderr", Buffer.from("E")],
      ];
      const stdout = Buffer.concat(
        writes.filter(([stream]) => stream === "stdout").map(([, bytes]) => bytes),
      );
      const stderr = Buffer.concat(
        writes.filter(([stream]) => stream === "stderr").map(([, bytes]) => bytes),
      );
      const expectedBytes = Buffer.concat(writes.map(([, bytes]) => bytes));
      const expectedStreams = Buffer.concat(
        writes.map(([stream, bytes]) => Buffer.alloc(bytes.length, stream === "stdout" ? 0 : 1)),
      );
      const family: SmolvmOciFamily = {
        sourceId: "candidate",
        statePath: dir,
        attachment: () => descriptor,
        execute: async (_id, request, options) => {
          if (request.argv.includes("/bin/large")) {
            requestSignal = options?.signal;
            for (const [stream, bytes] of writes) {
              (stream === "stdout" ? options?.onStdout : options?.onStderr)?.(bytes);
            }
            produced.resolve();
            await finish.promise;
            if (completion === "failure") throw new SandboxExecutionError("sandbox_timeout");
            return { exitCode: 7, signal: null, stdout, stderr };
          }
          const ready = Buffer.from("ready");
          options?.onStdout?.(ready);
          return { exitCode: 0, signal: null, stdout: ready, stderr: Buffer.alloc(0) };
        },
        branch: () => Promise.reject(Error("not used")),
        removeMachine: () => Promise.reject(Error("not used")),
        retainForColdReopen: () => Promise.reject(Error("not used")),
        close: () => Promise.reject(Error("Reader backpressure must not close the family")),
      };
      const stop = await serveOciFamily(descriptor.socketPath, family);
      // Pause only server-to-client forwarding after the initial client probe.
      // This produces real socket backpressure while exercising the public
      // attachment client's callbacks, rather than a second wire parser.
      const bridgePath = path.join(dir, "paused.sock");
      const sockets = new Set<Socket>();
      let pauseForwarding = false;
      let paused: Socket | undefined;
      const bridge = createServer((socket) => {
        const upstream = createConnection(descriptor.socketPath);
        for (const connected of [socket, upstream]) {
          sockets.add(connected);
          connected.on("error", () => {
            socket.destroy();
            upstream.destroy();
          });
          connected.once("close", () => sockets.delete(connected));
        }
        socket.pipe(upstream);
        upstream.pipe(socket);
        if (pauseForwarding) {
          upstream.pause();
          paused = upstream;
        }
      });
      await new Promise<void>((resolve) => bridge.listen(bridgePath, resolve));
      await chmod(bridgePath, 0o600);
      const client = await attachSmolvmOciMachine({ ...descriptor, socketPath: bridgePath });
      try {
        const callbackBytes = Buffer.alloc(expectedBytes.length);
        const callbackStreams = Buffer.alloc(expectedStreams.length);
        let offset = 0;
        const onOutput = (bytes: Buffer, stream: number) => {
          bytes.copy(callbackBytes, offset);
          callbackStreams.fill(stream, offset, offset + bytes.length);
          offset += bytes.length;
        };
        pauseForwarding = true;
        const completed = client
          .execute(
            { argv: ["/bin/large"], maxOutputBytes: 8 * 1048576 },
            { onStdout: (bytes) => onOutput(bytes, 0), onStderr: (bytes) => onOutput(bytes, 1) },
          )
          .then(
            (result) => ({ result, error: undefined }),
            (error: unknown) => ({ result: undefined, error }),
          );
        await produced.promise;
        await delay(50);
        expect(requestSignal?.aborted).toBe(false);
        finish.resolve();
        await delay(25);
        expect(offset).toBe(0);
        expect(paused).toBeDefined();
        paused!.resume();
        const { result, error } = await completed;
        expect(offset).toBe(expectedBytes.length);
        expect(callbackBytes.equals(expectedBytes)).toBe(true);
        expect(callbackStreams.equals(expectedStreams)).toBe(true);
        if (completion === "result") {
          expect(error).toBeUndefined();
          expect(result?.exitCode).toBe(7);
          expect(result?.signal).toBe(null);
          expect(result?.stdout.equals(stdout)).toBe(true);
          expect(result?.stderr.equals(stderr)).toBe(true);
        } else {
          expect(error).toMatchObject({ code: "sandbox_timeout" });
        }
        expect(requestSignal?.aborted).toBe(false);
        const next = await attachSmolvmOciMachine(descriptor);
        await next.close();
      } finally {
        finish.resolve();
        await client.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          bridge.close((error) => (error ? reject(error) : resolve())),
        );
        await stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("authenticates before tool dispatch and offers no controller operation", async () => {
    const dir = await mkdtemp("/var/tmp/oci-rpc-");
    const socketPath = path.join(dir, "control.sock");
    let executions = 0;
    const d: SmolvmOciAttachment = {
      version: 1,
      socketPath,
      token: "a".repeat(64),
      machineId: "candidate",
      cwd: "/workspace",
      home: "/root",
    };
    const family: SmolvmOciFamily = {
      sourceId: "candidate",
      statePath: dir,
      attachment: (id) => {
        if (id !== "candidate") throw Error("wrong machine");
        return d;
      },
      execute: (_id, r, o) => {
        executions++;
        const bytes = r.argv.includes("/bin/large")
          ? Buffer.alloc(2 * 65536 + 1, 0xa5)
          : Buffer.from(r.argv.includes("/bin/probe") ? "data" : "ready");
        const errors = r.argv.includes("/bin/large") ? Buffer.alloc(65537, 0xff) : Buffer.alloc(0);
        o?.onStdout?.(bytes);
        o?.onStderr?.(errors);
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: bytes,
          stderr: errors,
        });
      },
      branch: () => Promise.reject(Error("not reachable")),
      removeMachine: () => Promise.reject(Error("not reachable")),
      retainForColdReopen: () => Promise.reject(Error("not exposed by transport")),
      close: async () => {},
    };
    const stop = await serveOciFamily(socketPath, family);
    try {
      await expect(attachSmolvmOciMachine({ ...d, token: "b".repeat(64) })).rejects.toMatchObject({
        code: "sandbox_invalid_request",
      });
      expect(executions).toBe(0);
      const send = (value: unknown) =>
        new Promise<string>((resolve, reject) => {
          const s = createConnection(socketPath);
          let bytes = "";
          s.on("connect", () => s.write(JSON.stringify(value) + "\n"));
          s.on("data", (b) => (bytes += b.toString()));
          s.on("end", () => resolve(bytes));
          s.on("error", reject);
        });
      const reply = await send({
        version: 1,
        token: d.token,
        machineId: "candidate",
        operation: "branch",
      });
      expect(JSON.parse(reply)).toEqual({ type: "failure", code: "sandbox_invalid_request" });
      expect(executions).toBe(0);
      await symlink(dir, path.join(dir, "alias"));
      await expect(
        attachSmolvmOciMachine({ ...d, socketPath: path.join(dir, "alias", "control.sock") }),
      ).rejects.toMatchObject({ code: "sandbox_invalid_request" });
      const client = await attachSmolvmOciMachine(d);
      const chunks: Buffer[] = [];
      const result = await client.execute(
        { argv: ["/bin/probe"], stdin: Buffer.from([0, 255]) },
        { onStdout: (b) => chunks.push(b) },
      );
      expect(result.stdout.toString()).toBe("data");
      expect(Buffer.concat(chunks)).toEqual(result.stdout);
      expect(executions).toBe(2);
      const largeChunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];
      const large = await client.execute(
        { argv: ["/bin/large"] },
        {
          onStdout: (bytes) => largeChunks.push(bytes),
          onStderr: (bytes) => errorChunks.push(bytes),
        },
      );
      expect(
        [...largeChunks, ...errorChunks].every(
          (bytes) => bytes.length > 0 && bytes.length <= 65536,
        ),
      ).toBe(true);
      expect(Buffer.concat(largeChunks)).toEqual(Buffer.alloc(2 * 65536 + 1, 0xa5));
      expect(large.stdout).toEqual(Buffer.concat(largeChunks));
      expect(large.stderr).toEqual(Buffer.alloc(65537, 0xff));
      await client.close();
    } finally {
      await stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
