const MANAGED_COMMANDS = new Set(["config", "install", "list", "remove", "uninstall", "update"]);

const RESERVED_ARGUMENTS = new Set([
  "--extension",
  "-e",
  "--no-extensions",
  "-ne",
  "--no-builtin-tools",
  "-nbt",
  "--offline",
]);

const RESERVED_PREFIXES = ["--extension=", "--no-extensions=", "--no-builtin-tools=", "--offline="];

export class UnsafeManagedArgumentError extends Error {
  public constructor(argument: string) {
    super(`pi-sandbox does not permit the Pi argument ${JSON.stringify(argument)}`);
    this.name = "UnsafeManagedArgumentError";
  }
}

/** Reject caller input that could alter trusted code loading or enter Pi's package manager. */
export function validateManagedArguments(args: readonly string[]): void {
  const command = args[0];
  if (command !== undefined && MANAGED_COMMANDS.has(command)) {
    throw new UnsafeManagedArgumentError(command);
  }

  for (const argument of args) {
    if (
      RESERVED_ARGUMENTS.has(argument) ||
      RESERVED_PREFIXES.some((prefix) => argument.startsWith(prefix))
    ) {
      throw new UnsafeManagedArgumentError(argument);
    }
  }
}

export function createManagedPiArguments(args: readonly string[]): string[] {
  validateManagedArguments(args);
  if (args[0] === "auth") {
    return ["auth", ...args.slice(1), "--offline", "--no-extensions", "--no-builtin-tools"];
  }
  return ["--offline", "--no-extensions", "--no-builtin-tools", ...args];
}

function commaSeparatedTools(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}

/** Mirror Pi's tool-selection flags so tools registered at session_start honor the caller's choice. */
export function selectManagedActiveTools<T extends string>(
  args: readonly string[],
  enabledTools: ReadonlySet<T>,
): T[] {
  let noTools = false;
  let allowlist: Set<string> | undefined;
  let denylist: Set<string> | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-tools" || argument === "-nt") {
      noTools = true;
    } else if ((argument === "--tools" || argument === "-t") && args[index + 1] !== undefined) {
      allowlist = commaSeparatedTools(args[++index] ?? "");
    } else if (
      (argument === "--exclude-tools" || argument === "-xt") &&
      args[index + 1] !== undefined
    ) {
      denylist = commaSeparatedTools(args[++index] ?? "");
    }
  }
  if (noTools) return [];
  return [...enabledTools].filter(
    (name) => (allowlist === undefined || allowlist.has(name)) && denylist?.has(name) !== true,
  );
}
