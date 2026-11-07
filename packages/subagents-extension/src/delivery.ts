import type {
  BoundaryResult,
  BoundaryState,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Persisted in Pi's transcript; the IDs also identify the manager's durable outbox item. */
export const RESULT_MESSAGE_TYPE = "pi-subagents:result";

export interface PendingDelivery {
  eventId: string;
  agentId: string;
  taskId: string;
  /** Already bounded and formatted by the manager, including the active-child count. */
  content: string;
}

export interface DeliveryAdapters {
  /** Return only current, armed task results. Cancel/resume must fence stale task IDs here. */
  getPending(): readonly PendingDelivery[];
  /** Persist acknowledgment. Called only after finding the matching item in Pi's transcript. */
  acknowledge(eventId: string): void;
  /** Synchronously disarm all existing work after an explicit parent abort. */
  disarm(): void;
  onError?(error: unknown): void;
}

export interface DeliveryController {
  /** A controller belongs to one parent session; dispose it on session replacement. */
  updateContext(context: ExtensionContext): void;
  /** Call after refreshing the manager's durable results. Does not start its own timer. */
  tick(): void;
  dispose(): void;
}

interface Attempt {
  kind: "boundary" | "idle";
  /** The first idle tick after an unsuccessful run schedules a retry, not an immediate loop. */
  retryAt?: number;
}

function details(result: PendingDelivery) {
  return {
    eventId: result.eventId,
    agentId: result.agentId,
    taskId: result.taskId,
  };
}

function isMatchingDetails(value: unknown, result: PendingDelivery): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.eventId === result.eventId &&
    candidate.agentId === result.agentId &&
    candidate.taskId === result.taskId
  );
}

/**
 * Busy parents receive entries at Pi 1.5's after-tools boundaries. We deliberately
 * avoid the steering queue there: the public API cannot selectively retract a
 * queued result after cancel/resume. Idle delivery starts a custom-message run.
 * Transcript reconciliation closes the append-before-ack crash window; it does
 * not promise exactly-once processing across crashes or external transcript edits.
 *
 * Adapters must be synchronous. There is no await between checking armed task IDs
 * and handing their entries to Pi. A later abort stops continuation through Pi's
 * own abort signal. Other extensions can replace boundary entries; uncommitted
 * entries are retried after the next boundary, turn start, or settlement.
 */
