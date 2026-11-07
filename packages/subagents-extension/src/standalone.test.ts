import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Controller } from "./controller.js";
import { parseSubagentConfig } from "./config.js";
import { createStandaloneHost } from "./standalone.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const definition = {
  id: "fixture-model",
  name: "Fixture",
  reasoning: true,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 2048,
};

async function fixture(
  respond: (context: TranscriptContext, count: number) => AssistantMessage["content"],
  prepare?: (
    directory: string,
    agentDir: string,
  ) => { paths?: string[]; factories?: InlineExtension[] },
) {
  const directory = mkdtempSync(join(tmpdir(), "subagent-sdk-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, "work");
  const agentDir = join(directory, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  writeFileSync(join(cwd, "AGENTS.md"), "Repository rule: SDK_CONTEXT_EVIDENCE.\n");
  writeFileSync(join(cwd, "evidence.txt"), "SDK_FILE_EVIDENCE\n");
  const configured = prepare?.(directory, agentDir);
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(agentDir, "auth.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const requests: TranscriptContext[] = [];
  runtime.registerProvider("fixture", {
    api: "openai-completions",
    baseUrl: "http://localhost.invalid",
    apiKey: "test-only",
    models: [definition],
    streamSimple: (model, context, options) => {
      expect(options?.apiKey).toBe("test-only");
      requests.push(context);
      const stream = createAssistantMessageEventStream();
      const content = respond(context, requests.length);
      const hasTool = content.some((block) => block.type === "toolCall");
      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: hasTool ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: hasTool ? "toolUse" : "stop", message });
      });
      return stream;
    },
  });
  let api!: ExtensionAPI;
  let context!: ExtensionContext;
  const settings = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const resources = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    additionalExtensionPaths: configured?.paths ?? [],
    extensionFactories: [
      ...(configured?.factories ?? []),
      (pi) => {
        api = pi;
        pi.on("session_start", (_event, ctx) => {
          context = ctx;
        });
      },
    ],
  });
  await resources.reload();
  expect(resources.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: runtime.getModel("fixture", "fixture-model")!,
    thinkingLevel: "medium",
    settingsManager: settings,
    resourceLoader: resources,
    sessionManager: SessionManager.inMemory(cwd),
  });
  await session.bindExtensions({ mode: "rpc" });
  cleanup.push(async () => {
    await session.abort();
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  const host = createStandaloneHost(
    parseSubagentConfig({ startupTimeoutMs: 5000 }, join(directory, "children")),
  );
  const controller = new Controller(api, host, context.sessionManager.getSessionId());
  cleanup.push(() => controller.shutdown());
  return { directory, cwd, api, context, controller, requests, session, host };
}

describe("ordinary Pi SDK children", () => {
  it("honors cancellation during prompt preflight before the SDK has an active run", async () => {
    const f = await fixture(() => [{ type: "text", text: "must not request the provider" }]);
    let release!: () => void;
    let enter!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const create = f.host.createSession.bind(f.host);
    f.host.createSession = async (request) => {
      const child = await create(request);
      const prompt = child.prompt.bind(child);
      child.prompt = async (...args) => {
        enter();
        await released;
        return prompt(...args);
      };
      return child;
    };
    const child = await f.controller.spawn("cancel before startup", false, f.context);
    await entered;
    const cancelled = f.controller.cancel(child.id);
    release();
    expect((await cancelled).status).toBe("cancelled");
    expect(f.requests).toEqual([]);
    expect(f.controller.statistics()).toMatchObject({ active: 0, total: 1 });
  });

  it("uses function-backed parent authentication in memory, reads repository context, and resumes its transcript", async () => {
    const f = await fixture((context, count) => {
      if (count === 1) {
        expect(JSON.stringify(context)).toContain("SDK_CONTEXT_EVIDENCE");
        return [
          {
            type: "toolCall",
            id: "read-evidence",
            name: "read",
            arguments: { path: "evidence.txt" },
          },
        ];
      }
      expect(JSON.stringify(context)).toContain("SDK_FILE_EVIDENCE");
      return [{ type: "text", text: "SDK_CHILD_DONE" }];
    });
    const initial = await f.controller.spawn("Read evidence.txt", false, f.context);
    await vi.waitFor(() => expect(f.controller.snapshot()[0]!.status).toBe("completed"));
    expect(f.controller.snapshot()[0]!.result).toBe("SDK_CHILD_DONE");
    expect(readFileSync(initial.sessionFile, "utf8")).toContain("SDK_FILE_EVIDENCE");
    const resumed = await f.controller.resume(
      initial.id,
      "Continue from your prior result",
      false,
      f.context,
    );
    expect(resumed.taskId).not.toBe(initial.taskId);
    await vi.waitFor(() => expect(f.controller.snapshot()[0]!.status).toBe("completed"));
    expect(JSON.stringify(f.requests.at(-1))).toContain("SDK_CHILD_DONE");
    expect(f.requests).toHaveLength(3);
  });

  it("recreates selected file-backed and MCP tools without copying credential state", async () => {
    let filePath = "";
    const f = await fixture(
      (_context, count) => {
        if (count === 1)
          return [{ type: "toolCall", id: "file-fixture", name: "file_fixture", arguments: {} }];
        if (count === 2)
          return [
            { type: "toolCall", id: "mcp-fixture", name: "mcp__fixture__ping", arguments: {} },
          ];
        return [{ type: "text", text: "EXTENDED_DONE" }];
      },
      (directory, agentDir) => {
        filePath = join(directory, "tools.mjs");
        writeFileSync(
          filePath,
          `export default function(pi) { pi.registerTool({ name: 'file_fixture', label: 'File fixture', description: 'File-backed test tool', parameters: {type:'object',properties:{},additionalProperties:false}, execute: async () => ({content:[{type:'text',text:'FILE_TOOL_RESULT'}],details:{}}) }); }`,
        );
        const mcpPath = join(directory, "mcp.mjs");
        writeFileSync(
          mcpPath,
          `import {createInterface} from 'node:readline'; createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(r.method==='tools/list')result={tools:[{name:'ping',description:'Fixture ping',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};if(r.method==='tools/call')result={content:[{type:'text',text:'MCP_TOOL_RESULT'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`,
        );
        const config = { command: process.execPath, args: [mcpPath], exposure: "direct" as const };
        writeFileSync(
          join(agentDir, "mcp.json"),
          JSON.stringify({ mcpServers: { fixture: config } }),
        );
        return {
          paths: [filePath],
          factories: [
            createMcpExtension({
              loadConfig: () => ({
                servers: [
                  { name: "fixture", config, source: join(agentDir, "mcp.json"), scope: "global" },
                ],
                errors: [],
                autoEnableCodemode: false,
              }),
            }),
          ],
        };
      },
    );
    await vi.waitFor(() =>
      expect(f.api.getAllTools().some((tool) => tool.name === "mcp__fixture__ping")).toBe(true),
    );
    const started = await f.controller.spawn("Use file_fixture and MCP ping", true, f.context);
    await vi.waitFor(() => expect(f.controller.snapshot()[0]!.status).toBe("completed"), {
      timeout: 8000,
    });
    const transcript = readFileSync(started.sessionFile, "utf8");
    expect(transcript).toContain("FILE_TOOL_RESULT");
    expect(transcript).toContain("MCP_TOOL_RESULT");
    expect(f.controller.snapshot()[0]!.result).toBe("EXTENDED_DONE");
  }, 15000);

  it("loads native Code Mode through its built-in path and invokes a child-local file tool", async () => {
    const f = await fixture(
      (_context, count) =>
        count === 1
          ? [
              {
                type: "toolCall",
                id: "code-call",
                name: "codemode",
                arguments: { code: 'text(await tools.read({path:"evidence.txt"}));' },
              },
            ]
          : [{ type: "text", text: "CODEMODE_DONE" }],
      () => ({
        paths: ["builtin:codemode"],
        factories: [{ name: "codemode", builtin: true, factory: createCodemodeExtension() }],
      }),
    );
    f.api.setActiveTools([...f.api.getActiveTools(), "codemode"]);
    const child = await f.controller.spawn("Read the evidence using Code Mode", true, f.context);
    await vi.waitFor(() => expect(f.controller.snapshot()[0]!.status).toBe("completed"), {
      timeout: 8000,
    });
    expect(readFileSync(child.sessionFile, "utf8")).toContain("SDK_FILE_EVIDENCE");
    expect(f.controller.snapshot()[0]!.result).toBe("CODEMODE_DONE");
  }, 15000);

  it("uses the parent's live provider credential for HTTP MCP authentication", async () => {
    const credentials: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST") {
          response.writeHead(405);
          response.end();
          return;
        }
        credentials.push(request.headers.authorization);
        if (request.headers.authorization !== "Bearer test-only") {
          response.writeHead(401);
          response.end();
          return;
        }
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const rpc = JSON.parse(body) as {
          id?: number;
          method: string;
          params?: { protocolVersion?: string };
        };
        if (rpc.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        let result: unknown = {};
        if (rpc.method === "initialize")
          result = {
            protocolVersion: rpc.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "auth-fixture", version: "1" },
          };
        if (rpc.method === "tools/list")
          result = {
            tools: [
              {
                name: "ping",
                description: "Authenticated ping",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          };
        if (rpc.method === "tools/call")
          result = { content: [{ type: "text", text: "AUTHENTICATED_MCP_RESULT" }] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      })().catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture server address");
    const config = {
      url: `http://127.0.0.1:${address.port}/mcp`,
      auth: { provider: "fixture" },
      exposure: "direct" as const,
    };
    const f = await fixture(
      (_context, count) =>
        count === 1
          ? [
              {
                type: "toolCall",
                id: "authenticated",
                name: "mcp__authenticated__ping",
                arguments: {},
              },
            ]
          : [{ type: "text", text: "AUTH_DONE" }],
      (_directory, agentDir) => {
        const source = join(agentDir, "mcp.json");
        writeFileSync(source, JSON.stringify({ mcpServers: { authenticated: config } }));
        return {
          factories: [
            createMcpExtension({
              loadConfig: () => ({
                servers: [{ name: "authenticated", config, source, scope: "global" }],
                errors: [],
                autoEnableCodemode: false,
              }),
            }),
          ],
        };
      },
    );
    await vi.waitFor(() =>
      expect(f.api.getAllTools().some((tool) => tool.name === "mcp__authenticated__ping")).toBe(
        true,
      ),
    );
    const child = await f.controller.spawn("Call authenticated ping", true, f.context);
    await vi.waitFor(() => expect(f.controller.snapshot()[0]!.status).toBe("completed"), {
      timeout: 8000,
    });
    expect(readFileSync(child.sessionFile, "utf8")).toContain("AUTHENTICATED_MCP_RESULT");
    expect(credentials.length).toBeGreaterThan(4);
    expect(credentials.every((value) => value === "Bearer test-only")).toBe(true);
  }, 15000);

  it("rejects unreproducible runtime-only tools before any child model request", async () => {
    const f = await fixture(
      () => [{ type: "text", text: "UNREACHABLE" }],
      () => ({
        factories: [
          (pi) => {
            pi.registerTool({
              name: "runtime_only",
              label: "Runtime only",
              description: "Runtime only",
              parameters: { type: "object", properties: {} },
              execute: () => Promise.resolve({ content: [], details: {} }),
            });
          },
        ],
      }),
    );
    await expect(f.controller.spawn("runtime tool", true, f.context)).rejects.toThrow(
      "runtime-only",
    );
    expect(f.requests).toHaveLength(0);
    expect(f.controller.statistics().total).toBe(1);
  });
});
