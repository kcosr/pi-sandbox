import { readFile, writeFile } from "node:fs/promises";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";

const SANDBOX_TOOL_NAMES = Object.freeze(["read", "grep", "find", "ls", "write", "edit", "bash"]);

export async function prepareHostIndependentSmokeConfig(configPath, hiddenFile, decoyHome) {
  const config = parseToml(await readFile(configPath, "utf8"));
  const tools = config.tools;
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
    throw new Error("packaged administrative config has no tool policy table");
  }
  // The build host need not carry executables required only on the target system.
  // It also need not run the production identity broker or audit collector.
  // The release builder already validates the real selected extension config and inventory;
  // this smoke test exercises the packaged Pi application with its core sandbox tools.
  config.identity = { mode: "disabled" };
  config.audit = { ...config.audit, enabled: false };
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
  config.tools = Object.fromEntries(
    SANDBOX_TOOL_NAMES.map((name) => {
      const policy = tools[name];
      if (policy === undefined) {
        throw new Error(`packaged administrative config is missing tools.${name}`);
      }
      return [name, policy];
    }),
  );
  await writeFile(configPath, stringifyToml(config), { mode: 0o644 });
  return masksFile;
}
