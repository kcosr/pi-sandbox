import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { SandboxExecutionError } from "../sandbox/index.js";
import type { AuditClient, AuditEvent } from "./client.js";
import { ToolAuditor, toolAuditMetadata } from "./tools.js";

const success = { content: [], details: {} };
function fixture(submit?: (event: AuditEvent) => Promise<void>) {
  const events: AuditEvent[] = [];
  let session = "pi-1";
  const client: AuditClient = {
    submit: async (event) => {
      events.push(event);
      await submit?.(event);
    },
    close: () => Promise.resolve(),
  };
  const auditor = new ToolAuditor(client, "/workspace", "/home/user");
  const ctx = { sessionManager: { getSessionId: () => session } } as ExtensionContext;
  const definition = (execute: ToolDefinition["execute"], name = "write") =>
    auditor.wrap({ name, execute } as ToolDefinition, "bubblewrap");
  const invoke = (tool: ToolDefinition, args = {}, signal?: AbortSignal) =>
    tool.execute("call-1", args, signal, undefined, ctx);
  return {
    auditor,
    events,
    ctx,
    definition,
    invoke,
    setSession: (id: string) => {
      session = id;
    },
  };
}

describe("tool audit metadata", () => {
  it("records normalized targets without content, diffs or offsets", () => {
    for (const name of ["write", "edit", "read"]) {
      expect(
        toolAuditMetadata(
          name,
          { path: "dir/../target", content: "secret", oldText: "old", newText: "new", offset: 10 },
          "/workspace",
          "/home/user",
        ),
      ).toEqual({ path: "/workspace/target" });
    }
    expect(toolAuditMetadata("read", { path: "~/secret" }, "/workspace", "/home/user")).toEqual({
      path: "/home/user/secret",
    });
  });
  it("records search roots without search expressions", () => {
    for (const name of ["ls", "grep", "find"]) {
      expect(toolAuditMetadata(name, { pattern: "secret" }, "/workspace", "/home/user")).toEqual({
        path: "/workspace",
      });
    }
    expect(toolAuditMetadata("unknown", { content: "secret" }, "/workspace", "/home/user")).toEqual(
      {},
    );
  });
  it("bounds JSON encoded command bytes and never splits Unicode characters", () => {
    const metadata = toolAuditMetadata(
      "bash",
      { command: "😀".repeat(1025) },
      "/workspace",
      "/home/user",
    );
    expect(metadata).toEqual({ command: "😀".repeat(1024), command_truncated: true });
    const escaped = toolAuditMetadata(
      "bash",
      { command: "\n".repeat(2049) },
      "/workspace",
      "/home/user",
    );
    expect(escaped).toEqual({ command: "\n".repeat(2048), command_truncated: true });
    expect(Buffer.byteLength(JSON.stringify(escaped.command)) - 2).toBe(4096);
    expect(toolAuditMetadata("bash", { command: "pwd" }, "/workspace", "/home/user")).toEqual({
      command: "pwd",
      command_truncated: false,
    });
  });
});

