import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxExecutionOptions,
  SandboxResourceLimits,
  SandboxExecutor,
} from "../../contracts.js";

/** Trusted controller configuration; never supplied by a tool call. */
export interface SmolvmOciFamilyOptions {
  readonly smolvmPath: string;
  /** Pinned `docker save` archive, provisioned before evaluation. */
  readonly imageArchive: string;
  readonly imageSha256: string;
  /** Existing private canonical directory. Each family creates a fresh child. */
  readonly stateDirectory: string;
  readonly cwd: string;
  readonly networkMode: "none" | "host";
  readonly mounts?: readonly {
    readonly hostPath: string;
    readonly guestPath: string;
    readonly readOnly: true;
  }[];
  readonly resources: {
    readonly cpus: number;
    readonly memoryMiB: number;
    readonly storageGiB: number;
    readonly overlayGiB: number;
  };
  readonly limits?: SandboxResourceLimits;
}

/** Host-only bearer capability. Do not mount it or put it in model context. */
export interface SmolvmOciAttachment {
  readonly version: 1;
  readonly socketPath: string;
  readonly token: string;
  readonly machineId: string;
  readonly cwd: string;
  readonly home: string;
}

export interface SmolvmOciMachine extends SandboxExecutor {
  /** Disconnect only. The family controller owns the VM. */
  close(): Promise<void>;
}

export interface SmolvmOciRetainedFamily {
  readonly version: 1;
  readonly mode: "cold";
  readonly statePath: string;
  readonly imageSha256: string;
  readonly cwd: string;
}

export interface SmolvmOciTerminalExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** A launcher could not confirm cleanup of its partially started exec client. */
export class SmolvmOciTerminalCleanupError extends Error {
  constructor(message = "smolvm_terminal_cleanup_unconfirmed", options?: ErrorOptions) {
    super(message, options);
    this.name = "SmolvmOciTerminalCleanupError";
  }
}

/** One independent interactive exec client; never the lifetime owner of its VM. */
export interface SmolvmOciTerminal {
  /** Resolves after the host exec client is reaped. This is not a guest-process
   * cleanup acknowledgement; detached guest jobs may survive. */
  readonly completion: Promise<SmolvmOciTerminalExit>;
  /** Accept input with bounded backpressure; reject instead of dropping bytes. */
  write(bytes: Uint8Array): Promise<void>;
  resize(columns: number, rows: number): void;
  /** Idempotently stop and reap this exec client only. */
  close(): Promise<void>;
}

/** Trusted host integration, not model or attachment input. The launcher must
 * use exactly these argv/environment values with a PTY, honor signal during
 * startup, and clean up any partially started client before rejecting. If that
 * cleanup cannot be confirmed, reject with SmolvmOciTerminalCleanupError. It owns
 * bounded I/O buffering and output delivery. Consume readyMarker from the PTY
 * output and resolve only after it arrives: smolvm flushes early terminal input
 * while entering raw mode. No host shell expansion or fallback. */
export type SmolvmOciTerminalLauncher = (request: {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly columns: number;
  readonly rows: number;
  readonly readyMarker: string;
  readonly signal: AbortSignal;
}) => SmolvmOciTerminal | Promise<SmolvmOciTerminal>;

export interface SmolvmOciTerminalOptions {
  readonly terminalType: string;
  readonly columns: number;
  readonly rows: number;
  readonly launch: SmolvmOciTerminalLauncher;
  readonly signal?: AbortSignal;
}

export interface SmolvmOciFamily {
  readonly sourceId: string;
  readonly statePath: string;
  execute(
    machineId: string,
    request: SandboxCommandRequest,
    options?: SandboxExecutionOptions,
  ): Promise<SandboxCommandResult>;
  /** Open a scoped shell on an existing writable source or exact child. Up to
   * 16 independent sessions share the family without taking ordinary tool slots.
   * Close a machine's sessions before awaiting branch/remove; those operations
   * wait for the leases and block new admission in the meantime. */
  openTerminal(machineId: string, options: SmolvmOciTerminalOptions): Promise<SmolvmOciTerminal>;
  attachment(machineId: string): SmolvmOciAttachment;
  /** Freeze source, preserve its generation, and return a writable native child. */
  branch(machineId: string, options: { readonly branchable: boolean }): Promise<string>;
  /** Delete a leaf reviewer/collector. Sources with dependent children are refused. */
  removeMachine(machineId: string): Promise<void>;
  /** Retain a child-free source, frozen or writable, after acknowledged shutdown
   * for explicit same-host cold boot. Close its terminals first. Running
   * processes/RAM are not restored; edits to a reopened original are preserved. */
  retainForColdReopen(): Promise<SmolvmOciRetainedFamily>;
  /** Stop every named family VM before removing state. Retained state is forensic,
   * not a promise that an in-memory native checkpoint can be reopened. The first
   * close determines retention; abnormal retirement always retains. After a
   * successful shutdown, controllers can inspect statePath to record retained
   * versus removed state. A rejection leaves cleanup unconfirmed. Owner crashes
   * may leave VMs running; there is no background supervisor. */
  close(options?: { readonly retainState?: boolean }): Promise<void>;
}
