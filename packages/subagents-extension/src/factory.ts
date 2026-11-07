import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { boundedText } from "./bounds.js";
import { readSubagentConfig } from "./config.js";
import type { SubagentController, SubagentHost } from "./contracts.js";
import { Controller } from "./controller.js";
import { installDelivery, type DeliveryController } from "./delivery.js";
import { attachSubagentPresentation } from "./presentation.js";
import { createStandaloneHost } from "./standalone.js";

interface ArgumentProperty {
  readonly type: "string" | "boolean";
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly description: string;
}
interface ArgumentSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, ArgumentProperty>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}
function objectSchema(
  properties: ArgumentSchema["properties"],
  required = Object.keys(properties),
): ArgumentSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** Pi validates model calls; keep direct host calls subject to the same small argument contract. */
function validateArguments<Args>(value: unknown, schema: ArgumentSchema): Args {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid subagent tool arguments");
  const args = value as Record<string, unknown>;
  if (
    Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key)) ||
    schema.required.some((key) => !Object.hasOwn(args, key))
  )
    throw new Error("Invalid subagent tool arguments");
  for (const [key, input] of Object.entries(args)) {
    const property = schema.properties[key]!;
    if (
      typeof input !== property.type ||
      (typeof input === "string" &&
        (input.length < (property.minLength ?? 0) ||
          input.length > (property.maxLength ?? Infinity)))
    )
      throw new Error("Invalid subagent tool arguments");
  }
  return value as Args;
}

export interface SubagentsExtensionOptions {
  readonly host?: SubagentHost | ((context: ExtensionContext) => SubagentHost);
  readonly onController?: (controller: SubagentController, context: ExtensionContext) => void;
  readonly presentation?: boolean;
}

