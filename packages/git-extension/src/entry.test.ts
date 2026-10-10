import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGitConfig } from "./config.js";
import { createConfiguredGitExtension, type GitEntryDependencies } from "./entry.js";
import type { GitExecutionPort } from "./core.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function runner() {
  return {
    execute: vi.fn<GitExecutionPort["execute"]>().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}
type Handler = (event: { reason?: string }, ctx: ExtensionContext) => unknown;
async function fixture(dependencies: GitEntryDependencies = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-git-entry-"));
  directories.push(cwd);
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  const executor = runner();
  const create = vi.fn<NonNullable<GitEntryDependencies["create"]>>().mockResolvedValue(executor);
  const setActiveTools = vi.fn(),
    shutdown = vi.fn(),
    notify = vi.fn();
  const ctx = { cwd: "/alias", ui: { notify }, shutdown } as unknown as ExtensionContext;
  const getFlag = vi.fn(() => "/private/git.json");
  const api = {
    registerFlag: vi.fn(),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getFlag,
    setActiveTools,
  } as unknown as ExtensionAPI;
  const canonical = vi.fn().mockResolvedValue(cwd);
  const prerequisites = vi.fn().mockResolvedValue(undefined);
  await createConfiguredGitExtension({
    create,
    canonical,
    prerequisites,
    readConfig: () =>
      Promise.resolve(
        parseGitConfig({ version: 1, allowed_hosts: ["github.com"], allowed_schemes: ["https"] }),
      ),
    ...dependencies,
  })(api);
  return {
    cwd,
    create,
    canonical,
    prerequisites,
    executor,
    tools,
    setActiveTools,
    shutdown,
    notify,
    getFlag,
    emit(name: string, reason?: string) {
      return handlers.get(name)?.(reason ? { reason } : {}, ctx);
    },
    invoke(signal?: AbortSignal) {
      return tools
        .get("git_clone")!
        .execute(
          "id",
          { repository: "https://github.com/org/repo.git" },
          signal,
          undefined,
          ctx as ExtensionToolContext,
        );
    },
  };
}

describe("standalone Git lifecycle", () => {
  it("registers before session start, retains user exclusion and initializes once for repeated binding", async () => {
    const current = await fixture();
    expect([...current.tools.keys()]).toEqual(["git_clone"]);
    await expect(current.invoke()).rejects.toThrow("unavailable");
    await Promise.all([current.emit("session_start"), current.emit("session_start")]);
    expect(current.create).toHaveBeenCalledOnce();
    expect(current.canonical).toHaveBeenCalledWith("/alias");
    expect(current.prerequisites).toHaveBeenCalledWith(["/usr/bin/git"]);
    expect(current.setActiveTools).not.toHaveBeenCalled();
    const controller = new AbortController();
    await current.invoke(controller.signal);
    expect(current.executor.execute.mock.calls[0]?.[0].argv.at(-1)).toBe(
      path.join(current.cwd, "repo"),
    );
    expect(current.executor.execute.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    await current.emit("session_shutdown", "quit");
    await current.emit("session_shutdown", "quit");
    expect(current.executor.close).toHaveBeenCalledOnce();
    await expect(current.invoke()).rejects.toThrow("unavailable");
  });

  it.each(["new", "resume", "reload", "quit"])(
    "closes on %s and a replacement entry creates a new owner",
    async (reason) => {
      const first = await fixture();
      await first.emit("session_start");
      await first.emit("session_shutdown", reason);
      await first.emit("session_start");
      expect(first.create).toHaveBeenCalledOnce();
      expect(first.executor.close).toHaveBeenCalledOnce();
      const next = await fixture();
      await next.emit("session_start");
      await next.invoke();
      expect(next.executor.execute).toHaveBeenCalledOnce();
      await next.emit("session_shutdown", "quit");
    },
  );

  it("requires explicit configuration before creating a runner", async () => {
    const current = await fixture();
    current.getFlag.mockReturnValue("");
    await current.emit("session_start");
    expect(current.shutdown).toHaveBeenCalledOnce();
    expect(current.create).not.toHaveBeenCalled();
    await expect(current.invoke()).rejects.toThrow("unavailable");
  });

  it("closes a created runner when later asynchronous initialization fails", async () => {
    const current = await fixture({
      prerequisites: () => Promise.reject(new Error("sensitive error")),
    });
    await current.emit("session_start");
    expect(current.executor.close).toHaveBeenCalledOnce();
    expect(current.shutdown).toHaveBeenCalledOnce();
    expect(current.notify.mock.calls[0]?.[0]).not.toContain("sensitive error");
    await expect(current.invoke()).rejects.toThrow("unavailable");
    await current.emit("session_shutdown", "quit");
    expect(current.executor.close).toHaveBeenCalledOnce();
  });

  it("waits for pending creation during shutdown and never exposes the late runner", async () => {
    let release!: (value: ReturnType<typeof runner>) => void;
    const created = runner();
    const create = vi.fn(
      () =>
        new Promise<ReturnType<typeof runner>>((resolve) => {
          release = resolve;
        }),
    );
    const current = await fixture({ create });
    const starting = current.emit("session_start");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const closing = current.emit("session_shutdown", "quit");
    release(created);
    await Promise.all([starting, closing]);
    expect(created.close).toHaveBeenCalledOnce();
    expect(current.shutdown).not.toHaveBeenCalled();
    await expect(current.invoke()).rejects.toThrow("unavailable");
  });

  it("captures sanitized environment once for the standalone owner", async () => {
    vi.stubEnv("GIT_SSH_COMMAND", "unsafe");
    vi.stubEnv("SSH_ASKPASS", "prompt");
    vi.stubEnv("PI_GIT_TEST_CAPTURE", "original");
    const current = await fixture();
    vi.stubEnv("PI_GIT_TEST_CAPTURE", "later");
    await current.emit("session_start");
    const env = current.create.mock.calls[0]?.[1];
    expect(env?.PI_GIT_TEST_CAPTURE).toBe("original");
    expect(env).not.toHaveProperty("GIT_SSH_COMMAND");
    expect(env).not.toHaveProperty("SSH_ASKPASS");
    expect(env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    await current.emit("session_shutdown", "quit");
  });
});
