import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { SubagentSessionRequest } from "./contracts.js";
import { MAXIMUM_TIMER_MS } from "./config.js";

function parentUI(request: SubagentSessionRequest): ExtensionUIContext | undefined {
  try {
    if (request.signal.aborted || !request.isCurrent() || !request.parentContext.hasUI)
      return undefined;
    // Context getters remain live across turns and reject a disposed/replaced runner.
    return request.parentContext.ui;
  } catch {
    return undefined;
  }
}

function forward<T>(
  request: SubagentSessionRequest,
  options: ExtensionUIDialogOptions | undefined,
  fallback: T,
  invoke: (ui: ExtensionUIContext, options: ExtensionUIDialogOptions) => Promise<T>,
): Promise<T> {
  if (options?.signal?.aborted) return Promise.resolve(fallback);
  const ui = parentUI(request);
  if (!ui) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const forwarded = new AbortController();
    const signals = new Set([request.signal, ...(options?.signal ? [options.signal] : [])]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener("abort", cancel);
      resolve(value);
    };
    const cancel = () => {
      finish(fallback);
      // Dismiss the parent's supported dialog as well as settling the child.
      forwarded.abort();
    };
    for (const signal of signals) signal.addEventListener("abort", cancel, { once: true });
    if ([...signals].some((signal) => signal.aborted) || !parentUI(request)) {
      cancel();
      return;
    }
    // Add a local deadline only when JavaScript can represent it. Other values
    // retain the parent's interpretation instead of becoming an accidental 1 ms timer.
    const timeout = options?.timeout;
    if (
      timeout !== undefined &&
      Number.isFinite(timeout) &&
      timeout > 0 &&
      timeout <= MAXIMUM_TIMER_MS
    )
      timer = setTimeout(cancel, timeout);
    try {
      void invoke(ui, { ...options, signal: forwarded.signal }).then((value) => {
        if (!parentUI(request)) cancel();
        else finish(value);
      }, cancel);
    } catch {
      cancel();
    }
  });
}

/** Preserve the child's no-op UI except for the three cancellable dialog methods. */
export function createForwardedDialogUI(
  request: SubagentSessionRequest,
  childUI: ExtensionUIContext,
): ExtensionUIContext | undefined {
  if (!parentUI(request)) return undefined;
  return {
    ...childUI,
    select: (title, choices, options) =>
      forward<string | undefined>(request, options, undefined, (ui, forwarded) =>
        ui.select(title, choices, forwarded),
      ),
    confirm: (title, message, options) =>
      forward(request, options, false, (ui, forwarded) => ui.confirm(title, message, forwarded)),
    input: (title, placeholder, options) =>
      forward<string | undefined>(request, options, undefined, (ui, forwarded) =>
        ui.input(title, placeholder, forwarded),
      ),
  };
}
