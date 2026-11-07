import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SubagentController, SubagentSnapshot } from "./contracts.js";
import {
  attachSubagentPresentation,
  closeSubagentPreview,
  displayText,
  parseObservationRequest,
  SUBAGENT_RESPONSE_ENTRY,
  SUBAGENT_STATE_ENTRY,
} from "./presentation.js";

function fixture() {
  let agents: readonly SubagentSnapshot[] = [
    {
      id: "a-one",
      taskId: "task-one",
      parentSessionId: "parent",
      task: "Inspect auth",
      extended: false,
      status: "running",
      activity: "running tools",
      tools: ["read"],
      startedAt: 1,
      updatedAt: 2,
      assistant: "Reading files",
      thinking: "private preview",
      assistantTruncated: false,
      thinkingTruncated: false,
      callback: "armed",
      sessionFile: "/private/session.jsonl",
      provider: "fixture",
      model: "fixture",
      reasoning: "off",
    },
  ];
  let listener: ((agents: readonly SubagentSnapshot[]) => void) | undefined;
  const cancel = vi.fn((id: string, taskId?: string) => {
    expect(id).toBe("a-one");
    expect(taskId).toBe("task-one");
    return Promise.resolve(agents[0]!);
  });
  const controller = {
    parentSessionId: "parent",
    snapshot: () => agents,
    statistics: () => ({ enabled: true, active: 1, total: 1, maxConcurrent: 4, maxTotal: 32 }),
    subscribe(callback: typeof listener) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    cancel,
  } as unknown as SubagentController;
  const entries: { type: string; data: unknown }[] = [];
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const pi = {
    registerCommand(name, value) {
      commands.set(name, value);
    },
    appendEntry(type, data) {
      entries.push({ type, data });
    },
  } satisfies Pick<ExtensionAPI, "registerCommand" | "appendEntry">;
  const context = {
    mode: "rpc",
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  const presentation = attachSubagentPresentation(pi as ExtensionAPI, controller, context);
  return {
    entries,
    commands,
    cancel,
    presentation,
    context,
    controller,
    update(next: Partial<SubagentSnapshot>) {
      agents = [{ ...agents[0]!, ...next }];
      listener?.(agents);
    },
  };
}

describe("subagent observation", () => {
  it("rejects ambiguous control envelopes and unbounded input", () => {
    const request = {
      version: 1,
      requestId: "one",
      action: "cancel",
      id: "a-one",
      taskId: "task-one",
    };
    expect(parseObservationRequest(JSON.stringify(request))).toEqual(request);
    for (const value of [
      { ...request, taskId: undefined },
      { ...request, action: "spawn" },
      { ...request, extra: true },
      { ...request, version: 2 },
      { ...request, id: "bad\nidentity" },
    ])
      expect(() => parseObservationRequest(JSON.stringify(value))).toThrow();
    expect(() => parseObservationRequest(" ".repeat(4097))).toThrow("4096");
  });

  it("does not persist progress ticks or expose private state in snapshots", async () => {
    const f = fixture();
    expect(f.entries.filter((entry) => entry.type === SUBAGENT_STATE_ENTRY)).toHaveLength(1);
    f.update({ assistant: "more tokens", thinking: "more private preview", updatedAt: 3 });
    expect(f.entries).toHaveLength(1);
    await f.commands.get("agents-rpc")!.handler(
      JSON.stringify({
        version: 1,
        requestId: "inspect-one",
        action: "inspect",
        id: "a-one",
        taskId: "task-one",
      }),
      f.context as ExtensionCommandContext,
    );
    const response = f.entries.at(-1)!;
    expect(response.type).toBe(SUBAGENT_RESPONSE_ENTRY);
    expect(response.data).toMatchObject({
      requestId: "inspect-one",
      success: true,
      data: { assistant: "more tokens" },
    });
    expect(JSON.stringify(f.entries)).not.toMatch(/private preview|session\.jsonl/);
    f.presentation.dispose();
  });

  it("rejects stale cancellation generations and correlates malformed commands", async () => {
    const f = fixture();
    const request = {
      version: 1,
      requestId: "cancel-one",
      action: "cancel",
      id: "a-one",
      taskId: "old-task",
    };
    await f.commands
      .get("agents-rpc")!
      .handler(JSON.stringify(request), f.context as ExtensionCommandContext);
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.entries.at(-1)!.data).toMatchObject({ requestId: "cancel-one", success: false });
    await f.commands
      .get("agents-rpc")!
      .handler(JSON.stringify({ ...request, extra: true }), f.context as ExtensionCommandContext);
    expect(f.entries.at(-1)!.data).toMatchObject({ requestId: "cancel-one", success: false });
    await f.commands
      .get("agents-rpc")!
      .handler(
        JSON.stringify({ ...request, taskId: "task-one" }),
        f.context as ExtensionCommandContext,
      );
    expect(f.cancel).toHaveBeenCalledTimes(1);
    f.presentation.dispose();
  });

  it("fences late observations after disposal and separates observer epochs", () => {
    const f = fixture();
    const next = fixture();
    expect(f.entries[0]!.data).not.toEqual(next.entries[0]!.data);
    f.presentation.dispose();
    f.update({ status: "completed" });
    expect(f.entries).toHaveLength(1);
    next.presentation.dispose();
  });

  it("publishes approval waits without persisting ordinary progress ticks", () => {
    const f = fixture();
    f.update({ activity: "awaiting approval" });
    expect(f.entries).toHaveLength(2);
    f.update({ assistant: "still working" });
    expect(f.entries).toHaveLength(2);
    f.update({ activity: "running tools" });
    expect(f.entries).toHaveLength(3);
    f.presentation.dispose();
  });

  it("navigates previews without cancellation and yields focus to an approval", async () => {
    const f = fixture();
    let component:
      | { handleInput(input: string): void; render(width: number): string[]; dispose(): void }
      | undefined;
    let finish: (() => void) | undefined;
    const commandContext = {
      mode: "tui",
      ui: {
        custom(factory: (...args: unknown[]) => typeof component) {
          return new Promise<void>((resolve) => {
            finish = resolve;
            component = factory(
              { terminal: { rows: 30 }, requestRender: vi.fn() },
              { fg: (_name: string, value: string) => value },
              {},
              resolve,
            );
          }).finally(() => component?.dispose());
        },
      },
    } as unknown as ExtensionCommandContext;
    const opened = f.commands.get("agents")!.handler("", commandContext);
    try {
      expect(component!.render(80).join("\n")).toContain("Inspect auth");
      component!.handleInput("\r");
      expect(component!.render(80).join("\n")).toContain("Reading files");
      component!.handleInput("\u001b");
      expect(component!.render(80).join("\n")).toContain("Subagents");
      expect(f.cancel).not.toHaveBeenCalled();
      closeSubagentPreview(f.controller);
      await opened;
      expect(f.cancel).not.toHaveBeenCalled();
    } finally {
      finish?.();
      await opened;
      f.presentation.dispose();
    }
  });

  it("removes terminal control characters without splitting unicode", () => {
    expect(displayText("safe\u001b\u202e\ntext")).toBe("safe  \ntext");
    const text = displayText("😀".repeat(200), 20);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20);
    expect(text).not.toContain("�");
  });
});
