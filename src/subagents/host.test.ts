import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as PiSdk from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SubagentSessionRequest } from "../../packages/subagents-extension/src/contracts.js";
import type { SandboxConfig } from "../domain/index.js";
import { currentManagedChild } from "./invocation.js";
import { createManagedSubagentHost } from "./host.js";

vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof PiSdk>()),
  createAgentSession: vi.fn(),
}));
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(extended = false) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-managed-child-"));
  directories.push(cwd);
  const root = {
    cwd,
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "root" },
  } as unknown as ExtensionContext;
  let current = true;
  const abort = new AbortController();
  const calls: {
    name: string;
    child?: string;
    task?: string;
    context: ExtensionToolContext;
    signal?: AbortSignal;
  }[] = [];
  const definitions = new Map<string, ToolDefinition>();
  const define = (name: string, exposure?: ToolDefinition["exposure"]) => {
    const definition = {
      name,
      label: name,
      description: name,
      parameters: { type: "object", properties: {} },
      ...(exposure === undefined ? {} : { exposure }),
      execute: (
        _id: string,
        _args: unknown,
        signal: AbortSignal | undefined,
        _update: unknown,
        context: ExtensionToolContext,
      ) => {
        const child = currentManagedChild();
        calls.push({
          name,
          context,
          ...(signal === undefined ? {} : { signal }),
          ...(child === undefined ? {} : { child: child.childId, task: child.childTaskId }),
        });
        return Promise.resolve({ content: [], details: {} });
      },
    } as unknown as ToolDefinition;
    definitions.set(name, definition);
    return definition;
  };
  for (const name of ["read", "bash", "edit", "write", "grep", "spawn_agent"]) define(name);
  define("hidden", "hidden");
  define("mcp__docs__search", "deferred");
  const pi = {
    getActiveTools: () => ["read", "bash", "edit", "write", "grep", "spawn_agent"],
    getAllTools: () => [...definitions.values()],
  } as unknown as ExtensionAPI;
  const request = {
    id: "child",
    taskId: "task",
    parentSessionId: "root",
    task: "Review code",
    cwd,
    extended,
    model: { id: "fixture", provider: "offline", api: "openai-completions" },
    thinkingLevel: "off",
    sessionFile: join(cwd, "state", "child.jsonl"),
    parentContext: root,
    parentApi: pi,
    signal: abort.signal,
    isCurrent: () => current,
    setActivity: vi.fn(),
  } as unknown as SubagentSessionRequest;
  const runtime = {} as ModelRuntime;
  const host = createManagedSubagentHost({
    config: {
      subagents: { enabled: true, maxConcurrent: 4, maxTotal: 32 },
      codemode: { enabled: false },
    } as SandboxConfig,
    userStateDir: join(cwd, "state"),
    definitions,
    getModelRuntime: () => runtime,
    isAvailable: () => true,
    getEnvironmentPrompt: () => "Private tool HOME; read-only workspace.",
  });
  const childTools = new Map<string, ToolDefinition>();
  let extras: { name: string; sourceInfo: { source: string } }[] = [];
  const dispose = vi.fn();
  const shutdown = vi.fn();
  vi.mocked(createAgentSession).mockImplementation((options) => {
    for (const extension of options!.resourceLoader!.getExtensions().extensions)
      for (const { definition } of extension.tools.values())
        childTools.set(definition.name, definition);
    return Promise.resolve({
      session: {
        sessionManager: options!.sessionManager,
        bindExtensions: () => Promise.resolve(),
        getAllTools: () =>
          [...childTools.keys()]
            .map((name) => ({ name, sourceInfo: { source: "extension" } }))
            .concat(extras),
        dispose,
        extensionRunner: { emit: shutdown },
      } as unknown as AgentSession,
    } as Awaited<ReturnType<typeof createAgentSession>>);
  });
  return {
    host,
    request,
    runtime,
    childTools,
    calls,
    definitions,
    abort,
    define,
    invalidate: () => {
      current = false;
    },
    extras: (value: typeof extras) => {
      extras = value;
    },
    dispose,
    shutdown,
  };
}

describe("managed subagent host", () => {
  it("admits only managed standard tools with the shared runtime and no builtins", async () => {
    const f = await fixture();
    await f.host.createSession(f.request);
    expect([...f.childTools.keys()]).toEqual(["read", "bash", "edit", "write"]);
    const options = vi.mocked(createAgentSession).mock.calls[0]![0]!;
    expect(options).toMatchObject({
      modelRuntime: f.runtime,
      includeBuiltinTools: false,
      cwd: f.request.cwd,
    });
    expect(options.resourceLoader!.getSkills().skills).toEqual([]);
    expect(options.resourceLoader!.getPrompts().prompts).toEqual([]);
    expect(options.sessionManager!.getCwd()).toBe(f.request.cwd);
    expect(options.modelRuntime).toBe(f.runtime);
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    const hooks = options
      .resourceLoader!.getExtensions()
      .extensions.flatMap((extension) => extension.handlers.get("before_agent_start") ?? []);
    for (const hook of hooks) (hook as (event: unknown) => void)(event);
    expect(event.systemPromptOptions.sections.pi_sandbox_environment).toContain(
      "read-only workspace",
    );
    expect(event.systemPromptOptions.sections.pi_subagent_task).toContain("cannot delegate");
  });

  it("does not restore standard tools absent from the parent callable selection", async () => {
    const f = await fixture();
    vi.spyOn(f.request.parentApi, "getActiveTools").mockReturnValue(["read"]);
    await f.host.createSession(f.request);
    expect([...f.childTools.keys()]).toEqual(["read"]);
  });

  it("keeps extended tools in the child context, refreshes live definitions and cancels locally", async () => {
    const f = await fixture(true);
    await f.host.createSession(f.request);
    expect([...f.childTools.keys()]).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "mcp__docs__search",
    ]);
    const ctx = {
      sessionManager: { getSessionId: () => "child-session" },
    } as unknown as ExtensionToolContext;
    const read = f.childTools.get("read")!;
    const updated = f.define("read");
    const execute = vi.spyOn(updated, "execute");
    await read.execute("call", {}, undefined, undefined, ctx);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.calls[0]).toMatchObject({
      context: ctx,
      child: "child",
      task: "task",
      signal: f.abort.signal,
    });
    expect(currentManagedChild()).toBeUndefined();
    f.abort.abort();
    await expect(read.execute("late", {}, undefined, undefined, ctx)).rejects.toThrow(
      "unavailable",
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects a changed live schema and does not fall back to its original definition", async () => {
    const f = await fixture(true);
    await f.host.createSession(f.request);
    f.definitions.set("read", {
      ...f.definitions.get("read"),
      parameters: { type: "object", properties: { different: { type: "string" } } },
    } as unknown as ToolDefinition);
    const ctx = {
      sessionManager: { getSessionId: () => "child-session" },
    } as unknown as ExtensionToolContext;
    await expect(
      f.childTools.get("read")!.execute("call", {}, undefined, undefined, ctx),
    ).rejects.toThrow("changed or is unavailable");
    expect(f.calls).toHaveLength(0);
  });

  it("fails closed and disposes if the SDK restores a stock tool", async () => {
    const f = await fixture();
    f.extras([{ name: "powershell", sourceInfo: { source: "builtin" } }]);
    await expect(f.host.createSession(f.request)).rejects.toThrow("exceeded");
    expect(f.shutdown).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
  });
});
