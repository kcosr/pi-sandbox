import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Quiescence failure must block saving, but cannot permanently trap an interactive session. */
export async function beforeManagedQuit(
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  options: {
    readonly quiesce: () => Promise<void>;
    readonly canSave: () => boolean;
    readonly beforeQuit: (ctx: ExtensionCommandContext, signal: AbortSignal) => Promise<boolean>;
  },
): Promise<boolean> {
  if (signal.aborted) return false;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<"cancelled">((resolve) => {
    onAbort = () => resolve("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let outcome: "settled" | "failed" | "cancelled";
  try {
    outcome = await Promise.race([
      Promise.resolve()
        .then(options.quiesce)
        .then(
          () => "settled" as const,
          () => "failed" as const,
        ),
      cancelled,
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted || outcome === "cancelled") return false;
  if (outcome === "settled") return options.beforeQuit(ctx, signal);
  if (ctx.mode !== "tui" || !ctx.hasUI) return false;

  const canSave = options.canSave();
  const exit = canSave ? "Exit without saving" : "Exit anyway";
  const title =
    "Subagents have not finished stopping or cleanup." +
    (canSave ? "\nPrivate files cannot be safely saved while their work is unsettled." : "") +
    "\nExit now, or keep the session open to inspect them?";
  const selected = await ctx.ui.select(title, ["Keep session open", exit], { signal });
  return !signal.aborted && selected === exit;
}
