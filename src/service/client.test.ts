import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { createServer, type Server, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceClient, verifyServiceSocket } from "./client.js";
import { ServiceError } from "./protocol.js";
const directories: string[] = [];
const servers: Server[] = [];
const input = { audit_session_id: "a".repeat(32), service_epoch: "b".repeat(32) };
const result = { ...input, audit_generation: 1 };
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pi-service-client-"));
  directories.push(path);
  return path;
}
type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
function requestHandler(handler: Handler): RequestListener {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) =>
      res.destroy(error instanceof Error ? error : new Error("Fixture handler failed")),
    );
  };
}
function https(options: ServerOptions, handler: Handler) {
  return createHttpsServer(options, requestHandler(handler));
}
async function unix(handler: Handler) {
  const path = join(await directory(), "service.sock");
  const server = createServer(requestHandler(handler));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, server };
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}
function reply(response: ServerResponse, value: Record<string, unknown>, status = 200) {
  response.writeHead(status, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify(value));
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("managed HTTP/1.1 transport", () => {
  it("opens and verifies a new Unix connection for each operation without payload identity", async () => {
    const requests: Record<string, unknown>[] = [];
    const connections = new Set<unknown>();
    const { path } = await unix(async (req, res) => {
      connections.add(req.socket);
      const request = await body(req);
      requests.push(request);
      expect(req.url).toBe("/v1/service");
      expect(req.method).toBe("POST");
      expect(req.headers.connection).toBe("close");
      reply(res, {
        version: 1,
        request_id: request.request_id,
        operation: request.operation,
        result,
      });
    });
    const verify = vi.fn(async () => {}),
      identity = vi.fn(() => ({ username: "not-used" }));
    const client = new ServiceClient(
      { transport: "unix", socketPath: path },
      { verifySocket: verify, identity },
    );
    await client.request("audit_check", input);
    await client.request("audit_check", input);
    expect(connections.size).toBe(2);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(identity).not.toHaveBeenCalled();
    expect(requests[0]).not.toHaveProperty("identity");
    expect(requests[0]!.request_id).not.toBe(requests[1]!.request_id);
  });
  it("rejects invalid/cross-request responses and does not replay failed requests", async () => {
    let calls = 0;
    const { path } = await unix(async (req, res) => {
      calls++;
      await body(req);
      reply(res, { version: 1, request_id: "c".repeat(32), operation: "audit_check", result });
    });
    const client = new ServiceClient(
      { transport: "unix", socketPath: path },
      { verifySocket: async () => {} },
    );
    await expect(client.request("audit_check", input)).rejects.toThrow("invalid response");
    expect(calls).toBe(1);
  });
  it("shares the whole dispatch deadline with socket verification and never sends after expiry", async () => {
    const handler = vi.fn();
    const { path } = await unix(handler);
    const verify = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    };
    const client = new ServiceClient(
      { transport: "unix", socketPath: path },
      { verifySocket: verify },
    );
    await expect(client.request("audit_check", input, 10)).rejects.toThrow("timed out");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handler).not.toHaveBeenCalled();
  });
  it.each(["encoding", "size", "duplicate", "utf8", "redirect"])(
    "rejects unsupported HTTP response %s without retry",
    async (mode) => {
      let calls = 0;
      const { path } = await unix(async (req, res) => {
        calls++;
        const request = await body(req);
        const envelope = JSON.stringify({
          version: 1,
          request_id: request.request_id,
          operation: request.operation,
          result,
        });
        res.writeHead(mode === "redirect" ? 302 : 200, {
          "content-type": "application/json",
          connection: "close",
          ...(mode === "encoding" ? { "content-encoding": "gzip" } : {}),
          ...(mode === "redirect" ? { location: "http://127.0.0.1:1/" } : {}),
        });
        res.end(
          mode === "size"
            ? " ".repeat(4097)
            : mode === "duplicate"
              ? envelope.replace('"version":1', '"version":1,"version":1')
              : mode === "utf8"
                ? Buffer.from([0xff])
                : envelope,
        );
      });
      await expect(
        new ServiceClient(
          { transport: "unix", socketPath: path },
          { verifySocket: async () => {} },
        ).request("audit_check", input),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    },
  );
  it("enforces TLS trust and hostname verification independently of shared authentication", async () => {
    const root = await directory();
    await chmod(root, 0o700);
    const key = join(root, "key.pem"),
      cert = join(root, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
      ],
      { stdio: "ignore" },
    );
    const certificate = await readFile(cert, "utf8");
    const seen: Record<string, unknown>[] = [];
    const server = https({ key: await readFile(key), cert: certificate }, async (req, res) => {
      const request = await body(req);
      seen.push(request);
      if (
        req.headers.authorization !==
        `Basic ${Buffer.from("fixture:" + "p".repeat(32)).toString("base64")}`
      ) {
        reply(
          res,
          {
            version: 1,
            request_id: request.request_id,
            error: { code: "authentication_required", message: "Invalid credential" },
          },
          401,
        );
        return;
      }
      reply(res, {
        version: 1,
        request_id: request.request_id,
        operation: request.operation,
        result,
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const endpoint = {
      transport: "https" as const,
      url: `https://localhost:${port}/v1/service`,
      basicUsername: "fixture",
      basicPassword: "p".repeat(32),
      sendMachineId: false,
      tlsCa: certificate,
    };
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"])
      vi.stubEnv(name, "http://127.0.0.1:1");
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    vi.stubEnv("UNDICI_USE_MILO", "1");
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", cert);
    vi.stubEnv("SSL_CERT_FILE", cert);
    const identity = () => ({ username: "alice" });
    await expect(
      new ServiceClient(endpoint, { identity }).request("audit_check", input),
    ).resolves.toEqual(result);
    expect(seen[0]!.identity).toEqual({ username: "alice" });
    const untrusted = {
      transport: endpoint.transport,
      url: endpoint.url,
      basicUsername: endpoint.basicUsername,
      basicPassword: endpoint.basicPassword,
      sendMachineId: false,
    };
    await expect(
      new ServiceClient(untrusted, { identity }).request("audit_check", input),
    ).rejects.toThrow();
    await expect(
      new ServiceClient(
        { ...endpoint, url: `https://127.0.0.1:${port}/v1/service` },
        { identity },
      ).request("audit_check", input),
    ).rejects.toThrow();
    await expect(
      new ServiceClient({ ...endpoint, basicPassword: "wrong" }, { identity }).request(
        "audit_check",
        input,
      ),
    ).rejects.toThrow(ServiceError);
    expect(seen).toHaveLength(2);
  });
  it("rejects symlink or unprotected Unix socket paths before connecting", async () => {
    const { path } = await unix((_req, res) => {
      res.end();
    });
    const alias = join(await directory(), "alias.sock");
    await symlink(path, alias);
    await expect(verifyServiceSocket(alias)).rejects.toThrow();
    await expect(verifyServiceSocket(path)).rejects.toThrow();
    await expect(verifyServiceSocket(path + "/../service.sock")).rejects.toThrow(
      "Invalid managed service socket path",
    );
  });
  it("ignores ambient proxy and parser selection for a real Unix request", async () => {
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"])
      vi.stubEnv(name, "http://127.0.0.1:1");
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    vi.stubEnv("UNDICI_USE_MILO", "1");
    const { path } = await unix(async (req, res) => {
      expect(req.url).toBe("/v1/service");
      const request = await body(req);
      reply(res, {
        version: 1,
        request_id: request.request_id,
        operation: request.operation,
        result,
      });
    });
    await expect(
      new ServiceClient(
        { transport: "unix", socketPath: path },
        { verifySocket: async () => {} },
      ).request("audit_check", input),
    ).resolves.toEqual(result);
  });
  it.each(["http10", "fragmented10", "fragmented11", "interim", "headers", "truncated"])(
    "enforces HTTP/1.1 framing for %s",
    async (mode) => {
      let calls = 0;
      const { path } = await unix(async (req) => {
        calls++;
        const request = await body(req);
        const payload = JSON.stringify({
          version: 1,
          request_id: request.request_id,
          operation: request.operation,
          result,
        });
        const version = mode === "http10" || mode === "fragmented10" ? "1.0" : "1.1";
        const response = `HTTP/${version} 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(payload) + (mode === "truncated" ? 1 : 0)}\r\n${mode === "headers" ? "X-Pad: " + "a".repeat(17 * 1024) + "\r\n" : ""}\r\n${payload}`;
        if (mode === "interim") req.socket.end("HTTP/1.1 103 Early Hints\r\n\r\n" + response);
        else if (mode.startsWith("fragmented")) {
          req.socket.write(response.slice(0, 7));
          setTimeout(() => req.socket.end(response.slice(7)), 5);
        } else req.socket.end(response);
      });
      const pending = new ServiceClient(
        { transport: "unix", socketPath: path },
        { verifySocket: async () => {} },
      ).request("audit_check", input);
      if (mode === "fragmented11") await expect(pending).resolves.toEqual(result);
      else await expect(pending).rejects.toThrow();
      expect(calls).toBe(1);
    },
  );
  it("uses one absolute timeout despite continuing response bytes", async () => {
    let calls = 0;
    const { path } = await unix(async (req, res) => {
      calls++;
      await body(req);
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.write(" ");
      const timer = setInterval(() => res.write(" "), 5);
      res.once("close", () => clearInterval(timer));
    });
    const start = Date.now();
    await expect(
      new ServiceClient(
        { transport: "unix", socketPath: path },
        { verifySocket: async () => {} },
      ).request("audit_check", input, 50),
    ).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(calls).toBe(1);
  });
});
