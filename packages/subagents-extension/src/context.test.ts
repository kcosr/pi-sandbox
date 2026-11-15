import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEventBus,
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSubagentContextBus, getSubagentContext, SUBAGENT_CONTEXT_QUERY } from "./context.js";

const identity = { childId: "child-one", parentSessionId: "parent-one", taskId: "task-one" };

describe("subagent session context", () => {
  it("reports no child context on an ordinary parent bus", () => {
    expect(getSubagentContext({ events: createEventBus() })).toBeUndefined();
  });

  it("returns an immutable copy of the host's original identity", () => {
    const authored = { ...identity };
    const events = createSubagentContextBus(authored);
    authored.taskId = "changed-by-caller";
    const context = getSubagentContext({ events })!;
    expect(context).toEqual(identity);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Reflect.set(context, "taskId", "changed-by-consumer")).toBe(false);
    expect(getSubagentContext({ events })).toEqual(identity);
  });

  it("keeps sibling and resumed task generations independent until each bus is cleared", () => {
    const first = createSubagentContextBus(identity);
    const siblingIdentity = { ...identity, childId: "child-two", taskId: "task-two" };
    const sibling = createSubagentContextBus(siblingIdentity);
    const resumedIdentity = { ...identity, taskId: "resumed-task" };
    const resumed = createSubagentContextBus(resumedIdentity);
    for (let index = 0; index < 3; index++) {
      expect(getSubagentContext({ events: sibling })).toEqual(siblingIdentity);
      expect(getSubagentContext({ events: resumed })).toEqual(resumedIdentity);
      expect(getSubagentContext({ events: first })).toEqual(identity);
    }
    first.clear();
    expect(getSubagentContext({ events: first })).toBeUndefined();
    expect(getSubagentContext({ events: sibling })).toEqual(siblingIdentity);
    expect(getSubagentContext({ events: resumed })).toEqual(resumedIdentity);
  });

  it("works across separately imported helper modules", async () => {
    const events = createSubagentContextBus(identity);
    vi.resetModules();
    const independent = await import("./context.js");
    expect(independent.getSubagentContext).not.toBe(getSubagentContext);
    expect(independent.getSubagentContext({ events })).toEqual(identity);
    const otherEvents = independent.createSubagentContextBus(identity);
    expect(getSubagentContext({ events: otherEvents })).toEqual(identity);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { ...identity, taskId: "" },
    { ...identity, childId: 1 },
    { ...identity, extra: true },
  ])("rejects an invalid host response instead of reporting a parent session: %j", (value) => {
    const events = createEventBus();
    events.on(SUBAGENT_CONTEXT_QUERY, (respond) => {
      (respond as (context: unknown) => void)(value);
    });
    expect(() => getSubagentContext({ events })).toThrow("Invalid subagent context");
  });

  it("rejects conflicting responders", () => {
    const events = createSubagentContextBus(identity);
    events.on(SUBAGENT_CONTEXT_QUERY, (respond) => {
      (respond as (context: unknown) => void)({ ...identity, childId: "another-child" });
    });
    expect(() => getSubagentContext({ events })).toThrow("Multiple subagent context responses");
  });

  it("ignores asynchronous responses that cannot answer the synchronous query", async () => {
    const events = createEventBus();
    const replies: Array<(context: unknown) => void> = [];
    events.on(SUBAGENT_CONTEXT_QUERY, (respond) => {
      replies.push(respond as (context: unknown) => void);
    });
    const first = getSubagentContext({ events });
    await Promise.resolve();
    replies[0]!(identity);
    expect(first).toBeUndefined();
    expect(getSubagentContext({ events })).toBeUndefined();
  });

  it("is available to a real Pi extension factory before session binding", async () => {
    const directory = mkdtempSync(join(tmpdir(), "subagent-context-"));
    const events = createSubagentContextBus(identity);
    let api: ExtensionAPI | undefined;
    let factoryContext: ReturnType<typeof getSubagentContext>;
    const resources = new DefaultResourceLoader({
      cwd: directory,
      agentDir: join(directory, "agent"),
      settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "never" }),
      eventBus: events,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          api = pi;
          factoryContext = getSubagentContext(pi);
        },
      ],
    });
    try {
      await resources.reload();
      expect(resources.getExtensions().errors).toEqual([]);
      expect(factoryContext).toEqual(identity);
      expect(getSubagentContext(api!)).toEqual(identity);
      resources.getExtensions().runtime.invalidate();
      expect(() => getSubagentContext(api!)).toThrow();
    } finally {
      events.clear();
      resources.getExtensions().runtime.invalidate();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
