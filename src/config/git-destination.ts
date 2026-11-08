import type { ExecutionConfig, ExtensionConfig } from "../domain/index.js";

/** The selected destination is main-only and must remain valid after identity merging. */
export function usesSandboxGitDestination(
  extensions: Readonly<Record<string, ExtensionConfig>>,
): boolean {
  return extensions.git?.settings.destination === "sandbox_home";
}

export function assertGitDestinationBackend(
  extensions: Readonly<Record<string, ExtensionConfig>>,
  execution: ExecutionConfig,
): void {
  if (usesSandboxGitDestination(extensions) && execution.backend !== "bubblewrap")
    throw new Error('extensions.git.destination = "sandbox_home" requires Bubblewrap execution');
}
