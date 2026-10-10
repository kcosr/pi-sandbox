import { describe, expect, it, vi } from "vitest";
import type { StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig } from "../domain/index.js";
import { PolicyEngine } from "../policy/index.js";
import { ManagedMcpRuntime, type McpCatalogItem, type ManagedMcpOptions } from "./runtime.js";
import type { ManagedMcpPreferences } from "./preferences.js";
import { mcpSubject, matchesMcpPattern } from "./policy.js";

const allow = { mode: "allow", sessionGrant: "never", audit: false } as const;
const config: McpServerConfig = {
  id: "docs",
  enabled: true,
  transport: "http",
  url: "https://example.com/mcp",
  headers: {},
  headersFromEnv: {},
  exposure: "direct",
  timeoutMs: 100,
  defaultPolicy: allow,
  toolRules: [],
};
const result = { content: [{ type: "text" as const, text: "ok" }], details: {} };
function item(
  name = "search",
  execute = vi.fn<ToolDefinition["execute"]>(() => Promise.resolve(result)),
): McpCatalogItem & { execute: typeof execute } {
  return {
    execute,
    tool: {
      name,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
    definition: {
      name: `mcp__docs__${name}`,
      label: name,
      description: "Search documents",
      parameters: { type: "object" },
      execute,
    },
  };
}
function setup(
  overrides: Partial<McpServerConfig> = {},
  selected: (name: string) => boolean = () => true,
  preferences?: ManagedMcpPreferences,
  autoEnableCodemode = false,
) {
  const connection = {
    state: "connected",
    getClient: vi.fn(() => Promise.resolve({})),
    close: vi.fn(() => Promise.resolve()),
  };
  const runtime = new ManagedMcpRuntime({
    cwd: "/work",
    servers: [
      {
        policy: { ...config, ...overrides } as McpServerConfig,
        status: "ready",
        url: "https://example.com/mcp",
      },
    ],
    selected,
    autoEnableCodemode,
    ...(preferences === undefined ? {} : { preferences }),
    getPolicy: () => policy,
    getAuditor: () => undefined,
  });
  const policy: PolicyEngine = new PolicyEngine({}, runtime.resolveSubject);
  runtime.serverChanged("docs", connection);
  return { runtime, policy, connection };
}
function context(select?: () => Promise<string | undefined>) {
  return {
    hasUI: select !== undefined,
    ui: { select },
    sessionManager: { getSessionId: () => "session" },
  } as unknown as Parameters<ToolDefinition["execute"]>[4];
}
function invoke(
  tool: ToolDefinition,
  query: unknown = "hello",
  select?: () => Promise<string | undefined>,
  signal?: AbortSignal,
) {
  return tool.execute("call", { query }, signal, undefined, context(select));
}

describe("managed MCP admission", () => {
  it("wraps raw identities, validates arguments, and dispatches a frozen snapshot", async () => {
    const { runtime, connection } = setup();
    const source = item();
    const [tool] = runtime.adaptTools("docs", [source], connection);
    await invoke(tool!);
    expect(source.execute).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(vi.mocked(source.execute).mock.calls[0]![1])).toBe(true);
    await expect(invoke(tool!, {})).rejects.toThrow("Invalid MCP tool arguments");
    expect(source.execute).toHaveBeenCalledTimes(1);
  });
  it.each(["deny", "disabled"] as const)("never dispatches %s tools", async (mode) => {
    const { runtime, connection } = setup({ defaultPolicy: { ...allow, mode } });
    const source = item();
    const [tool] = runtime.adaptTools("docs", [source], connection);
    expect(tool!.exposure).toBe(mode === "disabled" ? "hidden" : "direct");
    await expect(invoke(tool!)).rejects.toThrow("denied");
    expect(source.execute).not.toHaveBeenCalled();
  });
  it("asks per raw tool and never grants an entire matching wildcard", async () => {
    const { runtime, connection, policy } = setup({
      toolRules: [{ ...allow, match: "*", mode: "ask", sessionGrant: "offer" }],
    });
    const first = item("first"),
      second = item("second");
    const tools = runtime.adaptTools("docs", [first, second], connection);
    const select = vi.fn(() => Promise.resolve("Allow for session"));
    await invoke(tools[0]!, "one", select);
    await invoke(tools[0]!, "two", select);
    expect(select).toHaveBeenCalledTimes(1);
    expect(policy.hasSessionGrant(mcpSubject("docs", "first"))).toBe(true);
    await expect(invoke(tools[1]!)).rejects.toThrow("no_ui");
    expect(second.execute).not.toHaveBeenCalled();
  });
  it("rejects an approval when catalog metadata changes while the prompt is open", async () => {
    const { runtime, connection, policy } = setup({
      defaultPolicy: { ...allow, mode: "ask", sessionGrant: "offer" },
    });
    const source = item();
    const [tool] = runtime.adaptTools("docs", [source], connection);
    let approve!: (value: string) => void;
    const select = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          approve = resolve;
        }),
    );
    const work = invoke(tool!, "hello", select);
    await vi.waitFor(() => expect(select).toHaveBeenCalled());
    runtime.adaptTools(
      "docs",
      [{ ...source, tool: { ...source.tool, description: "changed" } }],
      connection,
    );
    approve("Allow for session");
    await expect(work).rejects.toThrow("denied");
    expect(source.execute).not.toHaveBeenCalled();
    expect(policy.hasSessionGrant(mcpSubject("docs", "search"))).toBe(false);
  });
  it("keeps unchanged grants, tombstones removed tools, and invalidates on reconnect", async () => {
    const { runtime, connection, policy } = setup({
      defaultPolicy: { ...allow, mode: "ask", sessionGrant: "offer" },
    });
    const source = item();
    const [tool] = runtime.adaptTools("docs", [source], connection);
    await invoke(tool!, "hello", () => Promise.resolve("Allow for session"));
    runtime.adaptTools("docs", [source], connection);
    expect(policy.hasSessionGrant(mcpSubject("docs", "search"))).toBe(true);
    runtime.adaptTools("docs", [], connection);
    await expect(invoke(tool!)).rejects.toThrow("changed or unavailable");
    runtime.adaptTools("docs", [source], connection);
    expect(policy.hasSessionGrant(mcpSubject("docs", "search"))).toBe(false);
    connection.state = "disconnected";
    runtime.serverChanged("docs", connection);
    await expect(invoke(tool!)).rejects.toThrow("changed or unavailable");
  });
  it("rejects the whole duplicate/malformed catalog without retaining old authority", async () => {
    const { runtime, connection } = setup();
    const source = item();
    const [old] = runtime.adaptTools("docs", [source], connection);
    expect(() => runtime.adaptTools("docs", [item("new"), item("new")], connection)).toThrow(
      "Invalid MCP catalog",
    );
    await expect(invoke(old!)).rejects.toThrow("changed or unavailable");
    expect(runtime.resolveSubject(mcpSubject("docs", "new"))).toBeUndefined();
  });
  it("cannot widen initial tool selection through a late registration", async () => {
    const { runtime, connection } = setup({}, () => false);
    const source = item();
    const [tool] = runtime.adaptTools("docs", [source], connection);
    expect(tool!.exposure).toBe("hidden");
    await expect(invoke(tool!)).rejects.toThrow("changed or unavailable");
    expect(source.execute).not.toHaveBeenCalled();
  });
  it("marks code-mode exposure deferred and uses ordered original-name rules", () => {
    const { runtime, connection } = setup({
      exposure: "codemode",
      toolRules: [
        { ...allow, match: "secret*", mode: "disabled" },
        { ...allow, match: "*", mode: "deny" },
      ],
    });
    const tools = runtime.adaptTools("docs", [item("search"), item("secret")], connection);
    expect(tools.map((tool) => tool.exposure)).toEqual(["deferred", "hidden"]);
  });
  it("ends waiting approvals on shutdown without dispatch or a recreated grant", async () => {
    const { runtime, connection, policy } = setup({
      defaultPolicy: { ...allow, mode: "ask", sessionGrant: "offer" },
    });
    const source = item();
    const [tool] = runtime.adaptTools("docs", [source], connection);
    let approve!: (value: string) => void;
    const select = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          approve = resolve;
        }),
    );
    const work = invoke(tool!, "hello", select);
    const rejection = expect(work).rejects.toThrow("denied");
    await vi.waitFor(() => expect(select).toHaveBeenCalled());
    await runtime.close();
    approve("Allow for session");
    await rejection;
    expect(source.execute).not.toHaveBeenCalled();
    expect(policy.hasSessionGrant(mcpSubject("docs", "search"))).toBe(false);
  });
  it("rejects excess parallel dispatches instead of queueing them", async () => {
    const { runtime, connection } = setup();
    let finish!: (value: typeof result) => void;
    const execute = vi.fn(
      () =>
        new Promise<typeof result>((resolve) => {
          finish = resolve;
        }),
    );
    // Each call shares the same completion so all sixteen settle together.
    const pending = new Promise<typeof result>((resolve) => {
      finish = resolve;
    });
    execute.mockImplementation(() => pending);
    const [tool] = runtime.adaptTools("docs", [item("search", execute)], connection);
    const calls = Array.from({ length: 16 }, () => invoke(tool!));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(16));
    await expect(invoke(tool!)).rejects.toThrow("busy");
    finish(result);
    await Promise.all(calls);
  });
  it("reports unavailable stdio executables without admitting them to the upstream factory", () => {
    const transport = vi.fn(() => {
      throw new Error("unavailable executable must not start");
    });
    const runtime = new ManagedMcpRuntime({
      cwd: "/work",
      servers: [
        { policy: config, status: "ready", url: config.url },
        {
          policy: {
            id: "local",
            enabled: true,
            transport: "stdio",
            command: "/missing/server",
            args: [],
            env: {},
            envFromEnv: { TOKEN: "PRIVATE_TOKEN" },
            exposure: "direct",
            timeoutMs: 60000,
            defaultPolicy: allow,
            toolRules: [],
          },
          status: "executable-unavailable",
        },
      ],
      selected: () => true,
      getPolicy: () => undefined,
      getAuditor: () => undefined,
      transportFactory: transport,
    });
    let options!: ManagedMcpOptions;
    runtime.extension((value) => {
      options = value;
      return () => {};
    });
    expect(options.loadConfig()).toMatchObject({ servers: [{ name: "docs" }] });
    expect(options.loadConfig().servers).toHaveLength(1);
    expect(() => options.createTransport({ name: "local" })).toThrow("unavailable");
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.diagnostics("local")).toBe(
      "MCP servers (host execution)\nlocal: stdio, direct, executable-unavailable",
    );
  });
  it("passes only managed hooks/configuration to the upstream factory", () => {
    const { runtime } = setup();
    let options!: ManagedMcpOptions;
    runtime.extension((value) => {
      options = value;
      return () => {};
    });
    expect(options).toMatchObject({
      toolsOnly: true,
      authentication: false,
      management: { exposures: ["direct", "hidden"], persistenceLabel: "saved for this user" },
      serverLogging: false,
      allowRegisteredServers: false,
      resultMode: "inline",
    });
    expect(options.loadConfig()).toMatchObject({
      autoEnableCodemode: false,
      errors: [],
      servers: [{ name: "docs", source: "managed-policy" }],
    });
  });
});

