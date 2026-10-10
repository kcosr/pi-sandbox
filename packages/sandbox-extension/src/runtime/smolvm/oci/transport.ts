import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, realpath } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";
import {
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxExecutionErrorCode,
  type SandboxExecutionOptions,
} from "../../contracts.js";
import type { SmolvmOciAttachment, SmolvmOciFamily, SmolvmOciMachine } from "./types.js";
import { LINUX_TOOL_COMMANDS } from "../../tool-commands.js";

const MAX_REQUEST = 2 * 1048576;
const MAX_OUTPUT = 64 * 1048576 + 4096;
const MAX_OUTPUT_CHUNK = 65536;
type OutputStream = "stdout" | "stderr";
type OutputBlock = { stream: OutputStream; bytes: Buffer; length: number };
type OrderedBlock = { bytes: Buffer; stderr: Buffer; length: number };

/** Final result accumulation only. Callbacks have already run in wire order. */
class OutputBlocks {
  private readonly blocks: OutputBlock[] = [];
  private readonly tails: Partial<Record<OutputStream, OutputBlock>> = {};

  append(stream: OutputStream, bytes: Buffer): void {
    for (let offset = 0; offset < bytes.length;) {
      let tail = this.tails[stream];
      if (!tail || tail.length === MAX_OUTPUT_CHUNK) {
        tail = {
          stream,
          bytes: Buffer.allocUnsafe(
            Math.min(MAX_OUTPUT_CHUNK, Math.max(1024, bytes.length - offset)),
          ),
          length: 0,
        };
        this.tails[stream] = tail;
        this.blocks.push(tail);
      }
      const length = Math.min(MAX_OUTPUT_CHUNK - tail.length, bytes.length - offset);
      if (tail.length + length > tail.bytes.length) {
        const grown = Buffer.allocUnsafe(
          Math.min(MAX_OUTPUT_CHUNK, Math.max(tail.length + length, 2 * tail.bytes.length)),
        );
        tail.bytes.copy(grown, 0, 0, tail.length);
        tail.bytes = grown;
      }
      bytes.copy(tail.bytes, tail.length, offset, offset + length);
      tail.length += length;
      offset += length;
    }
  }

  concat(stream: OutputStream): Buffer {
    return Buffer.concat(
      this.blocks
        .filter((block) => block.stream === stream)
        .map((block) => block.bytes.subarray(0, block.length)),
    );
  }
}

/** Pending wire output must retain global arrival order. One stream bit per
 * byte avoids an object/allocation per alternating one-byte write. A shifted
 * block is immutable while draining; new writes append only to queued blocks. */
class OrderedOutputBlocks {
  private readonly blocks: OrderedBlock[] = [];

  get pending(): boolean {
    return this.blocks.length > 0;
  }

  append(stream: OutputStream, bytes: Buffer): void {
    for (let offset = 0; offset < bytes.length;) {
      let tail = this.blocks.at(-1);
      if (!tail || tail.length === MAX_OUTPUT_CHUNK) {
        const capacity = Math.min(MAX_OUTPUT_CHUNK, Math.max(1024, bytes.length - offset));
        tail = {
          bytes: Buffer.allocUnsafe(capacity),
          stderr: Buffer.alloc(Math.ceil(capacity / 8)),
          length: 0,
        };
        this.blocks.push(tail);
      }
      const length = Math.min(MAX_OUTPUT_CHUNK - tail.length, bytes.length - offset);
      if (tail.length + length > tail.bytes.length) {
        const capacity = Math.min(
          MAX_OUTPUT_CHUNK,
          Math.max(tail.length + length, 2 * tail.bytes.length),
        );
        const grown = Buffer.allocUnsafe(capacity);
        const stderr = Buffer.alloc(Math.ceil(capacity / 8));
        tail.bytes.copy(grown, 0, 0, tail.length);
        tail.stderr.copy(stderr);
        tail.bytes = grown;
        tail.stderr = stderr;
      }
      bytes.copy(tail.bytes, tail.length, offset, offset + length);
      if (stream === "stderr") markStderr(tail.stderr, tail.length, tail.length + length);
      tail.length += length;
      offset += length;
    }
  }

