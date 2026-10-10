import { SandboxExecutionError } from "../contracts.js";

interface Waiter {
  resolve(release: () => void): void;
  reject(error: unknown): void;
  dispose(): void;
}

/** Serial admission belongs to the owning process; there is no worker daemon. */
export class AdmissionQueue {
  readonly #queue: Waiter[] = [];
  #active = false;
  #failure: SandboxExecutionError | undefined;
  readonly #idle: (() => void)[] = [];

  constructor(
    private readonly capacity = 64,
    private readonly timeoutMs = 600_000,
  ) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2_147_483_647
    )
      throw new SandboxExecutionError("sandbox_invalid_request");
  }

  acquire(options: { readonly signal?: AbortSignal } = {}): Promise<() => void> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (options.signal?.aborted)
      return Promise.reject(new SandboxExecutionError("sandbox_aborted"));
    if (!this.#active) {
      this.#active = true;
      return Promise.resolve(this.release());
    }
    if (this.#queue.length >= this.capacity)
      return Promise.reject(new SandboxExecutionError("sandbox_queue_full"));
    return new Promise((resolve, reject) => {
      const remove = (code: "sandbox_aborted" | "sandbox_admission_timeout") => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        waiter.dispose();
        reject(new SandboxExecutionError(code));
      };
      const abort = () => remove("sandbox_aborted");
      const timer = setTimeout(() => remove("sandbox_admission_timeout"), this.timeoutMs);
      timer.unref();
      const waiter: Waiter = {
        resolve,
        reject,
        dispose: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        },
      };
      this.#queue.push(waiter);
      options.signal?.addEventListener("abort", abort, { once: true });
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
        return;
      }
      this.#active = false;
      for (const resolve of this.#idle.splice(0)) resolve();
    };
  }
}