function factoryOptions(runtime: ManagedMcpRuntime): ManagedMcpOptions {
  let options!: ManagedMcpOptions;
  runtime.extension((value) => {
    options = value;
    return () => {};
  });
  return options;
}
describe("MCP presentation preferences", () => {
  it("honors only enabled/exposure preferences while retaining managed connections", () => {
    const preferences: ManagedMcpPreferences = {
      autoEnableCodemode: false,
      server: () => ({ enabled: false, exposure: "hidden" }),
      update: vi.fn(async () => {}),
    };
    const { runtime } = setup({}, () => true, preferences, true);
    const options = factoryOptions(runtime);
    expect(options.loadConfig()).toMatchObject({
      autoEnableCodemode: false,
      servers: [
        {
          name: "docs",
          config: { enabled: false, exposure: "hidden", url: "https://example.com/mcp" },
        },
      ],
    });
    expect(() => options.createTransport({ name: "docs" })).toThrow("unavailable");
    expect(options.management.exposures).toEqual(["direct", "codemode", "hidden"]);
  });
  it.each([{ enabled: false }, { exposure: "hidden" as const }, { exposure: "codemode" as const }])(
    "revokes pending approvals and stale wrappers after a menu change: %j",
    async (patch) => {
      const { runtime, connection, policy } = setup(
        { defaultPolicy: { ...allow, mode: "ask", sessionGrant: "offer" } },
        () => true,
        undefined,
        true,
      );
      const source = item();
      const [tool] = runtime.adaptTools("docs", [source], connection);
      let approve!: (value: string) => void;
      const select = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            approve = resolve;
          }),
      );
      const work = invoke(tool!, "hello", select);
      await vi.waitFor(() => expect(select).toHaveBeenCalled());
      await factoryOptions(runtime).management.updateConfig({ name: "docs" }, patch);
      approve("Allow for session");
      await expect(work).rejects.toThrow("denied");
      expect(policy.hasSessionGrant(mcpSubject("docs", "search"))).toBe(false);
      expect(source.execute).not.toHaveBeenCalled();
      const [replacement] = runtime.adaptTools("docs", [source], connection);
      expect(replacement!.exposure).toBe(
        "exposure" in patch && patch.exposure === "codemode" ? "deferred" : "hidden",
      );
      await expect(invoke(tool!)).rejects.toThrow("changed or unavailable");
    },
  );
  it("keeps current state when saving fails and refuses changes after shutdown", async () => {
    const preferences: ManagedMcpPreferences = {
      autoEnableCodemode: true,
      server: () => ({}),
      update: vi.fn(() => Promise.reject(new Error("save failed"))),
    };
    const { runtime, connection } = setup({}, () => true, preferences);
    const source = item();
    const [tool] = runtime.adaptTools("docs", [source], connection);
    const options = factoryOptions(runtime);
    await expect(
      options.management.updateConfig({ name: "docs" }, { enabled: false }),
    ).rejects.toThrow("save failed");
    await invoke(tool!);
    await expect(
      options.management.updateConfig({ name: "docs" }, { exposure: "codemode" }),
    ).rejects.toThrow("unavailable");
    await expect(
      options.management.updateConfig({ name: "rogue" }, { enabled: true }),
    ).rejects.toThrow("unavailable");
    await runtime.close();
    await expect(
      options.management.updateConfig({ name: "docs" }, { enabled: true }),
    ).rejects.toThrow("unavailable");
    expect(preferences.update).toHaveBeenCalledTimes(1);
  });
});