  shift(): OrderedBlock | undefined {
    return this.blocks.shift();
  }

  clear(): void {
    this.blocks.length = 0;
  }
}

function markStderr(bits: Buffer, start: number, end: number): void {
  const first = start >> 3;
  const last = (end - 1) >> 3;
  if (first === last) {
    bits[first] = bits[first]! | (((1 << (end - start)) - 1) << (start & 7));
  } else {
    bits[first] = bits[first]! | (0xff << (start & 7));
    bits.fill(0xff, first + 1, last);
    bits[last] = bits[last]! | ((1 << (((end - 1) & 7) + 1)) - 1);
  }
}

function streamAt(block: OrderedBlock, offset: number): OutputStream {
  return (block.stderr[offset >> 3]! & (1 << (offset & 7))) === 0 ? "stdout" : "stderr";
}
const codes = new Set<SandboxExecutionErrorCode>([
  "sandbox_queue_full",
  "sandbox_admission_timeout",
  "sandbox_aborted",
  "sandbox_closed",
  "sandbox_input_too_large",
  "sandbox_invalid_request",
  "sandbox_output_limit_exceeded",
  "sandbox_process_failed",
  "sandbox_start_failed",
  "sandbox_timeout",
]);
export function validateOciAttachment(value: unknown): asserts value is SmolvmOciAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SandboxExecutionError("sandbox_invalid_request");
  const d = value as Record<string, unknown>;
  if (
    Object.keys(d).sort().join(",") !== "cwd,home,machineId,socketPath,token,version" ||
    d.version !== 1 ||
    typeof d.socketPath !== "string" ||
    !path.isAbsolute(d.socketPath) ||
    path.normalize(d.socketPath) !== d.socketPath ||
    /[\0\r\n]/u.test(d.socketPath) ||
    Buffer.byteLength(d.socketPath) > 100 ||
    typeof d.token !== "string" ||
    !/^[a-f0-9]{64}$/u.test(d.token) ||
    typeof d.machineId !== "string" ||
    !/^(?:candidate|branch-[1-9][0-9]*)$/u.test(d.machineId) ||
    typeof d.cwd !== "string" ||
    !path.posix.isAbsolute(d.cwd) ||
    path.posix.normalize(d.cwd) !== d.cwd ||
    /[\0\r\n]/u.test(d.cwd) ||
    d.home !== "/root"
  )
    throw new SandboxExecutionError("sandbox_invalid_request");
}

