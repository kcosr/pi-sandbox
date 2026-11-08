import {
  parseGitCloneConfig,
  type GitCloneConfig,
} from "../../../packages/git-extension/src/core.js";
import type { FrozenJsonObject } from "../contracts.js";

export type GitCloneDestination = "host_cwd" | "sandbox_home";
export interface ManagedGitCloneConfig extends FrozenJsonObject {
  readonly allowed_hosts: GitCloneConfig["allowed_hosts"];
  readonly allowed_schemes: GitCloneConfig["allowed_schemes"];
  readonly destination: GitCloneDestination;
}

/** Destination is managed deployment policy; standalone Git keeps its own contract. */
export function parseManagedGitCloneConfig(
  raw: unknown,
  configPath = "Git configuration",
): ManagedGitCloneConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`${configPath} must be a table`);
  const { destination = "host_cwd", ...policy } = raw as Record<string, unknown>;
  if (destination !== "host_cwd" && destination !== "sandbox_home")
    throw new Error(`${configPath}.destination must be host_cwd or sandbox_home`);
  return Object.freeze({ ...parseGitCloneConfig(policy, configPath), destination });
}

export function gitClonePolicy(config: ManagedGitCloneConfig): GitCloneConfig {
  return Object.freeze({
    allowed_hosts: config.allowed_hosts,
    allowed_schemes: config.allowed_schemes,
  });
}
