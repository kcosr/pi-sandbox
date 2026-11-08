import type {
  AgentSession,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseSubagentConfig } from "./config.js";
import { createSubagentsExtension } from "./factory.js";
import type { SubagentController } from "./contracts.js";

describe("subagent tool argument boundaries", () => {
  it.each([
    ["spawn_agent", {}],
    ["spawn_agent", { task: "task", extended: "true" }],
    ["spawn_agent", { task: "task", extended: null }],
    ["spawn_agent", { task: "task", extra: "ignored" }],
    ["steer_agent", { id: "child" }],
    ["resume_agent", { id: "child", message: 1 }],
    ["cancel_agent", { id: "a".repeat(129) }],
    ["inspect_agent", { id: "" }],
    ["inspect_agent", { id: "child", view: "transcript" }],
    ["inspect_agent", { id: "child", view: "result", cursor: 1 }],
    ["inspect_agent", { id: "child", view: "result", cursor: "" }],
    ["inspect_agent", { id: "child", view: "result", cursor: "x".repeat(161) }],
  ])("rejects invalid direct %s arguments before creating a controller", async (name, input) => {
    const tools = new Map<string, ToolDefinition>();
    const createSession = vi.fn(() => Promise.reject(new Error("must not create a child")));
    const pi = {
      on: () => () => undefined,
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI;
    await createSubagentsExtension({
      host: { config: parseSubagentConfig({}), createSession },
      presentation: false,
    })(pi);
    const result = await tools
      .get(name)!
      .execute("direct", input, undefined, undefined, {} as ExtensionToolContext);
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Invalid subagent tool arguments" }],
    });
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("cancellation delivery", () => {
  it.each(["user", "tool", "user-then-parent-abort"] as const)(
    "delivers only settled user intent, once: %s",
    async (source) => {
      const directory = mkdtempSync(join(tmpdir(), "subagent-cancel-delivery-"));
      type Handler = (event: unknown, context: ExtensionContext) => unknown;
      const handlers = new Map<string, Set<Handler>>();
      const entries: unknown[] = [];
      const tools = new Map<string, ToolDefinition>();
      const parentAbort = new AbortController();
      let finish!: () => void;
      const work = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let controller!: SubagentController;
      const context = {
        cwd: directory,
        model: { id: "fixture", provider: "fixture" },
        signal: parentAbort.signal,
        isIdle: () => false,
        sessionManager: { getSessionId: () => "parent", getEntries: () => entries },
        ui: { notify: vi.fn() },
      } as unknown as ExtensionToolContext;
      const pi = {
        on(name: string, handler: Handler) {
          const list = handlers.get(name) ?? new Set<Handler>();
          handlers.set(name, list);
          list.add(handler);
          return () => list.delete(handler);
        },
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
        getThinkingLevel: () => "off",
        appendEntry: (customType: string, data: unknown) =>
          entries.push({ type: "custom", customType, data }),
      } as unknown as ExtensionAPI;
      const fire = async (name: string, event: unknown = {}) => {
        let result: BoundaryResult | undefined;
        for (const handler of [...(handlers.get(name) ?? [])])
          result = (await handler(event, context)) as BoundaryResult | undefined;
        return result?.entries ?? [];
      };
      const boundary = () => fire("agent_before_settle", { outcome: "completed", entries: [] });
      try {
        await createSubagentsExtension({
          presentation: false,
          host: {
            config: parseSubagentConfig({ cancelTimeoutMs: 1 }, directory),
            createSession: () =>
              Promise.resolve({
                subscribe: () => () => undefined,
                prompt: () => work,
                abort: () => Promise.resolve(),
                dispose: () => undefined,
              } as unknown as AgentSession),
          },
          onController: (value) => {
            controller = value;
          },
        })(pi);
        await fire("session_start");
        const item = await controller.spawn("bounded task", false, context);
        if (source === "tool") {
          const response = await tools
            .get("cancel_agent")!
            .execute("cancel", { id: item.id }, undefined, undefined, context);
          expect(response.isError).not.toBe(true);
        } else await controller.cancelByUser(item.id, item.taskId);
        expect(controller.snapshot()[0]?.status).toBe("stopping");
        expect(await boundary()).toEqual([]);
        if (source === "user-then-parent-abort") parentAbort.abort();
        finish();
        await vi.waitFor(() => expect(controller.statistics().active).toBe(0));
        const delivered = await boundary();
        if (source === "user") {
          expect(delivered).toHaveLength(1);
          const message = delivered[0];
          if (message?.type !== "custom_message") throw new Error("Expected a result message");
          expect(message).toMatchObject({
            customType: "pi-subagents:result",
            details: { taskId: item.taskId, agentId: item.id },
          });
          expect(message.content).toContain(
            `Subagent cancelled by user: ${item.id} / ${item.taskId}\nOutcome: cancelled`,
          );
          expect(message.content).toContain("Do not automatically restart or replace this task.");
          entries.push(...delivered);
          expect(await boundary()).toEqual([]);
          expect(controller.snapshot()[0]?.callback).toBe("acknowledged");
          await controller.cancelByUser(item.id, item.taskId);
          expect(await boundary()).toEqual([]);
        } else {
          expect(delivered).toEqual([]);
          expect(controller.snapshot()[0]?.callback).toBe("disarmed");
        }
      } finally {
        finish();
        await fire("session_shutdown");
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
