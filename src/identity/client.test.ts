import { chmod, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { IDENTITY_BROKER_SOCKET_PATH, type SandboxConfig } from "../domain/index.js";

import {
  applyIdentityOverrides,
  configureManagedIdentity,
  IDENTITY_BROKER_TIMEOUT_MS,
  parseBrokerResponse,
  resolveBrokerIdentity,
} from "./client.js";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("managed identity", () => {
  it("returns empty scopes when disabled", async () => {
    await expect(configureManagedIdentity({ mode: "disabled" })).resolves.toEqual({
      environment: { pi: {}, sandbox: {}, extensions: {} },
      overrides: { tools: {} },
    });
  });

  it("returns the broker-selected environment and overrides", async () => {
    const identity = await configureManagedIdentity({ mode: "broker" }, (socketPath) => {
      expect(socketPath).toBe(IDENTITY_BROKER_SOCKET_PATH);
      return Promise.resolve({
        environment: {
          pi: { MODEL_TOKEN: "broker-value" },
          sandbox: {},
          extensions: {},
        },
        overrides: { tools: {} },
      });
    });
    expect(identity.environment.pi).toEqual({ MODEL_TOKEN: "broker-value" });
    expect(identity.overrides).toEqual({ tools: {} });
  });

  it("fails closed after broker failure", async () => {
    await expect(
      configureManagedIdentity({ mode: "broker" }, () => Promise.reject(new Error("unavailable"))),
    ).rejects.toThrow("unavailable");
  });
});

describe("broker response", () => {
  it("accepts partial execution patches without defaulting omitted fields", () => {
    const response = (execution: unknown) =>
      JSON.stringify({
        version: 6,
        status: "ok",
        environment: { pi: {}, sandbox: {}, extensions: {} },
        overrides: { execution, network: { mode: "local" } },
      });
    expect(parseBrokerResponse(response({ process_lifetime: "sandbox" }))).toMatchObject({
      overrides: { execution: { processLifetime: "sandbox" }, network: { mode: "local" } },
    });
    expect(parseBrokerResponse(response({ backend: "bubblewrap" }))).toMatchObject({
      overrides: { execution: { backend: "bubblewrap" } },
    });
    for (const execution of [
      {},
      { process_lifetime: "session" },
      { process_lifetime: null },
      { backend: null },
      { processLifetime: "sandbox" },
    ]) {
      expect(() => parseBrokerResponse(response(execution))).toThrow(
        "identity_broker_response_invalid",
      );
    }
  });
  it("accepts strict success and error responses", () => {
    expect(
      parseBrokerResponse(
        '{"version":6,"status":"ok","environment":{"pi":{"MODEL_TOKEN":"token"},"sandbox":{"PROJECT_ENV":"test"},"extensions":{"service-api":{"SERVICE_API_TOKEN":"service-token"}}},"overrides":{"models_file":"/etc/pi-sandbox/models/alice.json","execution":{"backend":"direct"},"network":{"mode":"host"},"tools":{"write":{"mode":"ask","session_grant":"offer"},"git_clone":{"mode":"deny","session_grant":"never"}}}}\n',
      ),
    ).toEqual({
      version: 6,
      status: "ok",
      environment: {
        pi: { MODEL_TOKEN: "token" },
        sandbox: { PROJECT_ENV: "test" },
        extensions: { "service-api": { SERVICE_API_TOKEN: "service-token" } },
      },
      overrides: {
        modelsFile: "/etc/pi-sandbox/models/alice.json",
        execution: { backend: "direct" },
        network: { mode: "host" },
        tools: {
          write: { mode: "ask", sessionGrant: "offer" },
          git_clone: { mode: "deny", sessionGrant: "never" },
        },
      },
    });
    expect(
      parseBrokerResponse('{"version":6,"status":"error","code":"identity_store_unavailable"}\n'),
    ).toEqual({ version: 6, status: "error", code: "identity_store_unavailable" });
  });

  it("accepts complete filesystem overrides and rejects malformed ones", () => {
    const response = (filesystem: unknown) =>
      JSON.stringify({
        version: 6,
        status: "ok",
        environment: { pi: {}, sandbox: {}, extensions: {} },
        overrides: { filesystem },
      });
    for (const cwdWritable of [true, false]) {
      expect(parseBrokerResponse(response({ cwd_writable: cwdWritable }))).toMatchObject({
        overrides: { filesystem: { cwdWritable } },
      });
    }
    for (const filesystem of [
      null,
      [],
      {},
      false,
      { cwd_writable: "false" },
      { cwd_writable: 0 },
      { cwd_writable: true, extra: true },
      { cwd_writable: true, hidden_paths: [] },
      { cwdWritable: true },
    ]) {
      expect(() => parseBrokerResponse(response(filesystem))).toThrow();
    }
    expect(() =>
      parseBrokerResponse(
        JSON.stringify({
          version: 5,
          status: "ok",
          environment: { pi: {}, sandbox: {}, extensions: {} },
          overrides: {},
        }),
      ),
    ).toThrow();
  });

  it("rejects malformed, unknown, and unsafe responses", () => {
    for (const response of [
      "not-json",
      '{"version":6,"status":"error","code":"user_not_found"}',
      '{"version":2,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{},"extra":true}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{},"extra":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":[],"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{"BAD-NAME":"value"},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{"NODE_OPTIONS":"--require=x"},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{"BASH_ENV":"/tmp/inject"},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{"PI_SANDBOX_INTERNAL_SECRET":"value"},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{"TOKEN":1},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{"TOKEN":"nul\\u0000value"},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{"HOME":"/tmp"},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":[]},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{"Bad_ID":{}}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{"service-api":[]}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"pi":{},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{"TOKEN":"one","T\\u004fKEN":"two"},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"audit":{"enabled":false,"facility":"local0"}}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"sessions":{"retention_days":0}}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"tools":{"write":{"mode":"ask","session_grant":"never","audit":false}}}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"unknown":true}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"models_file":"relative.json"}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"execution":{"backend":"container"}}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"execution":{"backend":"direct","extra":true}}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"network":{"mode":"filtered"}}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"network":{"mode":"host","extra":true}}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"tools":{"Bad-Name":{"mode":"deny","session_grant":"never"}}}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"tools":{"write":{"mode":"allow","session_grant":"offer"}}}}',
      '{"version":6,"status":"error","code":"unknown"}',
      '{"version":6,"status":"error","code":["user_not_found"]}',
      '{"version":6,"status":"error","code":"user_not_found","code":"protocol_error"}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"tools":{},"t\\u006fools":{}}}',
    ]) {
      expect(() => parseBrokerResponse(response)).toThrow("identity_broker_response_invalid");
    }
  });

  it("rejects environment responses that exceed bounded sizes", () => {
    const tooManyVariables = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`VARIABLE_${index}`, "value"]),
    );
    const tooManyExtensions = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`extension-${index}`, {}]),
    );
    for (const environment of [
      { pi: tooManyVariables, sandbox: {}, extensions: {} },
      { pi: { TOKEN: "x".repeat(8193) }, sandbox: {}, extensions: {} },
      { pi: {}, sandbox: {}, extensions: tooManyExtensions },
      {
        pi: Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`PI_${index}`, ""])),
        sandbox: Object.fromEntries(
          Array.from({ length: 128 }, (_, index) => [`SANDBOX_${index}`, ""]),
        ),
        extensions: { git: { OVER_LIMIT: "" } },
      },
    ]) {
      const response = JSON.stringify({
        version: 6,
        status: "ok",
        environment,
        overrides: {},
      });
      expect(() => parseBrokerResponse(response)).toThrow("identity_broker_response_invalid");
    }
  });

  it("resolves scoped environment over a Unix socket", async () => {
    const { server, socketPath } = await listen((socket) => {
      let request = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        request += chunk;
        if (!request.endsWith("\n")) return;
        expect(JSON.parse(request)).toEqual({ version: 6, operation: "resolve-identity" });
        socket.end(
          '{"version":6,"status":"ok","environment":{"pi":{"MODEL_TOKEN":"from-broker"},"sandbox":{"PROJECT_ENV":"test"},"extensions":{"service-api":{"SERVICE_API_TOKEN":"service-token"}}},"overrides":{}}\n',
        );
      });
    });
    servers.push(server);
    await expect(resolveBrokerIdentity(socketPath)).resolves.toEqual({
      environment: {
        pi: { MODEL_TOKEN: "from-broker" },
        sandbox: { PROJECT_ENV: "test" },
        extensions: { "service-api": { SERVICE_API_TOKEN: "service-token" } },
      },
      overrides: { tools: {} },
    });
  });

  it("keeps the request connection open for the compiled Bun runtime", async () => {
    const { server, socketPath } = await listen((socket) => {
      let request = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        request += chunk;
        if (!request.endsWith("\n")) return;
        setTimeout(() => {
          socket.end(
            '{"version":6,"status":"ok","environment":{"pi":{"MODEL_TOKEN":"bun-token"},"sandbox":{},"extensions":{}},"overrides":{}}\n',
          );
        }, 25);
      });
    });
    servers.push(server);

    const clientModule = pathToFileURL(join(process.cwd(), "src/identity/client.ts")).href;
    const source = `
      import { resolveBrokerIdentity } from ${JSON.stringify(clientModule)};
      const result = await resolveBrokerIdentity(process.env.TEST_BROKER_SOCKET);
      process.stdout.write(JSON.stringify(result));
    `;
    const result = await runBun(source, { TEST_BROKER_SOCKET: socketPath });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      environment: { pi: { MODEL_TOKEN: "bun-token" }, sandbox: {}, extensions: {} },
      overrides: { tools: {} },
    });
  });

  it("bounds the entire lookup even when a peer sends a partial response", async () => {
    let connected!: (socket: Socket) => void;
    const peer = new Promise<Socket>((resolve) => {
      connected = resolve;
    });
    const { server, socketPath } = await listen((socket) => {
      socket.once("data", () => connected(socket));
    });
    servers.push(server);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = resolveBrokerIdentity(socketPath);
    const rejected = expect(result).rejects.toThrow("identity broker timed out");
    const socket = await peer;
    await vi.advanceTimersByTimeAsync(IDENTITY_BROKER_TIMEOUT_MS - 1);
    socket.write('{"version":6');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    socket.destroy();
  });

  it("fails closed on broker errors and truncated responses", async () => {
    const errorEndpoint = await listen((socket) => {
      socket.once("data", () =>
        socket.end('{"version":6,"status":"error","code":"identity_store_unavailable"}\n'),
      );
    });
    servers.push(errorEndpoint.server);
    await expect(resolveBrokerIdentity(errorEndpoint.socketPath)).rejects.toThrow(
      "identity overrides are unavailable",
    );

    const truncatedEndpoint = await listen((socket) => {
      socket.once("data", () => socket.end('{"version":6'));
    });
    servers.push(truncatedEndpoint.server);
    await expect(resolveBrokerIdentity(truncatedEndpoint.socketPath)).rejects.toThrow(
      "invalid response",
    );
  });
});

