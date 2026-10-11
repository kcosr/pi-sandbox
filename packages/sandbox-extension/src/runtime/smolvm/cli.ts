import { lstat, realpath } from "node:fs/promises";
import {
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxExecutionOptions,
  type SandboxExecutionErrorCode,
} from "../contracts.js";
import { createHostCommandExecutor, HostCommandExecutionError } from "../host-command/index.js";
import { assertGuestPath } from "./request.js";
import { createSmolvmEnvironment } from "./registry.js";

/** Fixed executable/shared native context; each bounded CLI invocation is a direct child. */
export class SmolvmCli {
  readonly environment: Readonly<Record<string, string>>;
  readonly #ready: Promise<void>;
  readonly #active = new Set<{ controller: AbortController; done: Promise<void> }>();
  #disposed = false;
  readonly smolvmPath: string;
  readonly stateDirectory: string;

  constructor(options: {
    readonly smolvmPath: string;
    readonly stateDirectory: string;
    readonly nativeEnvironment?: Readonly<Record<string, string>>;
  }) {
    assertGuestPath(options.smolvmPath);
    this.smolvmPath = options.smolvmPath;
    this.stateDirectory = options.stateDirectory;
    this.environment = Object.freeze({
      ...(options.nativeEnvironment ?? createSmolvmEnvironment()),
    });
    this.#ready = this.prepare();
    // Construction is synchronous; preserve preparation failure for run().
    void this.#ready.catch(() => undefined);
  }

  private async prepare(): Promise<void> {
    const state = await lstat(this.stateDirectory);
    if (
      !state.isDirectory() ||
      state.uid !== process.getuid?.() ||
      state.mode & 0o077 ||
      (await realpath(this.stateDirectory)) !== this.stateDirectory
    )
      throw new SandboxExecutionError("sandbox_start_failed");
  }

  async run(
    request: SandboxCommandRequest,
    options: SandboxExecutionOptions = {},
  ): Promise<SandboxCommandResult> {
    if (this.#disposed) throw new SandboxExecutionError("sandbox_closed");
    if (
      !request ||
      request.cwd !== undefined ||
      request.environment !== undefined ||
      !Array.isArray(request.argv) ||
      !request.argv.length
    )
      throw new SandboxExecutionError("sandbox_invalid_request");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const active = { controller, done };
    this.#active.add(active);
    try {
      await this.#ready;
      if (controller.signal.aborted) throw new SandboxExecutionError("sandbox_aborted");
      const host = createHostCommandExecutor({
        cwd: this.stateDirectory,
        environment: this.environment,
      });
      try {
        return await host.execute(
          { ...request, argv: [this.smolvmPath, ...request.argv] },
          { ...options, signal: controller.signal },
        );
      } finally {
        await host.close();
      }
    } catch (error) {
      if (error instanceof SandboxExecutionError) throw error;
      if (error instanceof HostCommandExecutionError) {
        throw new SandboxExecutionError(
          `sandbox_${error.code.slice("host_command_".length)}` as SandboxExecutionErrorCode,
          { cause: error },
        );
      }
      throw new SandboxExecutionError("sandbox_process_failed", { cause: error });
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.#active.delete(active);
      resolveDone();
    }
  }

  async cancelActive(): Promise<void> {
    const active = [...this.#active];
    for (const command of active) command.controller.abort();
    await Promise.all(active.map((command) => command.done));
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.cancelActive();
  }
}
