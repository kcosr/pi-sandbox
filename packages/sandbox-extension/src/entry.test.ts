import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { TOOL_NAMES } from "./invocation.js";
import { createConfiguredSandboxExtension, type EntryDependencies } from "./entry.js";
import { parseSandboxConfig } from "./config.js";
import { LINUX_TOOL_COMMANDS, type SandboxExecutor } from "./runtime/index.js";

type Handler = (event: { reason?: string }, ctx: ExtensionContext) => unknown;
function directConfig() {
  return parseSandboxConfig({
    version: 4,
    mode: "owned",
    backend: { kind: "direct", environment: {} },
    userBash: false,
  });
}
function executorFixture() {
  return {
    backend: "direct" as const,
    cwd: "/workspace",
    home: "/home",
    commands: LINUX_TOOL_COMMANDS,
    probe: vi.fn<SandboxExecutor["probe"]>().mockResolvedValue(undefined),
    execute: vi.fn<SandboxExecutor["execute"]>().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: Buffer.from("done"),
      stderr: Buffer.alloc(0),
    }),
    close: vi.fn<SandboxExecutor["close"]>().mockResolvedValue(undefined),
  };
}
async function fixture(
  slot: object,
  create: () => Promise<SandboxExecutor>,
  dependencies: EntryDependencies = {},
) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const notify = vi.fn(),
    setStatus = vi.fn(),
    shutdown = vi.fn(),
    setActiveTools = vi.fn();
  const ctx = {
    cwd: "/workspace",
    ui: { notify, setStatus },
    shutdown,
  } as unknown as ExtensionContext;
  const pi = {
    registerFlag: vi.fn(),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerToolRenderer: vi.fn(),
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getFlag: () => "/private/config.json",
    getActiveTools: () => ["read", "bash"],
    setActiveTools,
  } as unknown as ExtensionAPI;
  await createConfiguredSandboxExtension(
    {
      create,
      canonical: (path) => Promise.resolve(path),
      readConfig: () => Promise.resolve(directConfig()),
      ...dependencies,
    },
    slot,
  )(pi);
  return {
    ctx,
    pi,
    notify,
    setStatus,
    shutdown,
    setActiveTools,
    tools,
    invoke(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const tool = tools.get(name);
      if (!tool) throw Error(`Missing tool ${name}`);
      return tool.execute("call", args, signal, undefined, ctx as ExtensionToolContext);
    },
    async emit(name: string, reason?: string) {
      for (const handler of handlers.get(name) ?? []) await handler(reason ? { reason } : {}, ctx);
    },
  };
}
describe("owned backend lifecycle", () => {
  it("rejects a smolvm config reached through an ancestor alias into the project", async () => {
    const create = vi.fn();
    const current = await fixture({}, create, {
      canonical: (value) =>
        Promise.resolve(
          value === "/private/config.json" ? "/workspace/control/config.json" : value,
        ),
      readConfig: () =>
        Promise.resolve(
          parseSandboxConfig({
            version: 4,
            mode: "owned",
            backend: {
              kind: "smolvm",
              executable: "/opt/smolvm/smolvm",
              image: "/opt/images/tools.smolmachine",
              imageSha256: "a".repeat(64),
              stateDirectory: "/var/tmp/private-state",
              resources: { cpus: 1, memoryMiB: 512, storageGiB: 1, overlayGiB: 1 },
              cwdWritable: true,
              environment: {},
            },
            userBash: false,
          }),
        ),
    });
    await current.emit("session_start");
    expect(current.shutdown).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });
  it("retains exactly one backend through new/resume and closes on quit", async () => {
    const close = vi.fn();
    const executor: SandboxExecutor = {
      backend: "direct",
      cwd: "/workspace",
      home: "/home",
      commands: LINUX_TOOL_COMMANDS,
      probe: vi.fn(),
      execute: vi.fn(),
      close,
    };
    const create = vi.fn(() => Promise.resolve(executor));
    const slot = {};
    const first = await fixture(slot, create);
    await Promise.all([first.emit("session_start"), first.emit("session_start")]);
    expect(first.shutdown).not.toHaveBeenCalled();
    await first.emit("session_shutdown", "new");
    const second = await fixture(slot, create);
    await second.emit("session_start");
    // A delayed duplicate from the replaced instance cannot close the owner.
    await first.emit("session_shutdown", "quit");
    expect(close).not.toHaveBeenCalled();
    await second.emit("session_shutdown", "resume");
    const third = await fixture(slot, create);
    await third.emit("session_start");
    expect(create).toHaveBeenCalledTimes(1);
    await third.emit("session_shutdown", "quit");
    await third.emit("session_shutdown", "quit");
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("closes before reload replacement and shuts down on startup failure", async () => {
    const close = vi.fn();
    const create = vi.fn((): Promise<SandboxExecutor> =>
      Promise.resolve({
        backend: "direct",
        cwd: "/workspace",
        home: "/home",
        commands: LINUX_TOOL_COMMANDS,
        probe: vi.fn(),
        execute: vi.fn(),
        close,
      }),
    );
    const slot = {};
    const first = await fixture(slot, create);
    await first.emit("session_start");
    await first.emit("session_shutdown", "reload");
    expect(close).toHaveBeenCalledTimes(1);
    const next = await fixture(slot, create);
    await next.emit("session_start");
    expect(create).toHaveBeenCalledTimes(2);
    await next.emit("session_shutdown", "quit");
    const failed = await fixture({}, () => Promise.reject(new Error("private cause")));
    await failed.emit("session_start");
    expect(failed.setActiveTools).toHaveBeenCalledWith([]);
    expect(failed.shutdown).toHaveBeenCalledOnce();
    expect(failed.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("private cause"),
      expect.anything(),
    );
  });
  it("waits for startup and closes when quit arrives while initialization is pending", async () => {
    let release!: (executor: SandboxExecutor) => void;
    const pending = new Promise<SandboxExecutor>((resolve) => {
      release = resolve;
    });
    const close = vi.fn();
    const current = await fixture({}, () => pending);
    const started = current.emit("session_start");
    const stopped = current.emit("session_shutdown", "quit");
    release({
      backend: "direct",
      cwd: "/workspace",
      home: "/home",
      commands: LINUX_TOOL_COMMANDS,
      probe: vi.fn(),
      execute: vi.fn(),
      close,
    });
    await Promise.all([started, stopped]);
    expect(close).toHaveBeenCalledOnce();
    expect(current.setStatus).not.toHaveBeenCalled();
  });
});

describe("standalone execution", () => {
  it("runs without a permissions provider and preserves Pi's tool selection", async () => {
    const executor = executorFixture();
    const current = await fixture({}, () => Promise.resolve(executor));
    await expect(current.invoke("bash", { command: "true" })).rejects.toThrow("unavailable");
    await current.emit("session_start");
    expect(current.shutdown).not.toHaveBeenCalled();
    expect([...current.tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
    expect(current.setActiveTools).not.toHaveBeenCalled();
    await current.invoke("bash", { command: "printf allowed" });
    expect(executor.execute).toHaveBeenCalledOnce();
    await current.emit("session_shutdown", "quit");
    await expect(current.invoke("bash", { command: "true" })).rejects.toThrow("unavailable");
  });

  it("closes a backend whose readiness probe fails and permits a fresh owner", async () => {
    const executor = executorFixture();
    executor.probe.mockRejectedValue(new Error("probe failed"));
    const slot = {};
    const failed = await fixture(slot, () => Promise.resolve(executor));
    await failed.emit("session_start");
    expect(failed.shutdown).toHaveBeenCalledOnce();
    expect(executor.close).toHaveBeenCalledOnce();
    expect(executor.execute).not.toHaveBeenCalled();
    await failed.emit("session_shutdown", "quit");
    const nextExecutor = executorFixture();
    const next = await fixture(slot, () => Promise.resolve(nextExecutor));
    await next.emit("session_start");
    await next.invoke("bash", { command: "true" });
    expect(nextExecutor.execute).toHaveBeenCalledOnce();
    await next.emit("session_shutdown", "quit");
  });
});
