import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import type {
  SubagentHost,
  SubagentSessionRequest,
} from "../../packages/subagents-extension/src/contracts.js";
import { SUBAGENT_TOOL_NAMES, type SandboxConfig } from "../domain/index.js";
import { createManagedCodemodeExtension } from "../codemode/index.js";
import { withManagedChild } from "./invocation.js";

const STANDARD_TOOLS = new Set(["read", "bash", "edit", "write"]);
const DELEGATION_TOOLS = new Set<string>(SUBAGENT_TOOL_NAMES);

export interface ManagedSubagentHostOptions {
  readonly config: SandboxConfig;
  readonly userStateDir: string;
  readonly getModelRuntime: () => ModelRuntime;
  readonly definitions: ReadonlyMap<string, ToolDefinition>;
  readonly isAvailable: () => boolean;
  readonly beforeApproval?: () => void;
  readonly wrapCodeMode?: (definition: ToolDefinition) => ToolDefinition;
  readonly getEnvironmentPrompt?: () => string | undefined;
  readonly getToolGuidance?: (active: ReadonlySet<string>) => string | undefined;
}

function bindChildContext(
  definition: ToolDefinition,
  request: SubagentSessionRequest,
  options: ManagedSubagentHostOptions,
): ToolDefinition {
  return {
    ...definition,
    execute(id, args, signal, update, ctx) {
      if (!options.isAvailable() || !request.isCurrent() || request.signal.aborted)
        return Promise.reject(new Error("Managed subagent is unavailable"));
      const invocationSignal =
        signal === undefined ? request.signal : AbortSignal.any([signal, request.signal]);
      return withManagedChild(
        {
          childId: request.id,
          childTaskId: request.taskId,
          childSessionId: ctx.sessionManager.getSessionId(),
          label: request.task,
          rootContext: request.parentContext,
          isCurrent: request.isCurrent,
          setActivity: request.setActivity,
          ...(options.beforeApproval === undefined
            ? {}
            : { beforeApproval: options.beforeApproval }),
        },
        () => definition.execute(id, args, invocationSignal, update, ctx),
      );
    },
  };
}

/** Calls always reach the live managed registry; a stale schema must never authorize new behavior. */
function bindTool(
  definition: ToolDefinition,
  request: SubagentSessionRequest,
  options: ManagedSubagentHostOptions,
): ToolDefinition {
  const schema = JSON.stringify(definition.parameters);
  return bindChildContext(
    {
      ...definition,
      execute(...args) {
        const current = options.definitions.get(definition.name);
        if (
          current === undefined ||
          current.exposure === "hidden" ||
          JSON.stringify(current.parameters) !== schema
        )
          return Promise.reject(new Error("Managed subagent tool changed or is unavailable"));
        return current.execute(...args);
      },
    },
    request,
    options,
  );
}

/** The generic runner owns tasks. This host owns all managed resource admission. */
export function createManagedSubagentHost(options: ManagedSubagentHostOptions): SubagentHost {
  const policy = options.config.subagents;
  if (policy?.enabled !== true) throw new Error("Managed subagents are disabled");
  return {
    config: {
      enabled: true,
      maxConcurrent: policy.maxConcurrent,
      maxTotal: policy.maxTotal,
      startupTimeoutMs: 30000,
      cancelTimeoutMs: 5000,
      taskTimeoutMs: 0,
      stateDirectory: join(options.userStateDir, "subagents"),
      tools: [...STANDARD_TOOLS],
    },
    async createSession(request) {
      if (!options.isAvailable() || !request.isCurrent() || request.signal.aborted)
        throw new Error("Managed subagent session is unavailable");
      const active = new Set(request.parentApi.getActiveTools());
      const callable = new Set(
        request.parentApi
          .getAllTools()
          .filter(
            (tool) =>
              tool.exposure !== "hidden" &&
              (active.has(tool.name) ||
                tool.exposure === "deferred" ||
                tool.exposure === "codemode"),
          )
          .map((tool) => tool.name),
      );
      const definitions = [...options.definitions.values()].filter(
        (definition) =>
          !DELEGATION_TOOLS.has(definition.name) &&
          definition.name !== "codemode" &&
          definition.exposure !== "hidden" &&
          callable.has(definition.name) &&
          (request.extended || STANDARD_TOOLS.has(definition.name)),
      );
      const codeMode =
        request.extended && callable.has("codemode") && options.config.codemode.enabled;
      const settingsManager = SettingsManager.inMemory({
        cacheWarming: "off",
        quietStartup: true,
        defaultProjectTrust: request.parentContext.isProjectTrusted() ? "always" : "never",
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: request.cwd,
        agentDir: options.userStateDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          async (pi) => {
            pi.on("before_agent_start", (event) => {
              // The controller aborts cancelled runs at agent_start. Prompt-hook
              // errors are caught by Pi and therefore cannot be used as a fence.
              if (request.signal.aborted || !request.isCurrent()) return;
              const environment = options.getEnvironmentPrompt?.();
              if (environment !== undefined)
                event.systemPromptOptions.sections.pi_sandbox_environment = environment;
              delete event.systemPromptOptions.sections.pi_sandbox_extension_guidance;
              const guidance = options.getToolGuidance?.(new Set(pi.getActiveTools()));
              if (guidance !== undefined)
                event.systemPromptOptions.sections.pi_sandbox_extension_guidance = guidance;
              event.systemPromptOptions.sections.pi_subagent_task =
                "You are a subagent assigned one bounded task. Complete the assignment and return a concise result with evidence and blockers. Do not invent additional assignments. You cannot delegate to other subagents.";
            });
            for (const definition of definitions)
              pi.registerTool(bindTool(definition, request, options));
            if (codeMode) {
              const factory = createManagedCodemodeExtension(options.config.codemode);
              if (factory !== undefined)
                await factory(
                  new Proxy(pi, {
                    get(target, property): unknown {
                      if (property !== "registerTool") return Reflect.get(target, property);
                      return (definition: ToolDefinition) =>
                        target.registerTool(
                          bindChildContext(
                            options.wrapCodeMode?.(definition) ?? definition,
                            request,
                            options,
                          ),
                        );
                    },
                  }),
                );
            }
          },
        ],
      });
      await resourceLoader.reload();
      if (resourceLoader.getExtensions().errors.length > 0)
        throw new Error("A managed subagent extension failed to load");
      request.signal.throwIfAborted();
      const sessionOptions: CreateAgentSessionOptions & { includeBuiltinTools: false } = {
        cwd: request.cwd,
        agentDir: options.userStateDir,
        modelRuntime: options.getModelRuntime(),
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        sessionManager: SessionManager.open(
          request.sessionFile,
          dirname(request.sessionFile),
          request.cwd,
        ),
        settingsManager,
        resourceLoader,
        includeBuiltinTools: false,
        tools: [
          ...definitions.map((definition) => definition.name),
          ...(codeMode ? ["codemode"] : []),
        ],
        excludeTools: [...SUBAGENT_TOOL_NAMES],
      };
      const { session } = await createAgentSession(sessionOptions);
      try {
        await session.bindExtensions({ mode: "print" });
        request.signal.throwIfAborted();
        if (
          !options.isAvailable() ||
          !request.isCurrent() ||
          session.sessionManager.getCwd() !== request.cwd ||
          session
            .getAllTools()
            .some((tool) => tool.sourceInfo.source === "builtin" || DELEGATION_TOOLS.has(tool.name))
        )
          throw new Error("Managed subagent session exceeded its admitted tools or workspace");
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
