import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BashRequestClass, CommandClass } from "./bash/contracts.js";
import type { ApprovalUi, JsonObject, SessionGrantScope } from "./policy-engine.js";

const COMMAND_CLASS_LABELS: Readonly<Record<CommandClass, string>> = Object.freeze({
  known_read_only: "known read-only",
});

const COMMAND_CLASS_SESSION_CHOICES: Readonly<Record<CommandClass, string>> = Object.freeze({
  known_read_only: "Allow known read-only commands for session",
});

export function commandClassLabel(commandClass: CommandClass): string {
  return COMMAND_CLASS_LABELS[commandClass];
}

/** A classified request names its class, for example `bash (known read-only)`. */
export function approvalSubjectLabel(subject: string, commandClass?: BashRequestClass): string {
  // Configured calls only prompt when whole-call coverage failed; do not imply approval.
  if (commandClass === "configured_command") return subject;
  return commandClass === undefined || commandClass === "unclassified"
    ? subject
    : `${subject} (${COMMAND_CLASS_LABELS[commandClass]})`;
}

export function sessionGrantChoice(scope: SessionGrantScope): string {
  return scope === "tool" ? "Allow for session" : COMMAND_CLASS_SESSION_CHOICES[scope];
}

const ELLIPSIS = "…";

function displayText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ");
}

/** Keep whole characters within `contentBytes`, then append an ellipsis. */
function truncatedDisplayText(clean: string, contentBytes: number): string {
  let bounded = "";
  let size = 0;
  for (const character of clean) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > contentBytes) break;
    bounded += character;
    size += bytes;
  }
  return `${bounded}${ELLIPSIS}`;
}

/** Replace terminal controls and bound UTF-8 size; truncated text ends with an ellipsis within the bound. */
export function boundedDisplayText(value: string, maximumBytes: number): string {
  const clean = displayText(value);
  return Buffer.byteLength(clean) <= maximumBytes
    ? clean
    : truncatedDisplayText(clean, maximumBytes - Buffer.byteLength(ELLIPSIS));
}

/** Previews longer than 1024 bytes keep 1024 bytes and gain an ellipsis. */
const APPROVAL_PREVIEW_BYTES = 1024;

/** Nested tools have no independent TUI card: the prompt must identify the operation. */
export function approvalPreview(label: string, args: JsonObject): string {
  const identifying =
    typeof args.path === "string"
      ? args.path
      : typeof args.command === "string"
        ? args.command
        : JSON.stringify(args);
  const clean = displayText(identifying);
  const preview =
    Buffer.byteLength(clean) <= APPROVAL_PREVIEW_BYTES
      ? clean
      : truncatedDisplayText(clean, APPROVAL_PREVIEW_BYTES);
  return `${label}: ${preview}`;
}

export function approvalUi(ctx: ExtensionContext): ApprovalUi | undefined {
  if (!ctx.hasUI) return undefined;
  return {
    async prompt(prompt, signal) {
      const session = sessionGrantChoice(prompt.sessionGrantScope);
      const choices = prompt.allowForSession
        ? ["Allow once", session, "Deny"]
        : ["Allow once", "Deny"];
      const selected = await ctx.ui.select(`Allow ${prompt.request.display}?`, choices, { signal });
      return selected === "Allow once"
        ? "allow_once"
        : selected === session
          ? "allow_session"
          : "deny";
    },
  };
}
