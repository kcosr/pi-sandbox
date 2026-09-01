const ROOT_RUNTIME_ERROR =
  "refusing to run as root; run pi-sandbox as the intended unprivileged user";

const ROOT_ADMINISTRATIVE_COMMANDS = new Set([
  "--validate-installation",
  "--print-execution-backend",
]);

function effectiveUserId(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

/** Reject root before starting Pi while preserving installer-only validation commands. */
export function assertRuntimeUser(
  args: readonly string[],
  effectiveUid: number | undefined = effectiveUserId(),
): void {
  if (effectiveUid !== 0) return;
  if (args[0] !== undefined && ROOT_ADMINISTRATIVE_COMMANDS.has(args[0])) return;
  throw new Error(ROOT_RUNTIME_ERROR);
}
