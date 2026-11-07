import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSubagentConfig } from "./config.js";
import { Controller, SUBAGENT_SPAWN_ENTRY } from "./controller.js";
import type { SubagentHost, SubagentSessionRequest } from "./contracts.js";
import { SubagentStore } from "./storage.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "subagent-core-"));
  directories.push(path);
  return path;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const parent = (cwd: string) =>
  ({
    cwd,
    model: {
      id: "fixture",
      provider: "fixture",
      api: "openai-completions",
      baseUrl: "http://localhost.invalid",
      name: "Fixture",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    },
    sessionManager: { getSessionId: () => "parent" },
  }) as unknown as ExtensionContext;
const api = { getThinkingLevel: () => "off" } as unknown as ExtensionAPI;
function fakeSession() {
  const done = deferred<void>();
  let listener: ((event: unknown) => void) | undefined;
  const complete = (text = "finished") => {
    listener?.({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
    });
    done.resolve();
  };
  const dispose = vi.fn();
  const abort = vi.fn(() => {
    done.resolve();
    return Promise.resolve();
  });
  const session = {
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    prompt: () => done.promise,
    steer: vi.fn(() => Promise.resolve()),
    abort,
    dispose,
  } as unknown as AgentSession;
  return { session, complete, dispose, abort };
}

