import { chmod, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { IDENTITY_BROKER_SOCKET_PATH, type SandboxConfig } from "../domain/index.js";
import { parseMcpConfig } from "../config/mcp.js";

import {
  applyIdentityOverrides,
  configureManagedIdentity,
  IDENTITY_BROKER_TIMEOUT_MS,
  MAXIMUM_IDENTITY_RESPONSE_BYTES,
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

function mcpResponse(servers: unknown): string {
  return JSON.stringify({
    version: 10,
    status: "ok",
    environment: { pi: {}, sandbox: {}, extensions: {} },
    overrides: { mcp: { servers } },
  });
}

describe("broker response", () => {
  it("admits opaque broker literals but never caller-side file reads", () => {
    const response = (entry: unknown, version = 10) =>
      JSON.stringify({
        version,
        status: "ok",
        environment: { pi: { TOKEN: entry }, sandbox: {}, extensions: {} },
        overrides: {},
      });
    expect(parseBrokerResponse(response({ literal: "~/{{unknown}}" }))).toMatchObject({
      environment: { pi: { TOKEN: { literal: "~/{{unknown}}" } } },
    });
    for (const entry of [
      { file: "/etc/secret" },
      { literal: "" },
      { literal: "secret", file: "/etc/secret" },
    ]) {
      expect(() => parseBrokerResponse(response(entry))).toThrow();
    }
    expect(() => parseBrokerResponse(response("token", 9))).toThrow();
  });

  it("preserves omitted MCP overrides and accepts bounded enabled patches", () => {
    const response = (overrides: unknown) =>
      JSON.stringify({
        version: 10,
        status: "ok",
        environment: { pi: {}, sandbox: {}, extensions: {} },
        overrides,
      });
    const omitted = parseBrokerResponse(response({}));
    expect(omitted).toMatchObject({ overrides: { tools: {} } });
    if (omitted.status !== "ok") throw new Error("expected success");
    expect(Object.hasOwn(omitted.overrides, "mcp")).toBe(false);
    for (const enabled of [true, false]) {
      const servers = Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`server${index}`, { enabled }]),
      );
      const parsed = parseBrokerResponse(response({ mcp: { servers } }));
      expect(parsed).toMatchObject({ overrides: { mcp: { servers } } });
      if (parsed.status !== "ok") throw new Error("expected success");
      expect(Object.isFrozen(parsed.overrides.mcp)).toBe(true);
      expect(Object.isFrozen(parsed.overrides.mcp!.servers)).toBe(true);
      expect(Object.isFrozen(parsed.overrides.mcp!.servers.server0)).toBe(true);
    }
  });

  it("rejects malformed MCP overrides and connection fields and authored policy shapes", () => {
    const server = { enabled: true };
    for (const mcp of [
      null,
      false,
      [],
      {},
      { servers: null },
      { servers: [] },
      { servers: {} },
      { servers: { docs: server }, extra: true },
      { servers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`server${i}`, server])) },
      ...["", "Docs", "a-b", "_docs", "a".repeat(33)].map((id) => ({ servers: { [id]: server } })),
      ...[
        null,
        [],
        false,
        {},
        { enabled: null },
        { enabled: 0 },
        { enabled: "false" },
        { enabled: true, extra: true },
        { enabled: true, url: "https://other.example/mcp" },
        { enabled: true, exposure: "direct" },
        { enabled: true, default_policy: { mode: "allow", session_grant: "never", audit: false } },
      ].map((entry) => ({ servers: { docs: entry } })),
    ]) {
      expect(() =>
        parseBrokerResponse(
          JSON.stringify({
            version: 10,
            status: "ok",
            environment: { pi: {}, sandbox: {}, extensions: {} },
            overrides: { mcp },
          }),
        ),
      ).toThrow("identity_broker_response_invalid");
    }
    expect(() =>
      parseBrokerResponse(
        '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"mcp":{"servers":{"docs":{"enabled":true,"enabled":false}}}}}',
      ),
    ).toThrow("identity_broker_response_invalid");
  });

  it("decodes immutable independent MCP layers without defaulting server admission", () => {
    const layer = {
      default_policy: { mode: "ask", session_grant: "offer" },
      tool_rules: [{ match: "search_*", mode: "allow", session_grant: "never" }],
    };
    const parsed = parseBrokerResponse(mcpResponse({ docs: { policy_layers: [layer] } }));
    if (parsed.status !== "ok") throw new Error("expected success");
    const patch = parsed.overrides.mcp!.servers.docs!;
    expect(Object.hasOwn(patch, "enabled")).toBe(false);
    expect(patch.policyLayers).toEqual([
      {
        defaultPolicy: { mode: "ask", sessionGrant: "offer" },
        toolRules: [{ match: "search_*", mode: "allow", sessionGrant: "never" }],
      },
    ]);
    for (const value of [
      patch,
      patch.policyLayers,
      patch.policyLayers![0],
      patch.policyLayers![0]!.defaultPolicy,
      patch.policyLayers![0]!.toolRules,
      patch.policyLayers![0]!.toolRules[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("rejects malformed, duplicate and excessive MCP policy contributions", () => {
    const pair = { mode: "ask", session_grant: "offer" };
    const rule = { match: "search_*", ...pair };
    const layer = { tool_rules: [rule] };
    for (const policy_layers of [
      null,
      {},
      [],
      [null],
      [{}],
      [{ tool_rules: [] }],
      [{ default_policy: pair }],
      [{ ...layer, audit: false }],
      [layer, layer],
      [{ tool_rules: [rule, rule] }],
      ...[
        {},
        null,
        { mode: "allow" },
        { session_grant: "never" },
        { mode: "allow", session_grant: "offer" },
        { ...pair, audit: true },
        { ...pair, known_read_only: { mode: "allow", session_grant: "never" } },
      ].map((default_policy) => [{ default_policy, tool_rules: [] }]),
      ...["", "x?", "x[", "x\\", "x ", "x\ufeff", "x\u0000", "x\ud800", "é".repeat(65)].map(
        (match) => [{ tool_rules: [{ ...rule, match }] }],
      ),
      [{ tool_rules: [{ ...rule, audit: false }] }],
      Array.from({ length: 257 }, (_, n) => ({ tool_rules: [{ ...rule, match: `tool${n}` }] })),
      [{ tool_rules: Array.from({ length: 257 }, (_, n) => ({ ...rule, match: `tool${n}` })) }],
      [
        { tool_rules: Array.from({ length: 256 }, (_, n) => ({ ...rule, match: `tool${n}` })) },
        { tool_rules: [{ ...rule, match: "extra" }] },
      ],
    ])
      expect(() => parseBrokerResponse(mcpResponse({ docs: { policy_layers } }))).toThrow(
        "identity_broker_response_invalid",
      );
    const rules = Array.from({ length: 256 }, (_, n) => ({ ...rule, match: `tool${n}` }));
    const servers = Object.fromEntries(
      Array.from({ length: 4 }, (_, n) => [`s${n}`, { policy_layers: [{ tool_rules: rules }] }]),
    );
    expect(parseBrokerResponse(mcpResponse(servers)).status).toBe("ok");
    expect(() =>
      parseBrokerResponse(mcpResponse({ ...servers, fifth: { policy_layers: [layer] } })),
    ).toThrow("identity_broker_response_invalid");
    const maxLayers = Array.from({ length: 256 }, (_, n) => ({
      tool_rules: [{ ...rule, match: `tool${n}` }],
    }));
    expect(parseBrokerResponse(mcpResponse({ docs: { policy_layers: maxLayers } })).status).toBe(
      "ok",
    );
  });

  it("bounds MCP and complete response bytes and rejects the previous wire version", () => {
    const rule = { mode: "disabled", session_grant: "never" };
    const large = {
      policy_layers: Array.from({ length: 256 }, (_, n) => ({
        default_policy: rule,
        tool_rules: [{ match: `${n}_${"x".repeat(124)}`, ...rule }],
      })),
    };
    const servers = Object.fromEntries(Array.from({ length: 4 }, (_, n) => [`s${n}`, large]));
    expect(Buffer.byteLength(JSON.stringify({ servers }))).toBeGreaterThan(256 * 1024);
    expect(() => parseBrokerResponse(mcpResponse(servers))).toThrow(
      "identity_broker_response_invalid",
    );
    const empty = mcpResponse({ docs: { enabled: true } });
    expect(() => parseBrokerResponse(empty.replace('"version":10', '"version":8'))).toThrow(
      "identity_broker_response_invalid",
    );
    const exact =
      empty + " ".repeat(MAXIMUM_IDENTITY_RESPONSE_BYTES - Buffer.byteLength(empty) - 1) + "\n";
    expect(parseBrokerResponse(exact).status).toBe("ok");
    expect(() => parseBrokerResponse(exact + " ")).toThrow("identity_broker_response_invalid");
  });

  it("accepts partial execution patches without defaulting omitted fields", () => {
    const response = (execution: unknown) =>
      JSON.stringify({
        version: 10,
        status: "ok",
        environment: { pi: {}, sandbox: {}, extensions: {} },
        overrides: { execution, network: { mode: "local" } },
      });
    expect(parseBrokerResponse(response({ backend: "bubblewrap" }))).toMatchObject({
      overrides: { execution: { backend: "bubblewrap" } },
    });
    for (const execution of [
      {},
      { process_lifetime: "command" },
      { process_lifetime: "sandbox" },
      { process_lifetime: "session" },
      { backend: "bubblewrap", max_command_timeout_seconds: 60 },
      { backend: "bubblewrap", maximumTimeoutMs: 60_000 },
      { backend: "bubblewrap", command_path_prepend: ["/usr/libexec/pi-sandbox"] },
      { backend: "bubblewrap", commandPathPrepend: ["/usr/libexec/pi-sandbox"] },
      { process_lifetime: null },
      { backend: null },
      { backend: "smolvm" },
      { backend: "seatbelt" },
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
        '{"version":10,"status":"ok","environment":{"pi":{"MODEL_TOKEN":"token"},"sandbox":{"PROJECT_ENV":"test"},"extensions":{"service-api":{"SERVICE_API_TOKEN":"service-token"}}},"overrides":{"models_file":"/etc/pi-sandbox/models/alice.json","execution":{"backend":"direct"},"network":{"mode":"host"},"tools":{"write":{"mode":"ask","session_grant":"offer"},"git_clone":{"mode":"deny","session_grant":"never"}}}}\n',
      ),
    ).toEqual({
      version: 10,
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
      parseBrokerResponse('{"version":10,"status":"error","code":"identity_store_unavailable"}\n'),
    ).toEqual({ version: 10, status: "error", code: "identity_store_unavailable" });
  });

  it("accepts complete filesystem overrides and rejects malformed ones", () => {
    const response = (filesystem: unknown) =>
      JSON.stringify({
        version: 10,
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
      { cwd_writable: true, denied_paths: [] },
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
      '{"version":7,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":6,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"error","code":"user_not_found"}',
      '{"version":2,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"ok","overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{},"extra":true}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{},"extra":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":[],"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{"BAD-NAME":"value"},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{"NODE_OPTIONS":"--require=x"},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{"BASH_ENV":"/tmp/inject"},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{"PI_SANDBOX_INTERNAL_SECRET":"value"},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{"TOKEN":1},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{"TOKEN":"nul\\u0000value"},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{"HOME":"/tmp"},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":[]},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{"Bad_ID":{}}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{"service-api":[]}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"pi":{},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{"TOKEN":"one","T\\u004fKEN":"two"},"sandbox":{},"extensions":{}},"overrides":{}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"audit":{"enabled":false,"facility":"local0"}}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"sessions":{"retention_days":0}}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"tools":{"write":{"mode":"ask","session_grant":"never","audit":false}}}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"unknown":true}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"models_file":"relative.json"}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"execution":{"backend":"container"}}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"execution":{"backend":"direct","extra":true}}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"network":{"mode":"filtered"}}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"network":{"mode":"host","extra":true}}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"tools":{"Bad-Name":{"mode":"deny","session_grant":"never"}}}}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"tools":{"write":{"mode":"allow","session_grant":"offer"}}}}',
      '{"version":10,"status":"error","code":"unknown"}',
      '{"version":10,"status":"error","code":["user_not_found"]}',
      '{"version":10,"status":"error","code":"user_not_found","code":"protocol_error"}',
      '{"version":10,"status":"ok","environment":{"pi":{},"sandbox":{},"extensions":{}},"overrides":{"tools":{},"t\\u006fools":{}}}',
    ]) {
      expect(() => parseBrokerResponse(response)).toThrow("identity_broker_response_invalid");
    }
  });

  it("parses an optional normalized known read-only class policy for Bash only", () => {
    const response = (tools: unknown) =>
      JSON.stringify({
        version: 10,
        status: "ok",
        environment: { pi: {}, sandbox: {}, extensions: {} },
        overrides: { tools },
      });
    expect(
      parseBrokerResponse(
        response({
          bash: {
            mode: "ask",
            session_grant: "never",
            known_read_only: { mode: "allow", session_grant: "never" },
          },
          write: { mode: "deny", session_grant: "never" },
        }),
      ),
    ).toMatchObject({
      overrides: {
        tools: {
          bash: {
            mode: "ask",
            sessionGrant: "never",
            commandClasses: { known_read_only: { mode: "allow", sessionGrant: "never" } },
          },
          write: { mode: "deny", sessionGrant: "never" },
        },
      },
    });
    expect(
      parseBrokerResponse(response({ bash: { mode: "ask", session_grant: "never" } })),
    ).not.toHaveProperty("overrides.tools.bash.commandClasses");
    for (const [main, knownReadOnly] of [
      [
        { mode: "deny", session_grant: "never" },
        { mode: "ask", session_grant: "offer" },
      ],
      [
        { mode: "ask", session_grant: "never" },
        { mode: "ask", session_grant: "offer" },
      ],
      [
        { mode: "ask", session_grant: "offer" },
        { mode: "allow", session_grant: "never" },
      ],
    ]) {
      expect(
        parseBrokerResponse(response({ bash: { ...main, known_read_only: knownReadOnly } })),
      ).toHaveProperty("overrides.tools.bash.commandClasses.known_read_only");
    }
    for (const tools of [
      {
        write: {
          mode: "deny",
          session_grant: "never",
          known_read_only: { mode: "allow", session_grant: "never" },
        },
      },
      { bash: { mode: "deny", session_grant: "never", known_read_only: null } },
      { bash: { mode: "deny", session_grant: "never", known_read_only: {} } },
      { bash: { mode: "deny", session_grant: "never", known_read_only: { mode: "allow" } } },
      {
        bash: {
          mode: "deny",
          session_grant: "never",
          known_read_only: { mode: "allow", session_grant: "never", audit: true },
        },
      },
      {
        bash: {
          mode: "deny",
          session_grant: "never",
          known_read_only: { mode: "disabled", session_grant: "never" },
        },
      },
      {
        bash: {
          mode: "deny",
          session_grant: "never",
          known_read_only: { mode: "allow", session_grant: "offer" },
        },
      },
      {
        bash: {
          mode: "deny",
          session_grant: "never",
          known_read_only: { mode: "deny", session_grant: "never" },
        },
      },
      {
        bash: {
          mode: "ask",
          session_grant: "offer",
          known_read_only: { mode: "ask", session_grant: "offer" },
        },
      },
      {
        bash: {
          mode: "allow",
          session_grant: "never",
          known_read_only: { mode: "allow", session_grant: "never" },
        },
      },
      {
        bash: {
          mode: "disabled",
          session_grant: "never",
          known_read_only: { mode: "allow", session_grant: "never" },
        },
      },
      {
        bash: {
          mode: "deny",
          session_grant: "never",
          knownReadOnly: { mode: "allow", session_grant: "never" },
        },
      },
      { bash: { mode: "deny", known_read_only: { mode: "allow", session_grant: "never" } } },
    ]) {
      expect(() => parseBrokerResponse(response(tools))).toThrow(
        "identity_broker_response_invalid",
      );
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
        version: 10,
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
        expect(JSON.parse(request)).toEqual({ version: 10, operation: "resolve-identity" });
        socket.end(
          '{"version":10,"status":"ok","environment":{"pi":{"MODEL_TOKEN":"from-broker"},"sandbox":{"PROJECT_ENV":"test"},"extensions":{"service-api":{"SERVICE_API_TOKEN":"service-token"}}},"overrides":{}}\n',
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
            '{"version":10,"status":"ok","environment":{"pi":{"MODEL_TOKEN":"bun-token"},"sandbox":{},"extensions":{}},"overrides":{}}\n',
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
    socket.write('{"version":10');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    socket.destroy();
  });

  it("fails closed on broker errors and truncated responses", async () => {
    const errorEndpoint = await listen((socket) => {
      socket.once("data", () =>
        socket.end('{"version":10,"status":"error","code":"identity_store_unavailable"}\n'),
      );
    });
    servers.push(errorEndpoint.server);
    await expect(resolveBrokerIdentity(errorEndpoint.socketPath)).rejects.toThrow(
      "identity overrides are unavailable",
    );

    const truncatedEndpoint = await listen((socket) => {
      socket.once("data", () => socket.end('{"version":10'));
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
      configVersion: 13,
      codemode: { enabled: false, timeoutMs: 300000 },
      mcp: { servers: {} },
      sessions: { retentionDays: 365 },
      filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: ["/srv/runs"] },
      audit: { enabled: false, facility: "local0" },
      modelsFile: "/etc/pi-sandbox/models.json",
      execution: { backend: "bubblewrap" },
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
    expect(effective.execution).toEqual({ backend: "direct" });
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
    const deniedBase = {
      ...base,
      filesystem: { ...base.filesystem, deniedPaths: ["/Users/alice/private"] },
    };
    expect(
      applyIdentityOverrides(deniedBase, { filesystem: { cwdWritable: false }, tools: {} })
        .filesystem.deniedPaths,
    ).toBe(deniedBase.filesystem.deniedPaths);
    const restricted = applyIdentityOverrides(base, {
      filesystem: { cwdWritable: false },
      tools: {},
    });
    expect(restricted.filesystem).toEqual({
      cwdWritable: false,
      deniedPaths: [],
      hiddenPaths: ["/srv/runs"],
    });
    expect(restricted.execution).toEqual(base.execution);
    const commandPathPrepend = Object.freeze(["/usr/libexec/pi-sandbox", "/opt/trusted tools"]);
    const capped = {
      ...base,
      execution: { ...base.execution, maximumTimeoutMs: 3_600_000, commandPathPrepend },
    };
    const patchedExecution = applyIdentityOverrides(capped, {
      execution: { backend: "direct" },
      tools: {},
    }).execution;
    expect(patchedExecution).toEqual({
      backend: "direct",
      maximumTimeoutMs: 3_600_000,
      commandPathPrepend,
    });
    expect(patchedExecution.commandPathPrepend).toBe(commandPathPrepend);
    expect(applyIdentityOverrides(capped, { tools: {} }).execution.commandPathPrepend).toBe(
      commandPathPrepend,
    );
    const direct = applyIdentityOverrides(restricted, {
      execution: { backend: "direct" },
      network: { mode: "host" },
      filesystem: { cwdWritable: true },
      tools: {},
    });
    expect(direct.filesystem).toEqual({
      cwdWritable: true,
      deniedPaths: [],
      hiddenPaths: ["/srv/runs"],
    });
    expect(direct.execution).toEqual({ backend: "direct" });
    expect(effective.identity).toBe(base.identity);
    expect(effective.extensions).toBe(base.extensions);
    expect(() =>
      applyIdentityOverrides(base, {
        tools: { unknown_tool: { mode: "deny", sessionGrant: "never" } },
      }),
    ).toThrow("override for unavailable tool: unknown_tool");
  });
});

describe("identity MCP overrides", () => {
  const codemode = { enabled: false, timeoutMs: 300000 };
  const policy = { mode: "ask", session_grant: "offer", audit: true };
  const mcp = parseMcpConfig(
    {
      servers: {
        docs: {
          enabled: false,
          transport: "http",
          url: "https://docs.example/mcp",
          bearer_token_from_env: "DOCS_TOKEN",
          exposure: "direct",
          default_policy: policy,
          tool_rules: [{ match: "search_*", ...policy }],
        },
        local: {
          enabled: true,
          transport: "stdio",
          command: "/opt/mcp/server",
          args: ["--tools"],
          env: { CACHE: "~/.cache/mcp" },
          env_from_env: { TOKEN: "LOCAL_TOKEN" },
          exposure: "direct",
          default_policy: policy,
        },
      },
    },
    codemode,
  );
  const base: SandboxConfig = {
    configVersion: 13,
    codemode,
    mcp,
    sessions: { retentionDays: 365 },
    filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
    audit: { enabled: false, facility: "local0" },
    modelsFile: "/etc/pi-sandbox/models.json",
    execution: { backend: "bubblewrap" },
    identity: { mode: "broker" },
    network: { mode: "none" },
    environment: { pi: {}, sandbox: {}, extensions: {} },
    extensions: {},
    tools: {},
  };

  it("inherits omitted MCP admission and immutably overlays enabled flags only", () => {
    expect(applyIdentityOverrides(base, { tools: {} }).mcp).toBe(mcp);
    for (const [id, enabled] of [
      ["docs", true],
      ["local", false],
    ] as const) {
      const other = id === "docs" ? "local" : "docs";
      const patch = Object.freeze({ enabled });
      const effective = applyIdentityOverrides(base, {
        mcp: { servers: { [id]: patch } },
        tools: {},
      });
      expect(effective.mcp.servers[id]).toEqual({ ...mcp.servers[id], enabled });
      expect(effective.mcp.servers[id]).not.toBe(mcp.servers[id]);
      expect(effective.mcp.servers[id]!.defaultPolicy).toBe(mcp.servers[id]!.defaultPolicy);
      expect(effective.mcp.servers[id]!.toolRules).toBe(mcp.servers[id]!.toolRules);
      expect(effective.mcp.servers[other]).toBe(mcp.servers[other]);
      expect(effective.codemode).toBe(base.codemode);
      expect(Object.isFrozen(effective.mcp)).toBe(true);
      expect(Object.isFrozen(effective.mcp.servers)).toBe(true);
      expect(Object.isFrozen(effective.mcp.servers[id])).toBe(true);
      expect(mcp.servers[id]!.enabled).toBe(!enabled);
      expect(patch).toEqual({ enabled });
    }
  });

  it("applies policy-only layers without enabling the server or replacing global audit/connection fields", () => {
    const response = parseBrokerResponse(
      mcpResponse({
        docs: {
          policy_layers: [
            {
              default_policy: { mode: "allow", session_grant: "never" },
              tool_rules: [],
            },
          ],
        },
      }),
    );
    if (response.status !== "ok") throw new Error("expected success");
    const effective = applyIdentityOverrides(base, response.overrides);
    expect(effective.mcp.servers.docs).toEqual({
      ...mcp.servers.docs,
      policyLayers: response.overrides.mcp!.servers.docs!.policyLayers,
    });
    expect(effective.mcp.servers.docs!.enabled).toBe(false);
    expect(effective.mcp.servers.docs!.defaultPolicy).toBe(mcp.servers.docs!.defaultPolicy);
    expect(effective.mcp.servers.docs!.toolRules).toBe(mcp.servers.docs!.toolRules);
    expect(effective.mcp.servers.local).toBe(mcp.servers.local);
    expect(base.mcp.servers.docs!.policyLayers).toBeUndefined();
  });

  it.each(["missing", "constructor"])("rejects the undefined server %s", (id) => {
    expect(() =>
      applyIdentityOverrides(base, { mcp: { servers: { [id]: { enabled: false } } }, tools: {} }),
    ).toThrow(`override for unavailable MCP server: ${id}`);
  });

  it("requires Code Mode when an override enables a dormant Code Mode exposure", () => {
    const dormant: SandboxConfig = {
      ...base,
      mcp: {
        servers: {
          docs: { ...mcp.servers.docs!, enabled: false, exposure: "codemode" },
        },
      },
    };
    expect(applyIdentityOverrides(dormant, { tools: {} }).mcp).toBe(dormant.mcp);
    expect(() =>
      applyIdentityOverrides(dormant, { mcp: { servers: { docs: { enabled: true } } }, tools: {} }),
    ).toThrow("config.mcp.servers.docs.exposure requires codemode.enabled");
    const permitted = applyIdentityOverrides(
      { ...dormant, codemode: { ...codemode, enabled: true } },
      { mcp: { servers: { docs: { enabled: true } } }, tools: {} },
    );
    expect(permitted.mcp.servers.docs).toMatchObject({ enabled: true, exposure: "codemode" });
    expect(dormant.mcp.servers.docs!.enabled).toBe(false);
  });
});

describe("identity command-class overrides", () => {
  const allow = { audit: true, mode: "allow", sessionGrant: "never" } as const;
  const base = {
    configVersion: 13,
    codemode: { enabled: false, timeoutMs: 300000 },
    mcp: { servers: {} },
    sessions: { retentionDays: 365 },
    filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
    audit: { enabled: false, facility: "local0" },
    modelsFile: "/etc/pi-sandbox/models.json",
    execution: { backend: "bubblewrap" },
    identity: { mode: "broker" },
    network: { mode: "none" },
    environment: { pi: {}, sandbox: {}, extensions: {} },
    extensions: {},
    tools: {
      read: allow,
      grep: allow,
      find: allow,
      ls: allow,
      write: allow,
      edit: allow,
      bash: {
        audit: true,
        mode: "deny",
        sessionGrant: "never",
        commandClasses: { known_read_only: { mode: "allow", sessionGrant: "never" } },
      },
    },
  } satisfies SandboxConfig;

  it("preserves only the main command-set definitions across ordinary policy overrides", () => {
    const commandSets = {
      utility_read: {
        commands: ["utility", "/usr/libexec/pi-sandbox/utility"],
        mode: "allow",
        sessionGrant: "never",
        requiredFlags: ["--read"],
        optionalFlags: [],
        options: {},
        operands: { min: 1, max: 1 },
      },
    } as const;
    const configured = {
      ...base,
      tools: { ...base.tools, bash: { ...base.tools.bash, commandSets } },
    };
    for (const mode of ["allow", "ask", "deny", "disabled"] as const) {
      const selected = applyIdentityOverrides(configured, {
        tools: { bash: { mode, sessionGrant: "never" } },
      });
      expect(selected.tools.bash!.commandSets).toBe(commandSets);
      expect(selected.tools.bash!.mode).toBe(mode);
      expect(selected.tools.bash).not.toHaveProperty("commandClasses");
    }
    const untrustedOverride = { mode: "ask", sessionGrant: "never", commandSets } as const;
    expect(
      applyIdentityOverrides(base, { tools: { bash: untrustedOverride } }).tools.bash,
    ).not.toHaveProperty("commandSets");
  });

  it("rejects command-set definitions in broker tool policy responses", () => {
    for (const field of ["command_sets", "commandSets"]) {
      const source = JSON.stringify({
        version: 10,
        status: "ok",
        environment: { pi: {}, sandbox: {}, extensions: {} },
        overrides: { tools: { bash: { mode: "ask", session_grant: "never", [field]: {} } } },
      });
      expect(() => parseBrokerResponse(source)).toThrow();
    }
  });

  it("replaces the whole Bash policy, including an absent class policy", () => {
    expect(applyIdentityOverrides(base, { tools: {} }).tools.bash).toBe(base.tools.bash);
    const withoutClass = applyIdentityOverrides(base, {
      tools: { bash: { mode: "ask", sessionGrant: "never" } },
    });
    expect(withoutClass.tools.bash).toEqual({ mode: "ask", sessionGrant: "never", audit: true });
    const withClass = applyIdentityOverrides(base, {
      tools: {
        bash: {
          mode: "ask",
          sessionGrant: "never",
          commandClasses: { known_read_only: { mode: "ask", sessionGrant: "offer" } },
        },
      },
    });
    expect(withClass.tools.bash).toEqual({
      mode: "ask",
      sessionGrant: "never",
      audit: true,
      commandClasses: { known_read_only: { mode: "ask", sessionGrant: "offer" } },
    });
  });

  it("fails closed when overlays leave a class allow without allowed read tools", () => {
    expect(() =>
      applyIdentityOverrides(base, {
        tools: { grep: { mode: "ask", sessionGrant: "never" } },
      }),
    ).toThrow(
      'effective tool policy after identity overrides is invalid: tools.bash.known_read_only.mode "allow" requires tools.grep.mode "allow" (it is "ask"); allow read, grep, find, ls or use a stricter bash.known_read_only mode in the base configuration or identity broker rules',
    );
    expect(() =>
      applyIdentityOverrides(
        { ...base, tools: { ...base.tools, bash: { ...allow, mode: "deny" } } },
        {
          tools: {
            read: { mode: "deny", sessionGrant: "never" },
            bash: {
              mode: "deny",
              sessionGrant: "never",
              commandClasses: { known_read_only: { mode: "allow", sessionGrant: "never" } },
            },
          },
        },
      ),
    ).toThrow('requires tools.read.mode "allow" (it is "deny")');
    expect(
      applyIdentityOverrides(base, {
        tools: {
          grep: { mode: "ask", sessionGrant: "never" },
          bash: {
            mode: "deny",
            sessionGrant: "never",
            commandClasses: { known_read_only: { mode: "ask", sessionGrant: "never" } },
          },
        },
      }).tools.bash?.commandClasses,
    ).toEqual({ known_read_only: { mode: "ask", sessionGrant: "never" } });
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
