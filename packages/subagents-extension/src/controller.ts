import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { boundedTail, boundedText, validateTask } from "./bounds.js";
import type {
  SubagentController,
  SubagentHost,
  SubagentSessionRequest,
  SubagentSnapshot,
} from "./contracts.js";
import { SubagentProgress } from "./progress.js";
import { SubagentStore } from "./storage.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
interface Child {
  value: SubagentSnapshot;
  active: boolean;
  abort: AbortController;
  session?: AgentSession;
  ready: ReturnType<typeof deferred<void>>;
  finished: ReturnType<typeof deferred<void>>;
  progress: SubagentProgress;
}
const isActiveStatus = (status: string) => ["starting", "running", "stopping"].includes(status);
export const SUBAGENT_SPAWN_ENTRY = "pi-subagents:spawn";

/** One owner per root conversation. Admission is synchronous; asynchronous child waits never serialize peers. */
export class Controller implements SubagentController {
  public readonly parentSessionId: string;
  private readonly store: SubagentStore;
  private readonly children = new Map<string, Child>();
  private readonly listeners = new Set<(snapshots: readonly SubagentSnapshot[]) => void>();
  private total = 0;
  private closed = false;
  private quiescing = false;
  private storeClosed = false;
  private shutdownWaiters = 0;
  private notification: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly pi: ExtensionAPI,
    private readonly host: SubagentHost,
    parentSessionId: string,
    private readonly parentContext?: ExtensionContext,
  ) {
    this.parentSessionId = parentSessionId;
    this.store = new SubagentStore(host.config.stateDirectory, parentSessionId);
    try {
      const saved = this.store.read();
      this.total = saved.used;
      for (const entry of parentContext?.sessionManager.getEntries() ?? []) {
        if (entry.type !== "custom" || entry.customType !== SUBAGENT_SPAWN_ENTRY) continue;
        const data = entry.data as
          { version?: unknown; parentSessionId?: unknown; total?: unknown } | undefined;
        if (
          data?.version === 1 &&
          data.parentSessionId === parentSessionId &&
          typeof data.total === "number" &&
          Number.isSafeInteger(data.total) &&
          data.total >= 0
        )
          this.total = Math.max(this.total, data.total);
      }
      for (const original of saved.records) {
        const value: SubagentSnapshot = isActiveStatus(original.status)
          ? {
              ...original,
              status: "interrupted",
              activity: "interrupted",
              tools: [],
              finishedAt: Date.now(),
              callback: "disarmed",
              error: "The previous application stopped. Resume explicitly to continue.",
            }
          : original;
        const child = this.child(value, false);
        child.finished.resolve();
        this.children.set(value.id, child);
      }
      this.persist();
    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  private child(value: SubagentSnapshot, active: boolean): Child {
    const ready = deferred<void>();
    void ready.promise.catch(() => undefined);
    return {
      value,
      active,
      abort: new AbortController(),
      ready,
      finished: deferred<void>(),
      progress: new SubagentProgress(),
    };
  }
  public statistics() {
    return Object.freeze({
      enabled: this.host.config.enabled,
      active: [...this.children.values()].filter((child) => child.active).length,
      total: this.total,
      maxConcurrent: this.host.config.maxConcurrent,
      maxTotal: this.host.config.maxTotal,
    });
  }
  public snapshot(): readonly SubagentSnapshot[] {
    return Object.freeze(
      [...this.children.values()].map(({ value }) =>
        Object.freeze({ ...value, tools: Object.freeze([...value.tools]) }),
      ),
    );
  }
  public subscribe(listener: (snapshots: readonly SubagentSnapshot[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify(): void {
    if (this.notification) {
      clearTimeout(this.notification);
      this.notification = undefined;
    }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* Observers cannot change task execution. */
      }
    }
  }
  private notifyProgress(): void {
    if (this.closed) return;
    if (!this.notification) {
      this.notification = setTimeout(() => {
        this.notification = undefined;
        this.notify();
      }, 100);
      this.notification.unref();
    }
  }
  private persist(): void {
    if (this.storeClosed) throw new Error("Subagent controller is closed");
    this.store.write(this.total, this.snapshot());
  }
  private require(id: string): Child {
    const child = this.children.get(id);
    if (!child) throw new Error(`Unknown child: ${boundedText(String(id), 128)}`);
    return child;
  }
  public spawn(
    task: string,
    extended: boolean,
    context: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<SubagentSnapshot> {
    return this.start(undefined, task, extended, context, signal);
  }
  public resume(
    id: string,
    message: string,
    extended: boolean | undefined,
    context: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<SubagentSnapshot> {
    const previous = this.require(id);
    if (previous.active)
      return Promise.reject(
        new Error("Child is still active or stopping; wait for settlement before resuming"),
      );
    return this.start(previous, message, extended ?? previous.value.extended, context, signal);
  }
  private async start(
    previous: Child | undefined,
    task: string,
    extended: boolean,
    context: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<SubagentSnapshot> {
    validateTask(task);
    if (typeof extended !== "boolean") throw new Error("extended must be boolean");
    signal?.throwIfAborted();
    if (this.closed || this.quiescing) throw new Error("Parent session is closing or quiescing");
    if (!this.host.config.enabled) throw new Error("Subagents are disabled");
    if (context.sessionManager.getSessionId() !== this.parentSessionId)
      throw new Error("Subagent controller belongs to another parent session");
    if (!context.model) throw new Error("Select a parent model before starting a child");
    const stats = this.statistics();
    if (!previous && stats.total >= stats.maxTotal)
      throw new Error(`Subagent session total limit reached (${stats.maxTotal})`);
    if (stats.active >= stats.maxConcurrent)
      throw new Error(`Subagent concurrency limit reached (${stats.maxConcurrent})`);
    const model = structuredClone(context.model) as Model<Api>;
    const thinkingLevel = this.pi.getThinkingLevel();
    let id = previous?.value.id ?? `a-${randomUUID().slice(0, 8)}`;
    while (!previous && this.children.has(id)) id = `a-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const value: SubagentSnapshot = {
      id,
      taskId: randomUUID(),
      parentSessionId: this.parentSessionId,
      task,
      extended,
      status: "starting",
      activity: "starting",
      tools: [],
      startedAt: now,
      updatedAt: now,
      assistant: "",
      thinking: "",
      assistantTruncated: false,
      thinkingTruncated: false,
      callback: "armed",
      sessionFile: this.store.sessionFile(id),
      provider: model.provider,
      model: model.id,
      reasoning: thinkingLevel,
    };
    const child = this.child(value, true);
    // Every generation reserves capacity. Only a new child consumes the lifetime spawn quota.
    if (!previous) this.total++;
    this.children.set(id, child);
    try {
      this.persist();
      if (!previous && this.parentContext)
        this.pi.appendEntry(SUBAGENT_SPAWN_ENTRY, {
          version: 1,
          parentSessionId: this.parentSessionId,
          id,
          taskId: value.taskId,
          total: this.total,
        });
    } catch (error) {
      child.active = false;
      child.value = {
        ...child.value,
        status: "failed",
        activity: "admission failed",
        callback: "disarmed",
        finishedAt: Date.now(),
        error: boundedText(String(error), 1024),
      };
      child.finished.resolve();
      // Keep any consumed spawn allowance if the other durable store remains writable.
      try {
        this.persist();
      } catch {
        /* The original persistence failure is returned. */
      }
      this.notify();
      throw error;
    }
    this.notify();
    const request: SubagentSessionRequest = {
      id,
      taskId: value.taskId,
      parentSessionId: this.parentSessionId,
      task,
      cwd: context.cwd,
      extended,
      model,
      thinkingLevel,
      sessionFile: value.sessionFile,
      parentContext: context,
      parentApi: this.pi,
      signal: child.abort.signal,
      isCurrent: () =>
        this.children.get(id) === child &&
        child.active &&
        !child.abort.signal.aborted &&
        !this.closed,
      setActivity: (activity) => {
        if (this.children.get(id) !== child || !child.active) return;
        child.value = {
          ...child.value,
          activity: boundedText(activity, 256),
          updatedAt: Date.now(),
        };
        this.notifyProgress();
      },
    };
    const abortStartup = () => {
      this.cancelFromCallback(child);
    };
    signal?.addEventListener("abort", abortStartup, { once: true });
    const startup = setTimeout(() => {
      child.value = { ...child.value, error: "Child startup timed out" };
      this.cancelFromCallback(child);
    }, this.host.config.startupTimeoutMs);
    void this.run(child, request).catch((error) => {
      child.value = {
        ...child.value,
        status: "stopping",
        activity: "cleanup failed",
        error: boundedText(String(error), 1024),
      };
      child.ready.reject(error);
      this.notify();
    });
    try {
      await child.ready.promise;
      return Object.freeze({ ...child.value, tools: Object.freeze([...child.value.tools]) });
    } finally {
      clearTimeout(startup);
      signal?.removeEventListener("abort", abortStartup);
    }
  }

  private async run(child: Child, request: SubagentSessionRequest): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let failure: string | undefined;
    let started = false;
    try {
      const session = await this.host.createSession(request);
      child.session = session;
      child.abort.signal.throwIfAborted();
      unsubscribe = session.subscribe((event) => {
        if (!child.active || this.children.get(child.value.id) !== child) return;
        // prompt() can await preflight before Pi creates an active run. An abort
        // in that gap must be repeated once Pi can honor it, before its first request.
        if (event.type === "agent_start" && (child.abort.signal.aborted || !request.isCurrent()))
          void session.abort().catch(() => undefined);
        child.progress.event(event);
        const progress = child.progress;
        child.value = {
          ...child.value,
          activity: child.abort.signal.aborted ? "stopping" : progress.activity,
          tools: progress.tools,
          assistant: progress.assistant,
          thinking: progress.thinking,
          assistantTruncated: progress.assistantTruncated,
          thinkingTruncated: progress.thinkingTruncated,
          updatedAt: Date.now(),
        };
        this.notifyProgress();
      });
      child.value = { ...child.value, status: "running", activity: "thinking" };
      if (this.host.config.taskTimeoutMs > 0)
        deadline = setTimeout(() => {
          child.value = { ...child.value, error: "Child task deadline exceeded" };
          this.cancelFromCallback(child);
        }, this.host.config.taskTimeoutMs);
      child.ready.resolve();
      started = true;
      this.notify();
      await session.prompt(request.task, { expandPromptTemplates: false, source: "extension" });
      if (!child.abort.signal.aborted && child.progress.stopReason !== "stop")
        failure = child.progress.error ?? "Child settled without a complete final answer";
    } catch (error) {
      if (!started) child.value = { ...child.value, callback: "disarmed" };
      failure = boundedText(error instanceof Error ? error.message : String(error), 1024);
      child.ready.reject(new Error(failure));
    } finally {
      let cleanupFailed = false;
      if (deadline) clearTimeout(deadline);
      unsubscribe?.();
      if (child.session) {
        try {
          try {
            if (this.host.disposeSession) await this.host.disposeSession(child.session, request);
            else
              await child.session.extensionRunner?.emit({
                type: "session_shutdown",
                reason: "quit",
              });
          } finally {
            child.session.dispose();
          }
        } catch (error) {
          child.value = {
            ...child.value,
            status: "stopping",
            activity: "cleanup failed",
            callback: "disarmed",
            error: boundedText(String(error), 1024),
          };
          cleanupFailed = true;
          try {
            this.persist();
          } finally {
            this.notify();
            child.finished.resolve();
          }
        }
      }
      if (!cleanupFailed) {
        const cancelled = child.abort.signal.aborted;
        child.active = false;
        child.value = {
          ...child.value,
          status: cancelled ? "cancelled" : failure ? "failed" : "completed",
          activity: cancelled ? "cancelled" : failure ? "failed" : "completed",
          tools: [],
          updatedAt: Date.now(),
          finishedAt: Date.now(),
          ...(child.progress.lastAnswer ? { result: child.progress.lastAnswer } : {}),
          ...(failure && !cancelled ? { error: failure } : {}),
        };
        try {
          this.persist();
        } catch (error) {
          child.value = {
            ...child.value,
            status: "failed",
            activity: "saving result failed",
            callback: "disarmed",
            error: boundedText(String(error), 1024),
          };
        }
        this.notify();
        child.finished.resolve();
        // A timed-out shutdown retains ownership until its last straggler really
        // settles. Only then may another controller reopen this conversation.
        try {
          this.releaseStoreIfSettled();
        } catch (error) {
          child.value = {
            ...child.value,
            callback: "disarmed",
            error: boundedText(`Releasing child state failed: ${String(error)}`, 1024),
          };
        }
      }
    }
  }

  private cancelFromCallback(child: Child): void {
    try {
      this.requestCancel(child);
    } catch (error) {
      // Timer and AbortSignal callbacks must never throw into the application.
      // Cancellation has already been requested even if its state cannot be saved.
      child.value = {
        ...child.value,
        error: boundedText(`Saving child cancellation failed: ${String(error)}`, 1024),
      };
      this.notify();
    }
  }

  private requestCancel(child: Child): void {
    child.value = { ...child.value, callback: "disarmed" };
    if (!child.active) {
      this.persist();
      this.notify();
      return;
    }
    child.abort.abort();
    child.value = {
      ...child.value,
      status: "stopping",
      activity: "stopping",
      updatedAt: Date.now(),
    };
    child.ready.reject(new Error(child.value.error ?? "Child startup cancelled"));
    if (child.session) void child.session.abort().catch(() => undefined);
    this.persist();
    this.notify();
  }
  public async cancel(id: string, expectedTaskId?: string): Promise<SubagentSnapshot> {
    const child = this.require(id);
    if (expectedTaskId !== undefined && child.value.taskId !== expectedTaskId)
      throw new Error("Child task changed; refresh before cancelling");
    let persistenceFailure: Error | undefined;
    try {
      this.requestCancel(child);
    } catch (error) {
      persistenceFailure = error instanceof Error ? error : new Error(String(error));
    }
    if (child.active) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        child.finished.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.host.config.cancelTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    if (persistenceFailure !== undefined) throw persistenceFailure;
    return Object.freeze({ ...child.value, tools: Object.freeze([...child.value.tools]) });
  }
  public async steer(id: string, message: string, signal?: AbortSignal): Promise<void> {
    validateTask(message);
    signal?.throwIfAborted();
    const child = this.require(id);
    if (child.value.status !== "running" || !child.session || child.abort.signal.aborted)
      throw new Error("Child is not accepting steering; resume settled work instead");
    await child.session.steer(message);
  }
  public inspect(id: string): string {
    const { value } = this.require(id);
    for (let budget = 1000; budget >= 0; budget -= 100) {
      const result = JSON.stringify({
        id: value.id,
        taskId: value.taskId,
        status: value.status,
        extended: value.extended,
        elapsedMs: (value.finishedAt ?? Date.now()) - value.startedAt,
        activity: boundedText(value.activity, 256),
        tools: value.tools.slice(0, 16),
        callback: value.callback,
        assistant: boundedTail(value.assistant || value.result || "", budget),
        thinking: boundedTail(value.thinking, budget),
        assistantTruncated:
          value.assistantTruncated ||
          Buffer.byteLength(value.assistant || value.result || "") > budget,
        thinkingTruncated: value.thinkingTruncated || Buffer.byteLength(value.thinking) > budget,
        error: value.error ? boundedText(value.error, 256) : undefined,
      });
      if (Buffer.byteLength(result) <= 4096) return result;
    }
    return JSON.stringify({
      id: value.id,
      taskId: value.taskId,
      status: value.status,
      extended: value.extended,
      truncated: true,
    });
  }
  public disarm(): void {
    for (const child of this.children.values())
      if (child.value.callback === "armed") child.value = { ...child.value, callback: "disarmed" };
    this.persist();
    this.notify();
  }
  public acknowledge(taskId: string): void {
    for (const child of this.children.values())
      if (child.value.taskId === taskId && child.value.callback === "armed")
        child.value = { ...child.value, callback: "acknowledged" };
    this.persist();
    this.notify();
  }
  public async quiesce(): Promise<void> {
    this.quiescing = true;
    try {
      const failures: unknown[] = [];
      try {
        this.disarm();
      } catch (error) {
        failures.push(error);
      }
      const cancellations = await Promise.allSettled(
        [...this.children.values()]
          .filter((child) => child.active)
          .map((child) => this.cancel(child.value.id, child.value.taskId)),
      );
      if ([...this.children.values()].some((child) => child.active))
        throw new Error("Subagent shutdown is still waiting for active work to settle");
      for (const result of cancellations)
        if (result.status === "rejected") failures.push(result.reason);
      if (failures.length)
        throw new AggregateError(failures, "Subagent state could not be saved while quiescing");
    } finally {
      this.quiescing = false;
    }
  }
  private releaseStoreIfSettled(): void {
    if (
      !this.closed ||
      this.storeClosed ||
      this.shutdownWaiters > 0 ||
      [...this.children.values()].some((child) => child.active)
    )
      return;
    this.store.close();
    this.storeClosed = true;
  }
  public async shutdown(): Promise<void> {
    if (this.storeClosed) return;
    this.closed = true;
    this.shutdownWaiters++;
    try {
      await this.quiesce();
      this.persist();
    } finally {
      this.shutdownWaiters--;
      if (this.notification) clearTimeout(this.notification);
      this.notification = undefined;
      this.listeners.clear();
      this.releaseStoreIfSettled();
    }
  }
}
