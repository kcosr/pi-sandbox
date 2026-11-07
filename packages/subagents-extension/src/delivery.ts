import type {
  BoundaryResult,
  BoundaryState,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { boundedText } from "./bounds.js";

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
  /** Disarm all existing work after a parent abort; return the number of newly suppressed tasks. */
  disarm(): number;
  onNotice?(message: string): void;
  onError?(error: unknown): void;
  /** Present only for the opt-in completion policy. All methods retain host authority. */
  completion?: {
    assertHealthy(): void;
    active(): number;
    waitForIdle(signal: AbortSignal): Promise<void>;
    quiesce(): Promise<void>;
  };
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
  /** Number of idle sends, including the first attempt. */
  sends?: number;
  /** The first idle tick after an unsuccessful run schedules a retry, not an immediate loop. */
  retryAt?: number;
  paused?: boolean;
}
const MAXIMUM_IDLE_SENDS = 6;
const MAXIMUM_RETRY_DELAY_MS = 30_000;
const PENDING_INPUT_CHECK_MS = 1_000;

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
 * Result/outbox adapters are synchronous; completion waits precede selection.
 * There is no await between checking armed task IDs
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
  let pauseNotified = false;
  const unsubscribe: Array<() => void> = [];
  const completion = adapters.completion;
  const lifetime = new AbortController();
  let stopped = false;
  let cleanup: Promise<void> | undefined;
  let failure: Error | undefined;
  let failureReported = false;
  let awaitingResultTurn = false;
  const terminatingTools = new Set<string>();

  function stopChildren(): Promise<void> {
    stopped = true;
    if (!cleanup) {
      cleanup = completion!.quiesce();
      // The boundary awaits and reports failure. AbortSignal listeners cannot await.
      void cleanup.catch(() => undefined);
    }
    return cleanup;
  }

  async function failCompletion(error: unknown, next: ExtensionContext): Promise<undefined> {
    failure ??= new Error(
      `Subagent completion failed: ${boundedText(error instanceof Error ? error.message : String(error), 1024)}`,
      { cause: error },
    );
    stopped = true;
    // Pi catches boundary exceptions. Abort explicitly BEFORE throwing, otherwise
    // an extension_error alone could accompany an apparently successful settlement.
    next.abort();
    try {
      await stopChildren();
    } catch (cleanupError) {
      failure = new AggregateError(
        [failure, cleanupError],
        "Subagent completion and cleanup failed",
      );
    }
    if (!failureReported) {
      failureReported = true;
      throw failure;
    }
    return undefined;
  }

  const report = (error: unknown) => {
    if (adapters.onError) adapters.onError(error);
    else console.error("pi-subagents result delivery:", error);
  };

  function notice(message: string) {
    try {
      if (adapters.onNotice) adapters.onNotice(message);
      else context?.ui?.notify(message, "warning");
    } catch (error) {
      report(error);
    }
  }

  function scheduleRetry(attempt: Attempt) {
    const sends = attempt.sends ?? 1;
    if (sends >= MAXIMUM_IDLE_SENDS) {
      attempt.paused = true;
      if (!pauseNotified) {
        pauseNotified = true;
        notice(
          "Automatic subagent results are paused because the parent could not start a turn. Use /subagents or inspect_agent to view results. A successful parent turn resumes automatic delivery.",
        );
      }
    } else {
      attempt.retryAt = Date.now() + Math.min(2_000 * 2 ** (sends - 1), MAXIMUM_RETRY_DELAY_MS);
    }
  }

  function abort() {
    if (disposed) return;
    if (watchedSignal) {
      if (handledAborts.has(watchedSignal)) return;
    }
    // Disarm durable records first. A callback must not become eligible again on reload.
    // If persistence fails, later ticks retry it before delivering anything else.
    abortPending = true;
    let count: number;
    try {
      count = adapters.disarm();
    } finally {
      if (completion) void stopChildren();
    }
    abortPending = false;
    if (count > 0)
      notice(
        `Automatic results were disabled for ${count} existing subagent task${count === 1 ? "" : "s"}, including running tasks. ${completion ? "Running tasks are being cancelled." : "Running tasks continue."} Use /subagents or inspect_agent to view their results.`,
      );
    if (watchedSignal) handledAborts.add(watchedSignal);
    attempts.clear();
    pauseNotified = false;
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
      if (completion)
        failure ??= new Error("Subagent cancellation could not be saved", { cause: error });
      else report(error);
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

  function boundary(
    event: BoundaryState,
    next: ExtensionContext,
    settling = false,
  ): BoundaryResult | undefined {
    updateContext(next);
    if (disposed) return;
    releaseUncommittedBoundaries();
    if (event.outcome === "aborted" || next.signal?.aborted) {
      abort();
      return;
    }
    if (settling && event.outcome === "completed") {
      // A completed parent run demonstrates recovery; failed startup or provider
      // errors must not reset the budget and restart an infinite retry loop.
      for (const [id, attempt] of attempts) if (attempt.kind === "idle") attempts.delete(id);
      pauseNotified = false;
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
    // Waiting mode handles results at lifecycle boundaries; pending-input polling
    // runs only inside an outstanding child wait.
    // Never start an independent idle run after its operation has settled or aborted.
    if (completion || disposed || !context) return;
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
          if (attempt.paused) continue;
          if (attempt.retryAt === undefined) scheduleRetry(attempt);
          if (attempt.paused || Date.now() < attempt.retryAt!) continue;
        }
        const next: Attempt = { kind: "idle", sends: (attempt?.sends ?? 0) + 1 };
        attempts.set(result.eventId, next);
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
          scheduleRetry(next);
          report(error);
        }
        // Start only one idle run. Remaining results join its next safe boundary.
        break;
      }
    } catch (error) {
      report(error);
    }
  }

  async function waitForIdleOrInput(next: ExtensionContext, signal: AbortSignal) {
    if (completion!.active() === 0 || next.hasPendingMessages()) return;
    const waiting = new AbortController();
    const waitSignal = AbortSignal.any([signal, lifetime.signal, waiting.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        // Stock Pi exposes no post-enqueue extension event. Check only while
        // waiting, leaving accepted input in Pi's own steering/follow-up queues.
        const checkInput = () => {
          try {
            if (next.hasPendingMessages()) resolve();
            else timer = setTimeout(checkInput, PENDING_INPUT_CHECK_MS);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        void completion!.waitForIdle(waitSignal).then(resolve, reject);
        checkInput();
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // A queue wake must unsubscribe the otherwise still-active child waiter.
      waiting.abort();
    }
  }

  async function waitBoundary(event: TurnEndEvent, next: ExtensionContext) {
    try {
      updateContext(next);
      if (disposed) return;
      if (failure) return failCompletion(failure, next);
      if (event.outcome === "aborted" || next.signal?.aborted || stopped) {
        abort();
        await stopChildren();
        return;
      }
      completion!.assertHealthy();
      // Leave Pi's provider retry/compaction policy intact. A final failed parent
      // is handled by the pre-settlement guard after those retries finish.
      if (event.outcome === "error") return;
      let result = boundary(event, next);
      if (result) {
        awaitingResultTurn = true;
        return result;
      }
      const calls =
        event.message.role === "assistant"
          ? event.message.content.filter((part) => part.type === "toolCall")
          : [];
      const terminates = calls.length > 0 && calls.every((call) => terminatingTools.has(call.id));
      if (event.continue || next.hasPendingMessages() || (calls.length > 0 && !terminates)) return;
      const signal = next.signal;
      if (!signal) throw new Error("Pi turn_end did not provide an active abort signal");
      await waitForIdleOrInput(next, signal);
      if (disposed) return;
      if (signal.aborted || stopped) {
        abort();
        await stopChildren();
        return;
      }
      completion!.assertHealthy();
      result = boundary(event, next);
      if (result) awaitingResultTurn = true;
      return result;
    } catch (error) {
      if (disposed) return;
      if (next.signal?.aborted && error === next.signal.reason && !failure) {
        try {
          await stopChildren();
          return;
        } catch (cleanupError) {
          return failCompletion(cleanupError, next);
        }
      }
      return failCompletion(error, next);
    }
  }

  async function verifyCompletion(event: BoundaryState, next: ExtensionContext) {
    try {
      updateContext(next);
      if (disposed) return;
      if (failure) return failCompletion(failure, next);
      if (stopped || event.outcome === "aborted" || next.signal?.aborted) {
        abort();
        await stopChildren();
        return;
      }
      completion!.assertHealthy();
      releaseUncommittedBoundaries();
      const unfinished = completion!.active() > 0 || pending().length > 0 || awaitingResultTurn;
      if (event.outcome === "error") {
        // Preserve Pi's ordinary provider-error outcome. Cancel a still-active
        // delegation tree; already-settled results remain eligible for the next
        // prompt when no active work needs cancellation.
        if (completion!.active() > 0) await stopChildren();
        return;
      }
      if (unfinished)
        throw new Error(
          "Parent reached settlement with unfinished subagent work or undelivered results",
        );
      // Never await child work here: stock Pi has already cleared its abort signal.
    } catch (error) {
      if (!disposed) return failCompletion(error, next);
    }
  }

  const controller: DeliveryController = {
    updateContext,
    tick,
    dispose() {
      if (disposed) return;
      disposed = true;
      // Stock RPC shutdown emits session_shutdown before disposing its session;
      // it does not first abort an active run. Fence that run before waking it.
      if (completion && context && !context.isIdle()) context.abort();
      lifetime.abort();
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
      if (completion) {
        // Delivery failures belong to one run. Durable controller faults are
        // checked again (and reported again) at turn_start, never silently latched.
        failure = undefined;
        failureReported = false;
        stopped = false;
        cleanup = undefined;
      }
      updateContext(next);
    }),
    pi.on("turn_start", async (_event, next) => {
      try {
        updateContext(next);
        if (!disposed) {
          if (completion) {
            terminatingTools.clear();
            if (failure) return failCompletion(failure, next);
            completion.assertHealthy();
            awaitingResultTurn = false;
          }
          releaseUncommittedBoundaries();
        }
      } catch (error) {
        if (completion) await failCompletion(error, next);
        else throw error;
      }
    }),
    pi.on("turn_end", (event, next) =>
      completion ? waitBoundary(event, next) : boundary(event, next),
    ),
    pi.on("agent_before_settle", (event, next) =>
      completion ? verifyCompletion(event, next) : boundary(event, next, true),
    ),
    pi.on("agent_settled", async (event, next) => {
      if (completion) {
        try {
          updateContext(next);
          if (disposed) return;
          if (event.aborted) abort();
          if (cleanup) await cleanup;
        } catch (error) {
          if (!failureReported) {
            failureReported = true;
            throw error;
          }
        }
        return;
      }
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
  if (completion)
    unsubscribe.push(
      pi.on("tool_execution_end", (event) => {
        // Pi does not retain this flag in turn_end.toolResults. The finalized public
        // execution event exposes it, including blocked calls, before finishTurn runs.
        const result: unknown = event.result;
        if (
          !event.parentToolCallId &&
          result !== null &&
          typeof result === "object" &&
          "terminate" in result &&
          result.terminate === true
        )
          terminatingTools.add(event.toolCallId);
      }),
    );
  return controller;
}
