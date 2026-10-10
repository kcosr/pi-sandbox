import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
// Build-time reuse only: the package build bundles this runner privately.
import { createHostCommandExecutor } from "../../sandbox-extension/src/runtime/host-command/host-command-executor.js";
import { readGitConfig, type GitExtensionConfig } from "./config.js";
import {
  gitHostEnvironment,
  parseGitCloneConfig,
  requiredGitExecutables,
  type GitCloneRuntime,
  type GitExecutionPort,
} from "./core.js";
import { createGitExtension } from "./factory.js";

interface OwnedGitRunner extends GitExecutionPort {
  close(): Promise<void>;
}
export interface GitEntryDependencies {
  readonly readConfig?: (file: string) => Promise<GitExtensionConfig>;
  readonly canonical?: (cwd: string) => Promise<string>;
  readonly prerequisites?: (executables: readonly string[]) => Promise<void>;
  readonly create?: (
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ) => Promise<OwnedGitRunner>;
}

async function requireExecutables(executables: readonly string[]): Promise<void> {
  for (const executable of executables) {
    if (!(await stat(executable)).isFile())
      throw new Error("Git prerequisite is not a regular file");
    await access(executable, constants.X_OK);
  }
}

/** Only this entry owns a runner; the public factory and core borrow execution. */
export function createConfiguredGitExtension(
  dependencies: GitEntryDependencies = {},
): ExtensionFactory {
  return async (pi) => {
    let runtime: GitCloneRuntime | undefined;
    let runner: OwnedGitRunner | undefined;
    let starting: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let ended = false;
    const environment = gitHostEnvironment(process.env);
    const close = async (): Promise<void> => {
      runtime = undefined;
      if (runner) {
        closing ??= runner.close();
        await closing;
      }
    };
    pi.registerFlag("git-config", {
      type: "string",
      description: "Absolute path to an explicit private Git JSON configuration",
    });
    await createGitExtension({
      getRuntime() {
        if (!runtime || ended) throw new Error("Git extension is unavailable");
        return runtime;
      },
    })(pi);
    pi.on("session_start", (_event, ctx) => {
      if (ended) return;
      starting ??= (async () => {
        try {
          const file = pi.getFlag("git-config");
          if (typeof file !== "string" || !file) throw new Error("--git-config is required");
          const { allowed_hosts, allowed_schemes } = await (
            dependencies.readConfig ?? readGitConfig
          )(file);
          const config = parseGitCloneConfig({ allowed_hosts, allowed_schemes });
          const cwd = await (dependencies.canonical ?? realpath)(ctx.cwd);
          runner = await (
            dependencies.create ??
            ((cwd, environment) => Promise.resolve(createHostCommandExecutor({ cwd, environment })))
          )(cwd, environment);
          await (dependencies.prerequisites ?? requireExecutables)(requiredGitExecutables(config));
          if (!ended) runtime = Object.freeze({ cwd, config, host: runner });
        } catch {
          ended = true;
          try {
            await close();
          } finally {
            ctx.ui.notify(
              "Git startup failed. Check --git-config and host prerequisites.",
              "error",
            );
            ctx.shutdown();
          }
        }
      })();
      return starting;
    });
    pi.on("session_shutdown", async () => {
      ended = true;
      runtime = undefined;
      try {
        await starting;
      } finally {
        await close();
      }
    });
  };
}
