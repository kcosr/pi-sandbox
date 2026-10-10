import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  executeGitClone,
  GIT_CLONE_TOOL,
  gitCloneCallSummary,
  parseGitCloneArguments,
  type GitCloneRuntime,
} from "./core.js";

export interface GitExtensionOptions {
  /** Must reject before initialization or after shutdown. The caller owns this runtime. */
  readonly getRuntime: () => GitCloneRuntime;
}

/** Register a standard Pi tool while borrowing its caller's configured host executor. */
export function createGitExtension(options: GitExtensionOptions): ExtensionFactory {
  if (typeof options.getRuntime !== "function")
    throw new Error("Git requires an explicit runtime provider");
  const getRuntime = options.getRuntime;
  return (pi) => {
    pi.registerTool({
      ...GIT_CLONE_TOOL,
      promptGuidelines: [...GIT_CLONE_TOOL.promptGuidelines],
      renderCall(args, theme, context) {
        const component =
          context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
        const summary = gitCloneCallSummary(args);
        component.setText(
          `${theme.fg("toolTitle", theme.bold(GIT_CLONE_TOOL.name))}${
            summary === undefined ? "" : ` ${theme.fg("accent", summary)}`
          }`,
        );
        return component;
      },
      async execute(_id, params, signal) {
        const runtime = getRuntime();
        const arguments_ = parseGitCloneArguments(params);
        return executeGitClone(arguments_, {
          ...runtime,
          ...(signal === undefined ? {} : { signal }),
        });
      },
    });
  };
}
