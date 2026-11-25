import type {
  AuthoredSandboxConfig,
  SandboxConfig,
  WorkspaceAccess,
  WorkspaceOverrides,
  WorkspaceSelection,
} from "../domain/index.js";

export const MAXIMUM_WORKSPACE_MODES = 32;

export function isWorkspaceModeName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/u.test(value);
}

/** Selection metadata is resolved independently from ordinary account policy. */
export function resolveWorkspaceAccess<PiValue>(
  authored: AuthoredSandboxConfig<PiValue>,
  overrides?: WorkspaceOverrides,
): WorkspaceAccess {
  const { modes } = authored.workspace;
  const allowed = overrides?.allowed ?? authored.workspace.allowed;
  const defaultName = overrides?.default ?? authored.workspace.default;
  if (allowed.length === 0) throw new Error("No workspace mode is selectable for this account");
  if (
    allowed.length > MAXIMUM_WORKSPACE_MODES ||
    !allowed.every(isWorkspaceModeName) ||
    new Set(allowed).size !== allowed.length
  )
    throw new Error("Effective workspace allowed modes must be at most 32 distinct identifiers");
  for (const name of allowed) {
    if (!Object.hasOwn(modes, name))
      throw new Error(
        `Effective workspace allowed list names an undefined mode: ${JSON.stringify(name)}`,
      );
  }
  if (!isWorkspaceModeName(defaultName) || !Object.hasOwn(modes, defaultName))
    throw new Error(`Effective workspace default is undefined: ${JSON.stringify(defaultName)}`);
  if (!allowed.includes(defaultName))
    throw new Error(
      `Effective workspace default ${JSON.stringify(defaultName)} is not selectable. Allowed modes: ${[...allowed].sort().join(", ")}`,
    );
  return Object.freeze({
    default: defaultName,
    allowed: Object.freeze(
      [...allowed].sort().map((name) =>
        Object.freeze({
          name,
          ...(modes[name]!.description === undefined
            ? {}
            : { description: modes[name]!.description }),
        }),
      ),
    ),
  });
}

export function resolveWorkspaceSelection<PiValue>(
  authored: AuthoredSandboxConfig<PiValue>,
  overrides?: WorkspaceOverrides,
  requestedName?: string,
): WorkspaceAccess & {
  readonly config: SandboxConfig<PiValue>;
  readonly selection: WorkspaceSelection;
} {
  const access = resolveWorkspaceAccess(authored, overrides);
  const name = requestedName ?? access.default;
  const summary = access.allowed.find((mode) => mode.name === name);
  if (summary === undefined)
    throw new Error(
      `Workspace mode ${JSON.stringify(name)} is not selectable. Allowed modes: ${access.allowed.map((mode) => mode.name).join(", ")}`,
    );
  return Object.freeze({
    ...access,
    config: authored.workspace.modes[name]!.config,
    selection: Object.freeze({
      ...summary,
      source: requestedName === undefined ? "default" : "cli",
    }),
  });
}
