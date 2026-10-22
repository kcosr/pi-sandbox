import {
  TOOL_NAMES,
  WORKSPACE_MODES,
  type AdministrativeConfig,
  type AdministrativeToolPolicies,
  type SandboxConfig,
  type ToolPolicy,
  type WorkspaceMode,
  type WorkspaceToolPolicy,
} from "../domain/index.js";
import { commandClassPreconditionIssues } from "../permissions/command-classes.js";

function workspaceToolPolicies(
  tools: AdministrativeToolPolicies,
  mode: WorkspaceMode,
): Readonly<Record<string, ToolPolicy>> {
  const projected: Record<string, ToolPolicy> = {};
  for (const [name, policy] of Object.entries(tools)) {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) {
      projected[name] = policy as ToolPolicy;
      continue;
    }
    const workspace = policy as WorkspaceToolPolicy;
    const branch = mode === "read_only" ? workspace.readOnly : workspace.readWrite;
    projected[name] = Object.freeze(
      workspace.enabled
        ? { ...branch, audit: workspace.audit }
        : { mode: "disabled", sessionGrant: "never", audit: workspace.audit },
    );
  }
  return Object.freeze(projected);
}

/** Validate both authored branches, never only the branch chosen for this process. */
export function administrativeToolPolicyIssues(tools: AdministrativeToolPolicies): string[] {
  const issues: string[] = [];
  for (const mode of WORKSPACE_MODES) {
    // Keep Bash's class policy even if disabled, so disabling it cannot conceal invalid policy.
    const projected = { ...workspaceToolPolicies(tools, mode) };
    const bash = tools.bash as WorkspaceToolPolicy | undefined;
    if (bash !== undefined) {
      const branch = mode === "read_only" ? bash.readOnly : bash.readWrite;
      projected.bash = { ...branch, audit: bash.audit };
    }
    issues.push(...commandClassPreconditionIssues(projected, `config.tools[${mode}]`));
  }
  return issues;
}

/** Shared by parsing, identity overlays and the final startup projection. */
export function administrativeConfigIssues(config: AdministrativeConfig<unknown>): string[] {
  const issues = administrativeToolPolicyIssues(config.tools);
  const { cwdDefault, cwdAllowed } = config.filesystem;
  if (
    cwdAllowed.length === 0 ||
    new Set(cwdAllowed).size !== cwdAllowed.length ||
    cwdAllowed.some((mode) => !WORKSPACE_MODES.includes(mode))
  )
    issues.push("config.filesystem.cwd_allowed must contain unique workspace modes");
  if (!cwdAllowed.includes(cwdDefault))
    issues.push("config.filesystem.cwd_default must be included in config.filesystem.cwd_allowed");
  if (config.execution.backend === "direct") {
    if (cwdAllowed.length !== 1 || cwdAllowed[0] !== "read_write")
      issues.push(
        'config.filesystem.cwd_allowed must be ["read_write"] when config.execution.backend is "direct"',
      );
    if (config.network.mode !== "host")
      issues.push('config.network.mode must be "host" when config.execution.backend is "direct"');
  }
  if (config.execution.backend !== "bubblewrap" && config.filesystem.hiddenPaths.length > 0)
    issues.push("config.filesystem.hidden_paths requires the bubblewrap backend");
  if (config.execution.backend !== "seatbelt" && config.filesystem.deniedPaths.length > 0)
    issues.push("config.filesystem.denied_paths requires the seatbelt backend");
  if (config.execution.backend === "seatbelt" && config.network.mode === "local")
    issues.push(
      'config.network.mode must be "none" or "host" when config.execution.backend is "seatbelt"',
    );
  return issues;
}

export function projectWorkspaceMode<PiValue>(
  config: AdministrativeConfig<PiValue>,
  requestedMode?: WorkspaceMode,
): SandboxConfig<PiValue> {
  const issues = administrativeConfigIssues(config);
  if (issues.length > 0)
    throw new Error(`effective administrative policy is invalid: ${issues.join("; ")}`);
  const mode = requestedMode ?? config.filesystem.cwdDefault;
  if (!config.filesystem.cwdAllowed.includes(mode))
    throw new Error(`workspace mode ${mode} is not permitted by the administrative policy`);
  return Object.freeze({
    ...config,
    filesystem: Object.freeze({
      cwdWritable: mode === "read_write",
      hiddenPaths: config.filesystem.hiddenPaths,
      deniedPaths: config.filesystem.deniedPaths,
    }),
    tools: workspaceToolPolicies(config.tools, mode),
    workspace: Object.freeze({
      mode,
      default: config.filesystem.cwdDefault,
      allowed: Object.freeze([...config.filesystem.cwdAllowed]),
      source: requestedMode === undefined ? "default" : "flag",
    }),
  });
}
