import { SandboxExecutionError } from "./contracts.js";

interface ActiveCommand {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

/** Tracks independent calls, including asynchronous preparation; never serializes admission. */
export class CommandRegistry {
  readonly #active = new Set<ActiveCommand>();
  #failure: SandboxExecutionError | undefined;

  async run<T>(
    signal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#failure) throw this.#failure;
    if (signal?.aborted) throw new SandboxExecutionError("sandbox_aborted");
    const controller = new AbortController();
    let finish!: () => void;
    const active = {
      controller,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.#active.add(active);
    const abort = () => controller.abort(new SandboxExecutionError("sandbox_aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await execute(controller.signal);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#active.delete(active);
      finish();
    }
  }

  fail(error: SandboxExecutionError): void {
    this.#failure ??= error;
    for (const active of this.#active) active.controller.abort(this.#failure);
  }

  async close(): Promise<void> {
    this.fail(new SandboxExecutionError("sandbox_closed"));
    await Promise.all([...this.#active].map((active) => active.done));
  }
}
