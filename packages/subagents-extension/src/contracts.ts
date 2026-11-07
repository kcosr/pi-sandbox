import type { SubagentActivityEvent } from "./activity.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MANAGEMENT_TOOLS = [
  "spawn_agent",
  "steer_agent",
  "cancel_agent",
  "resume_agent",
  "inspect_agent",
] as const;

export type SubagentStatus =
  "starting" | "running" | "stopping" | "completed" | "failed" | "cancelled" | "interrupted";
export interface SubagentSnapshot {
  readonly id: string;
  readonly taskId: string;
  readonly parentSessionId: string;
  readonly task: string;
  readonly extended: boolean;
  readonly status: SubagentStatus;
  readonly activity: string;
  readonly tools: readonly string[];
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly updatedAt: number;
  readonly assistant: string;
  readonly thinking: string;
  readonly assistantTruncated: boolean;
  readonly thinkingTruncated: boolean;
  readonly result?: string;
  readonly error?: string;
  readonly callback: "armed" | "disarmed" | "acknowledged";
  /** Explicit UI/RPC intent; notification remains subject to the task's callback state. */
  readonly cancelRequestedBy?: "user";
  readonly sessionFile: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ThinkingLevel;
}

/** One captured generation. Host resources must never broaden its tool authority. */
export interface SubagentSessionRequest {
  readonly id: string;
  readonly taskId: string;
  readonly parentSessionId: string;
  readonly task: string;
  readonly cwd: string;
  readonly extended: boolean;
  readonly model: Model<Api>;
  readonly thinkingLevel: ThinkingLevel;
  readonly sessionFile: string;
  readonly parentContext: ExtensionContext;
  readonly parentApi: ExtensionAPI;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  /** Used by the host for activity such as queued/active approvals. */
  readonly setActivity: (activity: string) => void;
}

export interface SubagentConfig {
  readonly enabled: boolean;
  /** Keep the parent run open through child cleanup and result incorporation. */
  readonly waitForChildren: boolean;
  /** Persist bounded child activity as namespaced parent-session custom entries. */
  readonly forwardActivity: boolean;
  readonly maxConcurrent: number;
  /** Lifetime limit on accepted new spawns; resuming a child does not consume it. */
  readonly maxTotal: number;
  readonly startupTimeoutMs: number;
  readonly cancelTimeoutMs: number;
  readonly taskTimeoutMs: number;
  readonly stateDirectory: string;
  readonly tools: readonly string[];
}

export interface SubagentHost {
  readonly config: SubagentConfig;
  /** Return a prepared, bound SDK session. Never start its prompt here. */
  createSession(request: SubagentSessionRequest): Promise<AgentSession>;
  /** Optional host cleanup after the SDK session has settled. */
  disposeSession?(session: AgentSession, request: SubagentSessionRequest): Promise<void>;
}

export interface SubagentController {
  readonly parentSessionId: string;
  spawn(
    task: string,
    extended: boolean,
    context: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<SubagentSnapshot>;
  resume(
    id: string,
    message: string,
    extended: boolean | undefined,
    context: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<SubagentSnapshot>;
  steer(id: string, message: string, signal?: AbortSignal): Promise<void>;
  cancel(id: string, expectedTaskId?: string): Promise<SubagentSnapshot>;
  /** Cancel an exact current task on behalf of the user, retaining its existing callback state. */
  cancelByUser(id: string, expectedTaskId: string): Promise<SubagentSnapshot>;
  snapshot(): readonly SubagentSnapshot[];
  statistics(): {
    readonly enabled: boolean;
    readonly active: number;
    readonly maxConcurrent: number;
    /** Accepted new spawns in this parent conversation, including failed starts. */
    readonly total: number;
    readonly maxTotal: number;
  };
  inspect(id: string): string;
  subscribe(listener: (snapshots: readonly SubagentSnapshot[]) => void): () => void;
  /** Observe bounded child events without changing execution; no historical replay. */
  subscribeActivity(listener: (event: SubagentActivityEvent) => void): () => void;
  /** Throw if this controller closed or encountered a lifecycle/storage failure. */
  assertHealthy(): void;
  /** Wait for actual work and cleanup to finish; reject on abort, closure or lifecycle failure. */
  waitForIdle(signal?: AbortSignal): Promise<void>;
  disarm(): void;
  acknowledge(taskId: string): void;
  quiesce(): Promise<void>;
  shutdown(): Promise<void>;
}