describe("MCP wildcard matching", () => {
  it.each([
    ["*", "a*b", true],
    ["*a", "*ba", true],
    ["search_*", "search_docs", true],
    ["search_*", "Search_docs", false],
    ["a*b*c", "abxc", true],
    ["a*b*c", "abxd", false],
    ["read", "read_more", false],
  ])("matches %s against %s", (pattern, value, expected) => {
    expect(matchesMcpPattern(pattern, value)).toBe(expected);
  });
});

describe("MCP dispatch lifecycle", () => {
  it("accepts shutdown withdrawal while rejecting late nonempty publication", async () => {
    const { runtime, connection } = setup();
    runtime.adaptTools("docs", [item()], connection);
    await runtime.close();
    expect(runtime.adaptTools("docs", [], connection)).toEqual([]);
    expect(() => runtime.adaptTools("docs", [item()], connection)).toThrow("unavailable");
  });

  it("applies an absolute dispatch deadline and reports a typed timeout", async () => {
    const { runtime, connection } = setup({ timeoutMs: 10 });
    const execute: ToolDefinition["execute"] = async (_id, _args, signal) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("fixture aborted")), {
          once: true,
        });
      });
    const source = item();
    const [tool] = runtime.adaptTools(
      "docs",
      [{ ...source, definition: { ...source.definition, execute } }],
      connection,
    );
    await expect(invoke(tool!)).rejects.toMatchObject({ code: "timeout" });
  });
  it("shares one approval mutex between built-in and dynamically admitted MCP subjects", async () => {
    const { runtime, connection } = setup({ defaultPolicy: { ...allow, mode: "ask" } });
    runtime.adaptTools("docs", [item()], connection);
    const engine = new PolicyEngine(
      { write: { mode: "ask", sessionGrant: "never" } },
      runtime.resolveSubject,
    );
    const { prepareApprovalRequest } = await import("../policy/index.js");
    let finish!: (value: "allow_once") => void;
    const prompt = vi.fn(
      () =>
        new Promise<"allow_once">((resolve) => {
          finish = resolve;
        }),
    );
    const first = engine.evaluate(
      prepareApprovalRequest({ subject: "write", display: "write", arguments: {} }),
      { ui: { prompt } },
    );
    const second = engine.evaluate(
      prepareApprovalRequest({
        subject: mcpSubject("docs", "search"),
        display: "search",
        arguments: {},
      }),
      { ui: { prompt } },
    );
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    finish("allow_once");
    await first;
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    finish("allow_once");
    await second;
  });
});

