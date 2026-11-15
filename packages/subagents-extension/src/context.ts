import {
  createEventBus,
  type EventBusController,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/** The owning child session and its current task generation, not an authorization claim. */
export interface SubagentContext {
  readonly childId: string;
  readonly parentSessionId: string;
  readonly taskId: string;
}

/** Public Pi event-bus query. The payload is a synchronous response callback. */
export const SUBAGENT_CONTEXT_QUERY = "pi-subagents:context:v1";

function copyContext(value: unknown): SubagentContext {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid subagent context");
  const { childId, parentSessionId, taskId } = value as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    !["childId", "parentSessionId", "taskId"].every((key) => Object.hasOwn(value, key)) ||
    typeof childId !== "string" ||
    childId.length === 0 ||
    typeof parentSessionId !== "string" ||
    parentSessionId.length === 0 ||
    typeof taskId !== "string" ||
    taskId.length === 0
  )
    throw new Error("Invalid subagent context");
  return Object.freeze({ childId, parentSessionId, taskId });
}

/**
 * Read the identity of the session owning this extension API. Ordinary parent
 * sessions return undefined. No module singleton, environment or saved transcript
 * is consulted, so independently imported copies share the same host response.
 */
export function getSubagentContext(pi: Pick<ExtensionAPI, "events">): SubagentContext | undefined {
  let accepting = true;
  let responses = 0;
  let value: unknown;
  try {
    pi.events.emit(SUBAGENT_CONTEXT_QUERY, (response: unknown) => {
      if (!accepting) return;
      responses++;
      value = response;
    });
  } finally {
    accepting = false;
  }
  if (responses === 0) return undefined;
  if (responses !== 1) throw new Error("Multiple subagent context responses");
  return copyContext(value);
}

/**
 * Create a private bus before loading a child's extension factories, then supply
 * it as DefaultResourceLoader.eventBus. Keep it through cancellation and shutdown
 * hooks. Pi disposal invalidates extension access; a host retaining the bus may
 * clear it after the child session is actually disposed.
 */
export function createSubagentContextBus(context: SubagentContext): EventBusController {
  const identity = copyContext(context);
  const eventBus = createEventBus();
  eventBus.on(SUBAGENT_CONTEXT_QUERY, (respond) => {
    if (typeof respond === "function") (respond as (value: SubagentContext) => void)(identity);
  });
  return eventBus;
}
