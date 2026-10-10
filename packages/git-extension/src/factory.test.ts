import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createGitExtension } from "./factory.js";

describe("programmatic Git extension", () => {
  it("requires an explicit runtime and never registers lifecycle ownership or tool activation", async () => {
    expect(() => createGitExtension({} as never)).toThrow("runtime provider");
    const tools: ToolDefinition[] = [];
    const on = vi.fn(),
      setActiveTools = vi.fn();
    await createGitExtension({
      getRuntime() {
        throw new Error("not ready");
      },
    })({
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      on,
      setActiveTools,
    } as unknown as ExtensionAPI);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "git_clone", executionMode: "sequential" });
    expect(on).not.toHaveBeenCalled();
    expect(setActiveTools).not.toHaveBeenCalled();
    await expect(
      tools[0]!.execute(
        "id",
        { repository: "https://github.com/a/b.git" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("not ready");
  });
});
