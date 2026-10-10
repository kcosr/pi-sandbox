const MANAGED_COMMANDS = new Set([
  "config",
  "install",
  "list",
  "mcp",
  "remove",
  "uninstall",
  "update",
]);

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

/** Reject caller input that could alter trusted code loading or manage packages or MCP servers. */
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

interface ManagedToolSelection {
  readonly noTools: boolean;
  readonly allowlist: ReadonlySet<string> | undefined;
  readonly denylist: ReadonlySet<string> | undefined;
}

/** Match the tool flags accepted by the pinned Pi argument parser. */
function managedToolSelection(args: readonly string[]): ManagedToolSelection {
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
  return { noTools, allowlist, denylist };
}

function permitsTool(selection: ManagedToolSelection, name: string): boolean {
  return (
    !selection.noTools &&
    (selection.allowlist === undefined || selection.allowlist.has(name)) &&
    selection.denylist?.has(name) !== true
  );
}

/** CLI selection is an availability ceiling, independent of the user's initial tool defaults. */
export function isManagedToolSelected(args: readonly string[], name: string): boolean {
  return permitsTool(managedToolSelection(args), name);
}

/** Resolve Pi's already-merged defaultTools setting, retaining the managed tool defaults. */
export function selectManagedActiveTools<T extends string>(
  args: readonly string[],
  enabledTools: ReadonlySet<T>,
  defaultTools?: unknown,
): T[] {
  const selection = managedToolSelection(args);
  const defaults = [...enabledTools].filter((name) => name !== "codemode");
  let active = new Set<string>(defaults);
  if (defaultTools !== undefined) {
    // Pi tolerates malformed settings as an empty list and ignores non-string entries.
    const entries: string[] = Array.isArray(defaultTools)
      ? defaultTools.filter((entry): entry is string => typeof entry === "string")
      : [];
    const plain = entries.filter((entry) => !entry.startsWith("+") && !entry.startsWith("-"));
    active = new Set(plain.length > 0 || entries.length === 0 ? plain : defaults);
    for (const entry of entries) {
      const name = entry.slice(1);
      if (entry.startsWith("+") && name.length > 0) active.add(name);
      else if (entry.startsWith("-")) active.delete(name);
    }
  }
  // An explicit CLI allowlist replaces defaults; exclusions still apply to every activation.
  if (selection.allowlist !== undefined) active = new Set(selection.allowlist);
  return [...enabledTools].filter((name) => active.has(name) && permitsTool(selection, name));
}
