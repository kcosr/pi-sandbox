import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
  ToolRendererResolver,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { TOOL_NAMES, type SandboxConfig, type ToolName } from "../domain/index.js";
import type { HostCommandExecutor, HostCommandRequest } from "../host/index.js";
import {
  freezeExtensionConfig,
  type JsonObject,
  type ManagedExtensionInstance,
  type ManagedToolExecutionContext,
  type PiToolExtension,
} from "../managed-extensions/sdk.js";
import { SandboxExecutionError } from "../sandbox/index.js";
import { createPiSandboxExtension } from "./index.js";
import { LINUX_TOOL_COMMANDS } from "../sandbox/index.js";
import type { AuditClient, AuditEvent } from "../audit/client.js";
import type { SandboxExecutor } from "./types.js";

type Handler = (event: never, context: ExtensionContext) => unknown;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

interface FakePi {
  readonly api: ExtensionAPI;
  readonly handlers: Map<string, Handler>;
  readonly tools: Map<string, ToolDefinition>;
  readonly commands: Map<string, CommandOptions>;
  readonly toolRenderers: ToolRendererResolver[];
  readonly activeTools: string[][];
}

interface HostEchoArguments extends JsonObject {
  readonly value: string;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandOptions>();
  const toolRenderers: ToolRendererResolver[] = [];
  const activeTools: string[][] = [];
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: CommandOptions) {
      commands.set(name, options);
    },
    registerToolRenderer(resolver: ToolRendererResolver) {
      toolRenderers.push(resolver);
    },
    setActiveTools(names: string[]) {
      activeTools.push([...names]);
    },
    getActiveTools() {
      return [...(activeTools.at(-1) ?? [])];
    },
    exec: vi.fn(() =>
      Promise.resolve({ code: 0, stdout: "standard output", stderr: "", killed: false }),
    ),
  } as unknown as ExtensionAPI;
  return { api, handlers, tools, commands, toolRenderers, activeTools };
}

function config(
  overrides: Partial<Record<ToolName, "allow" | "ask" | "deny" | "disabled">> = {},
): SandboxConfig {
  return {
    configVersion: 10,
    codemode: { enabled: false, timeoutMs: 300000 },
    mcp: { servers: {} },
    sessions: { retentionDays: 0 },
    filesystem: { cwdWritable: true, hiddenPaths: [] },
    audit: { enabled: false, facility: "local0" },
    modelsFile: "/etc/pi-sandbox/models.json",
    execution: { backend: "bubblewrap" },
    identity: { mode: "disabled" },
    network: { mode: "none" },
    environment: { pi: {}, sandbox: {}, extensions: {} },
    extensions: {},
    tools: Object.fromEntries(
      TOOL_NAMES.map((name) => [
        name,
        { mode: overrides[name] ?? "allow", sessionGrant: "never", audit: false },
      ]),
    ),
  };
}

function context(
  options: {
    readonly hasUI?: boolean;
    readonly select?: (title: string) => Promise<string | undefined>;
    readonly notify?: (message: string, type?: "info" | "warning" | "error") => void;
    readonly signal?: AbortSignal;
    readonly sessionFile?: string;
  } = {},
): ExtensionToolContext {
  return {
    cwd: "/work/project",
    sessionManager: {
      getSessionId: () => "pi-session-1",
      getSessionFile: () => options.sessionFile,
    },
    hasUI: options.hasUI ?? false,
    mode: "tui",
    signal: options.signal,
    tools: [],
    executeTool: () => Promise.reject(new Error("Unexpected nested tool execution in fixture")),
    ui: {
      select: options.select ?? (() => Promise.resolve(undefined)),
      notify: options.notify ?? (() => undefined),
    },
  } as unknown as ExtensionToolContext;
}

