import { MAXIMUM_KNOWN_READ_ONLY_VERSION } from "../audit/client.js";
import type { EnvironmentVariables, SandboxConfig } from "../domain/index.js";
import { createBashCommandAnalyzer } from "../permissions/bash/analyzer.js";
import type {
  BashCommandAnalyzer,
  BashExecutionContext,
  CreateBashCommandAnalyzer,
} from "../permissions/bash/contracts.js";
import { COMMAND_CLASS_TOOL, hasCommandClassPolicies } from "../permissions/command-classes.js";
import { bubblewrapCommandEnvironment } from "../../packages/sandbox-extension/src/runtime/bubblewrap-policy.js";
import type { ToolBundle } from "../../packages/sandbox-extension/src/runtime/contracts.js";
import { directCommandEnvironment } from "../../packages/sandbox-extension/src/runtime/direct-executor.js";
import { seatbeltCommandEnvironment } from "../../packages/sandbox-extension/src/runtime/seatbelt-executor.js";

export interface BashAnalysisRuntime {
  readonly config: SandboxConfig;
  /** Canonical launch directory shared with the executor. */
  readonly cwd: string;
  /** Effective administrator `environment.sandbox` values passed to the executor. */
  readonly sandboxEnvironment: EnvironmentVariables;
  /** Ambient snapshot passed to the direct executor. */
  readonly ambientEnvironment: NodeJS.ProcessEnv;
  readonly toolBundle?: ToolBundle;
  /** Canonical startup snapshot also passed to the executor constructor. */
  readonly commandPathPrepend?: readonly string[];
}

/** The context the selected executor uses for `[bash, "-c", command]`, from the executors' own helpers. */
export function bashExecutionContext(runtime: BashAnalysisRuntime): BashExecutionContext {
  const backend = runtime.config.execution.backend;
  if (
    (runtime.config.execution.commandPathPrepend?.length ?? 0) > 0 &&
    runtime.commandPathPrepend === undefined
  )
    throw new Error("Command PATH must be prepared before Bash analysis");
  const environment =
    backend === "bubblewrap"
      ? bubblewrapCommandEnvironment(
          runtime.sandboxEnvironment,
          runtime.toolBundle,
          runtime.commandPathPrepend,
        )
      : backend === "seatbelt"
        ? seatbeltCommandEnvironment(
            runtime.sandboxEnvironment,
            runtime.toolBundle,
            runtime.commandPathPrepend,
          )
        : directCommandEnvironment(
            runtime.ambientEnvironment,
            runtime.sandboxEnvironment,
            runtime.toolBundle,
            runtime.commandPathPrepend,
          );
  const commandSets = runtime.config.tools[COMMAND_CLASS_TOOL]?.commandSets;
  return Object.freeze({
    backend,
    cwd: runtime.cwd,
    environment,
    ...(backend === "bubblewrap"
      ? { hiddenPaths: Object.freeze([...runtime.config.filesystem.hiddenPaths]) }
      : backend === "seatbelt"
        ? { deniedPaths: Object.freeze([...runtime.config.filesystem.deniedPaths]) }
        : {}),
    ...(commandSets ? { commandSets } : {}),
  });
}

/** Construct an analyzer only when the effective Bash policy has a command-class policy. */
export function createConfiguredBashAnalyzer(
  runtime: BashAnalysisRuntime,
  create: CreateBashCommandAnalyzer = createBashCommandAnalyzer,
): BashCommandAnalyzer | undefined {
  if (!hasCommandClassPolicies(runtime.config.tools[COMMAND_CLASS_TOOL])) return undefined;
  let analyzer: BashCommandAnalyzer;
  try {
    analyzer = create(bashExecutionContext(runtime));
  } catch (error) {
    throw new Error(
      `Bash command analysis could not be initialized: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }
  if (
    !Number.isSafeInteger(analyzer.version) ||
    analyzer.version < 1 ||
    analyzer.version > MAXIMUM_KNOWN_READ_ONLY_VERSION ||
    !Array.isArray(analyzer.commands) ||
    typeof analyzer.analyze !== "function"
  ) {
    throw new Error("Bash command analysis could not be initialized: invalid analyzer");
  }
  return analyzer;
}
