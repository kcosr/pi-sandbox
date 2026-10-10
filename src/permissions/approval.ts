import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalUi, JsonObject } from "./policy-engine.js";

/** Nested tools have no independent TUI card: the prompt must identify the operation. */
export function approvalPreview(label: string, args: JsonObject): string {
  const identifying =
    typeof args.path === "string"
      ? args.path
      : typeof args.command === "string"
        ? args.command
        : JSON.stringify(args);
  const clean = identifying.replace(/[\p{Cc}\p{Cf}]/gu, " ");
  let preview = "";
  for (const character of clean) {
    if (Buffer.byteLength(preview) + Buffer.byteLength(character) > 1024) {
      preview += "…";
      break;
    }
    preview += character;
  }
  return `${label}: ${preview}`;
}

export function approvalUi(ctx: ExtensionContext): ApprovalUi | undefined {
  if (!ctx.hasUI) return undefined;
  return {
    async prompt(prompt, signal) {
      const choices = prompt.allowForSession
        ? ["Allow once", "Allow for session", "Deny"]
        : ["Allow once", "Deny"];
      const selected = await ctx.ui.select(`Allow ${prompt.request.display}?`, choices, { signal });
      return selected === "Allow once"
        ? "allow_once"
        : selected === "Allow for session"
          ? "allow_session"
          : "deny";
    },
  };
}