describe("subagent controller", () => {
  it("retains user cancellation intent until settlement without releasing capacity or replacing it with a deadline", async () => {
    vi.useFakeTimers();
    const directory = root();
    const fake = fakeSession();
    fake.abort.mockImplementation(() => Promise.resolve());
    const next = fakeSession();
    let sessions = 0;
    const controller = new Controller(
      api,
      {
        config: parseSubagentConfig(
          { maxConcurrent: 1, cancelTimeoutMs: 1, taskTimeoutMs: 10 },
          directory,
        ),
        createSession: () => Promise.resolve(sessions++ === 0 ? fake.session : next.session),
      },
      "parent",
    );
    const item = await controller.spawn("work", false, parent(directory));
    await expect(controller.cancelByUser(item.id, "stale")).rejects.toThrow("changed");
    expect(fake.abort).not.toHaveBeenCalled();
    const cancellation = controller.cancelByUser(item.id, item.taskId);
    await vi.advanceTimersByTimeAsync(1);
    const stopping = await cancellation;
    expect(stopping).toMatchObject({
      status: "stopping",
      callback: "armed",
      cancelRequestedBy: "user",
    });
    expect(controller.statistics().active).toBe(1);
    await expect(controller.resume(item.id, "too soon", false, parent(directory))).rejects.toThrow(
      "still active",
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(controller.snapshot()[0]?.error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(directory, "parent", "state.json"), "utf8"))).toMatchObject(
      { records: [{ cancelRequestedBy: "user", callback: "armed" }] },
    );
    fake.complete();
    await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
    expect(controller.snapshot()[0]).toMatchObject({
      status: "cancelled",
      callback: "armed",
      cancelRequestedBy: "user",
    });
    controller.acknowledge(item.taskId);
    await expect(controller.cancelByUser(item.id, item.taskId)).resolves.toMatchObject({
      callback: "acknowledged",
    });
    const resumed = await controller.resume(
      item.id,
      "continue explicitly",
      false,
      parent(directory),
    );
    expect(resumed.cancelRequestedBy).toBeUndefined();
    await controller.cancel(resumed.id);
    await controller.shutdown();
  });

  it("retains a user callback when cancellation wins during asynchronous startup", async () => {
    const directory = root();
    const ready = deferred<AgentSession>();
    const fake = fakeSession();
    const controller = new Controller(
      api,
      {
        config: parseSubagentConfig({ cancelTimeoutMs: 1 }, directory),
        createSession: () => ready.promise,
      },
      "parent",
    );
    const starting = controller.spawn("work", false, parent(directory));
    const rejected = expect(starting).rejects.toThrow("cancelled");
    const item = controller.snapshot()[0]!;
    await expect(controller.cancelByUser(item.id, item.taskId)).resolves.toMatchObject({
      status: "stopping",
      callback: "armed",
      cancelRequestedBy: "user",
    });
    await rejected;
    ready.resolve(fake.session);
    await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
    expect(controller.snapshot()[0]).toMatchObject({
      status: "cancelled",
      callback: "armed",
      cancelRequestedBy: "user",
    });
    expect(fake.dispose).toHaveBeenCalled();
    await controller.shutdown();
  });

  it.each(["before", "after", "shutdown"] as const)(
    "does not re-arm user cancellation after suppression: %s",
    async (when) => {
      const directory = root();
      const fake = fakeSession();
      fake.abort.mockImplementation(() => Promise.resolve());
      const controller = new Controller(
        api,
        {
          config: parseSubagentConfig({ cancelTimeoutMs: 1 }, directory),
          createSession: () => Promise.resolve(fake.session),
        },
        "parent",
      );
      const item = await controller.spawn("work", false, parent(directory));
      if (when === "before") controller.disarm();
      await controller.cancelByUser(item.id, item.taskId);
      if (when === "after") controller.disarm();
      if (when === "shutdown")
        await expect(controller.shutdown()).rejects.toThrow("waiting for active work");
      await expect(controller.cancelByUser(item.id, item.taskId)).resolves.toMatchObject({
        callback: "disarmed",
      });
      fake.complete();
      await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
      expect(controller.snapshot()[0]?.callback).toBe("disarmed");
      await controller.shutdown();
    },
  );

  it("does not fabricate user cancellation for an already settled task", async () => {
    const directory = root();
    const fake = fakeSession();
    const controller = new Controller(
      api,
      {
        config: parseSubagentConfig({}, directory),
        createSession: () => Promise.resolve(fake.session),
      },
      "parent",
    );
    const item = await controller.spawn("work", false, parent(directory));
    fake.complete();
    await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
    const result = await controller.cancelByUser(item.id, item.taskId);
    expect(result).toMatchObject({ status: "completed", callback: "armed" });
    expect(result.cancelRequestedBy).toBeUndefined();
    expect(fake.abort).not.toHaveBeenCalled();
    await controller.shutdown();
  });

  it("persists user cancellation origin and rejects invalid stored origins", async () => {
    const directory = root();
    const fake = fakeSession();
    const host: SubagentHost = {
      config: parseSubagentConfig({}, directory),
      createSession: () => Promise.resolve(fake.session),
    };
    let controller = new Controller(api, host, "parent");
    const item = await controller.spawn("work", false, parent(directory));
    await controller.cancelByUser(item.id, item.taskId);
    await controller.shutdown();
    controller = new Controller(api, host, "parent");
    expect(controller.snapshot()[0]).toMatchObject({
      status: "cancelled",
      cancelRequestedBy: "user",
      callback: "disarmed",
    });
    await controller.shutdown();
    const path = join(directory, "parent", "state.json");
    const document = JSON.parse(readFileSync(path, "utf8")) as {
      records: { cancelRequestedBy: unknown }[];
    };
    for (const invalid of [null, "tool", true]) {
      document.records[0]!.cancelRequestedBy = invalid;
      writeFileSync(path, JSON.stringify(document));
      expect(() => new Controller(api, host, "parent")).toThrow("Invalid subagent record");
    }
  });

  it("shares state, ownership and resume identity across aliases of its state directory", async () => {
    const directory = root();
    const target = join(directory, "state");
    const alias = join(directory, "alias");
    mkdirSync(target);
    symlinkSync(target, alias, "dir");
    const canonical = realpathSync(target);
    const sessions = [fakeSession(), fakeSession()];
    const requests: SubagentSessionRequest[] = [];
    const host = (stateDirectory: string): SubagentHost => ({
      config: parseSubagentConfig({ maxTotal: 1 }, stateDirectory),
      createSession(request) {
        requests.push(request);
        return Promise.resolve(sessions[requests.length - 1]!.session);
      },
    });
    let controller = new Controller(api, host(alias), "parent");
    let childId: string;
    try {
      const child = await controller.spawn("first", false, parent(directory));
      childId = child.id;
      expect(child.sessionFile).toBe(join(canonical, "parent", child.id, "session.jsonl"));
      writeFileSync(child.sessionFile, "saved conversation\n");
      expect(() => new Controller(api, host(canonical), "parent")).toThrow("already has an owner");
      sessions[0]!.complete();
      await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
    } finally {
      await controller.shutdown();
    }
    controller = new Controller(api, host(canonical), "parent");
    try {
      expect(controller.statistics().total).toBe(1);
      const resumed = await controller.resume(childId, "continue", false, parent(directory));
      expect(resumed.id).toBe(childId);
      expect(requests[1]!.sessionFile).toBe(requests[0]!.sessionFile);
      expect(readFileSync(requests[1]!.sessionFile, "utf8")).toBe("saved conversation\n");
      expect(() => new Controller(api, host(alias), "parent")).toThrow("already has an owner");
    } finally {
      await controller.shutdown();
    }
    const reopened = new Controller(api, host(alias), "parent");
    try {
      expect(reopened.statistics().total).toBe(1);
      await expect(reopened.spawn("over cap", false, parent(directory))).rejects.toThrow(
        "total limit",
      );
    } finally {
      await reopened.shutdown();
    }
  });

  it.each(["startup", "deadline", "signal"])(
    "contains cancellation persistence failures from a %s callback",
    async (source) => {
      vi.useFakeTimers();
      const directory = root();
      const pending = deferred<AgentSession>();
      const fake = fakeSession();
      const controller = new Controller(
        api,
        {
          config: parseSubagentConfig(
            { startupTimeoutMs: 10, taskTimeoutMs: source === "deadline" ? 10 : 0 },
            directory,
          ),
          createSession: () =>
            source === "deadline" ? Promise.resolve(fake.session) : pending.promise,
        },
        "parent",
      );
      const abort = new AbortController();
      const spawn = controller.spawn("task", false, parent(directory), abort.signal);
      const started =
        source === "deadline"
          ? spawn
          : expect(spawn).rejects.toThrow(source === "startup" ? "timed out" : "cancelled");
      if (source === "deadline") await started;
      const write = vi.spyOn(SubagentStore.prototype, "write").mockImplementation(() => {
        throw new Error("fixture disk full");
      });
      if (source === "signal") abort.abort();
      else await vi.advanceTimersByTimeAsync(10);
      await started;
      expect(controller.snapshot()[0]!.callback).toBe("disarmed");
      write.mockRestore();
      pending.resolve(fake.session);
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.statistics().active).toBe(0);
      expect(fake.dispose).toHaveBeenCalledOnce();
      await controller.shutdown();
    },
  );

  it("requests every child's cancellation even when saving quiescence fails", async () => {
    const directory = root();
    const sessions = [fakeSession(), fakeSession()];
    let next = 0;
    const host: SubagentHost = {
      config: parseSubagentConfig({}, directory),
      createSession: () => Promise.resolve(sessions[next++]!.session),
    };
    const controller = new Controller(api, host, "parent");
    await controller.spawn("first", false, parent(directory));
    await controller.spawn("second", false, parent(directory));
    const write = vi.spyOn(SubagentStore.prototype, "write").mockImplementation(() => {
      throw new Error("fixture disk full");
    });
    await expect(controller.shutdown()).rejects.toThrow("could not be saved");
    for (const fake of sessions) {
      expect(fake.abort).toHaveBeenCalledOnce();
      expect(fake.dispose).toHaveBeenCalledOnce();
    }
    expect(controller.statistics().active).toBe(0);
    write.mockRestore();
    const reopened = new Controller(api, host, "parent");
    expect(reopened.statistics().total).toBe(2);
    await reopened.shutdown();
  });

  it("releases failed-shutdown ownership only after late work has actually settled", async () => {
    const directory = root();
    const pending = deferred<AgentSession>();
    const host: SubagentHost = {
      config: parseSubagentConfig({ cancelTimeoutMs: 10 }, directory),
      createSession: () => pending.promise,
    };
    const controller = new Controller(api, host, "parent");
    const spawn = expect(
      controller.spawn("late startup", false, parent(directory)),
    ).rejects.toThrow("cancelled");
    await expect(controller.shutdown()).rejects.toThrow("waiting for active work");
    await spawn;
    expect(() => new Controller(api, host, "parent")).toThrow("owner");
    const late = fakeSession();
    pending.resolve(late.session);
    await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledOnce());
    const reopened = new Controller(api, host, "parent");
    expect(reopened.statistics()).toMatchObject({ active: 0, total: 1 });
    const stored = readFileSync(join(directory, "parent", "state.json"), "utf8");
    await expect(controller.cancel(controller.snapshot()[0]!.id)).rejects.toThrow("closed");
    expect(readFileSync(join(directory, "parent", "state.json"), "utf8")).toBe(stored);
    await reopened.shutdown();
  });

  it("still waits for disposal when saving cancellation fails", async () => {
    const directory = root();
    const fake = fakeSession();
    const cleanup = deferred<void>();
    const controller = new Controller(
      api,
      {
        config: parseSubagentConfig({}, directory),
        createSession: () => Promise.resolve(fake.session),
        disposeSession: () => cleanup.promise,
      },
      "parent",
    );
    const child = await controller.spawn("task", false, parent(directory));
    const write = vi.spyOn(SubagentStore.prototype, "write").mockImplementationOnce(() => {
      throw new Error("fixture disk full");
    });
    let settled = false;
    const cancellation = controller.cancel(child.id).finally(() => {
      settled = true;
    });
    const failure = expect(cancellation).rejects.toThrow("fixture disk full");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fake.dispose).not.toHaveBeenCalled();
    cleanup.resolve();
    await failure;
    expect(fake.dispose).toHaveBeenCalledOnce();
    expect(controller.statistics().active).toBe(0);
    write.mockRestore();
    await controller.shutdown();
  });

  it("charges failed new spawns durably while allowing repeated resumes at the total cap", async () => {
    const directory = root();
    const config = parseSubagentConfig({ maxTotal: 2 }, directory);
    let attempts = 0;
    const sessions: ReturnType<typeof fakeSession>[] = [];
    const host: SubagentHost = {
      config,
      createSession() {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error("auth unavailable"));
        const fake = fakeSession();
        sessions.push(fake);
        return Promise.resolve(fake.session);
      },
    };
    let controller = new Controller(api, host, "parent");
    await expect(controller.spawn("first", false, parent(directory))).rejects.toThrow(
      "auth unavailable",
    );
    expect(controller.statistics()).toMatchObject({ total: 1, active: 0 });
    const second = await controller.spawn("second", false, parent(directory));
    sessions[0]!.complete();
    await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
    const resumed = await controller.resume(second.id, "next", true, parent(directory));
    expect(resumed.id).toBe(second.id);
    expect(resumed.taskId).not.toBe(second.taskId);
    sessions[1]!.complete();
    await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
    await controller.shutdown();
    controller = new Controller(api, host, "parent");
    expect(controller.statistics().total).toBe(2);
    await expect(controller.spawn("over cap", false, parent(directory))).rejects.toThrow(
      "total limit",
    );
    await controller.resume(second.id, "continue at the cap", undefined, parent(directory));
    expect(controller.statistics().total).toBe(2);
    expect(attempts).toBe(4);
    await controller.shutdown();
  });

  it("enforces concurrency on resume without charging total or permitting new spawns", async () => {
    const directory = root();
    const sessions = [fakeSession(), fakeSession(), fakeSession()];
    let calls = 0;
    const host: SubagentHost = {
      config: parseSubagentConfig({ maxConcurrent: 1, maxTotal: 2 }, directory),
      createSession: () => Promise.resolve(sessions[calls++]!.session),
    };
    const controller = new Controller(api, host, "parent");
    try {
      const first = await controller.spawn("first", false, parent(directory));
      await controller.cancel(first.id);
      const second = await controller.spawn("second", false, parent(directory));
      await expect(
        controller.resume(first.id, "blocked by live peer", false, parent(directory)),
      ).rejects.toThrow("concurrency limit");
      expect(controller.statistics()).toMatchObject({ total: 2, active: 1 });
      await controller.cancel(second.id);
      await controller.resume(first.id, "allowed at total cap", false, parent(directory));
      expect(controller.statistics()).toMatchObject({ total: 2, active: 1 });
      await expect(controller.spawn("still capped", false, parent(directory))).rejects.toThrow(
        "total limit",
      );
    } finally {
      await controller.shutdown();
    }
  });

  it("does not charge total when a resume fails to start", async () => {
    const directory = root();
    const fake = fakeSession();
    let calls = 0;
    const controller = new Controller(
      api,
      {
        config: parseSubagentConfig({ maxTotal: 1 }, directory),
        createSession: () =>
          ++calls === 1
            ? Promise.resolve(fake.session)
            : Promise.reject(new Error("resume auth unavailable")),
      },
      "parent",
    );
    try {
      const child = await controller.spawn("first", false, parent(directory));
      await controller.cancel(child.id);
      await expect(
        controller.resume(child.id, "continue", false, parent(directory)),
      ).rejects.toThrow("resume auth unavailable");
      expect(controller.statistics()).toMatchObject({ total: 1, active: 0 });
    } finally {
      await controller.shutdown();
    }
  });

  it("retains admission totals in the parent journal after child history is removed", async () => {
    const directory = root();
    const journal: unknown[] = [];
    const context = parent(directory);
    context.sessionManager.getEntries = () =>
      journal as ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;
    const parentApi = {
      ...api,
      appendEntry: (customType: string, data: unknown) =>
        journal.push({ type: "custom", customType, data }),
    } as unknown as ExtensionAPI;
    const fake = fakeSession();
    const host: SubagentHost = {
      config: parseSubagentConfig({ maxTotal: 1 }, directory),
      createSession: () => Promise.resolve(fake.session),
    };
    const original = new Controller(parentApi, host, "parent", context);
    const child = await original.spawn("one attempt", false, context);
    await original.cancel(child.id);
    await original.resume(child.id, "resume without another journal charge", false, context);
    await original.shutdown();
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ customType: SUBAGENT_SPAWN_ENTRY, data: { total: 1 } });
    rmSync(join(directory, "parent"), { recursive: true });
    const recovered = new Controller(parentApi, host, "parent", context);
    expect(recovered.statistics().total).toBe(1);
    await expect(recovered.spawn("cannot reset the quota", false, context)).rejects.toThrow(
      "total limit",
    );
    await recovered.shutdown();
  });

  it("quiesces work before a cancelled exit and permits later work without refunding quota", async () => {
    const directory = root();
    const sessions = [fakeSession(), fakeSession()];
    const host: SubagentHost = {
      config: parseSubagentConfig({}, directory),
      createSession: () => Promise.resolve(sessions.shift()!.session),
    };
    const controller = new Controller(api, host, "parent");
    await controller.spawn("first", false, parent(directory));
    await controller.quiesce();
    expect(controller.statistics()).toMatchObject({ active: 0, total: 1 });
    expect(controller.snapshot()[0]).toMatchObject({ status: "cancelled", callback: "disarmed" });
    await controller.spawn("after cancelling exit", false, parent(directory));
    expect(controller.statistics()).toMatchObject({ active: 1, total: 2 });
    await controller.shutdown();
  });

  it("settles a rejected admission without a phantom active child when persistence fails", async () => {
    const directory = root();
    const createSession = vi.fn(() => Promise.resolve(fakeSession().session));
    const controller = new Controller(
      api,
      { config: parseSubagentConfig({}, directory), createSession },
      "parent",
    );
    const write = vi.spyOn(SubagentStore.prototype, "write").mockImplementationOnce(() => {
      throw new Error("fixture storage unavailable");
    });
    await expect(controller.spawn("failed admission", false, parent(directory))).rejects.toThrow(
      "storage unavailable",
    );
    expect(controller.statistics()).toMatchObject({ total: 1, active: 0 });
    expect(controller.snapshot()[0]).toMatchObject({ status: "failed", callback: "disarmed" });
    expect(createSession).not.toHaveBeenCalled();
    write.mockRestore();
    await controller.shutdown();
  });

  it("preserves charged quota if appending the parent journal fails", async () => {
    const directory = root();
    const context = parent(directory);
    context.sessionManager.getEntries = () => [];
    const parentApi = {
      ...api,
      appendEntry: () => {
        throw new Error("fixture journal unavailable");
      },
    } as unknown as ExtensionAPI;
    const host = {
      config: parseSubagentConfig({}, directory),
      createSession: vi.fn(() => Promise.resolve(fakeSession().session)),
    };
    const controller = new Controller(parentApi, host, "parent", context);
    await expect(controller.spawn("failed journal", false, context)).rejects.toThrow(
      "journal unavailable",
    );
    expect(controller.statistics()).toMatchObject({ total: 1, active: 0 });
    expect(host.createSession).not.toHaveBeenCalled();
    await controller.shutdown();
    const recovered = new Controller(api, host, "parent");
    expect(recovered.statistics().total).toBe(1);
    await recovered.shutdown();
  });

  it("settles without a misleading stopping state when saving the final result fails", async () => {
    const directory = root();
    const fake = fakeSession();
    const controller = new Controller(
      api,
      {
        config: parseSubagentConfig({}, directory),
        createSession: () => Promise.resolve(fake.session),
      },
      "parent",
    );
    await controller.spawn("task", false, parent(directory));
    const write = vi.spyOn(SubagentStore.prototype, "write").mockImplementationOnce(() => {
      throw new Error("fixture result exceeds storage limit");
    });
    fake.complete();
    await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
    expect(controller.snapshot()[0]).toMatchObject({
      status: "failed",
      callback: "disarmed",
      activity: "saving result failed",
    });
    write.mockRestore();
    await controller.shutdown();
  });

  it.each(["host", "extension"])(
    "disposes the local session after %s cleanup rejects while retaining uncertain capacity",
    async (kind) => {
      const directory = root();
      const fake = fakeSession();
      const cleanup = vi.fn(() => Promise.reject(new Error("fixture cleanup failed")));
      if (kind === "extension")
        Object.defineProperty(fake.session, "extensionRunner", { value: { emit: cleanup } });
      const controller = new Controller(
        api,
        {
          config: parseSubagentConfig({ maxConcurrent: 1 }, directory),
          createSession: () => Promise.resolve(fake.session),
          ...(kind === "host" ? { disposeSession: cleanup } : {}),
        },
        "parent",
      );
      const child = await controller.spawn("task", false, parent(directory));
      fake.complete();
      await vi.waitFor(() => expect(controller.snapshot()[0]!.activity).toBe("cleanup failed"));
      expect(fake.dispose).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(controller.statistics().active).toBe(1);
      expect(controller.snapshot()[0]).toMatchObject({ status: "stopping", callback: "disarmed" });
      await expect(
        controller.resume(child.id, "continue", false, parent(directory)),
      ).rejects.toThrow("still active");
      await expect(controller.spawn("new", false, parent(directory))).rejects.toThrow(
        "concurrency limit",
      );
      await expect(controller.shutdown()).rejects.toThrow("waiting for active work");
    },
  );

  it("cancels a running child while another startup is suspended, retaining unsettled capacity", async () => {
    const directory = root();
    const blocked = deferred<AgentSession>();
    const running = fakeSession();
    let first = true;
    const host: SubagentHost = {
      config: parseSubagentConfig({ maxConcurrent: 2, cancelTimeoutMs: 10 }, directory),
      createSession() {
        if (first) {
          first = false;
          return Promise.resolve(running.session);
        }
        return blocked.promise;
      },
    };
    const controller = new Controller(api, host, "parent");
    const child = await controller.spawn("running", false, parent(directory));
    const pending = controller.spawn("blocked startup", false, parent(directory));
    const pendingFailure = expect(pending).rejects.toThrow("cancelled");
    const starting = controller.snapshot().find((item) => item.status === "starting")!;
    await controller.cancel(child.id, child.taskId);
    expect(running.abort).toHaveBeenCalledTimes(1);
    const stopped = await controller.cancel(starting.id, starting.taskId);
    expect(stopped.status).toBe("stopping");
    expect(controller.statistics().active).toBe(1);
    await expect(
      controller.resume(starting.id, "still alive", undefined, parent(directory)),
    ).rejects.toThrow("still active");
    const late = fakeSession();
    blocked.resolve(late.session);
    await pendingFailure;
    await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
    expect(late.dispose).toHaveBeenCalled();
    await controller.shutdown();
  });

  it("rejects disabled or malformed calls before consuming quota and guards stale cancellation", async () => {
    const directory = root();
    const fake = fakeSession();
    const host: SubagentHost = {
      config: parseSubagentConfig({}, directory),
      createSession: vi.fn(() => Promise.resolve(fake.session)),
    };
    const controller = new Controller(api, host, "parent");
    await expect(controller.spawn(" ", false, parent(directory))).rejects.toThrow();
    expect(controller.statistics().total).toBe(0);
    const child = await controller.spawn("task", false, parent(directory));
    await expect(controller.cancel(child.id, "old-generation")).rejects.toThrow("changed");
    expect(fake.abort).not.toHaveBeenCalled();
    await controller.cancel(child.id);
    await controller.shutdown();
    const disabled = new Controller(
      api,
      { ...host, config: parseSubagentConfig({ enabled: false }, directory) },
      "parent",
    );
    await expect(disabled.spawn("no", false, parent(directory))).rejects.toThrow("disabled");
    expect(disabled.statistics().total).toBe(1);
    await disabled.shutdown();
  });

  it("bounds inspection, omits model routing metadata, and does not acknowledge observation", async () => {
    const directory = root();
    const fake = fakeSession();
    const controller = new Controller(
      api,
      {
        config: parseSubagentConfig({}, directory),
        createSession: () => Promise.resolve(fake.session),
      },
      "parent",
    );
    const child = await controller.spawn("task", false, parent(directory));
    fake.complete("\0🦉".repeat(20000));
    await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
    const result = controller.inspect(child.id);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(4096);
    expect(result).not.toContain("�");
    expect(JSON.parse(result)).not.toHaveProperty("provider");
    expect(controller.snapshot()[0]!.callback).toBe("armed");
    expect(controller.snapshot()[0]!.result!.length).toBeLessThanOrEqual(32768);
    await controller.shutdown();
  });

  it("has one owner and rejects malformed recovered state instead of trusting file paths", async () => {
    const directory = root();
    const fake = fakeSession();
    const host: SubagentHost = {
      config: parseSubagentConfig({}, directory),
      createSession: () => Promise.resolve(fake.session),
    };
    const controller = new Controller(api, host, "parent");
    expect(() => new Controller(api, host, "parent")).toThrow("owner");
    const child = await controller.spawn("task", false, parent(directory));
    fake.complete();
    await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
    await controller.shutdown();
    const path = join(directory, "parent", "state.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as { records: { sessionFile: string }[] };
    state.records[0]!.sessionFile = join(directory, "elsewhere.jsonl");
    writeFileSync(path, JSON.stringify(state));
    expect(() => new Controller(api, host, "parent")).toThrow("Invalid subagent record");
    expect(child.status).toBe("running");
  });

  it("captures model/reasoning for each generation before asynchronous creation", async () => {
    const directory = root();
    const contexts: SubagentSessionRequest[] = [];
    const fake = fakeSession();
    const context = parent(directory);
    const controller = new Controller(
      api,
      {
        config: parseSubagentConfig({}, directory),
        createSession(request) {
          contexts.push(request);
          return Promise.resolve(fake.session);
        },
      },
      "parent",
    );
    const child = await controller.spawn("first", false, context);
    expect(contexts[0]!.model).not.toBe(context.model);
    expect(contexts[0]!.thinkingLevel).toBe("off");
    await controller.cancel(child.id);
    await controller.shutdown();
  });
});

describe("subagent configuration", () => {
  it("rejects obsolete process options and timer overflow", () => {
    expect(() => parseSubagentConfig({ piExecutable: "/usr/bin/pi" })).toThrow("Unknown");
    expect(() => parseSubagentConfig({ startupTimeoutMs: 2147483648 })).toThrow();
    expect(() => parseSubagentConfig({ cancelTimeoutMs: 2147483648 })).toThrow();
    expect(() => parseSubagentConfig({ maxTotal: 0 })).toThrow();
    expect(() => parseSubagentConfig({ maxTotal: null })).toThrow();
    expect(() => parseSubagentConfig({ tools: null })).toThrow();
    expect(() => parseSubagentConfig({ tools: ["spawn_agent"] })).toThrow();
  });
});
