import {
  executeGitClone,
  GIT_CLONE_TOOL,
  GIT_HOST_ENVIRONMENT,
  gitCloneCallSummary,
  gitCloneTarget,
  parseGitCloneConfig,
  requiredGitExecutables,
  type GitCloneArguments,
} from "../../../packages/git-extension/src/core.js";
import { defineManagedExtension, defineManagedHostEnvironment, defineManagedTool } from "../sdk.js";

export { parseGitCloneConfig } from "../../../packages/git-extension/src/core.js";

/** The application wrapper owns approvals, audit and the scoped host executor. */
export const gitCloneExtension = defineManagedExtension({
  kind: "managed",
  apiVersion: 3,
  id: "git",
  version: "1.2.0",
  hostEnvironment: defineManagedHostEnvironment(GIT_HOST_ENVIRONMENT),
  parseConfig: parseGitCloneConfig,
  requiredHostExecutables: (config) => requiredGitExecutables(parseGitCloneConfig(config)),
  tools: Object.freeze([
    defineManagedTool<GitCloneArguments>({
      ...GIT_CLONE_TOOL,
      diagnosticScope: "git.clone",
      formatCall: gitCloneCallSummary,
      auditTarget(arguments_, cwd) {
        return {
          repository: arguments_.repository,
          path: gitCloneTarget(arguments_.repository, cwd),
        };
      },
      execute(arguments_, context) {
        return executeGitClone(arguments_, {
          ...context,
          config: parseGitCloneConfig(context.config),
        });
      },
    }),
  ]),
});

export default gitCloneExtension;
