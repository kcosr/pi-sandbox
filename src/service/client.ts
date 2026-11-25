import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { connect as connectNet, isIP } from "node:net";
import type { buildConnector } from "undici";
import Client from "undici/lib/dispatcher/client.js";
import request from "undici/lib/api/api-request.js";
import { dirname, isAbsolute, normalize } from "node:path";
import { connect as connectTls, rootCertificates } from "node:tls";
import type { ServiceEndpoint } from "./endpoint.js";
import { freezeJson, parseStrictJson } from "./json.js";
import {
  parseServiceResponse,
  type OperationInputs,
  type OperationResults,
  type ServiceIdentity,
  type ServiceOperation,
  type ServiceTransport,
} from "./protocol.js";

export async function verifyServiceSocket(path: string): Promise<void> {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0"))
    throw new Error("Invalid managed service socket path");
  const socket = await lstat(path);
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== 0)
    throw new Error("Managed service socket must be root-owned");
  for (let ancestor = dirname(path); ;) {
    const stat = await lstat(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
      throw new Error("Managed service socket ancestors must be protected");
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}
export interface ServiceClientDependencies {
  readonly identity?: () => ServiceIdentity;
  readonly verifySocket?: (path: string) => Promise<void>;
}

/** Direct sockets avoid Bun's node:http shim and any ambient/global proxy dispatcher. */
function directConnector(endpoint: ServiceEndpoint, signal: AbortSignal): buildConnector.connector {
  return (_options, callback) => {
    const url = endpoint.transport === "https" ? new URL(endpoint.url) : undefined;
    const host = url?.hostname.replace(/^\[|\]$/gu, "");
    const socket =
      endpoint.transport === "unix"
        ? connectNet({ path: endpoint.socketPath })
        : connectTls({
            host,
            port: Number(url!.port || 443),
            ...(host && !isIP(host) ? { servername: host } : {}),
            ca: endpoint.tlsCa ?? [...rootCertificates],
            minVersion: "TLSv1.2",
            rejectUnauthorized: true,
            ALPNProtocols: ["http/1.1"],
          });
    const abort = () => socket.destroy(new Error("Managed service request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    socket.once("close", () => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    let connected = false;
    socket.once("error", (error: Error) => {
      if (!connected) {
        connected = true;
        callback(error, null);
      }
    });
    // Undici's public response does not expose HTTP version. Check only the fixed
    // nine-byte prefix before its parser reads each chunk; Undici owns all framing.
    // Informational responses are rejected below, so only one preface is permitted.
    const expected = Buffer.from("HTTP/1.1 ");
    let offset = 0;
    const checkVersion = (chunk: Buffer) => {
      for (let index = 0; index < chunk.length && offset < expected.length; index++, offset++) {
        if (chunk[index] !== expected[offset]) {
          socket.destroy(new Error("Invalid managed service HTTP version"));
          socket.removeListener("data", checkVersion);
          return;
        }
      }
      if (offset === expected.length) socket.removeListener("data", checkVersion);
    };
    socket.prependListener("data", checkVersion);
    socket.once(endpoint.transport === "unix" ? "connect" : "secureConnect", () => {
      if (connected) return;
      connected = true;
      callback(null, socket);
    });
  };
}

/** One immutable endpoint; every operation uses a new connection and is never retried. */
export class ServiceClient implements ServiceTransport {
  readonly endpoint: ServiceEndpoint;
  constructor(
    endpoint: ServiceEndpoint,
    private readonly dependencies: ServiceClientDependencies = {},
  ) {
    this.endpoint = freezeJson(structuredClone(endpoint));
  }
  async request<K extends ServiceOperation>(
    operation: K,
    input: OperationInputs[K],
    timeoutMs = 10_000,
  ): Promise<OperationResults[K]> {
    const requestId = randomBytes(16).toString("hex");
    const deadline = Date.now() + Math.min(timeoutMs, 10_000);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new Error("Managed service request timed out"));
        },
        Math.max(1, deadline - Date.now()),
      );
    });
    try {
      return await Promise.race([
        this.dispatch(
          operation,
          freezeJson(structuredClone(input)),
          requestId,
          deadline,
          controller.signal,
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer!);
      controller.abort();
    }
  }
  private async dispatch<K extends ServiceOperation>(
    operation: K,
    input: OperationInputs[K],
    requestId: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<OperationResults[K]> {
    const endpoint = this.endpoint;
    if (endpoint.transport === "unix")
      await (this.dependencies.verifySocket ?? verifyServiceSocket)(endpoint.socketPath);
    const identity = endpoint.transport === "https" ? this.dependencies.identity?.() : undefined;
    if (
      endpoint.transport === "https" &&
      (!identity ||
        (endpoint.sendMachineId && !identity.machine_id) ||
        (!endpoint.sendMachineId && identity.machine_id !== undefined))
    )
      throw new Error("Managed service identity is unavailable");
    if (signal.aborted || Date.now() >= deadline)
      throw new Error("Managed service request timed out");
    const body = Buffer.from(
      JSON.stringify({
        version: 1,
        request_id: requestId,
        operation,
        ...input,
        ...(identity ? { identity } : {}),
      }),
    );
    const large = operation === "bootstrap" || operation === "policy_inspect";
    if (body.length > (large ? 16 * 1024 : 32 * 1024))
      throw new Error("Managed service request exceeds size limit");
    const client = new Client(
      endpoint.transport === "https" ? new URL(endpoint.url).origin : "http://localhost",
      {
        connect: directConnector(endpoint, signal),
        allowH2: false,
        useMilo: false,
        pipelining: 0,
        maxRequestsPerClient: 1,
        maxHeaderSize: 16 * 1024,
        maxResponseSize: 4 * 1024 * 1024,
        headersTimeout: 0,
        bodyTimeout: 0,
      },
    );
    // Dispatcher errors are also delivered to the request promise; avoid an
    // unhandled EventEmitter error while aborting a partial response.
    EventEmitter.prototype.on.call(client, "error", () => {});
    try {
      let response;
      try {
        response = await request.call(client, {
          path: "/v1/service",
          method: "POST",
          idempotent: false,
          signal,
          body,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(body.length),
            Connection: "close",
            ...(endpoint.transport === "https"
              ? {
                  Authorization: `Basic ${Buffer.from(`${endpoint.basicUsername}:${endpoint.basicPassword}`).toString("base64")}`,
                }
              : {}),
          },
          onInfo() {
            throw new Error("Informational service responses are not permitted");
          },
        });
      } catch {
        throw new Error("Managed service connection failed");
      }
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
          String(response.headers["content-type"]),
        ) ||
        response.headers["content-encoding"] !== undefined ||
        String(response.headers.connection).toLowerCase() !== "close"
      )
        throw new Error("Managed service returned an invalid HTTP response");
      const maximum = response.statusCode === 200 && large ? 4 * 1024 * 1024 : 4 * 1024;
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const chunk of response.body as AsyncIterable<Buffer>) {
          bytes += chunk.length;
          if (bytes > maximum) throw new Error("Response size limit");
          chunks.push(Buffer.from(chunk));
        }
      } catch {
        throw new Error("Managed service returned an invalid HTTP response");
      }
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(chunks),
      );
      const result = parseServiceResponse(
        parseStrictJson(text, maximum),
        operation,
        requestId,
        response.statusCode,
      );
      if (signal.aborted || Date.now() >= deadline)
        throw new Error("Managed service request timed out");
      return result;
    } finally {
      // Abort/parse failure may already have destroyed the connection. Cleanup
      // cannot replace the operation result or leave a rejected promise unhandled.
      await client.destroy().catch(() => {});
    }
  }
}
