import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "../domain/index.js";
import { SUBAGENT_TOOL_NAMES, managedToolPolicySubject } from "../domain/subagents.js";
import { isManagedToolSelected, managedExtensionSelection } from "../runtime/arguments.js";
import {
  loadExtensionPreferences,
  type ExtensionPreferences,
} from "../extension-preferences/index.js";

export async function createOptionalExtensions(options: {
  pi: ExtensionAPI;
  config: SandboxConfig;
  agentDir: string;
  args: readonly string[];
  definitions: Map<string, ToolDefinition>;
  originals: ReadonlyMap<string, ToolDefinition>;
  desiredActive: Set<string>;
}): Promise<ExtensionPreferences> {
  const { pi, config, args, definitions, originals, desiredActive } = options;
  const overrides = managedExtensionSelection(args).overrides;
  const groups = [
    {
      id: "subagents",
      label: "Subagents",
      toolNames: SUBAGENT_TOOL_NAMES,
      configured: config.subagents?.enabled === true,
    },
    ...Object.values(config.extensions).map((extension) => ({
      id: extension.id,
      label: extension.id === "git" ? "Git" : extension.id,
      toolNames: extension.toolNames,
      configured: true,
    })),
  ];
  for (const id of overrides.keys()) {
    if (!groups.some((group) => group.id === id))
      throw new Error(`Unknown configured optional extension: ${id}`);
  }
  const descriptors = groups.map((group) => ({
    id: group.id,
    label: group.label,
    toolNames: group.toolNames,
    adminEnabled:
      group.configured &&
      group.toolNames.some((name) => {
        const policy = config.tools[managedToolPolicySubject(name)];
        return (
          policy !== undefined && policy.mode !== "disabled" && isManagedToolSelected(args, name)
        );
      }),
    ...(overrides.has(group.id) ? { cliEnabled: overrides.get(group.id)! } : {}),
  }));
  const preferences = await loadExtensionPreferences({
    agentDir: options.agentDir,
    descriptors,
    onChange(id, enabled) {
      const group = groups.find((candidate) => candidate.id === id)!;
      const active = new Set(pi.getActiveTools());
      for (const name of group.toolNames) {
        if (!enabled) {
          if (active.has(name)) desiredActive.add(name);
          else desiredActive.delete(name);
          active.delete(name);
        }
        const original = originals.get(name);
        if (original === undefined) continue;
        const definition = enabled ? original : { ...original, exposure: "hidden" as const };
        definitions.set(name, definition);
        pi.registerTool(definition);
        if (enabled && desiredActive.has(name)) active.add(name);
      }
      pi.setActiveTools([...active].filter((name) => preferences.permitsTool(name)));
    },
  });
  return preferences;
}

/** Guidance follows effective tool exposure, including a child's narrower tool set. */
export function optionalExtensionGuidance(
  config: SandboxConfig | undefined,
  preferences: ExtensionPreferences | undefined,
  active: ReadonlySet<string>,
): string | undefined {
  if (config?.extensionGuidance === undefined || preferences === undefined) return undefined;
  const sections = Object.entries(config.extensionGuidance).flatMap(([id, guidance]) => {
    const names =
      id === "subagents" ? SUBAGENT_TOOL_NAMES : (config.extensions[id]?.toolNames ?? []);
    return preferences.enabled(id) && names.some((name) => active.has(name)) ? [guidance] : [];
  });
  return sections.length === 0 ? undefined : sections.join("\n\n");
}
