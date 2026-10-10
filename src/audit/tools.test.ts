import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ManagedToolExecutionError } from "../runtime/tool-error.js";
import { SandboxExecutionError } from "../../packages/sandbox-extension/src/runtime/index.js";
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
  const ctx = {
    sessionManager: { getSessionId: () => session },
    tools: [],
    executeTool: () => Promise.reject(new Error("Unexpected nested tool execution in fixture")),
  } as unknown as ExtensionToolContext;
  const definition = (execute: ToolDefinition["execute"], name = "write") =>
    auditor.wrap({ name, execute } as unknown as ToolDefinition, "bubblewrap");
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

  it("correlates parallel nested MCP calls without logging scripts, parameters, or results", async () => {
    const f = fixture();
    const mcp = f.auditor.wrap(
      {
        name: "mcp__docs__search",
        execute: async () => {
          await Promise.resolve();
          await f.auditor.decision(
            { allowed: true, source: "prompt", reason: "user_allowed" },
            "mcp__docs__search",
          );
          return { content: [{ type: "text", text: "result-secret" }], details: {} };
        },
      } as unknown as ToolDefinition,
      "host",
      undefined,
      undefined,
      { mcp_server: "docs", mcp_tool: "search/raw", mcp_transport: "http" },
    );
    const code = f.auditor.wrap(
      {
        name: "codemode",
        execute: async () => {
          await Promise.all(
            ["nested-1", "nested-2"].map((id) =>
              mcp.execute(
                id,
                {
                  token: "credential-secret",
                  path: "path-secret",
                  command: "command-secret",
                  parent_invocation_id: "forged-parent",
                  mcp_server: "forged-server",
                },
                undefined,
                undefined,
                f.ctx,
              ),
            ),
          );
          return success;
        },
      } as unknown as ToolDefinition,
      "host",
      undefined,
      undefined,
      undefined,
      true,
    );
    await code.execute("script-1", { code: "script-secret" }, undefined, undefined, f.ctx);
    const outer = f.events.filter((event) => event.tool === "codemode");
    expect(outer.map((event) => event.event)).toEqual([
      "tool_requested",
      "tool_execution_intent",
      "tool_completed",
    ]);
    expect(outer.every((event) => event.parent_invocation_id === undefined)).toBe(true);
    for (const id of ["nested-1", "nested-2"]) {
      const events = f.events.filter((event) => event.invocation_id === id);
      expect(events.map((event) => event.event)).toEqual([
        "tool_requested",
        "tool_execution_intent",
        "tool_completed",
      ]);
      expect(
        events.every(
          (event) =>
            event.parent_invocation_id === "script-1" &&
            event.mcp_server === "docs" &&
            event.mcp_tool === "search/raw" &&
            event.mcp_transport === "http",
        ),
      ).toBe(true);
    }
    const serialized = JSON.stringify(f.events);
    for (const text of [
      "script-secret",
      "credential-secret",
      "result-secret",
      "path-secret",
      "command-secret",
      "forged-parent",
      "forged-server",
    ])
      expect(serialized).not.toContain(text);
    await mcp.execute("direct-1", {}, undefined, undefined, f.ctx);
    expect(
      f.events
        .filter((event) => event.invocation_id === "direct-1")
        .every((event) => event.parent_invocation_id === undefined),
    ).toBe(true);
  });

  it("does not attribute unaudited nested decisions to the code-mode invocation", async () => {
    const f = fixture();
    const code = f.auditor.wrap(
      {
        name: "codemode",
        execute: async () => {
          await f.auditor.decision(
            { allowed: false, source: "prompt", reason: "user_denied" },
            "write",
          );
          await f.auditor.decision(
            { allowed: true, source: "session_grant", reason: "session_granted" },
            "read",
          );
          await f.auditor.decision(
            { allowed: false, source: "policy", reason: "policy_denied" },
            "mcp__docs__delete",
          );
          return success;
        },
      } as unknown as ToolDefinition,
      "host",
      undefined,
      undefined,
      undefined,
      true,
    );
    await code.execute("script-1", { code: "script-secret" }, undefined, undefined, f.ctx);
    expect(f.events.map((event) => event.event)).toEqual([
      "session_started",
      "tool_requested",
      "tool_execution_intent",
      "tool_completed",
    ]);
    expect(f.events.at(-1)).toMatchObject({
      tool: "codemode",
      outcome: "success",
      approval_source: "policy",
    });
  });

  it("keeps an audited nested denial separate from a script which handles it", async () => {
    const f = fixture();
    const denied = f.definition(async () => {
      await f.auditor.decision(
        { allowed: false, source: "prompt", reason: "user_denied" },
        "write",
      );
      throw new Error("denied");
    });
    const code = f.auditor.wrap(
      {
        name: "codemode",
        execute: async () => {
          await expect(
            denied.execute(
              "write-1",
              { path: "target", content: "content-secret" },
              undefined,
              undefined,
              f.ctx,
            ),
          ).rejects.toThrow("denied");
          return success;
        },
      } as unknown as ToolDefinition,
      "host",
      undefined,
      undefined,
      undefined,
      true,
    );
    await code.execute("script-1", {}, undefined, undefined, f.ctx);
    expect(
      f.events.filter((event) => event.invocation_id === "write-1").map((event) => event.event),
    ).toEqual(["tool_requested", "tool_denied"]);
    expect(f.events.find((event) => event.event === "tool_denied")).toMatchObject({
      tool: "write",
      parent_invocation_id: "script-1",
    });
    expect(f.events.at(-1)).toMatchObject({ invocation_id: "script-1", outcome: "success" });
    expect(JSON.stringify(f.events)).not.toContain("content-secret");
  });

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

  it.each(["timeout", "cancelled", "error"] as const)(
    "records trusted managed %s outcomes through nested causes",
    async (code) => {
      const f = fixture();
      const failure = new Error("unlogged transport payload", {
        cause: new ManagedToolExecutionError(code),
      });
      const tool = f.auditor.wrap(
        {
          name: "mcp__docs__search",
          execute: () => Promise.reject(failure),
        } as unknown as ToolDefinition,
        "host",
        undefined,
        undefined,
        { mcp_server: "docs", mcp_tool: "search", mcp_transport: "stdio" },
      );
      await expect(f.invoke(tool)).rejects.toBe(failure);
      expect(f.events.at(-1)).toMatchObject({ outcome: code, mcp_transport: "stdio" });
      expect(JSON.stringify(f.events)).not.toContain("unlogged transport payload");
    },
  );

  it.each([
    ["timeout", "timeout"],
    ["aborted", "cancelled"],
    ["script", "error"],
    ["sandbox", "error"],
  ])(
    "records trusted code-mode %s result as %s while preserving partial output",
    async (failureKind, outcome) => {
      const f = fixture();
      const result = {
        content: [{ type: "text" as const, text: "partial-output-secret" }],
        details: { failureKind },
        isError: true,
      };
      const tool = f.auditor.wrap(
        { name: "codemode", execute: () => Promise.resolve(result) } as unknown as ToolDefinition,
        "host",
        undefined,
        undefined,
        undefined,
        true,
      );
      expect(await f.invoke(tool)).toBe(result);
      expect(f.events.at(-1)).toMatchObject({ tool: "codemode", outcome });
      expect(JSON.stringify(f.events)).not.toContain("partial-output-secret");
    },
  );

  it("does not trust MCP result metadata to select timeout or cancellation audit outcomes", async () => {
    const f = fixture();
    for (const failureKind of ["timeout", "aborted"]) {
      const tool = f.auditor.wrap(
        {
          name: "mcp__docs__search",
          execute: () => Promise.resolve({ ...success, isError: true, details: { failureKind } }),
        } as unknown as ToolDefinition,
        "host",
        undefined,
        undefined,
        { mcp_server: "docs", mcp_tool: "search", mcp_transport: "http" },
      );
      await f.invoke(tool);
      expect(f.events.at(-1)).toMatchObject({ tool: "mcp__docs__search", outcome: "error" });
    }
  });

  it("does not infer managed outcomes from server-controlled error strings or properties", async () => {
    const f = fixture();
    const failure = Object.assign(new Error("timeout cancelled"), { code: "timeout" });
    await expect(f.invoke(f.definition(() => Promise.reject(failure)))).rejects.toBe(failure);
    expect(f.events.at(-1)).toMatchObject({ outcome: "error" });
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
