import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSandboxExtension, type SandboxExtensionOptions } from "./factory.js";
import type { SandboxToolRequest, BuiltInToolName } from "./invocation.js";
import { LINUX_TOOL_COMMANDS, type SandboxExecutor } from "./runtime/index.js";

type Handler = (event: never, context: ExtensionContext) => unknown;

function fixture() {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler>();
  const execute = vi.fn<SandboxExecutor["execute"]>().mockResolvedValue({
    exitCode: 0,
    signal: null,
    stdout: Buffer.from("done"),
    stderr: Buffer.alloc(0),
  });
  const executor: SandboxExecutor = {
    cwd: "/canonical/project",
    home: "/canonical/home",
    backend: "bubblewrap",
    commands: LINUX_TOOL_COMMANDS,
    execute,
    probe: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerToolRenderer: vi.fn(),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  const context = { hasUI: false } as ExtensionToolContext;
  const options: SandboxExtensionOptions = {
    cwd: "/aliased/project",
    getExecutor: () => executor,
    tools: ["bash", "write"],
    authorize: () => Promise.resolve(),
  };
  const invoke = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`Missing tool ${name}`);
    return tool.execute("call", args, signal, undefined, context);
  };
  return { tools, handlers, execute, executor, pi, context, options, invoke };
}

describe("reusable sandbox factory", () => {
  it.each([undefined, null, false, {}])(
    "rejects a missing or invalid authorization callback (%s)",
    (authorize) => {
      const f = fixture();
      expect(() =>
        createSandboxExtension({ ...f.options, authorize } as unknown as SandboxExtensionOptions),
      ).toThrow("authorization callback");
    },
  );

  it("registers eagerly without obtaining an executor or assuming managed Pi APIs", async () => {
    const f = fixture();
    const getExecutor = vi.fn(() => {
      throw new Error("not started");
    });
    await createSandboxExtension({ ...f.options, getExecutor })(f.pi);
    expect([...f.tools.keys()]).toEqual(["write", "bash"]);
    expect(getExecutor).not.toHaveBeenCalled();
    await expect(f.invoke("bash", { command: "true" })).rejects.toThrow("not started");
  });

  it("copies the registration ceiling and rejects duplicate or unknown tool names", async () => {
    const f = fixture();
    const tools: BuiltInToolName[] = ["bash"];
    const factory = createSandboxExtension({ ...f.options, tools });
    tools.push("write");
    await factory(f.pi);
    expect([...f.tools.keys()]).toEqual(["bash"]);
    expect(() => createSandboxExtension({ ...f.options, tools: ["bash", "bash"] })).toThrow(
      "duplicate",
    );
    expect(() =>
      createSandboxExtension({ ...f.options, tools: ["unknown" as BuiltInToolName] }),
    ).toThrow("unknown");
  });

  it("authorizes the canonical immutable arguments that actually reach the executor", async () => {
    const f = fixture();
    let request: SandboxToolRequest | undefined;
    let allow: (() => void) | undefined;
    await createSandboxExtension({
      ...f.options,
      authorize: async (prepared) => {
        request = prepared;
        await new Promise<void>((resolve) => {
          allow = resolve;
        });
      },
    })(f.pi);
    const args = { path: "./notes.txt", content: "original" };
    const pending = f.invoke("write", args);
    await vi.waitFor(() => expect(request).toBeDefined());
    expect(request?.arguments.path).toBe("/canonical/project/notes.txt");
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request?.arguments)).toBe(true);
    args.path = "/outside/replacement";
    args.content = "changed";
    expect(f.execute).not.toHaveBeenCalled();
    allow?.();
    await pending;
    const command = f.execute.mock.calls[0]?.[0];
    expect(command?.argv).toContain("/canonical/project/notes.txt");
    expect(command?.argv).not.toContain(args.path);
    expect(command?.stdin?.toString()).toBe("original");
  });

  it("uses the same mandatory authorization for every call and never consults visibility", async () => {
    const f = fixture();
    const authorize = vi.fn<SandboxExtensionOptions["authorize"]>();
    authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("not admitted"));
    await createSandboxExtension({ ...f.options, authorize })(f.pi);
    await f.invoke("bash", { command: "printf once" });
    await expect(f.invoke("bash", { command: "printf twice" })).rejects.toThrow("not admitted");
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0]?.[0].arguments.cwd).toBe("/canonical/project");
  });

  it("passes the actual invocation signal and context to authorization and execution", async () => {
    const f = fixture();
    const controller = new AbortController();
    const authorize = vi.fn<SandboxExtensionOptions["authorize"]>().mockResolvedValue(undefined);
    await createSandboxExtension({ ...f.options, authorize })(f.pi);
    await f.invoke("bash", { command: "printf approved" }, controller.signal);
    expect(authorize.mock.calls[0]?.[1]).toBe(f.context);
    expect(authorize.mock.calls[0]?.[2]).toBe(controller.signal);
    expect(f.execute.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("does not execute when cancellation arrives while authorization is pending", async () => {
    const f = fixture();
    const controller = new AbortController();
    await createSandboxExtension({
      ...f.options,
      authorize: () => {
        controller.abort();
        return Promise.resolve();
      },
    })(f.pi);
    await expect(f.invoke("bash", { command: "true" }, controller.signal)).rejects.toMatchObject({
      code: "sandbox_aborted",
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("blocks user shell fallback by default and supports a separately supplied shell capability", async () => {
    const f = fixture();
    let shellEnabled = false;
    const authorize = vi.fn<SandboxExtensionOptions["authorize"]>();
    await createSandboxExtension({
      ...f.options,
      tools: [],
      authorize,
      userBash: () => shellEnabled,
    })(f.pi);
    const invoke = async () =>
      (await f.handlers.get("user_bash")?.(
        { command: "printf user" } as never,
        f.context,
      )) as UserBashEventResult;
    const denied = (await invoke()).result;
    expect(denied?.exitCode).toBe(1);
    expect(denied?.output).toContain("disabled");
    expect(f.execute).not.toHaveBeenCalled();
    shellEnabled = true;
    expect((await invoke()).result).toMatchObject({ exitCode: 0, output: "done" });
    expect(authorize).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.handlers.has("session_shutdown")).toBe(false);
  });
});