export function installDelivery(pi: ExtensionAPI, adapters: DeliveryAdapters): DeliveryController {
  let context: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let disposed = false;
  let watchedSignal: AbortSignal | undefined;
  let abortPending = false;
  const handledAborts = new WeakSet<AbortSignal>();
  const attempts = new Map<string, Attempt>();
  const unsubscribe: Array<() => void> = [];

  const report = (error: unknown) => {
    if (adapters.onError) adapters.onError(error);
    else console.error("pi-subagents result delivery:", error);
  };

  function abort() {
    if (disposed) return;
    if (watchedSignal) {
      if (handledAborts.has(watchedSignal)) return;
    }
    // Disarm durable records first. A callback must not become eligible again on reload.
    // If persistence fails, later ticks retry it before delivering anything else.
    abortPending = true;
    adapters.disarm();
    abortPending = false;
    if (watchedSignal) handledAborts.add(watchedSignal);
    attempts.clear();
  }

  function updateContext(next: ExtensionContext) {
    if (disposed) return;
    const nextId = next.sessionManager.getSessionId();
    if (sessionId !== undefined && sessionId !== nextId) {
      throw new Error(
        "Result delivery cannot move to another parent session; create a new controller.",
      );
    }
    sessionId = nextId;
    context = next;
    const signal = next.signal;
    if (signal !== watchedSignal) {
      watchedSignal?.removeEventListener("abort", onAbort);
      watchedSignal = signal;
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    if (signal?.aborted || abortPending) abort();
  }

  function onAbort() {
    try {
      abort();
    } catch (error) {
      report(error);
    }
  }

  function pending(): PendingDelivery[] {
    if (!context || disposed) return [];
    const results = adapters.getPending();
    const eligible = new Set(results.map((result) => result.eventId));
    for (const id of attempts.keys()) if (!eligible.has(id)) attempts.delete(id);
    const entries = context.sessionManager.getEntries();
    const remaining: PendingDelivery[] = [];
    for (const result of results) {
      const persisted = entries.some(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === RESULT_MESSAGE_TYPE &&
          isMatchingDetails(entry.details, result),
      );
      if (persisted) {
        adapters.acknowledge(result.eventId);
        attempts.delete(result.eventId);
      } else remaining.push(result);
    }
    return remaining;
  }

  /** A subsequent lifecycle boundary proves earlier boundary handlers have returned. */
  function releaseUncommittedBoundaries() {
    pending();
    for (const [id, attempt] of attempts) if (attempt.kind === "boundary") attempts.delete(id);
  }

  function boundary(event: BoundaryState, next: ExtensionContext): BoundaryResult | undefined {
    updateContext(next);
    if (disposed) return;
    releaseUncommittedBoundaries();
    if (event.outcome === "aborted" || next.signal?.aborted) {
      abort();
      return;
    }
    const ready = pending().filter((result) => !attempts.has(result.eventId));
    if (ready.length === 0) return;
    const entries: CustomMessageEntryDraft[] = ready.map((result) => ({
      type: "custom_message",
      customType: RESULT_MESSAGE_TYPE,
      content: result.content,
      display: true,
      details: details(result),
    }));
    for (const result of ready) attempts.set(result.eventId, { kind: "boundary" });
    // BoundaryResult.entries replaces the prior list, so preserve earlier extensions' entries.
    return { entries: [...event.entries, ...entries], continue: true };
  }

  function tick() {
    if (disposed || !context) return;
    try {
      updateContext(context);
      const ready = pending();
      if (context.signal?.aborted || !context.isIdle()) return;
      for (const result of ready) {
        const attempt = attempts.get(result.eventId);
        if (attempt?.kind === "boundary") continue;
        if (attempt?.kind === "idle") {
          // If a run settled or startup failed without persisting the message, retry
          // after a backoff. A live run is excluded by isIdle() above.
          if (attempt.retryAt === undefined) attempt.retryAt = Date.now() + 2_000;
          if (Date.now() < attempt.retryAt) continue;
        }
        attempts.set(result.eventId, { kind: "idle" });
        try {
          pi.sendMessage(
            {
              customType: RESULT_MESSAGE_TYPE,
              content: result.content,
              display: true,
              details: details(result),
            },
            { deliverAs: "steer", triggerTurn: true },
          );
        } catch (error) {
          attempts.set(result.eventId, {
            kind: "idle",
            retryAt: Date.now() + 2_000,
          });
          report(error);
        }
        // Start only one idle run. Remaining results join its next safe boundary.
        break;
      }
    } catch (error) {
      report(error);
    }
  }

  const controller: DeliveryController = {
    updateContext,
    tick,
    dispose() {
      if (disposed) return;
      disposed = true;
      watchedSignal?.removeEventListener("abort", onAbort);
      for (const remove of unsubscribe.splice(0)) remove();
      attempts.clear();
      context = undefined;
    },
  };

  unsubscribe.push(
    pi.on("session_start", (_event, next) => {
      updateContext(next);
    }),
    pi.on("agent_start", (_event, next) => {
      updateContext(next);
    }),
    pi.on("turn_start", (_event, next) => {
      updateContext(next);
      if (!disposed) releaseUncommittedBoundaries();
    }),
    pi.on("turn_end", (event, next) => boundary(event, next)),
    pi.on("agent_before_settle", (event, next) => boundary(event, next)),
    pi.on("agent_settled", (event, next) => {
      updateContext(next);
      if (disposed) return;
      if (event.aborted) abort();
      releaseUncommittedBoundaries();
      // Do not start a run inside settlement; the manager's next tick handles idle delivery.
    }),
    pi.on("session_shutdown", () => {
      controller.dispose();
    }),
  );
  return controller;
}