export async function serveOciFamily(
  socketPath: string,
  family: SmolvmOciFamily,
): Promise<() => Promise<void>> {
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    if (clients.size >= 64) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    const abort = new AbortController();
    let buffer = "",
      started = false,
      ended = false;
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.once("close", () => {
      clients.delete(socket);
      if (!ended) abort.abort();
    });
    // Execution callbacks are synchronous. Queue bounded raw bytes rather than
    // filling the socket's write buffer; encode each frame only when it can drain.
    const output = new OrderedOutputBlocks();
    let draining: Promise<void> | undefined;
    let writeFailed = false;
    let outputBytes = 0;
    let outputLimit = false;
    const drain = () => {
      if (draining || writeFailed) return;
      draining = Promise.resolve()
        .then(async () => {
          for (let block; (block = output.shift());) {
            for (let offset = 0; offset < block.length;) {
              const stream = streamAt(block, offset);
              let end = offset + 1;
              while (end < block.length && streamAt(block, end) === stream) end++;
              await writeFrame(socket, {
                type: "output",
                stream,
                data: block.bytes.subarray(offset, end).toString("base64"),
              });
              offset = end;
            }
          }
        })
        .catch(() => {
          writeFailed = true;
          output.clear();
          socket.destroy();
        })
        .finally(() => {
          draining = undefined;
          if (output.pending) drain();
        });
    };
    const writeOutput = (stream: OutputStream, bytes: Buffer) => {
      if (abort.signal.aborted || writeFailed) return;
      if (outputBytes + bytes.length > MAX_OUTPUT) {
        outputLimit = true;
        abort.abort();
        return;
      }
      outputBytes += bytes.length;
      output.append(stream, bytes);
      drain();
    };
    const handle = async (raw: Record<string, unknown>) => {
      let terminal: object;
      try {
        if (
          Object.keys(raw).sort().join(",") !== "machineId,request,token,version" ||
          raw.version !== 1 ||
          typeof raw.machineId !== "string" ||
          typeof raw.token !== "string" ||
          !/^[a-f0-9]{64}$/u.test(raw.token)
        )
          throw new SandboxExecutionError("sandbox_invalid_request");
        const descriptor = family.attachment(raw.machineId);
        if (!timingSafeEqual(Buffer.from(raw.token, "hex"), Buffer.from(descriptor.token, "hex")))
          throw new SandboxExecutionError("sandbox_invalid_request");
        const request = raw.request as Record<string, unknown>;
        if (!request || typeof request !== "object" || Array.isArray(request))
          throw new SandboxExecutionError("sandbox_invalid_request");
        const wire = { ...request };
        if (wire.stdin !== undefined) {
          if (typeof wire.stdin !== "string")
            throw new SandboxExecutionError("sandbox_invalid_request");
          const bytes = Buffer.from(wire.stdin, "base64");
          if (bytes.toString("base64") !== wire.stdin)
            throw new SandboxExecutionError("sandbox_invalid_request");
          wire.stdin = bytes;
        }
        socket.setTimeout(0);
        const result = await family.execute(
          raw.machineId,
          wire as unknown as SandboxCommandRequest,
          {
            signal: abort.signal,
            onStdout: (bytes) => writeOutput("stdout", bytes),
            onStderr: (bytes) => writeOutput("stderr", bytes),
          },
        );
        terminal = outputLimit
          ? { type: "failure", code: "sandbox_output_limit_exceeded" }
          : { type: "result", exitCode: result.exitCode, signal: result.signal };
      } catch (error) {
        terminal = {
          type: "failure",
          code: outputLimit
            ? "sandbox_output_limit_exceeded"
            : error instanceof SandboxExecutionError
              ? error.code
              : "sandbox_process_failed",
        };
      } finally {
        // A slow reader after execution completes does not own the family lifecycle.
        ended = true;
      }
      while (draining) await draining;
      if (!writeFailed) await writeFrame(socket, terminal).catch(() => socket.destroy());
      socket.end();
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST) {
        socket.destroy();
        return;
      }
      for (let end; (end = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const raw = JSON.parse(line) as Record<string, unknown>;
          if (started) {
            if (raw && Object.keys(raw).length === 1 && raw.cancel === true) abort.abort();
            else socket.destroy();
          } else {
            started = true;
            void handle(raw);
          }
        } catch {
          socket.destroy();
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.on("error", () => {
    for (const c of clients) c.destroy();
  });
  await chmod(socketPath, 0o600);
  return async () => {
    for (const c of clients) c.destroy();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  };
}

function writeFrame(socket: Socket, message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("drain", drained);
      socket.off("close", closed);
      socket.off("error", closed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new Error("Attachment socket closed"));
    };
    if (socket.destroyed || !socket.writable) {
      closed();
      return;
    }
    socket.once("close", closed);
    socket.once("error", closed);
    try {
      if (socket.write(JSON.stringify(message) + "\n")) drained();
      else socket.once("drain", drained);
    } catch {
      closed();
    }
  });
}

