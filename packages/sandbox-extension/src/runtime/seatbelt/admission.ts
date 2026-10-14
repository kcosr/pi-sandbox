import { AsyncLocalStorage } from "node:async_hooks";
import { SandboxExecutionError } from "../contracts.js";

interface Waiter {
  resolve(release: () => void): void;
  reject(error: unknown): void;
  dispose(): void;
}

/** Serializes tracked commands only; detached survivors remain outside this queue. */
export class SeatbeltAdmissionQueue {
  readonly context = new AsyncLocalStorage<boolean>();
  readonly #queue: Waiter[] = [];
  #active = false;
  #failure: SandboxExecutionError | undefined;
  readonly #idle: (() => void)[] = [];

  constructor(
    private readonly capacity = 64,
    private readonly timeoutMs = 600_000,
  ) {}

  acquire(signal?: AbortSignal, commandDeadline = Infinity): Promise<() => void> {
    if (this.context.getStore())
      return Promise.reject(
        new SandboxExecutionError("sandbox_invalid_request", {
          cause: new Error("sandbox_reentrant"),
        }),
      );
    if (this.#failure) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(new SandboxExecutionError("sandbox_aborted"));
    const remaining = commandDeadline - Date.now();
    if (remaining <= 0) return Promise.reject(new SandboxExecutionError("sandbox_timeout"));
    if (!this.#active) {
      this.#active = true;
      return Promise.resolve(this.release());
    }
    if (this.#queue.length >= this.capacity)
      return Promise.reject(new SandboxExecutionError("sandbox_queue_full"));
    return new Promise((resolve, reject) => {
      const remove = (
        code: "sandbox_aborted" | "sandbox_admission_timeout" | "sandbox_timeout",
      ) => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        waiter.dispose();
        reject(new SandboxExecutionError(code));
      };
      const abort = () => remove("sandbox_aborted");
      const timer = setTimeout(
        () => remove(remaining <= this.timeoutMs ? "sandbox_timeout" : "sandbox_admission_timeout"),
        Math.min(remaining, this.timeoutMs),
      );
      const waiter: Waiter = {
        resolve,
        reject,
        dispose: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      };
      this.#queue.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  fail(error: SandboxExecutionError): void {
    this.#failure ??= error;
    for (const waiter of this.#queue.splice(0)) {
      waiter.dispose();
      waiter.reject(this.#failure);
    }
  }

  async idle(): Promise<void> {
    if (this.#active) await new Promise<void>((resolve) => this.#idle.push(resolve));
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) {
        next.dispose();
        next.resolve(this.release());
      } else {
        this.#active = false;
        for (const resolve of this.#idle.splice(0)) resolve();
      }
    };
  }
}
