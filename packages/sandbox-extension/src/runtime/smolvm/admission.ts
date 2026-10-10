import { SandboxExecutionError } from "../contracts.js";

interface Waiter {
  readonly exclusive: boolean;
  readonly deadline: number;
  readonly timeoutCode: "sandbox_admission_timeout" | "sandbox_timeout";
  resolve(release: () => void): void;
  reject(error: unknown): void;
  dispose(): void;
}

interface AdmissionOptions {
  readonly signal?: AbortSignal;
  readonly exclusive?: boolean;
  /** Monotonic request deadline, including time spent waiting for admission. */
  readonly deadline?: number;
}

/** Bounded parallel execution with FIFO exclusive lifecycle operations. */
export class AdmissionQueue {
  readonly #queue: Waiter[] = [];
  #active = 0;
  #exclusive = false;
  #failure: SandboxExecutionError | undefined;
  readonly #idle: (() => void)[] = [];

  readonly #capacity: number;
  readonly #concurrency: number;
  readonly #timeoutMs: number;

  constructor(
    options: {
      readonly capacity?: number;
      readonly concurrency?: number;
      readonly timeoutMs?: number;
    } = {},
  ) {
    this.#capacity = options.capacity ?? 64;
    this.#concurrency = options.concurrency ?? 4;
    this.#timeoutMs = options.timeoutMs ?? 600_000;
    if (
      ![this.#capacity, this.#concurrency, this.#timeoutMs].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      this.#concurrency > this.#capacity ||
      this.#timeoutMs > 2_147_483_647
    )
      throw new SandboxExecutionError("sandbox_invalid_request");
  }

  /** Call before copying request input; acquire repeats the check atomically. */
  assertAvailable(options: { readonly signal?: AbortSignal } = {}): void {
    if (this.#failure) throw this.#failure;
    if (options.signal?.aborted) throw new SandboxExecutionError("sandbox_aborted");
    if (this.#active + this.#queue.length >= this.#capacity)
      throw new SandboxExecutionError("sandbox_queue_full");
  }

  acquire(options: AdmissionOptions = {}): Promise<() => void> {
    try {
      this.assertAvailable(options);
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new SandboxExecutionError("sandbox_invalid_request", { cause: error }),
      );
    }
    const timeoutMs =
      options.deadline === undefined ? this.#timeoutMs : options.deadline - performance.now();
    const timeoutCode =
      options.deadline === undefined ? "sandbox_admission_timeout" : "sandbox_timeout";
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new SandboxExecutionError(timeoutCode));
    const exclusive = options.exclusive === true;
    if (!this.#queue.length && this.canAdmit(exclusive))
      return Promise.resolve(this.admit(exclusive));
    return new Promise((resolve, reject) => {
      const remove = (code: "sandbox_aborted" | typeof timeoutCode) => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        waiter.dispose();
        reject(new SandboxExecutionError(code));
        this.drain();
      };
      const abort = () => remove("sandbox_aborted");
      const timer = setTimeout(() => remove(timeoutCode), Math.min(timeoutMs, 2_147_483_647));
      timer.unref();
      const waiter: Waiter = {
        exclusive,
        deadline: performance.now() + timeoutMs,
        timeoutCode,
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

  private canAdmit(exclusive: boolean): boolean {
    return !this.#exclusive && this.#active < (exclusive ? 1 : this.#concurrency);
  }

  private drain(): void {
    while (!this.#failure && this.#queue.length) {
      const next = this.#queue[0]!;
      if (next.deadline <= performance.now()) {
        this.#queue.shift();
        next.dispose();
        next.reject(new SandboxExecutionError(next.timeoutCode));
        continue;
      }
      if (!this.canAdmit(next.exclusive)) break;
      this.#queue.shift();
      next.dispose();
      next.resolve(this.admit(next.exclusive));
    }
    if (!this.#active) for (const resolve of this.#idle.splice(0)) resolve();
  }

  private admit(exclusive: boolean): () => void {
    this.#active++;
    this.#exclusive = exclusive;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      if (exclusive) this.#exclusive = false;
      this.drain();
    };
  }
}