export async function attachSmolvmOciMachine(
  attachment: SmolvmOciAttachment,
): Promise<SmolvmOciMachine> {
  validateOciAttachment(attachment);
  attachment = { ...attachment };
  const [socket, parent] = await Promise.all([
    lstat(attachment.socketPath),
    lstat(path.dirname(attachment.socketPath)),
  ]);
  if (
    (await realpath(path.dirname(attachment.socketPath))) !== path.dirname(attachment.socketPath) ||
    !socket.isSocket() ||
    socket.uid !== process.getuid?.() ||
    (socket.mode & 0o077) !== 0 ||
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  )
    throw new SandboxExecutionError("sandbox_invalid_request");
  let closed = false;
  const sockets = new Set<Socket>();
  const machine: SmolvmOciMachine = {
    backend: "smolvm",
    cwd: attachment.cwd,
    home: attachment.home,
    commands: LINUX_TOOL_COMMANDS,
    async execute(
      request: SandboxCommandRequest,
      options: SandboxExecutionOptions = {},
    ): Promise<SandboxCommandResult> {
      if (closed) throw new SandboxExecutionError("sandbox_closed");
      if (options.signal?.aborted) throw new SandboxExecutionError("sandbox_aborted");
      if (
        request.stdin !== undefined &&
        typeof request.stdin !== "string" &&
        !(request.stdin instanceof Uint8Array)
      )
        throw new SandboxExecutionError("sandbox_invalid_request");
      const payload =
        JSON.stringify({
          version: 1,
          machineId: attachment.machineId,
          token: attachment.token,
          request: {
            ...request,
            ...(request.stdin === undefined
              ? {}
              : { stdin: Buffer.from(request.stdin).toString("base64") }),
          },
        }) + "\n";
      if (Buffer.byteLength(payload) > MAX_REQUEST)
        throw new SandboxExecutionError("sandbox_input_too_large");
      return new Promise((resolve, reject) => {
        const connection = createConnection(attachment.socketPath);
        sockets.add(connection);
        let buffer = "",
          bytes = 0,
          settled = false;
        const output = new OutputBlocks();
        const abort = () => {
          connection.write('{"cancel":true}\n');
        };
        const finish = (error?: Error, result?: SandboxCommandResult) => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener("abort", abort);
          connection.destroy();
          sockets.delete(connection);
          if (error) reject(error);
          else resolve(result!);
        };
        connection.setEncoding("utf8");
        connection.setTimeout(5000, () =>
          finish(new SandboxExecutionError("sandbox_process_failed")),
        );
        connection.once("connect", () => {
          connection.setTimeout(25 * 60 * 1000);
          connection.write(payload);
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        });
        connection.on("error", () => finish(new SandboxExecutionError("sandbox_process_failed")));
        connection.once("close", () => finish(new SandboxExecutionError("sandbox_closed")));
        connection.on("data", (chunk: string) => {
          try {
            buffer += chunk;
            if (buffer.length > 1024 * 1024) throw Error("frame too large");
            for (let end; (end = buffer.indexOf("\n")) >= 0;) {
              const message = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
              buffer = buffer.slice(end + 1);
              if (
                message.type === "output" &&
                (message.stream === "stdout" || message.stream === "stderr") &&
                typeof message.data === "string"
              ) {
                const b = Buffer.from(message.data, "base64");
                if (
                  !b.length ||
                  b.length > MAX_OUTPUT_CHUNK ||
                  b.toString("base64") !== message.data ||
                  (bytes += b.length) > MAX_OUTPUT
                )
                  throw Error("invalid output");
                output.append(message.stream, b);
                (message.stream === "stdout" ? options.onStdout : options.onStderr)?.(b);
              } else if (
                message.type === "result" &&
                (message.exitCode === null ||
                  (typeof message.exitCode === "number" && Number.isInteger(message.exitCode))) &&
                (message.signal === null || message.signal === "SIGKILL")
              ) {
                finish(undefined, {
                  exitCode: message.exitCode,
                  signal: message.signal,
                  stdout: output.concat("stdout"),
                  stderr: output.concat("stderr"),
                });
              } else if (
                message.type === "failure" &&
                codes.has(message.code as SandboxExecutionErrorCode)
              ) {
                finish(new SandboxExecutionError(message.code as SandboxExecutionErrorCode));
              } else throw Error("invalid response");
            }
          } catch {
            finish(new SandboxExecutionError("sandbox_process_failed"));
          }
        });
      });
    },
    async probe(signal?: AbortSignal) {
      const result = await machine.execute(
        { argv: ["/usr/bin/node", "-e", "process.stdout.write('ready')"] },
        signal ? { signal } : {},
      );
      if (result.exitCode !== 0 || result.stdout.toString() !== "ready")
        throw new SandboxExecutionError("sandbox_start_failed");
    },
    close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return Promise.resolve();
    },
  };
  await machine.probe();
  return machine;
}
