import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionPreferences, ExtensionPreferenceState } from "./preferences.js";

const HINT = "Use /mcp for MCP servers.";
function description(entry: ExtensionPreferenceState): string {
  return (
    `${entry.enabled ? "On" : "Off"}  ${entry.label} (${entry.id})` +
    (entry.source === "administrator"
      ? " — unavailable under policy or tool selection"
      : entry.source === "command-line"
        ? " — command line"
        : "")
  );
}
function notifyState(ctx: ExtensionCommandContext, preferences: ExtensionPreferences): void {
  const entries = preferences.snapshot();
  ctx.ui.notify(
    [
      "Optional extensions",
      ...(entries.length ? entries.map(description) : ["No optional extensions are configured."]),
      HINT,
    ].join("\n"),
    "info",
  );
}

/** User command only. Toggling availability never unloads code or cancels an active call. */
export function registerExtensionPreferencesCommand(
  pi: ExtensionAPI,
  preferences: ExtensionPreferences,
): void {
  pi.registerCommand("extensions", {
    description: "Enable or disable optional extension tools for this user",
    getArgumentCompletions(prefix) {
      const choices = [
        "list",
        ...preferences
          .snapshot()
          .filter((entry) => entry.editable)
          .flatMap((entry) => [`enable ${entry.id}`, `disable ${entry.id}`]),
      ].filter((value) => value.startsWith(prefix));
      return choices.length ? choices.map((value) => ({ value, label: value })) : null;
    },
    async handler(text, ctx) {
      const args = text.trim().split(/\s+/u).filter(Boolean);
      if (args.length === 1 && args[0] === "list") {
        notifyState(ctx, preferences);
        return;
      }
      if (args.length === 2 && (args[0] === "enable" || args[0] === "disable")) {
        try {
          await preferences.setEnabled(args[1]!, args[0] === "enable");
          notifyState(ctx, preferences);
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : "Could not update extension preferences",
            "error",
          );
        }
        return;
      }
      if (args.length) {
        ctx.ui.notify("Usage: /extensions [list | enable ID | disable ID]", "warning");
        return;
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        notifyState(ctx, preferences);
        return;
      }
      for (;;) {
        const entries = preferences.snapshot();
        if (!entries.length) {
          notifyState(ctx, preferences);
          return;
        }
        const choices = entries.map(description);
        const selected = await ctx.ui.select(`Optional extensions — select to toggle\n${HINT}`, [
          ...choices,
          "Close",
        ]);
        if (selected === undefined || selected === "Close") return;
        const entry = entries[choices.indexOf(selected)];
        if (entry === undefined) return;
        try {
          await preferences.setEnabled(entry.id, !entry.enabled);
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : "Could not update extension preferences",
            "error",
          );
        }
      }
    },
  });
}