function fakeExecutor(): SandboxExecutor & {
  readonly calls: Array<{
    readonly argv: readonly string[];
    readonly stdin?: string | Uint8Array;
    readonly signal?: AbortSignal;
  }>;
} {
  const calls: Array<{
    readonly argv: readonly string[];
    readonly stdin?: string | Uint8Array;
    readonly signal?: AbortSignal;
  }> = [];
  return {
    cwd: "/work/project",
    home: "/run/pi-sandbox/home",
    backend: "bubblewrap",
    commands: LINUX_TOOL_COMMANDS,
    calls,
    probe: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    execute(request, options) {
      calls.push({
        argv: request.argv,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      const command = request.argv[0];
      let stdout = Buffer.alloc(0);
      const exitCode = 0;
      if (command === "/usr/bin/file") stdout = Buffer.from("text/plain\n");
      if (command === "/bin/cat") stdout = Buffer.from("old text\n");
      if (command === "/usr/bin/stat") {
        stdout = Buffer.from(
          request.argv.at(-1) === "/work/project" ? "directory\n" : "regular file\n",
        );
      }
      if (command === "/usr/bin/find") {
        stdout = Buffer.from(request.argv.includes("-type") ? "/work/project/a.ts\0" : "a.ts\0");
      }
      if (command === "/bin/grep") stdout = Buffer.from("/work/project/a.ts:1:match\n");
      if (command === "/bin/bash") {
        stdout = Buffer.from("shell output\n");
        options?.onStdout?.(stdout);
      }
      const stderr =
        command === "/bin/bash" && request.argv.includes("pipefail")
          ? Buffer.from("PI_SANDBOX_TOTAL_LINES=2\nPI_SANDBOX_FIRST_LINE_BYTES=12\n")
          : Buffer.alloc(0);
      return Promise.resolve({ exitCode, signal: null, stdout, stderr });
    },
  };
}

function managedToolFixture(): {
  readonly instance: ManagedExtensionInstance;
  readonly calls: Array<{ readonly arguments_: unknown; readonly context: unknown }>;
} {
  const calls: Array<{ readonly arguments_: unknown; readonly context: unknown }> = [];
  const config = freezeExtensionConfig({ prefix: "managed" });
  const extension = {
    kind: "managed" as const,
    apiVersion: 3 as const,
    id: "example",
    version: "1.0.0",
    hostEnvironment: Object.freeze({ variables: Object.freeze([]) }),
    parseConfig: () => config,
    requiredHostExecutables: () => ["/usr/bin/example"],
    tools: [
      {
        name: "host_echo",
        label: "Host echo",
        description: "Echo through a managed host tool",
        diagnosticScope: "example.echo",
        parameters: {
          type: "object" as const,
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        formatCall(arguments_: Readonly<Partial<HostEchoArguments>>) {
          return typeof arguments_.value === "string" ? arguments_.value : undefined;
        },
        async execute(
          arguments_: Readonly<HostEchoArguments>,
          context: ManagedToolExecutionContext,
        ) {
          calls.push({ arguments_, context });
          await context.host.execute({ argv: ["/usr/bin/example", arguments_.value ?? ""] });
          return {
            content: [{ type: "text" as const, text: arguments_.value ?? "" }],
            details: undefined,
          };
        },
      },
    ],
  };
  return {
    instance: Object.freeze({
      extension,
      config,
      hostEnvironment: extension.hostEnvironment,
      requiredHostExecutables: Object.freeze(["/usr/bin/example"]),
    }),
    calls,
  };
}

function configWithManagedTool(mode: "allow" | "ask" | "deny" | "disabled"): SandboxConfig {
  const base = config();
  return {
    ...base,
    extensions: {
      example: { id: "example", settings: { prefix: "managed" }, toolNames: ["host_echo"] },
    },
    tools: {
      ...base.tools,
      host_echo: { mode, sessionGrant: "never", audit: false },
    },
  };
}

function piToolFixture(): PiToolExtension {
  return Object.freeze({
    kind: "pi-tool",
    apiVersion: 3,
    id: "standard-example",
    version: "1.0.0",
    hostEnvironment: Object.freeze({ variables: Object.freeze([]) }),
    parseConfig: () => Object.freeze({}),
    requiredHostExecutables: () => Object.freeze([]),
    toolNames: Object.freeze(["standard_echo"]),
    factory(pi: ExtensionAPI) {
      pi.registerTool({
        name: "standard_echo",
        label: "Standard echo",
        description: "Execute a standard Pi extension tool",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        async execute(_id: string, params: { value: string }) {
          const result = await pi.exec("/usr/bin/printf", ["%s", String(params.value)]);
          return { content: [{ type: "text", text: result.stdout }], details: undefined };
        },
      });
    },
  });
}

function configWithPiTool(mode: "allow" | "ask" | "deny" | "disabled"): SandboxConfig {
  const base = config();
  return {
    ...base,
    extensions: {
      "standard-example": {
        id: "standard-example",
        settings: {},
        toolNames: ["standard_echo"],
      },
    },
    tools: { ...base.tools, standard_echo: { mode, sessionGrant: "never", audit: false } },
  };
}

async function start(
  fake: FakePi,
  executor: SandboxExecutor,
  cfg = config(),
  activeTools?: readonly ToolName[],
): Promise<void> {
  await createPiSandboxExtension({
    cwd: "/work/project",
    configPath: "/etc/pi-sandbox/config.toml",
    userStateDir: "/home/test/.pi/agent",
    loadConfig: () => Promise.resolve(cfg),
    executor,
    ...(activeTools === undefined ? {} : { activeTools }),
  })(fake.api);
  await fake.handlers.get("session_start")?.(undefined as never, context());
}

async function executeTool(
  fake: FakePi,
  name: ToolName,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const tool = fake.tools.get(name);
  if (tool === undefined) throw new Error(`missing ${name}`);
  return tool.execute("call-1", input, signal, undefined, context());
}

describe("Pi Sandbox extension", () => {
  async function loggedExtension(
    options: {
      config?: SandboxConfig;
      failEvent?: AuditEvent["event"];
      managed?: boolean;
      compiled?: boolean;
    } = {},
  ) {
    const pi = fakePi();
    const executor = fakeExecutor();
    const events: AuditEvent[] = [];
    const auditClient: AuditClient = {
      submit(event) {
        events.push(event);
        if (event.event === options.failEvent)
          return Promise.reject(new Error("collector unavailable"));
        return Promise.resolve();
      },
      close: async () => {},
    };
    const base =
      options.config ??
      (options.managed
        ? configWithManagedTool("allow")
        : options.compiled
          ? configWithPiTool("allow")
          : config());
    const cfg = {
      ...base,
      audit: { enabled: true, facility: "local0" as const },
      tools: Object.fromEntries(
        Object.entries(base.tools).map(([name, policy]) => [
          name,
          { ...policy, audit: name !== "read" },
        ]),
      ),
    };
    const managed = managedToolFixture();
    const host = {
      cwd: "/work/project",
      close: async () => {},
      execute: vi.fn(() =>
        Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }),
      ),
    };
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(cfg),
      executor,
      auditClient,
      ...(options.managed
        ? { managedExtensions: [managed.instance], hostExecutors: { example: host } }
        : {}),
      ...(options.compiled ? { piToolExtensions: [piToolFixture()] } : {}),
    })(pi.api);
    await pi.handlers.get("session_start")?.(undefined as never, context());
    return { pi, executor, events, managed, host };
  }

  it("logs model write targets and decisions without contents while excluding read and human shell", async () => {
    const { pi, events } = await loggedExtension();
    await executeTool(pi, "write", { path: "note.txt", content: "PRIVATE CONTENT" });
    expect(events.map((event) => event.event)).toEqual([
      "session_started",
      "tool_requested",
      "tool_execution_intent",
      "tool_completed",
    ]);
    expect(events[0]).toMatchObject({ pi_session_id: "pi-session-1", cwd: "/work/project" });
    expect(events.at(-1)).toMatchObject({
      invocation_id: "call-1",
      tool: "write",
      path: "/work/project/note.txt",
      boundary: "bubblewrap",
      approval_source: "policy",
      outcome: "success",
    });
    expect(JSON.stringify(events)).not.toContain("PRIVATE CONTENT");
    await executeTool(pi, "read", { path: "note.txt" });
    await pi.handlers.get("user_bash")?.(
      { type: "user_bash", command: "echo human" } as never,
      context(),
    );
    expect(events).toHaveLength(4);
    await pi.handlers.get("session_shutdown")?.(undefined as never, context());
    expect(events.at(-1)?.event).toBe("session_ended");
  });

  it("logs denied calls without dispatching them", async () => {
    const { pi, events, executor } = await loggedExtension({ config: config({ write: "deny" }) });
    await expect(
      executeTool(pi, "write", { path: "note.txt", content: "private" }),
    ).rejects.toThrow("denied");
    expect(executor.calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      event: "tool_denied",
      reason: "policy_denied",
      path: "/work/project/note.txt",
    });
  });

  it("blocks effects on intent submission failure and never retries a completed effect", async () => {
    const before = await loggedExtension({ failEvent: "tool_execution_intent" });
    await expect(
      executeTool(before.pi, "write", { path: "note.txt", content: "private" }),
    ).rejects.toThrow("logging is unavailable");
    expect(before.executor.calls).toHaveLength(0);
    const after = await loggedExtension({ failEvent: "tool_completed" });
    await expect(
      executeTool(after.pi, "write", { path: "note.txt", content: "private" }),
    ).rejects.toThrow("logging is unavailable");
    const calls = after.executor.calls.length;
    expect(calls).toBeGreaterThan(0);
    await expect(
      executeTool(after.pi, "write", { path: "other.txt", content: "private" }),
    ).rejects.toThrow("logging is unavailable");
    expect(after.executor.calls).toHaveLength(calls);
    expect(after.events.filter((event) => event.event === "tool_completed")).toHaveLength(1);
  });

  it("logs managed and compiled Pi tools at their actual host boundary", async () => {
    const managed = await loggedExtension({ managed: true });
    await executeTool(managed.pi, "host_echo", { value: "private payload" });
    expect(managed.events.at(-1)).toMatchObject({
      tool: "host_echo",
      extension: "example",
      boundary: "host",
      outcome: "success",
    });
    expect(JSON.stringify(managed.events)).not.toContain("private payload");
    const compiled = await loggedExtension({ compiled: true });
    await executeTool(compiled.pi, "standard_echo", { value: "private payload" });
    expect(compiled.events.at(-1)).toMatchObject({
      tool: "standard_echo",
      extension: "standard-example",
      boundary: "host",
      outcome: "success",
    });
  });

  it("records bounded Bash commands and typed timeout outcomes without output", async () => {
    const { pi, events, executor } = await loggedExtension();
    executor.execute = vi.fn(() => Promise.reject(new SandboxExecutionError("sandbox_timeout")));
    await expect(executeTool(pi, "bash", { command: "echo hello\n".repeat(1000) })).rejects.toThrow(
      "sandbox_timeout",
    );
    const event = events.at(-1)!;
    expect(event).toMatchObject({ outcome: "timeout", command_truncated: true });
    expect(Buffer.byteLength(JSON.stringify(event.command)) - 2).toBeLessThanOrEqual(4096);
  });

  it("registers standard Pi tool extensions through the same tool policy", async () => {
    const pi = fakePi();
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(configWithPiTool("allow")),
      executor: fakeExecutor(),
      piToolExtensions: [piToolFixture()],
    })(pi.api);
    await pi.handlers.get("session_start")?.(undefined as never, context());
    expect(pi.activeTools.at(-1)).toContain("standard_echo");
    await expect(executeTool(pi, "standard_echo", { value: "ok" })).resolves.toMatchObject({
      content: [{ type: "text", text: "standard output" }],
    });

    const denied = fakePi();
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(configWithPiTool("deny")),
      executor: fakeExecutor(),
      piToolExtensions: [piToolFixture()],
    })(denied.api);
    await denied.handlers.get("session_start")?.(undefined as never, context());
    await expect(executeTool(denied, "standard_echo", { value: "no" })).rejects.toThrow(
      "Pi Sandbox denied standard_echo",
    );

    const disabled = fakePi();
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(configWithPiTool("disabled")),
      executor: fakeExecutor(),
      piToolExtensions: [piToolFixture()],
    })(disabled.api);
    await disabled.handlers.get("session_start")?.(undefined as never, context());
    expect(disabled.tools.has("standard_echo")).toBe(false);
  });

  it("rejects undeclared Pi tool registrations and non-tool extension APIs", async () => {
    const mismatch = { ...piToolFixture(), toolNames: ["different"] } satisfies PiToolExtension;
    const pi = fakePi();
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(configWithPiTool("allow")),
      executor: fakeExecutor(),
      piToolExtensions: [mismatch],
    })(pi.api);
    await expect(pi.handlers.get("session_start")?.(undefined as never, context())).rejects.toThrow(
      "registered [standard_echo] but declared [different]",
    );

    const unsupported = {
      ...piToolFixture(),
      factory(api: ExtensionAPI) {
        api.on("session_start", () => undefined);
      },
    } satisfies PiToolExtension;
    const second = fakePi();
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(configWithPiTool("allow")),
      executor: fakeExecutor(),
      piToolExtensions: [unsupported],
    })(second.api);
    await expect(
      second.handlers.get("session_start")?.(undefined as never, context()),
    ).rejects.toThrow("unsupported ExtensionAPI member on");
  });

  it("registers managed tools through the same approval snapshot and host-only context", async () => {
    const pi = fakePi();
    const sandbox = fakeExecutor();
    const fixture = managedToolFixture();
    const hostCalls: Array<readonly string[]> = [];
    const host = {
      cwd: "/work/project",
      execute: vi.fn((request: HostCommandRequest) => {
        hostCalls.push(request.argv);
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        });
      }),
      close: vi.fn(() => Promise.resolve()),
    } satisfies HostCommandExecutor;
    let release!: () => void;
    const prompt = new Promise<void>((resolve) => {
      release = resolve;
    });
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(configWithManagedTool("ask")),
      executor: sandbox,
      managedExtensions: [fixture.instance],
      hostExecutors: { example: host },
    })(pi.api);
    await pi.handlers.get("session_start")?.(undefined as never, context());
    expect(pi.activeTools.at(-1)).toContain("host_echo");
    const managedTool = pi.tools.get("host_echo");
    const renderer = managedTool?.renderCall;
    if (renderer === undefined) throw new Error("managed tool call renderer is missing");
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Parameters<typeof renderer>[1];
    const renderCall = (value: string) =>
      renderer({ value }, theme, { lastComponent: undefined } as Parameters<typeof renderer>[2])
        .render(2_000)[0]
        ?.trimEnd();
    expect(renderCall("visible summary")).toBe("host_echo visible summary");
    expect(renderCall("hidden\nsummary")).toBe("host_echo");
    expect(renderCall("x".repeat(1_025))).toBe("host_echo");

    const input = { value: "approved" };
    const operation = managedTool?.execute(
      "call",
      input,
      undefined,
      undefined,
      context({
        hasUI: true,
        select: async () => {
          await prompt;
          return "Allow once";
        },
      }),
    );
    input.value = "changed";
    release();
    await operation;

    expect(hostCalls).toEqual([["/usr/bin/example", "approved"]]);
    expect(sandbox.calls).toHaveLength(0);
    const invocation = fixture.calls[0];
    expect(invocation?.arguments_).toEqual({ value: "approved" });
    expect(Object.isFrozen(invocation?.arguments_)).toBe(true);
    expect(invocation?.context).toMatchObject({
      cwd: "/work/project",
      config: { prefix: "managed" },
    });
    expect(Object.keys(invocation?.context ?? {}).sort()).toEqual([
      "config",
      "cwd",
      "host",
      "signal",
    ]);
    expect(
      ((invocation?.context as { host: object }).host as { close?: unknown }).close,
    ).toBeUndefined();
  });

  it("denies a managed tool before requiring a host executor", async () => {
    const pi = fakePi();
    const fixture = managedToolFixture();
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(configWithManagedTool("deny")),
      executor: fakeExecutor(),
      managedExtensions: [fixture.instance],
    })(pi.api);
    await pi.handlers.get("session_start")?.(undefined as never, context());

    await expect(executeTool(pi, "host_echo", { value: "blocked" })).rejects.toThrow(
      "policy_denied",
    );
    expect(fixture.calls).toHaveLength(0);
  });

  it("reports status, semantic mounts, effective policy, and focused policy details", async () => {
    const pi = fakePi();
    await start(pi, fakeExecutor(), config({ write: "ask", bash: "disabled" }), ["read"]);
    const command = pi.commands.get("sandbox");
    expect(command).toBeDefined();
    expect(await command?.getArgumentCompletions?.("policy w")).toEqual([
      { value: "policy write", label: "policy write" },
    ]);

    const notices: Array<{ readonly message: string; readonly type?: string }> = [];
    const ctx = context({
      notify: (message, type) => notices.push({ message, ...(type === undefined ? {} : { type }) }),
    });
    await command?.handler("", ctx as never);
    expect(notices.at(-1)?.message).toContain("Pi Sandbox: initialized");
    expect(notices.at(-1)?.message).toContain("Config:        /etc/pi-sandbox/config.toml");
    expect(notices.at(-1)?.message).toContain("Extensions:    none");
    expect(notices.at(-1)?.message).toContain("User state:    /home/test/.pi/agent");

    await command?.handler("mounts", ctx as never);
    expect(notices.at(-1)?.message).toContain("/work/project  read/write  host launch directory");
    expect(notices.at(-1)?.message).toContain("Only the launch directory persists writes");

    await command?.handler("policy", ctx as never);
    expect(notices.at(-1)?.message).toContain("write       sandbox    ask");
    expect(notices.at(-1)?.message).toContain("bash        sandbox    disabled");

    await command?.handler("policy write", ctx as never);
    expect(notices.at(-1)?.message).toContain("Policy: write");
    expect(notices.at(-1)?.message).toContain("Approval:        required");
    expect(notices.at(-1)?.message).toContain("Advertised:      no");
    expect(notices.at(-1)?.message).toContain("Cannot write elsewhere on the host");

    await command?.handler("mounts all", ctx as never);
    expect(notices.at(-1)).toEqual({
      message:
        "Usage: /sandbox [mounts | policy [read|grep|find|ls|write|edit|bash|user_shell] | mcp [server]]",
      type: "warning",
    });
  });

  it("registers only truthful non-disabled tools", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor, config({ write: "disabled", bash: "deny" }));

    expect([...pi.tools.keys()]).toEqual(["read", "edit", "ls", "find", "grep", "bash"]);
    expect(pi.tools.has("write")).toBe(false);
    expect(pi.activeTools).toEqual([["read", "grep", "find", "ls", "edit", "bash"]]);
    expect(executor.calls).toHaveLength(0);
  });

  it("preserves Pi 1.0 definition metadata without the host edit preview renderer", async () => {
    const pi = fakePi();
    await start(pi, fakeExecutor());
    for (const tool of pi.tools.values()) {
      expect(tool.promptSnippet).toBeTypeOf("string");
      if (tool.promptGuidelines !== undefined) expect(tool.promptGuidelines).toBeInstanceOf(Array);
      expect(
        tool.constrainedSampling === undefined || typeof tool.constrainedSampling === "object",
      ).toBe(true);
    }
    const edit = pi.tools.get("edit");
    expect(edit?.prepareArguments).toBeTypeOf("function");
    expect(
      edit?.prepareArguments?.({ path: "a", edits: '[{"oldText":"a","newText":"b"}]' }),
    ).toMatchObject({
      path: "a",
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(edit?.renderCall).toBeTypeOf("function");
    expect(edit?.renderResult).toBeTypeOf("function");
    const renderer = edit?.renderCall;
    if (renderer === undefined) throw new Error("missing safe edit renderer");
    const component = renderer(
      { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] },
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as Parameters<typeof renderer>[1],
      { lastComponent: undefined } as Parameters<typeof renderer>[2],
    );
    expect(component.render(80)[0]?.trimEnd()).toBe("edit a.txt");
  });

  it("draws edit calls without the host preview even while edit is disabled", async () => {
    const pi = fakePi();
    await start(pi, fakeExecutor(), config({ edit: "disabled" }));
    expect(pi.tools.has("edit")).toBe(false);
    const [resolver] = pi.toolRenderers;
    if (resolver === undefined) throw new Error("missing tool renderer resolver");

    const stock = { renderCall: vi.fn(), renderResult: vi.fn() };
    const renderers = resolver("edit", () => stock);
    expect(renderers?.renderResult).toBe(stock.renderResult);
    const renderer = renderers?.renderCall;
    if (renderer === undefined || renderer === stock.renderCall) {
      throw new Error("missing safe edit renderer");
    }
    const component = renderer(
      { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] },
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as Parameters<typeof renderer>[1],
      { lastComponent: undefined, argsComplete: true } as Parameters<typeof renderer>[2],
    );
    expect(component.render(80)[0]?.trimEnd()).toBe("edit missing.txt");

    const read = { renderCall: vi.fn() };
    expect(resolver("read", () => read)).toBe(read);
  });

  it("routes all seven tools through the sandbox executor", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor);
    executor.calls.length = 0;

    await executeTool(pi, "read", { path: "a.ts" });
    await executeTool(pi, "write", { path: "new.ts", content: "new" });
    await executeTool(pi, "edit", { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] });
    await executeTool(pi, "ls", { path: "." });
    await executeTool(pi, "find", { pattern: "*.ts", path: "." });
    await executeTool(pi, "grep", { pattern: "match", path: "." });
    await executeTool(pi, "bash", { command: "printf ok" });

    const commands = executor.calls.map((call) => call.argv[0]);
    expect(commands).toEqual(expect.arrayContaining(["/bin/cat", "/bin/sh", "/bin/bash"]));
    expect(
      executor.calls.some((call) => call.argv.some((arg) => arg.includes("/usr/bin/find"))),
    ).toBe(true);
    expect(executor.calls.some((call) => call.argv.some((arg) => arg.includes("/bin/grep")))).toBe(
      true,
    );
    expect(executor.calls.some((call) => call.stdin === "new")).toBe(true);
    expect(executor.calls.every((call) => call.argv.every((arg) => typeof arg === "string"))).toBe(
      true,
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest inspects the mock without invoking it.
    expect(executor.probe).not.toHaveBeenCalled();
  });

  it("describes model tools with the selected execution boundary", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    Object.assign(executor, { backend: "direct" as const });
    await start(pi, executor, {
      ...config(),
      execution: { backend: "direct" },
      network: { mode: "host" },
    });

    for (const name of ["find", "grep", "bash"] as const) {
      expect(pi.tools.get(name)?.description).toContain("directly on the host as the current user");
      expect(pi.tools.get(name)?.description).not.toContain("inside the sandbox");
    }
  });

  it("converts model Bash timeout seconds to executor milliseconds", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    const execute = vi.spyOn(executor, "execute");
    await start(pi, executor);

    await executeTool(pi, "bash", { command: "sleep 1", timeout: 2.5 });

    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ argv: ["/bin/bash", "-c", "sleep 1"], timeoutMs: 2_500 }),
      expect.anything(),
    );

    await executeTool(pi, "bash", { command: "true", timeout: 600 });
    expect(execute.mock.calls.at(-1)?.[0].timeoutMs).toBe(600_000);
    await expect(executeTool(pi, "bash", { command: "true", timeout: 0 })).rejects.toThrow(
      "greater than 0 and at most 600",
    );
    await expect(executeTool(pi, "bash", { command: "true", timeout: 600.1 })).rejects.toThrow(
      "greater than 0 and at most 600",
    );
    await executeTool(pi, "bash", { command: "true" });
    expect(execute.mock.calls.at(-1)?.[0].timeoutMs).toBeUndefined();
  });

  it("passes cancellation to sandbox execution", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    const execute = vi.spyOn(executor, "execute");
    await start(pi, executor);
    const controller = new AbortController();

    await executeTool(pi, "grep", { pattern: "match" }, controller.signal);

    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("passes cancellation to every structured tool child and user shell", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor);
    executor.calls.length = 0;
    const controller = new AbortController();
    const invocations: Array<[ToolName, unknown]> = [
      ["read", { path: "a.ts" }],
      ["write", { path: "new.ts", content: "new" }],
      ["edit", { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }],
      ["ls", { path: "." }],
      ["find", { pattern: "*.ts", path: "." }],
      ["grep", { pattern: "match", path: "." }],
      ["bash", { command: "printf ok" }],
    ];
    for (const [name, input] of invocations) {
      const before = executor.calls.length;
      await executeTool(pi, name, input, controller.signal);
      expect(executor.calls.slice(before).every((call) => call.signal === controller.signal)).toBe(
        true,
      );
    }

    const event: UserBashEvent = {
      type: "user_bash",
      command: "pwd",
      cwd: "/work/project",
      excludeFromContext: false,
    };
    await pi.handlers.get("user_bash")?.(event as never, context({ signal: controller.signal }));
    expect(executor.calls.at(-1)?.signal).toBe(controller.signal);
  });

  it("denies before execution and never invokes a host fallback", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor, config({ write: "deny" }));
    executor.calls.length = 0;

    await expect(executeTool(pi, "write", { path: "x", content: "x" })).rejects.toThrow(
      "policy_denied",
    );
    expect(executor.calls).toHaveLength(0);
  });

  it("uses the exact frozen arguments approved before an asynchronous prompt", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    let release!: () => void;
    const prompt = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = context({
      hasUI: true,
      select: async () => {
        await prompt;
        return "Allow once";
      },
    });
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(config({ write: "ask" })),
      executor,
    })(pi.api);
    await pi.handlers.get("session_start")?.(undefined as never, context());
    const input = { path: "approved.txt", content: "approved" };
    const operation = pi.tools.get("write")?.execute("call", input, undefined, undefined, ctx);
    input.path = "changed.txt";
    input.content = "changed";
    release();
    await operation;

    const write = executor.calls.find((call) => call.argv[0] === "/bin/sh");
    expect(write?.argv).toContain("/work/project/approved.txt");
    expect(write?.stdin).toBe("approved");
  });

  it("uses the normal Pi tool rendering and shows bounded identifying arguments in approvals", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor, config({ bash: "ask", write: "ask" }));
    executor.calls.length = 0;
    const prompts: string[] = [];
    const ctx = context({
      hasUI: true,
      select: (title) => {
        prompts.push(title);
        return Promise.resolve("Allow once");
      },
    });
    const command = `printf '${"x".repeat(3_000)}'`;
    await pi.tools.get("bash")?.execute("bash", { command }, undefined, undefined, ctx);
    expect(prompts[0]).toMatch(/^Allow bash: printf/);
    expect(Buffer.byteLength(prompts[0]!)).toBeLessThan(1100);

    const content = `${"h".repeat(2_000)}middle${"t".repeat(2_000)}`;
    await pi.tools
      .get("write")
      ?.execute("write", { path: "target.txt", content }, undefined, undefined, ctx);
    expect(prompts[1]).toBe("Allow write: /work/project/target.txt?");
    expect(prompts[1]).not.toContain(content);

    await expect(
      pi.tools
        .get("bash")
        ?.execute("large", { command: "x".repeat(8 * 1024 + 1) }, undefined, undefined, ctx),
    ).resolves.toBeDefined();
    expect(prompts[2]).toMatch(/^Allow bash: x/);
    expect(Buffer.byteLength(prompts[2]!)).toBeLessThan(1100);
  });

  it("approves and executes the same canonical lexical path", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor, config({ read: "ask" }));
    executor.calls.length = 0;
    const prompts: string[] = [];
    const ctx = context({
      hasUI: true,
      select: (title) => {
        prompts.push(title);
        return Promise.resolve("Allow once");
      },
    });
    const cases = [
      ["@relative\u202Fname.txt", "/work/project/relative name.txt"],
      ["~/home.txt", "/run/pi-sandbox/home/home.txt"],
    ] as const;
    for (const [input, expected] of cases) {
      const before = executor.calls.length;
      await pi.tools.get("read")?.execute("read", { path: input }, undefined, undefined, ctx);
      expect(prompts.at(-1)).toBe(`Allow read: ${expected}?`);
      expect(executor.calls.slice(before).some((call) => call.argv.includes(expected))).toBe(true);
    }
  });

  it("routes user shell through sandbox operations", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor);
    const event: UserBashEvent = {
      type: "user_bash",
      command: "pwd",
      cwd: "/work/project",
      excludeFromContext: false,
    };

    const result = (await pi.handlers.get("user_bash")?.(
      event as never,
      context(),
    )) as UserBashEventResult;
    expect(result.result?.exitCode).toBe(0);
    expect(executor.calls.at(-1)?.argv).toEqual(["/bin/bash", "-c", "pwd"]);
  });

  it("preserves user-shell stream interleaving and reports truncation", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor);
    vi.spyOn(executor, "execute").mockImplementation((request, options) => {
      if (request.argv[0] !== "/bin/bash")
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        });
      const tail = Buffer.alloc(60 * 1024, 120);
      options?.onStdout?.(tail);
      options?.onStdout?.(Buffer.from("\u001b[31mone\u001b[0m\r\n"));
      options?.onStderr?.(Buffer.from("two\u0000\u0085\u0090\u009c\n"));
      return Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
    });
    const result = (await pi.handlers.get("user_bash")?.(
      {
        type: "user_bash",
        command: "output",
        cwd: "/work/project",
        excludeFromContext: false,
      } as never,
      context(),
    )) as UserBashEventResult;
    expect(result.result?.output).toContain("two\n");
    expect(result.result?.output).not.toContain("\u001b");
    expect(result.result?.output).not.toContain("\r");
    expect(result.result?.output).not.toContain("\u0000");
    expect(result.result?.output).not.toContain("\u0085");
    expect(result.result?.output).not.toContain("\u0090");
    expect(result.result?.output).not.toContain("\u009c");
    expect(result.result?.output.indexOf("one\n")).toBeLessThan(
      result.result?.output.indexOf("two\n") ?? -1,
    );
    expect(result.result?.truncated).toBe(true);
  });

  it("reports user-shell cancellation with its bounded partial output", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor);
    const controller = new AbortController();
    vi.spyOn(executor, "execute").mockImplementation((_request, options) => {
      options?.onStdout?.(Buffer.from("partial output"));
      controller.abort();
      return Promise.reject(new SandboxExecutionError("sandbox_aborted"));
    });
    const result = (await pi.handlers.get("user_bash")?.(
      {
        type: "user_bash",
        command: "wait",
        cwd: "/work/project",
        excludeFromContext: false,
      } as never,
      context({ signal: controller.signal }),
    )) as UserBashEventResult;
    expect(result.result).toMatchObject({ cancelled: true, exitCode: undefined });
    expect(result.result?.output).toContain("partial output");
  });

  it("returns a blocking user-shell result when the extension context becomes stale", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor);
    vi.spyOn(executor, "execute").mockRejectedValue(
      new SandboxExecutionError("sandbox_process_failed"),
    );
    const controller = new AbortController();
    let signalReads = 0;
    const staleContext = {
      ...context(),
      get signal() {
        signalReads += 1;
        if (signalReads > 1) throw new Error("extension context is stale");
        return controller.signal;
      },
    } as ExtensionContext;

    const result = (await pi.handlers.get("user_bash")?.(
      {
        type: "user_bash",
        command: "wait",
        cwd: "/work/project",
        excludeFromContext: false,
      } as never,
      staleContext,
    )) as UserBashEventResult;

    expect(signalReads).toBe(1);
    expect(result.result).toMatchObject({ cancelled: false, exitCode: 1 });
    expect(result.result?.output).toContain("sandbox_process_failed");
  });

  it("returns a blocking user-shell result when the initial signal read fails", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor);
    const staleContext = {
      ...context(),
      get signal() {
        throw new Error("extension context is stale");
      },
    } as ExtensionContext;

    const result = (await pi.handlers.get("user_bash")?.(
      {
        type: "user_bash",
        command: "wait",
        cwd: "/work/project",
        excludeFromContext: false,
      } as never,
      staleContext,
    )) as UserBashEventResult;

    expect(result.result).toMatchObject({ cancelled: true, exitCode: undefined });
    expect(result.result?.output).toContain("extension context is stale");
    expect(executor.calls).toHaveLength(0);
  });

  it("runs user shell without consulting approval UI", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor);
    executor.calls.length = 0;
    const select = vi.fn(() => Promise.resolve("Deny"));
    const result = (await pi.handlers.get("user_bash")?.(
      {
        type: "user_bash",
        command: "pwd",
        cwd: "/work/project",
        excludeFromContext: false,
      } as never,
      context({ hasUI: true, select }),
    )) as UserBashEventResult;
    expect(result.result).toMatchObject({ cancelled: false, exitCode: 0 });
    expect(executor.calls.at(-1)?.argv).toEqual(["/bin/bash", "-c", "pwd"]);
    expect(select).not.toHaveBeenCalled();
  });

  it("blocks user shell when managed initialization failed", async () => {
    const pi = fakePi();
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.reject(new Error("configuration failed")),
      executor: fakeExecutor(),
    })(pi.api);
    await expect(pi.handlers.get("session_start")?.(undefined as never, context())).rejects.toThrow(
      "configuration failed",
    );
    const result = (await pi.handlers.get("user_bash")?.(
      {
        type: "user_bash",
        command: "pwd",
        cwd: "/work/project",
        excludeFromContext: false,
      } as never,
      context(),
    )) as UserBashEventResult;
    expect(result.result?.exitCode).toBe(1);
  });

  it("awaits session maintenance before making tools available", async () => {
    const pi = fakePi();
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onSessionStart = vi.fn<(file: string | undefined) => Promise<void>>(async () => {
      enter();
      await finished;
    });
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(config()),
      executor: fakeExecutor(),
      onSessionStart,
    })(pi.api);
    const file = "/home/test/.pi/agent/sessions/--work-project--/initial.jsonl";
    const pending = pi.handlers.get("session_start")?.(
      undefined as never,
      context({ sessionFile: file }),
    );
    await entered;
    expect(onSessionStart).toHaveBeenCalledExactlyOnceWith(file);
    expect(pi.tools.size).toBe(0);
    expect(pi.activeTools).toHaveLength(0);
    finish();
    await pending;
    expect(pi.tools.size).toBe(7);
    expect(pi.activeTools).toHaveLength(1);
  });

  it("tracks the current file on initial, resumed, and new replacement sessions", async () => {
    const onSessionStart = vi.fn(() => Promise.resolve());
    const extension = createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(config()),
      executor: fakeExecutor(),
      onSessionStart,
    });
    const files = [
      "/home/test/.pi/agent/sessions/--work-project--/initial.jsonl",
      "/home/test/.pi/agent/sessions/--work-project--/old-resumed.jsonl",
      undefined,
    ];
    for (const file of files) {
      const pi = fakePi();
      await extension(pi.api);
      const ctx = context(file === undefined ? {} : { sessionFile: file });
      await pi.handlers.get("session_start")?.(undefined as never, ctx);
      await pi.handlers.get("session_shutdown")?.(undefined as never, ctx);
    }
    expect(onSessionStart.mock.calls).toEqual(files.map((file) => [file]));
  });

  it("starts normally without an optional session maintenance callback", async () => {
    const pi = fakePi();
    const getSessionFile = vi.fn(() => {
      throw new Error("Session file access was unnecessary");
    });
    const ctx = context();
    await createPiSandboxExtension({
      cwd: "/work/project",
      configPath: "/etc/pi-sandbox/config.toml",
      userStateDir: "/home/test/.pi/agent",
      loadConfig: () => Promise.resolve(config()),
      executor: fakeExecutor(),
    })(pi.api);
    await pi.handlers.get("session_start")?.(undefined as never, {
      ...ctx,
      sessionManager: { ...ctx.sessionManager, getSessionFile },
    });
    expect(getSessionFile).not.toHaveBeenCalled();
    expect(pi.tools.size).toBe(7);
  });

  it("clears session state without closing the process-owned executor", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor);

    await pi.handlers.get("session_shutdown")?.(undefined as never, context());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest inspects the mock without invoking it.
    expect(executor.close).not.toHaveBeenCalled();
    const result = (await pi.handlers.get("user_bash")?.(
      {
        type: "user_bash",
        command: "pwd",
        cwd: "/work/project",
        excludeFromContext: false,
      } as never,
      context(),
    )) as UserBashEventResult;
    expect(result.result?.exitCode).toBe(1);
  });

  it("revokes tool and shell access when the same extension runtime is started twice", async () => {
    const pi = fakePi();
    const executor = fakeExecutor();
    await start(pi, executor);
    await expect(pi.handlers.get("session_start")?.(undefined as never, context())).rejects.toThrow(
      "started more than once",
    );
    await expect(executeTool(pi, "write", { path: "blocked", content: "blocked" })).rejects.toThrow(
      "not available",
    );
    const result = (await pi.handlers.get("user_bash")?.(
      { type: "user_bash", command: "pwd" } as never,
      context(),
    )) as UserBashEventResult;
    expect(result.result?.exitCode).toBe(1);
    expect(executor.calls).toHaveLength(0);
  });

  it("does not carry session approval grants into a replacement extension runtime", async () => {
    const executor = fakeExecutor();
    const cfg = config({ write: "ask" });
    const granted = {
      ...cfg,
      tools: { ...cfg.tools, write: { ...cfg.tools.write!, sessionGrant: "offer" as const } },
    };
    const first = fakePi();
    await start(first, executor, granted);
    const select = vi.fn(() => Promise.resolve("Allow for session"));
    const ctx = context({ hasUI: true, select });
    const invoke = (pi: FakePi) =>
      pi.tools
        .get("write")!
        .execute("call", { path: "note", content: "safe" }, undefined, undefined, ctx);
    await invoke(first);
    await invoke(first);
    expect(select).toHaveBeenCalledTimes(1);
    await first.handlers.get("session_shutdown")?.(undefined as never, context());
    await expect(invoke(first)).rejects.toThrow("not available");
    const second = fakePi();
    await start(second, executor, granted);
    await invoke(second);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("reuses the process-owned executor across logical extension sessions", async () => {
    const executor = fakeExecutor();
    const first = fakePi();
    await start(first, executor);
    await first.handlers.get("session_shutdown")?.(undefined as never, context());

    const second = fakePi();
    await start(second, executor);
    await executeTool(second, "write", { path: "next-session.txt", content: "persisted" });

    expect(
      executor.calls.some((call) => call.argv.includes("/work/project/next-session.txt")),
    ).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest inspects the mock without invoking it.
    expect(executor.close).not.toHaveBeenCalled();
  });
});
