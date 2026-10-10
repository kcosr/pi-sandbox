import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  gitCloneExtension,
  parseGitCloneConfig,
} from "../../src/managed-extensions/git-clone/index.js";

const model = {
  id: "fixture",
  name: "Offline fixture",
  api: "openai-completions" as const,
  provider: "fixture",
  baseUrl: "http://unused.invalid",
  reasoning: false,
  input: ["text" as const],
  contextWindow: 32768,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const textResult = { content: [{ type: "text" as const, text: "ok" }], details: undefined };

describe("Pi scheduling of the managed Git tool", () => {
  it.each([false, true])("preserves clone sequencing with nested=%s", async (nested) => {
    const cwd = await mkdtemp("/var/tmp/pi-tool-scheduling-");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    const started: string[] = [];
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const definition = gitCloneExtension.tools[0]!;
    const gitTool: ToolDefinition = {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
      execute: (_id, args, signal) => {
        if (
          typeof args !== "object" ||
          args === null ||
          !("repository" in args) ||
          typeof args.repository !== "string"
        )
          throw new Error("Invalid Git fixture arguments");
        return definition.execute(
          { repository: args.repository },
          {
            cwd,
            config: parseGitCloneConfig(
              { allowed_hosts: ["example.invalid"], allowed_schemes: ["https"] },
              "git",
            ),
            signal: signal ?? new AbortController().signal,
            host: {
              async execute(request) {
                const destination = path.basename(request.argv.at(-1)!);
                started.push(destination);
                if (destination === "first") await blocked;
                return {
                  exitCode: 0,
                  signal: null,
                  stdout: Buffer.alloc(0),
                  stderr: Buffer.alloc(0),
                };
              },
            },
          },
        );
      },
    };
    const probe: ToolDefinition = {
      name: "probe",
      label: "Probe",
      description: "Observe ordinary parallel scheduling",
      parameters: { type: "object", properties: {} },
      execute() {
        started.push("probe");
        return Promise.resolve(textResult);
      },
    };
    const calls = [
      {
        type: "toolCall" as const,
        id: "first",
        name: "git_clone",
        arguments: { repository: "https://example.invalid/first.git" },
      },
      { type: "toolCall" as const, id: "probe", name: "probe", arguments: {} },
      {
        type: "toolCall" as const,
        id: "second",
        name: "git_clone",
        arguments: { repository: "https://example.invalid/second.git" },
      },
    ];
    const wrapper: ToolDefinition = {
      name: "nested",
      label: "Nested",
      description: "Exercise the ctx.executeTool path used by Code Mode",
      parameters: { type: "object", properties: {} },
      async execute(_id, _args, _signal, _onUpdate, ctx) {
        const results = await Promise.all(
          calls.map((call) => ctx.executeTool(call.name, call.arguments)),
        );
        expect(results.every((result) => !result.isError)).toBe(true);
        return textResult;
      },
    };
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      customTools: [gitTool, probe, wrapper],
      tools: ["git_clone", "probe", "nested"],
    });
    let requests = 0;
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const first = requests++ === 0;
      const message: AssistantMessage = {
        role: "assistant",
        content: first
          ? nested
            ? [{ type: "toolCall", id: "parent", name: "nested", arguments: {} }]
            : calls
          : [{ type: "text", text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: first ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      return stream;
    };
    const running = session.agent.prompt("Exercise sequencing without contacting a provider");
    try {
      await vi.waitFor(() => expect(started).toContain("first"));
      // Stock Pi serializes sequential nested tools with each other; unlike its
      // top-level batch scheduler it does not exclude other nested parallel tools.
      if (nested) await vi.waitFor(() => expect(started).toContain("probe"));
      else expect(started).toEqual(["first"]);
      expect(started).not.toContain("second");
      release();
      await running;
      expect(started).toContain("probe");
      expect(started.indexOf("second")).toBeGreaterThan(started.indexOf("first"));
      expect(requests).toBe(2);
      expect(
        session.agent.state.messages
          .filter((message) => message.role === "toolResult")
          .every((message) => !message.isError),
      ).toBe(true);
    } finally {
      release();
      await running;
      session.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
