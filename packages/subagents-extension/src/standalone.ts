import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ProjectTrustStore,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type LoadedMcpConfig,
  type McpServerConfig,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  MANAGEMENT_TOOLS,
  type SubagentConfig,
  type SubagentHost,
  type SubagentSessionRequest,
} from "./contracts.js";
import { readBoundedFile } from "./bounds.js";

const BUILTINS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
const MCP_RESOURCES = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);
const isMcp = (name: string) => name.startsWith("mcp__") || MCP_RESOURCES.has(name);
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readBoundedFile(path, 1024 * 1024));
  if (!object(value)) throw new Error("Expected an object in parent configuration");
  return value;
}
function jsonCopy<T>(value: T): T {
  const text = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint")
      throw new Error("Tool configuration contains runtime-only values");
    return entry;
  });
  if (text.length > 4 * 1024 * 1024)
    throw new Error("Tool configuration exceeds the child snapshot limit");
  return JSON.parse(text) as T;
}

function captureMcp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  names: readonly string[],
): LoadedMcpConfig {
  if (!names.some(isMcp)) return { servers: [], errors: [], autoEnableCodemode: false };
  const merged = new Map<string, { config: McpServerConfig; source: string }>();
  for (const entry of pi.getMcpServers())
    merged.set(entry.name, { config: jsonCopy(entry.config), source: entry.extensionPath });
  const globalNames = new Set<string>();
  const agentDir = getAgentDir();
  for (const [path, local] of [
    [join(agentDir, "mcp.json"), false],
    [join(ctx.cwd, ".pi", "mcp.json"), true],
  ] as const) {
    if (local && !ctx.isProjectTrusted()) continue;
    const data = readObject(path);
    if (data.mcpServers !== undefined && !object(data.mcpServers))
      throw new Error("Invalid parent MCP configuration");
    for (const [name, raw] of Object.entries(data.mcpServers ?? {})) {
      if (!object(raw)) throw new Error("Invalid parent MCP server");
      if (local && raw.auth !== undefined)
        throw new Error("Provider authentication is only allowed in global MCP configuration");
      let config = raw;
      if (local && raw.command === undefined && raw.url === undefined && raw.type === undefined) {
        const prior = merged.get(name);
        if (
          !prior ||
          !globalNames.has(name) ||
          Object.keys(raw).some((key) => !["enabled", "exposure", "toolExposure"].includes(key))
        )
          throw new Error("Cannot reproduce parent MCP override");
        config = { ...prior.config, ...raw };
      }
      if (typeof config.command !== "string" && typeof config.url !== "string")
        throw new Error("Parent MCP server needs command or url");
      merged.set(name, { config: jsonCopy(config) as unknown as McpServerConfig, source: path });
      if (!local) globalNames.add(name);
    }
  }
  const resources = names.some((name) => MCP_RESOURCES.has(name));
  const servers: LoadedMcpConfig["servers"] = [];
  for (const [name, entry] of merged) {
    if (
      entry.config.enabled === false ||
      (!resources && !names.some((tool) => tool.startsWith(`mcp__${name.replaceAll("-", "_")}__`)))
    )
      continue;
    if ("url" in entry.config && entry.config.auth) {
      const url = new URL(entry.config.url);
      if (
        url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
        throw new Error("Provider-authenticated MCP requires HTTPS or a loopback URL");
    }
    servers.push({ name, config: entry.config, source: entry.source, scope: "extension" });
  }
  if (
    names.some(
      (name) =>
        name.startsWith("mcp__") &&
        !servers.some((server) => name.startsWith(`mcp__${server.name.replaceAll("-", "_")}__`)),
    )
  )
    throw new Error("An inherited MCP tool has no reproducible server configuration");
  return { servers, errors: [], autoEnableCodemode: false };
}

interface Toolset {
  names: string[];
  active: string[];
  captured: ToolInfo[];
  paths: string[];
  factories: InlineExtension[];
}
async function captureTools(
  request: SubagentSessionRequest,
  config: SubagentConfig,
): Promise<Toolset> {
  if (!request.extended)
    return {
      names: [...config.tools],
      active: [...config.tools],
      captured: [],
      paths: [],
      factories: [],
    };
  const active = new Set(request.parentApi.getActiveTools());
  const captured = request.parentApi
    .getAllTools()
    .filter(
      (tool) =>
        !MANAGEMENT_TOOLS.some((name) => name === tool.name) &&
        tool.exposure !== "hidden" &&
        (active.has(tool.name) || tool.exposure === "codemode" || tool.exposure === "deferred"),
    );
  const paths = new Set<string>();
  const factories: InlineExtension[] = [];
  for (const tool of captured) {
    if (/[,*]/u.test(tool.name) || /^[+-]/u.test(tool.name))
      throw new Error("Child tools require exact representable names");
    if (isMcp(tool.name)) continue;
    if (tool.sourceInfo.source === "builtin") {
      if (BUILTINS.has(tool.name)) continue;
      if (tool.name === "codemode") {
        factories.push({ name: "codemode", factory: createCodemodeExtension(), builtin: true });
        // Built-in factories load through Pi's native synthetic path selection.
        paths.add("builtin:codemode");
      } else if (tool.name === "tool_search") {
        factories.push({
          name: "tool-search",
          factory: createToolSearchExtension(),
          builtin: true,
        });
        paths.add("builtin:tool-search");
      } else throw new Error(`Cannot reproduce built-in tool ${tool.name}`);
    } else {
      if (tool.sourceInfo.source === "sdk" || !isAbsolute(tool.sourceInfo.path))
        throw new Error(`Tool ${tool.name} is runtime-only and cannot be reproduced in a child`);
      paths.add(await realpath(tool.sourceInfo.path));
    }
  }
  const names = captured.map((tool) => tool.name);
  const mcp = captureMcp(request.parentApi, request.parentContext, names);
  if (mcp.servers.length)
    factories.push({
      name: "subagent-mcp",
      factory: (pi) =>
        createMcpExtension({
          loadConfig: () => mcp,
          updateConfig: () => {
            throw new Error("Change MCP configuration in the parent");
          },
          openUrl: () => {
            throw new Error("MCP login must be performed in the parent");
          },
        })(
          new Proxy(pi, {
            get(target, property): unknown {
              if (property !== "on") return Reflect.get(target, property);
              return (
                name: string,
                handler: (event: unknown, context: ExtensionContext) => void | Promise<void>,
              ) => {
                if (name !== "session_start")
                  return Reflect.apply(target.on.bind(target), target, [
                    name,
                    handler,
                  ]) as () => void;
                // MCP's provider-token resolver must use the parent's live credential
                // authority. All other context and nested tool execution stay child-local.
                return target.on("session_start", (event, context) =>
                  handler(
                    event,
                    new Proxy(context, {
                      get(child, key): unknown {
                        return key === "modelRegistry"
                          ? request.parentContext.modelRegistry
                          : Reflect.get(child, key);
                      },
                    }),
                  ),
                );
              };
            },
          }),
        ),
    });
  return {
    names,
    active: names.filter((name) => active.has(name)),
    captured,
    paths: [...paths],
    factories,
  };
}

/** Public Pi SDK only. All model requests use the parent's live in-memory provider/auth authority. */
export function createStandaloneHost(config: SubagentConfig): SubagentHost {
  return {
    config,
    async createSession(request) {
      const selected = await captureTools(request, config);
      request.signal.throwIfAborted();
      const agentDir = dirname(request.sessionFile);
      new ProjectTrustStore(agentDir).set(request.cwd, request.parentContext.isProjectTrusted());
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(agentDir, "model-cache.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      const { provider, ...definition } = request.model;
      const bindProvider = () =>
        runtime.registerProvider(provider, {
          api: request.model.api,
          apiKey: "subagent-in-memory-provider",
          baseUrl: request.model.baseUrl,
          models: [definition],
          streamSimple: (_model, context, options) => {
            // The child runtime resolves its synthetic admission credential before
            // invoking this function. Never let it override the parent's live auth.
            const forwarded = { ...options };
            delete forwarded.apiKey;
            delete forwarded.headers;
            delete forwarded.env;
            return request.parentContext.modelRegistry.streamSimple(
              request.model,
              context,
              forwarded,
            );
          },
        });
      bindProvider();
      let childApi: ExtensionAPI | undefined;
      const settings = SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true },
        cacheWarming: "off",
        defaultProjectTrust: "never",
      });
      const resources = new DefaultResourceLoader({
        cwd: request.cwd,
        agentDir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        additionalExtensionPaths: selected.paths,
        extensionFactories: [
          ...selected.factories,
          {
            name: "subagent-context",
            factory(pi) {
              childApi = pi;
              pi.on("before_agent_start", (event) => {
                // Controller fences cancellation at agent_start; Pi catches errors
                // thrown by prompt hooks, so throwing here cannot stop a run.
                if (request.signal.aborted || !request.isCurrent()) return;
                return {
                  systemPrompt: `${event.systemPrompt}\n\nYou are a child agent assigned one bounded task. Complete the assignment and return a concise result with evidence and blockers. Do not invent additional assignments. You cannot delegate to other agents.`,
                };
              });
            },
          },
        ],
      });
      await resources.reload();
      if (resources.getExtensions().errors.length)
        throw new Error("A selected child extension failed to load");
      const manager = existsSync(request.sessionFile)
        ? SessionManager.open(request.sessionFile, agentDir, request.cwd)
        : SessionManager.create(request.cwd, agentDir);
      if (!existsSync(request.sessionFile)) manager.setSessionFile(request.sessionFile);
      const { session } = await createAgentSession({
        cwd: request.cwd,
        agentDir,
        modelRuntime: runtime,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        settingsManager: settings,
        resourceLoader: resources,
        sessionManager: manager,
        tools: selected.names,
        // Pi otherwise retains MCP tools outside a non-MCP allowlist for Code Mode.
        excludeTools: [
          ...MANAGEMENT_TOOLS,
          ...(selected.names.some((name) => name.startsWith("mcp__")) ? [] : ["mcp__*"]),
        ],
      });
      try {
        await session.bindExtensions({ mode: "rpc" });
        bindProvider();
        const until = Date.now() + config.startupTimeoutMs;
        while (true) {
          request.signal.throwIfAborted();
          const actual = childApi?.getAllTools() ?? [];
          if (actual.some((tool) => !selected.names.includes(tool.name)))
            throw new Error("Unexpected tool in child registry");
          if (selected.names.every((name) => actual.some((tool) => tool.name === name))) {
            for (const expected of selected.captured) {
              const got = actual.find((tool) => tool.name === expected.name)!;
              if (
                JSON.stringify(got.parameters) !== JSON.stringify(expected.parameters) ||
                got.description !== expected.description ||
                got.exposure !== expected.exposure
              )
                throw new Error(`Child tool declaration changed: ${expected.name}`);
            }
            break;
          }
          if (Date.now() >= until) throw new Error("Child tool registration timed out");
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        childApi!.setActiveTools(selected.active);
        return session;
      } catch (error) {
        try {
          await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          session.dispose();
        }
        throw error;
      }
    },
  };
}
