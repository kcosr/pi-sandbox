import {
  executeGitClone,
  GIT_CLONE_TOOL,
  GIT_HOST_ENVIRONMENT,
  gitCloneCallSummary,
  gitCloneTarget,
  requiredGitExecutables,
  type GitCloneArguments,
} from "../../../packages/git-extension/src/core.js";
import {
  executeSandboxGitClone,
  gitSandboxCloneTarget,
} from "../../../packages/git-extension/src/sandbox-clone.js";
import { defineManagedExtension, defineManagedHostEnvironment, defineManagedTool } from "../sdk.js";
import { gitClonePolicy, parseManagedGitCloneConfig } from "./config.js";

export { parseGitCloneConfig } from "../../../packages/git-extension/src/core.js";

/** The application wrapper owns approvals, audit and the scoped host executor. */
export const gitCloneExtension = defineManagedExtension({
  kind: "managed",
  apiVersion: 3,
  id: "git",
  version: "1.2.0",
  hostEnvironment: defineManagedHostEnvironment(GIT_HOST_ENVIRONMENT),
  parseConfig: parseManagedGitCloneConfig,
  requiredHostExecutables: (config) =>
    requiredGitExecutables(gitClonePolicy(parseManagedGitCloneConfig(config))),
  tools: Object.freeze([
    defineManagedTool<GitCloneArguments>({
      ...GIT_CLONE_TOOL,
      description:
        "Clone an approved HTTP or SSH Git repository into a derived directory at the administrator-selected destination. Use the returned absolute checkout path. The destination and Git options cannot be selected.",
      diagnosticScope: "git.clone",
      formatCall: gitCloneCallSummary,
      auditTarget(arguments_, cwd, context) {
        const config = parseManagedGitCloneConfig(context.config);
        return {
          repository: arguments_.repository,
          path:
            config.destination === "sandbox_home"
              ? gitSandboxCloneTarget(arguments_.repository, context.home)
              : gitCloneTarget(arguments_.repository, cwd),
        };
      },
      async execute(arguments_, context) {
        const config = parseManagedGitCloneConfig(context.config);
        if (config.destination === "sandbox_home") {
          if (context.sandbox === undefined)
            throw new Error("Sandbox Git destination is unavailable");
          return executeSandboxGitClone(arguments_, {
            ...context,
            config: gitClonePolicy(config),
            sandbox: context.sandbox,
          });
        }
        return executeGitClone(arguments_, {
          ...context,
          config: gitClonePolicy(config),
        });
      },
    }),
  ]),
});

export default gitCloneExtension;
