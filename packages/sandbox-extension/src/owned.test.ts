import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createOwnedSandboxExtension } from "./owned.js";
import { parseSandboxConfig } from "./config.js";
import { LINUX_TOOL_COMMANDS, type SandboxExecutor } from "./runtime/index.js";

type Handler = (event: { reason?: string }, ctx: ExtensionContext) => unknown;
async function fixture(slot: object, create: () => Promise<SandboxExecutor>) {
  const handlers = new Map<string, Handler[]>();
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
    registerTool: vi.fn(),
    registerToolRenderer: vi.fn(),
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getFlag: () => "/private/config.json",
    getActiveTools: () => ["read", "bash"],
    setActiveTools,
  } as unknown as ExtensionAPI;
  await createOwnedSandboxExtension(
    {
      create,
      canonical: (path) => Promise.resolve(path),
      readConfig: () =>
        Promise.resolve(
          parseSandboxConfig({
            version: 1,
            mode: "owned",
            backend: { kind: "direct", environment: {} },
            tools: { read: { mode: "allow", sessionGrant: "never" } },
            userBash: false,
          }),
        ),
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
    async emit(name: string, reason?: string) {
      for (const handler of handlers.get(name) ?? []) await handler(reason ? { reason } : {}, ctx);
    },
  };
}
describe("owned backend lifecycle", () => {
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
