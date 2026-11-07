import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
beforeAll(() => initTheme("dark"));
import type { SubagentController, SubagentSnapshot } from "./contracts.js";
import {
  attachSubagentPresentation,
  closeSubagentPreview,
  displayText,
  parseObservationRequest,
  safeMarkdownLine,
  SUBAGENT_RESPONSE_ENTRY,
  SUBAGENT_STATE_ENTRY,
} from "./presentation.js";

function fixture(empty = false) {
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
  const initial = agents[0]!;
  if (empty) agents = [];
  let total = agents.length;
  let listener: ((agents: readonly SubagentSnapshot[]) => void) | undefined;
  const cancel = vi.fn((id: string, taskId?: string) => {
    expect(id).toBe("a-one");
    expect(taskId).toBe("task-one");
    return Promise.resolve(agents[0]!);
  });
  const controller = {
    parentSessionId: "parent",
    snapshot: () => agents,
    statistics: () => ({
      enabled: true,
      active: agents.filter((agent) => ["starting", "running", "stopping"].includes(agent.status))
        .length,
      total,
      maxConcurrent: 4,
      maxTotal: 32,
    }),
    subscribe(callback: typeof listener) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    cancel: () => Promise.reject(new Error("User controls must not use model cancellation")),
    cancelByUser: cancel,
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
  const setStatus = vi.fn();
  const context = {
    mode: "rpc",
    ui: { setStatus, notify: vi.fn() },
  } as unknown as ExtensionContext;
  const presentation = attachSubagentPresentation(pi as ExtensionAPI, controller, context);
  return {
    entries,
    commands,
    cancel,
    presentation,
    context,
    setStatus,
    controller,
    update(next: Partial<SubagentSnapshot>) {
      agents = [{ ...(agents[0] ?? initial), ...next }];
      total = 1;
      listener?.(agents);
    },
  };
}

describe("subagent observation", () => {
  it("shows machine-command input errors in the TUI while retaining structured RPC errors", async () => {
    const f = fixture();
    const notify = vi.fn();
    const command = f.commands.get("subagents-rpc")!;
    await command.handler("", { mode: "tui", ui: { notify } } as never);
    expect(command.description).toContain("JSON required");
    expect(notify).toHaveBeenCalledWith(
      "This command requires a JSON request. Use /subagents for the interactive menu.",
      "error",
    );
    expect(f.entries.some((entry) => entry.type === SUBAGENT_RESPONSE_ENTRY)).toBe(false);
    for (const text of [
      "not JSON",
      JSON.stringify({ version: 1, requestId: "bad", action: "spawn" }),
    ]) {
      notify.mockClear();
      await command.handler(text, { mode: "tui", ui: { notify } } as never);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Use /subagents"), "error");
      expect(f.entries.at(-1)).toMatchObject({
        type: SUBAGENT_RESPONSE_ENTRY,
        data: { success: false },
      });
    }
    notify.mockClear();
    Object.assign(f.context.ui, { notify });
    await command.handler("", f.context as never);
    expect(notify).not.toHaveBeenCalled();
    expect(f.entries.at(-1)).toMatchObject({
      type: SUBAGENT_RESPONSE_ENTRY,
      data: { success: false },
    });
    f.presentation.dispose();
  });

  it("styles interactive status with the current theme and keeps RPC status plain", () => {
    const f = fixture();
    Object.assign(f.context, { mode: "tui", hasUI: true });
    Object.assign(f.context.ui, {
      theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
    });
    f.update({ status: "running", activity: "awaiting approval" });
    const interactive = String(f.setStatus.mock.calls.at(-1)?.[1]);
    expect(interactive).toBe("<dim>Subagents </dim><accent>1/4</accent>");
    f.update({ status: "failed" });
    expect(String(f.setStatus.mock.calls.at(-1)?.[1])).toBe("<dim>Subagents </dim><dim>0/4</dim>");
    Object.assign(f.context, { mode: "rpc" });
    f.update({ status: "completed" });
    expect(f.setStatus).toHaveBeenLastCalledWith("subagents", "Subagents 0/4");
    f.presentation.dispose();
  });

  it("keeps persistent status hidden until the first accepted child and visible after completion", () => {
    const f = fixture(true);
    expect(f.setStatus).not.toHaveBeenCalled();
    f.update({ status: "starting" });
    expect(f.setStatus).toHaveBeenLastCalledWith("subagents", "Subagents 1/4");
    f.update({ status: "completed" });
    expect(f.setStatus).toHaveBeenLastCalledWith("subagents", "Subagents 0/4");
    f.presentation.dispose();
  });

  it("preserves native Markdown styling while removing clickable links and control commands", () => {
    const styled = "\u001b[1mResult\u001b[0m";
    expect(
      safeMarkdownLine(`\u001b]8;;javascript:alert(1)\u001b\\${styled}\u001b]8;;\u001b\\`),
    ).toBe(styled);
    expect(safeMarkdownLine("safe\u001b[2Jtext\u0007")).toBe("safetext ");
  });

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
    await f.commands.get("subagents-rpc")!.handler(
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
      .get("subagents-rpc")!
      .handler(JSON.stringify(request), f.context as ExtensionCommandContext);
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.entries.at(-1)!.data).toMatchObject({ requestId: "cancel-one", success: false });
    await f.commands
      .get("subagents-rpc")!
      .handler(JSON.stringify({ ...request, extra: true }), f.context as ExtensionCommandContext);
    expect(f.entries.at(-1)!.data).toMatchObject({ requestId: "cancel-one", success: false });
    await f.commands
      .get("subagents-rpc")!
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
    const terminal = { rows: 30 };
    const commandContext = {
      mode: "tui",
      ui: {
        custom(factory: (...args: unknown[]) => typeof component, options: unknown) {
          expect(options).toMatchObject({ overlay: true });
          return new Promise<void>((resolve) => {
            finish = resolve;
            component = factory(
              { terminal, requestRender: vi.fn() },
              { fg: (_name: string, value: string) => value, bold: (value: string) => value },
              {},
              resolve,
            );
          }).finally(() => component?.dispose());
        },
      },
    } as unknown as ExtensionCommandContext;
    const opened = f.commands.get("subagents")!.handler("", commandContext);
    try {
      expect(component!.render(80).join("\n")).toContain("Inspect auth");
      component!.handleInput("\r");
      expect(component!.render(80).map(stripTerminalSequences).join("\n")).toContain(
        "Reading files",
      );
      f.update({ assistant: "## Findings\n\n**Safe** result.\n\n```ts\nconst answer = 42;\n```" });
      const rendered = component!.render(80).map(stripTerminalSequences).join("\n");
      expect(rendered).toContain("Findings");
      expect(rendered).toContain("Safe result.");
      expect(rendered).toContain("const answer = 42;");
      expect(rendered).not.toContain("## Findings");
      expect(rendered).not.toContain("**Safe**");
      expect(rendered).not.toContain("private preview");
      expect(rendered).not.toContain("session.jsonl");
      expect(component!.render(35).every((line) => visibleWidth(line) <= 35)).toBe(true);
      for (const rows of [1, 3, 5, 6, 7, 8]) {
        terminal.rows = rows;
        for (const width of [10, 80]) {
          const compact = component!.render(width);
          expect(compact.length).toBeLessThanOrEqual(Math.max(1, rows - 2));
          expect(compact.every((line) => visibleWidth(line) <= width)).toBe(true);
          expect(compact.map(stripTerminalSequences).join("\n")).toContain("Esc back");
          if (rows >= 6 && width === 80)
            expect(compact.map(stripTerminalSequences).join("\n")).toContain("Findings");
        }
      }
      terminal.rows = 30;
      f.update({
        assistant: Array.from({ length: 80 }, (_, index) => `line-${index}\n`).join("\n"),
      });
      component!.render(80);
      component!.handleInput("\u001b[F");
      expect(component!.render(80).map(stripTerminalSequences).join("\n")).toContain("line-79");
      f.update({ taskId: "new-generation" });
      component!.handleInput("c");
      expect(f.cancel).not.toHaveBeenCalled();
      expect(component!.render(80).map(stripTerminalSequences).join("\n")).toContain(
        "task changed",
      );
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
