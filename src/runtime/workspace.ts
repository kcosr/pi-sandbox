import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Capture the launch workspace once, before Pi selects or resumes a session. */
export function createWorkspaceBoundary(launchCwd: string): {
  readonly cwd: string;
  readonly validateSessionCwd: (cwd: string) => void;
} {
  const cwd = realpathSync(launchCwd);
  return {
    cwd,
    validateSessionCwd(candidate) {
      if (!isAbsolute(candidate) || candidate !== cwd || realpathSync(candidate) !== cwd) {
        throw new Error(`Pi Sandbox session CWD must match the launch workspace: ${cwd}`);
      }
    },
  };
}