describe("ToolAuditor", () => {
  it.each(["\0", "\ud800", "x".repeat(5000)])(
    "keeps logging usable after invalid path metadata",
    async (path) => {
      const f = fixture();
      const tool = f.definition(() => Promise.reject(new Error("invalid tool argument")));
      await expect(f.invoke(tool, { path })).rejects.toThrow("invalid tool argument");
      expect(f.events.find((e) => e.event === "tool_requested")).not.toHaveProperty("path");
      await f.invoke(
        f.definition(() => Promise.resolve(success)),
        { path: "valid" },
      );
      expect(f.events.at(-1)).toMatchObject({ outcome: "success", path: "/workspace/valid" });
    },
  );

  it.each(["\0", "\ud800"])(
    "captures a valid command prefix before invalid Unicode or NUL",
    async (invalid) => {
      const f = fixture();
      await f.invoke(
        f.definition(() => Promise.resolve(success), "bash"),
        { command: `pwd${invalid}tail` },
      );
      expect(f.events.at(-1)).toMatchObject({ command: "pwd", command_truncated: true });
      await f.invoke(
        f.definition(() => Promise.resolve(success), "bash"),
        { command: "pwd" },
      );
      expect(f.events.at(-1)).toMatchObject({ command: "pwd", command_truncated: false });
    },
  );

  it("emits only one start for concurrent callers and tracks Pi session transitions", async () => {
    const f = fixture();
    await Promise.all([f.auditor.start(f.ctx), f.auditor.start(f.ctx)]);
    f.setSession("pi-2");
    await f.auditor.start(f.ctx);
    await f.auditor.end();
    expect(f.events).toEqual([
      { event: "session_started", pi_session_id: "pi-1", cwd: "/workspace" },
      { event: "session_ended", pi_session_id: "pi-1" },
      { event: "session_started", pi_session_id: "pi-2", cwd: "/workspace" },
      { event: "session_ended", pi_session_id: "pi-2" },
    ]);
  });

  it.each(["policy", "prompt", "session_grant"] as const)(
    "records %s approval before executing",
    async (source) => {
      const f = fixture();
      const tool = f.definition(async () => {
        await f.auditor.decision({ allowed: true, source, reason: "user_allowed" });
        expect(f.events.at(-1)?.event).toBe("tool_execution_intent");
        return success;
      });
      await f.invoke(tool, { path: "target", content: "secret" });
      expect(f.events.map((event) => event.event)).toEqual([
        "session_started",
        "tool_requested",
        "tool_execution_intent",
        "tool_completed",
      ]);
      expect(f.events.at(-1)).toMatchObject({
        approval_source: source,
        outcome: "success",
        path: "/workspace/target",
        invocation_id: "call-1",
      });
      expect(typeof f.events.at(-1)?.duration_ms).toBe("number");
      expect(JSON.stringify(f.events)).not.toContain("secret");
    },
  );

  it("records denials without an execution or completion event", async () => {
    const f = fixture();
    const tool = f.definition(async () => {
      await f.auditor.decision({ allowed: false, source: "prompt", reason: "user_denied" });
      throw new Error("denied");
    });
    await expect(f.invoke(tool)).rejects.toThrow("denied");
    expect(f.events.map((event) => event.event)).toEqual([
      "session_started",
      "tool_requested",
      "tool_denied",
    ]);
    expect(f.events.at(-1)).toMatchObject({ approval_source: "prompt", reason: "user_denied" });
  });

  it("snapshots arguments before waiting for the first acknowledgment", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture((event) => (event.event === "session_started" ? pending : Promise.resolve()));
    const execute = vi.fn<ToolDefinition["execute"]>(() => Promise.resolve(success));
    const args = { path: "original", content: "original content" };
    const result = f.invoke(f.definition(execute), args);
    args.path = "changed";
    args.content = "changed content";
    release();
    await result;
    expect(execute.mock.calls[0]?.[1]).toEqual({ path: "original", content: "original content" });
    expect(f.events.at(-1)?.path).toBe("/workspace/original");
  });

  it("never retries effects after completion submission fails and blocks subsequent execution", async () => {
    const f = fixture((event) =>
      event.event === "tool_completed" ? Promise.reject(new Error("offline")) : Promise.resolve(),
    );
    const execute = vi.fn<ToolDefinition["execute"]>(() => Promise.resolve(success));
    const tool = f.definition(execute);
    await expect(f.invoke(tool)).rejects.toThrow("logging is unavailable");
    await expect(f.invoke(tool)).rejects.toThrow("logging is unavailable");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.events.filter((event) => event.event === "tool_completed")).toHaveLength(1);
  });

  it("blocks execution when request submission fails", async () => {
    const f = fixture((event) =>
      event.event === "tool_requested" ? Promise.reject(new Error("offline")) : Promise.resolve(),
    );
    const execute = vi.fn<ToolDefinition["execute"]>(() => Promise.resolve(success));
    await expect(f.invoke(f.definition(execute))).rejects.toThrow("logging is unavailable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("records isError results as errors", async () => {
    const f = fixture();
    await f.invoke(f.definition(() => Promise.resolve({ ...success, isError: true })));
    expect(f.events.at(-1)?.outcome).toBe("error");
  });

  it("recognizes typed timeout causes without logging error payloads", async () => {
    const f = fixture();
    const error = new Error("secret payload", {
      cause: new SandboxExecutionError("sandbox_timeout"),
    });
    await expect(f.invoke(f.definition(() => Promise.reject(error)))).rejects.toBe(error);
    expect(f.events.at(-1)?.outcome).toBe("timeout");
    expect(JSON.stringify(f.events)).not.toContain("secret payload");
  });

  it("recognizes cancellation", async () => {
    const f = fixture();
    await expect(
      f.invoke(
        f.definition(() => Promise.reject(new Error("cancelled"))),
        {},
        AbortSignal.abort(),
      ),
    ).rejects.toThrow("cancelled");
    expect(f.events.at(-1)?.outcome).toBe("cancelled");
  });
});
