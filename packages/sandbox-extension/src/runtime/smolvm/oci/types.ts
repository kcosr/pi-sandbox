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

export interface SmolvmOciFamily {
  readonly sourceId: string;
  readonly statePath: string;
  execute(
    machineId: string,
    request: SandboxCommandRequest,
    options?: SandboxExecutionOptions,
  ): Promise<SandboxCommandResult>;
  attachment(machineId: string): SmolvmOciAttachment;
  /** Freeze source, preserve its generation, and return a writable native child. */
  branch(machineId: string, options: { readonly branchable: boolean }): Promise<string>;
  /** Delete a leaf reviewer/collector. Sources with dependent children are refused. */
  removeMachine(machineId: string): Promise<void>;
  /** Retain a frozen, child-free source after acknowledged shutdown for explicit
   * same-host cold boot. Running processes/RAM are not restored. */
  retainForColdReopen(): Promise<SmolvmOciRetainedFamily>;
  /** Stop every named family VM before removing state. Retained state is forensic,
   * not a promise that an in-memory native checkpoint can be reopened. The first
   * close determines retention; abnormal retirement always retains. After a
   * successful shutdown, controllers can inspect statePath to record retained
   * versus removed state. A rejection leaves cleanup unconfirmed. Owner crashes
   * may leave VMs running; there is no background supervisor. */
  close(options?: { readonly retainState?: boolean }): Promise<void>;
}
