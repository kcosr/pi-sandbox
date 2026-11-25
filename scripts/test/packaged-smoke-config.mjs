import { readFile, writeFile } from "node:fs/promises";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";

const SANDBOX_TOOL_NAMES = Object.freeze(["read", "grep", "find", "ls", "write", "edit", "bash"]);

/** Replace authored modes with the writable baseline shared by packaged smoke scenarios. */
export function prepareWritableSmokeWorkspace(config) {
  if (typeof config.tools !== "object" || config.tools === null || Array.isArray(config.tools)) {
    throw new Error("packaged administrative config has no tool policy table");
  }
  const workspace = config.workspace;
  if (!workspace?.modes || !Object.hasOwn(workspace.modes, workspace.default)) {
    throw new Error("packaged administrative config has no authored default workspace mode");
  }
  // The builder already validated every definition. Materialize only the authored
  // default for this isolated test fixture; a tool overlay replaces the whole policy.
  const selected = workspace.modes[workspace.default];
  config.tools = { ...config.tools, ...selected.tools };
  config.filesystem = { ...config.filesystem, ...selected.filesystem, cwd_writable: true };
  config.exports = { enabled: false };
  // Other smoke scenarios mutate common policy; workspace-mode acceptance supplies its own overlays.
  config.workspace = { default: "host", allowed: ["host"], modes: { host: {} } };
  return config;
}

export async function prepareHostIndependentSmokeConfig(configPath, hiddenFile, decoyHome) {
  const config = prepareWritableSmokeWorkspace(parseToml(await readFile(configPath, "utf8")));
  // The build host need not carry executables required only on the target system.
  // Audit is disabled for this isolated local-source runtime smoke.
  // The release builder already validates the real selected extension config and inventory;
  // this smoke test exercises the packaged Pi application with its core sandbox tools.
  config.audit = { ...config.audit, enabled: false };
  config.audit.tools = Object.fromEntries(
    SANDBOX_TOOL_NAMES.map((name) => [name, config.audit.tools[name]]),
  );
  config.sessions = { retention_days: 365 };
  const masksFile = config.execution?.backend === "bubblewrap";
  if (masksFile) {
    config.filesystem.hidden_paths = [
      hiddenFile,
      "~/.private-home-credentials",
      "~/.gitconfig",
      "~/missing-config/nested",
    ];
  }
  config.environment = {
    pi: { PI_CODING_AGENT_DIR: "~/.pi-state", HOME: decoyHome },
    sandbox: { HOME_EXPANSION_CHECK: "~/cache" },
    extensions: {},
  };
  config.extensions = {};
  delete config.subagents;
  config.tools = Object.fromEntries(
    SANDBOX_TOOL_NAMES.map((name) => {
      const policy = config.tools[name];
      if (policy === undefined) {
        throw new Error(`packaged administrative config is missing tools.${name}`);
      }
      return [name, policy];
    }),
  );
  await writeFile(configPath, stringifyToml(config), { mode: 0o644 });
  return masksFile;
}
