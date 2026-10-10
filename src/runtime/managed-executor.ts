import {
  SandboxExecutionError,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";

/** One process-owned executor, first started by mandatory session initialization.
 * Pi's metadata and CLI-error exits must not create a boundary needing teardown. */
export function createManagedExecutor(options: {
  readonly cwd: string;
  readonly backend: SandboxExecutor["backend"];
  /** The factory must return a probed executor and clean up failed creation. */
  readonly create: () => Promise<SandboxExecutor>;
}): SandboxExecutor {
  let executor: SandboxExecutor | undefined;
  let starting: Promise<SandboxExecutor> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const ready = (): SandboxExecutor => {
    if (!executor || closed) throw new SandboxExecutionError("sandbox_closed");
    return executor;
  };
  const initialize = (): Promise<SandboxExecutor> => {
    if (closed) return Promise.reject(new SandboxExecutionError("sandbox_closed"));
    return (starting ??= options.create().then((created) => {
      executor = created;
      return created;
    }));
  };
  return {
    cwd: options.cwd,
    backend: options.backend,
    get home() {
      return ready().home;
    },
    get commands() {
      return ready().commands;
    },
    async probe(signal) {
      if (signal?.aborted) throw new SandboxExecutionError("sandbox_aborted");
      await initialize();
      if (closed) throw new SandboxExecutionError("sandbox_closed");
    },
    execute(request, executionOptions) {
      return ready().execute(request, executionOptions);
    },
    close() {
      closed = true;
      return (closing ??= starting
        ? starting.then(
            (created) => created.close(),
            () => undefined,
          )
        : Promise.resolve());
    },
  };
}

/** Pi may report extension shutdown errors without rethrowing them. Preserve
 * failure status and recovery details before its graceful process.exit path. */
export function createManagedCleanup(
  resources: () => readonly { close(): Promise<void> }[],
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () =>
    (closing ??= (async () => {
      const results = await Promise.allSettled(
        resources().map((resource) => Promise.resolve().then(() => resource.close())),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (failures.length) {
        process.exitCode = 1;
        throw new AggregateError(
          failures,
          `Managed runtime shutdown failed: ${failures.map(shutdownErrorMessage).join("; ")}`,
        );
      }
    })());
}

function shutdownErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details =
    error instanceof AggregateError
      ? Array.from(error.errors as unknown[], shutdownErrorMessage)
      : [];
  return [error.message, ...details].join("; ");
}
