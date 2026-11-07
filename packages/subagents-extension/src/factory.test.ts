import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { parseSubagentConfig } from "./config.js";
import { createSubagentsExtension } from "./factory.js";

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