describe("HTTP dispatch and protocol cleanup", () => {
  it("permits bounded cancellation and DELETE after invocation abort but rejects another tool call", async () => {
    const { runtime, connection } = setup();
    let options!: ManagedMcpOptions;
    runtime.extension((value) => {
      options = value;
      return () => {};
    });
    const transport = options.createTransport({ name: "docs" }) as StreamableHttpTransport;
    const request = transport.options.fetch!;
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 202 })),
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    try {
      const execute = vi.fn<ToolDefinition["execute"]>(async () => {
        controller.abort();
        await request("https://example.com/mcp", {
          method: "POST",
          body: JSON.stringify({ method: "notifications/cancelled" }),
        });
        await expect(
          request("https://example.com/mcp", {
            method: "POST",
            body: JSON.stringify({ method: "tools/call" }),
          }),
        ).rejects.toThrow("invalidated");
        await request("https://example.com/mcp", { method: "DELETE" });
        return result;
      });
      const [tool] = runtime.adaptTools("docs", [item("search", execute)], connection);
      await expect(invoke(tool!, "hello", undefined, controller.signal)).rejects.toMatchObject({
        code: "cancelled",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", redirect: "error" });
      expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(false);
      expect(fetch.mock.calls[1]![1]).toMatchObject({ method: "DELETE", redirect: "error" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
