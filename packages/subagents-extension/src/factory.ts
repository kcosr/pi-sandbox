import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { bool, compile, obj, opt, str, type Schema, type Static } from "@earendil-works/pi-schema";
import { boundedText } from "./bounds.js";
import { readSubagentConfig } from "./config.js";
import type { SubagentController, SubagentHost } from "./contracts.js";
import { Controller } from "./controller.js";
import { installDelivery, type DeliveryController } from "./delivery.js";
import { attachSubagentPresentation } from "./presentation.js";
import { createStandaloneHost } from "./standalone.js";

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
              content: `Child result: ${item.id} / ${item.taskId}\nOutcome: ${item.status}\n${boundedText(item.result ?? item.error ?? "No answer", 6000)}`,
            })),
        acknowledge: (id) => owner.acknowledge(id),
        disarm: () => owner.disarm(),
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
    const tool = <S extends Schema>(
      name: string,
      description: string,
      schema: S,
      execute: (
        owner: Controller,
        args: Static<S>,
        context: ExtensionContext,
        signal?: AbortSignal,
      ) => unknown,
    ) => {
      const validator = compile(schema);
      pi.registerTool({
        name,
        label: name,
        description,
        parameters: schema,
        exposure: "model-only",
        async execute(_id, args, signal, _update, context) {
          try {
            if (!validator.check(args)) throw new Error("Invalid subagent tool arguments");
            const owner = ensure(context);
            if (!owner.statistics().enabled) throw new Error("Subagents are disabled");
            const result = await execute(owner, args, context, signal);
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
    const text = (description: string) => str({ minLength: 1, maxLength: 32768, description });
    const id = () =>
      str({
        minLength: 1,
        maxLength: 128,
        description: "Child ID returned by spawn_agent, not its task ID.",
      });
    const registerTools = () => {
      if (toolsRegistered) return;
      toolsRegistered = true;
      tool(
        "spawn_agent",
        "Start one bounded background task with a fresh conversation and shared files. Include needed context and avoid overlapping edits. Returns a child ID. Results arrive automatically: continue other work or end your turn; do not poll for completion.",
        obj({
          task: text(
            "Objective, relevant context, constraints and expected result; the child does not receive this conversation.",
          ),
          extended: opt(
            bool({
              description:
                "Use the parent's reproducible work tools, including MCP and extensions. Defaults to false (standard tools).",
            }),
          ),
        }),
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
      tool(
        "steer_agent",
        "Redirect a running child after its current tools finish. Returns acceptance, not completion. Use resume_agent for settled children.",
        obj({
          id: id(),
          message: text("Correction or additional instructions for the current task."),
        }),
        (owner, args, _context, signal) => owner.steer(args.id, args.message, signal),
      );
      tool(
        "cancel_agent",
        "Request cancellation and suppress a child's completion callback. Its transcript and existing file changes remain. Stopping work still occupies capacity until it settles.",
        obj({ id: id() }),
        async (owner, args) => {
          const result = await owner.cancel(args.id);
          return { id: result.id, taskId: result.taskId, status: result.status };
        },
      );
      tool(
        "resume_agent",
        "Give a follow-up task to a settled child, preserving its conversation. Uses the parent's current model/reasoning and consumes another session task allowance. Results arrive automatically.",
        obj({
          id: id(),
          message: text("The next bounded task or instructions for continuing saved work."),
          extended: opt(
            bool({
              description:
                "Explicitly switch standard/extended mode. Omission preserves the child's current mode.",
            }),
          ),
        }),
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
      tool(
        "inspect_agent",
        "Read status and bounded recent progress to decide whether to steer or cancel. Does not wait, acknowledge a result, or change the child; results arrive automatically.",
        obj({ id: id() }),
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
