import { SandboxExecutionError } from "../../contracts.js";
import { SmolvmOciTerminalCleanupError } from "./types.js";
import type {
  SmolvmOciTerminal,
  SmolvmOciTerminalLauncher,
  SmolvmOciTerminalOptions,
} from "./types.js";

const invalid = () => new SandboxExecutionError("sandbox_invalid_request");
const closed = () => new SandboxExecutionError("sandbox_closed");

export function validateTerminalSize(columns: number, rows: number): void {
  if (![columns, rows].every((n) => Number.isSafeInteger(n) && n >= 1 && n <= 1000))
    throw invalid();
}

export function validateTerminalOptions(options: SmolvmOciTerminalOptions): void {
  if (
    !options ||
    Object.keys(options).some(
      (key) => !["terminalType", "columns", "rows", "launch", "signal"].includes(key),
    ) ||
    typeof options.terminalType !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9+_.-]{0,63}$/u.test(options.terminalType) ||
    typeof options.launch !== "function" ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  )
    throw invalid();
  validateTerminalSize(options.columns, options.rows);
}

interface Entry {
  readonly machineId: string;
  readonly terminal: SmolvmOciTerminal;
  readonly settled: Promise<void>;
}

/** Family-owned leases; no process or polling loop is created here. */
export class TerminalSessions {
  readonly #entries = new Set<Entry>();
  readonly #failures: { machineId: string; error: unknown }[] = [];

  async open(
    machineId: string,
    request: Omit<Parameters<SmolvmOciTerminalLauncher>[0], "signal">,
    options: SmolvmOciTerminalOptions,
  ): Promise<SmolvmOciTerminal> {
    if (this.#failures.length) throw new SandboxExecutionError("sandbox_process_failed");
    if (this.#entries.size >= 16) throw new SandboxExecutionError("sandbox_queue_full");
    if (options.signal?.aborted) throw new SandboxExecutionError("sandbox_aborted");
    const controller = new AbortController();
    let finished = false;
    let closePromise: Promise<void> | undefined;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // Defer invocation until the entry is registered, including synchronous
    // launchers that trigger an owner close from their startup callback.
    const startup = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw new SandboxExecutionError("sandbox_aborted");
        return options.launch({ ...request, signal: controller.signal });
      })
      .catch((error: unknown) => {
        if (error instanceof SmolvmOciTerminalCleanupError)
          this.#failures.push({ machineId, error });
        throw error;
      });
    const completion = startup
      .then(async (process) => {
        try {
          return await process.completion;
        } catch (error) {
          this.#failures.push({ machineId, error });
          throw error;
        }
      })
      .finally(() => {
        finished = true;
        settle();
        this.#entries.delete(entry);
        options.signal?.removeEventListener("abort", abort);
      });
    // Consumers are allowed to await open before attaching completion handlers.
    void completion.catch(() => undefined);
    const terminal: SmolvmOciTerminal = {
      completion,
      write: async (bytes) => {
        if (finished || controller.signal.aborted) throw closed();
        if (!(bytes instanceof Uint8Array)) throw invalid();
        await (await startup).write(bytes);
      },
      resize: (columns, rows) => {
        validateTerminalSize(columns, rows);
        if (finished || controller.signal.aborted) throw closed();
        // open returns only once startup has completed.
        process.resize(columns, rows);
      },
      close: () => {
        if (!closePromise) {
          controller.abort();
          closePromise = (async () => {
            let child: SmolvmOciTerminal;
            try {
              child = await startup;
            } catch {
              // Launcher rejection guarantees its partially started client was
              // cleaned up. The original error remains on open/completion.
              return;
            }
            try {
              await child.close();
              await completion;
            } catch (error) {
              this.#failures.push({ machineId, error });
              // A failed reap must release lifecycle waiters to report the
              // failure, never deadlock shutdown waiting for an uncertain child.
              settle();
              throw error;
            }
          })();
        }
        return closePromise;
      },
    };
    const entry = { machineId, terminal, settled };
    this.#entries.add(entry);
    const abort = () => {
      void terminal.close().catch(() => undefined);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const process = await startup;
    if (controller.signal.aborted) {
      await terminal.close();
      throw new SandboxExecutionError("sandbox_aborted");
    }
    return terminal;
  }

  /** Called under the family's exclusive queue lease: no new sessions can join. */
  async waitFor(machineId?: string): Promise<void> {
    const entries = [...this.#entries].filter(
      (entry) => !machineId || entry.machineId === machineId,
    );
    await Promise.all(entries.map((entry) => entry.settled));
    const failures = this.#failures.filter(
      (failure) => !machineId || failure.machineId === machineId,
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.error),
        "smolvm_terminal_cleanup_unconfirmed",
      );
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#entries].map((entry) => entry.terminal.close()),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length || this.#failures.length)
      throw new AggregateError(
        [
          ...failures.map((result) => result.reason as unknown),
          ...this.#failures.map((failure) => failure.error),
        ],
        "smolvm_terminal_cleanup_unconfirmed",
      );
  }
}