/** All execution is provided by one SDK-session host. No process or direct-execution fallback exists. */
export function createSubagentsExtension(
  options: SubagentsExtensionOptions = {},
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    let controller: Controller | undefined;
    let delivery: DeliveryController | undefined;
    let presentation: ReturnType<typeof attachSubagentPresentation> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    let toolsRegistered = false;
    const ensure = (context: ExtensionContext): Controller => {
      if (controller) {
        if (controller.parentSessionId !== context.sessionManager.getSessionId())
          throw new Error("Previous subagent session was not shut down");
        delivery?.updateContext(context);
        return controller;
      }
      const host =
        typeof options.host === "function"
          ? options.host(context)
          : (options.host ??
            createStandaloneHost(readSubagentConfig(context.cwd, context.isProjectTrusted())));
      controller = new Controller(pi, host, context.sessionManager.getSessionId(), context);
      const owner = controller;
      delivery = installDelivery(pi, {
        getPending: () =>
          owner
            .snapshot()
            .filter(
              (item) =>
                !["starting", "running", "stopping"].includes(item.status) &&
                item.callback === "armed",
            )
            .map((item) => ({
              eventId: item.taskId,
              agentId: item.id,
              taskId: item.taskId,
              content: `Subagent result: ${item.id} / ${item.taskId}\nOutcome: ${item.status}\n${boundedText(item.result ?? item.error ?? "No answer", 6000)}`,
            })),
        acknowledge: (id) => owner.acknowledge(id),
        disarm: () => {
          const count = owner.snapshot().filter((item) => item.callback === "armed").length;
          owner.disarm();
          return count;
        },
      });
      delivery.updateContext(context);
      const currentDelivery = delivery;
      unsubscribe = owner.subscribe(() => {
        queueMicrotask(() => currentDelivery.tick());
      });
      timer = setInterval(() => currentDelivery.tick(), 250);
      timer.unref();
      if (options.presentation !== false)
        presentation = attachSubagentPresentation(pi, owner, context);
      options.onController?.(owner, context);
      return owner;
    };
    pi.on("session_start", (_event, context) => {
      const owner = ensure(context);
      if (!options.host && owner.statistics().enabled) registerTools();
    });
    pi.on("session_shutdown", async () => {
      if (timer) clearInterval(timer);
      unsubscribe?.();
      presentation?.dispose();
      delivery?.dispose();
      await controller?.shutdown();
      controller = undefined;
      delivery = undefined;
      presentation = undefined;
    });
    const tool = <Args extends object>(
      name: string,
      label: string,
      description: string,
      schema: ArgumentSchema,
      execute: (
        owner: Controller,
        args: Args,
        context: ExtensionContext,
        signal?: AbortSignal,
      ) => unknown,
    ) => {
      pi.registerTool({
        name,
        label,
        description,
        parameters: schema satisfies ToolDefinition["parameters"],
        exposure: "model-only",
        async execute(_id, args, signal, _update, context) {
          try {
            const arguments_ = validateArguments<Args>(args, schema);
            const owner = ensure(context);
            if (!owner.statistics().enabled) throw new Error("Subagents are disabled");
            const result = await execute(owner, arguments_, context, signal);
            return {
              content: [
                {
                  type: "text",
                  text:
                    typeof result === "string"
                      ? result
                      : JSON.stringify(result ?? { accepted: true }),
                },
              ],
              details: {},
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: boundedText(error instanceof Error ? error.message : String(error), 2048),
                },
              ],
              details: {},
              isError: true,
            };
          }
        },
      });
    };
    const text = (description: string): ArgumentProperty => ({
      type: "string",
      minLength: 1,
      maxLength: 32768,
      description,
    });
    const id = (): ArgumentProperty => ({
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Subagent ID returned by spawn_agent, not its task ID.",
    });
    const registerTools = () => {
      if (toolsRegistered) return;
      toolsRegistered = true;
      tool<{ task: string; extended?: boolean }>(
        "spawn_agent",
        "Spawn subagent",
        "Start one bounded background task with a fresh conversation and shared files. Include needed context and avoid overlapping edits. Returns a subagent ID. Results arrive automatically: continue other work or end your turn; do not poll for completion.",
        objectSchema(
          {
            task: text(
              "Objective, relevant context, constraints and expected result; the subagent does not receive this conversation.",
            ),
            extended: {
              type: "boolean",
              description:
                "Use the parent's reproducible work tools, including MCP and extensions. Defaults to false (standard tools).",
            },
          },
          ["task"],
        ),
        async (owner, args, context, signal) => {
          const result = await owner.spawn(args.task, args.extended ?? false, context, signal);
          return {
            id: result.id,
            taskId: result.taskId,
            status: result.status,
            extended: result.extended,
          };
        },
      );
      tool<{ id: string; message: string }>(
        "steer_agent",
        "Steer subagent",
        "Redirect a running subagent after its current tools finish. Returns acceptance, not completion. Use resume_agent for settled subagents.",
        objectSchema({
          id: id(),
          message: text("Correction or additional instructions for the current task."),
        }),
        (owner, args, _context, signal) => owner.steer(args.id, args.message, signal),
      );
      tool<{ id: string }>(
        "cancel_agent",
        "Cancel subagent",
        "Request cancellation and suppress a subagent's completion callback. Its transcript and existing file changes remain. Stopping work still occupies capacity until it settles.",
        objectSchema({ id: id() }),
        async (owner, args) => {
          const result = await owner.cancel(args.id);
          return { id: result.id, taskId: result.taskId, status: result.status };
        },
      );
      tool<{ id: string; message: string; extended?: boolean }>(
        "resume_agent",
        "Resume subagent",
        "Give a follow-up task to a settled subagent, preserving its conversation. Uses the parent's current model/reasoning without consuming another spawn allowance. Concurrency limits still apply. Results arrive automatically.",
        objectSchema(
          {
            id: id(),
            message: text("The next bounded task or instructions for continuing saved work."),
            extended: {
              type: "boolean",
              description:
                "Explicitly switch standard/extended mode. Omission preserves the subagent's current mode.",
            },
          },
          ["id", "message"],
        ),
        async (owner, args, context, signal) => {
          const result = await owner.resume(args.id, args.message, args.extended, context, signal);
          return {
            id: result.id,
            taskId: result.taskId,
            status: result.status,
            extended: result.extended,
          };
        },
      );
      tool<{ id: string }>(
        "inspect_agent",
        "Inspect subagent",
        "Read status and bounded recent progress to decide whether to steer or cancel. Does not wait, acknowledge a result, or change the subagent; results arrive automatically.",
        objectSchema({ id: id() }),
        (owner, args) => owner.inspect(args.id),
      );
    };
    if (options.host) registerTools();
  };
}

export type {
  SubagentHost,
  SubagentController,
  SubagentSessionRequest,
  SubagentSnapshot,
  SubagentConfig,
} from "./contracts.js";
