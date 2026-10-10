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

// Pinned Pi options that consume the next argument even when it starts with '-'.
const VALUE_ARGUMENTS = new Set([
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
]);

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
  managedToolSelection(args);
}

export function createManagedPiArguments(args: readonly string[]): string[] {
  validateManagedArguments(args);
  if (args[0] === "auth") {
    return ["auth", ...args.slice(1), "--offline", "--no-extensions", "--no-builtin-tools"];
  }
  return ["--offline", "--no-extensions", "--no-builtin-tools", ...args];
}

function* managedArguments(
  args: readonly string[],
): Generator<readonly [string, string | undefined]> {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") break;
    yield [argument, VALUE_ARGUMENTS.has(argument) ? args[++index] : undefined];
  }
}

/** Suppress managed MCP connections when the user selects Pi's --no-mcp flag. */
export function isManagedMcpSelected(args: readonly string[]): boolean {
  return ![...managedArguments(args)].some(([argument]) => argument === "--no-mcp");
}

function commaSeparatedTools(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function isToolModifier(entry: string): boolean {
  return entry.startsWith("+") || entry.startsWith("-");
}

function applyToolModifiers(active: Set<string>, entries: readonly string[]): void {
  for (const entry of entries) {
    const name = entry.slice(1);
    if (entry.startsWith("+") && name.length > 0) active.add(name);
    else if (entry.startsWith("-")) active.delete(name);
  }
}

/** Pi's CLI patterns support only '*' as a wildcard; all other characters are literal. */
function matchesTool(patterns: readonly string[] | undefined, name: string): boolean {
  return (
    patterns?.some((pattern) => {
      if (!pattern.includes("*")) return pattern === name;
      const source = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(`^${source}$`).test(name);
    }) ?? false
  );
}

interface ManagedToolSelection {
  readonly noTools: boolean;
  readonly allowlist: readonly string[] | undefined;
  readonly denylist: readonly string[] | undefined;
  readonly modifiers: readonly string[];
}

/** Match the tool flags accepted by the pinned Pi argument parser. */
function managedToolSelection(args: readonly string[]): ManagedToolSelection {
  let noTools = false;
  let allowlist: string[] | undefined;
  let denylist: string[] | undefined;
  let modifiers: string[] = [];
  for (const [argument, value] of managedArguments(args)) {
    if (argument === "--no-tools" || argument === "-nt") {
      noTools = true;
    } else if ((argument === "--tools" || argument === "-t") && value !== undefined) {
      const entries = commaSeparatedTools(value);
      modifiers = entries.filter(isToolModifier);
      if (modifiers.length > 0 && modifiers.length !== entries.length) {
        throw new Error(`${argument}: tool names cannot be mixed with +name or -name entries`);
      }
      const pattern = modifiers.find((entry) => entry.includes("*"));
      if (pattern !== undefined) {
        throw new Error(
          `${argument}: +name and -name entries take exact tool names, not patterns: ${pattern}`,
        );
      }
      allowlist = modifiers.length === 0 ? entries : undefined;
    } else if ((argument === "--exclude-tools" || argument === "-xt") && value !== undefined) {
      denylist = commaSeparatedTools(value);
    }
  }
  return { noTools, allowlist, denylist, modifiers };
}

function permitsTool(selection: ManagedToolSelection, name: string): boolean {
  // A final CLI removal is a managed availability ceiling, including MCP/code-mode activation.
  const modifier = selection.modifiers.findLast((entry) => entry.slice(1) === name);
  return (
    !selection.noTools &&
    (selection.allowlist === undefined || matchesTool(selection.allowlist, name)) &&
    !matchesTool(selection.denylist, name) &&
    modifier?.startsWith("-") !== true
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
    const plain = entries.filter((entry) => !isToolModifier(entry));
    active = new Set(plain.length > 0 || entries.length === 0 ? plain : defaults);
    applyToolModifiers(active, entries);
  }
  // Plain CLI lists replace defaults; modifiers change them. Neither can broaden effective policy.
  if (selection.allowlist !== undefined)
    active = new Set([...enabledTools].filter((name) => matchesTool(selection.allowlist, name)));
  else applyToolModifiers(active, selection.modifiers);
  return [...enabledTools].filter((name) => active.has(name) && permitsTool(selection, name));
}