describe("identity overrides", () => {
  it("atomically replaces selected tools and inherits all omitted values", () => {
    const basePolicy = { audit: true, mode: "allow", sessionGrant: "never" } as const;
    const base = {
      configVersion: 11,
      codemode: { enabled: false, timeoutMs: 300000 },
      mcp: { servers: {} },
      sessions: { retentionDays: 365 },
      filesystem: { cwdWritable: true, hiddenPaths: ["/srv/runs"] },
      audit: { enabled: false, facility: "local0" },
      modelsFile: "/etc/pi-sandbox/models.json",
      execution: { backend: "bubblewrap", processLifetime: "command" },
      identity: { mode: "broker" },
      network: { mode: "none" },
      environment: { pi: {}, sandbox: {}, extensions: {} },
      extensions: {
        git: { id: "git", settings: {}, toolNames: ["git_clone"] },
        "service-api": {
          id: "service-api",
          settings: {},
          toolNames: ["service_api"],
        },
      },
      tools: Object.fromEntries(
        ["read", "grep", "find", "ls", "write", "edit", "bash", "git_clone", "service_api"].map(
          (name) => [name, basePolicy],
        ),
      ) as SandboxConfig["tools"],
    } satisfies SandboxConfig;
    const effective = applyIdentityOverrides(base, {
      modelsFile: "/etc/pi-sandbox/models/alice.json",
      execution: { backend: "direct" },
      network: { mode: "host" },
      tools: {
        write: { mode: "disabled", sessionGrant: "never" },
        git_clone: { mode: "disabled", sessionGrant: "never" },
        service_api: { mode: "deny", sessionGrant: "never" },
      },
    });
    expect(effective.modelsFile).toBe("/etc/pi-sandbox/models/alice.json");
    expect(effective.execution).toEqual({ backend: "direct", processLifetime: "command" });
    expect(effective.network).toEqual({ mode: "host" });
    expect(effective.tools.write).toEqual({ mode: "disabled", sessionGrant: "never", audit: true });
    expect(effective.tools.git_clone).toEqual({
      mode: "disabled",
      sessionGrant: "never",
      audit: true,
    });
    expect(effective.tools.service_api).toEqual({
      mode: "deny",
      sessionGrant: "never",
      audit: true,
    });
    expect(effective.tools.read).toBe(basePolicy);
    expect(effective.audit).toBe(base.audit);
    expect(effective.sessions).toBe(base.sessions);
    expect(effective.filesystem).toEqual(base.filesystem);
    const restricted = applyIdentityOverrides(base, {
      filesystem: { cwdWritable: false },
      tools: {},
    });
    expect(restricted.filesystem).toEqual({ cwdWritable: false, hiddenPaths: ["/srv/runs"] });
    expect(restricted.execution).toEqual(base.execution);
    const persistent = applyIdentityOverrides(base, {
      execution: { processLifetime: "sandbox" },
      network: { mode: "local" },
      tools: {},
    });
    expect(persistent.execution).toEqual({ backend: "bubblewrap", processLifetime: "sandbox" });
    expect(
      applyIdentityOverrides(persistent, { execution: { backend: "bubblewrap" }, tools: {} })
        .execution,
    ).toEqual(persistent.execution);
    expect(
      applyIdentityOverrides(persistent, { execution: { processLifetime: "command" }, tools: {} })
        .execution,
    ).toEqual(base.execution);
    const direct = applyIdentityOverrides(restricted, {
      execution: { backend: "direct" },
      network: { mode: "host" },
      filesystem: { cwdWritable: true },
      tools: {},
    });
    expect(direct.filesystem).toEqual({ cwdWritable: true, hiddenPaths: ["/srv/runs"] });
    expect(direct.execution).toEqual({ backend: "direct", processLifetime: "command" });
    expect(effective.identity).toBe(base.identity);
    expect(effective.extensions).toBe(base.extensions);
    expect(() =>
      applyIdentityOverrides(base, {
        tools: { unknown_tool: { mode: "deny", sessionGrant: "never" } },
      }),
    ).toThrow("override for unavailable tool: unknown_tool");
  });
});

async function listen(handler: (socket: Socket) => void): Promise<{
  server: Server;
  socketPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-sandbox-identity-client-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  const socketPath = join(directory, "broker.sock");
  const server = createServer({ allowHalfOpen: true }, handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, socketPath };
}

function runBun(
  source: string,
  environment: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["--eval", source], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Bun client failed with ${signal ?? `exit code ${code}`}: ${stderr}`));
    });
  });
}
