import type { ExecutionBackend, FilesystemConfig } from "../domain/index.js";
import {
  isNormalizedAbsoluteFilePath,
  PRIVATE_SANDBOX_SYSTEM_PATHS,
} from "../../packages/sandbox-extension/src/runtime/paths.js";

function safePath(value: string): boolean {
  return (
    (value === "/" || isNormalizedAbsoluteFilePath(value)) && !/[\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function within(root: string, path: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}

/** Quote paths as data, including characters that could terminate the prompt's XML section. */
function quoted(path: string): string {
  return JSON.stringify(path).replace(
    /[<>&]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Describe known startup policy without probing files or claiming blanket home access. */
export function toolEnvironmentPrompt(options: {
  readonly home: string;
  readonly cwd: string;
  readonly backend: ExecutionBackend;
  readonly filesystem: FilesystemConfig;
  readonly accountHome?: string;
}): string | undefined {
  if (options.backend === "direct" || !safePath(options.home)) return undefined;
  const parts = [
    `Tool home: $HOME in Bash and ~ in tool paths resolve to ${quoted(options.home)}.`,
  ];
  const home = options.accountHome;
  if (home === undefined || !safePath(home)) return parts.join(" ");

  parts.push(`OS account home: ${quoted(home)}.`);
  if (home !== options.home) parts.push("The tool home is different from the OS account home.");
  const exclusions =
    options.backend === "bubblewrap"
      ? [...options.filesystem.hiddenPaths, ...PRIVATE_SANDBOX_SYSTEM_PATHS, "/tmp"]
      : options.filesystem.deniedPaths;
  const cwdKnown = safePath(options.cwd);
  const restricted = exclusions.some(
    (root) =>
      within(root, home) && !(cwdKnown && within(root, options.cwd) && within(options.cwd, home)),
  );
  if (restricted) {
    parts.push("Its host contents are restricted by the execution policy.");
    if (cwdKnown && within(home, options.cwd)) {
      parts.push(
        `Within that home, only the workspace ${quoted(options.cwd)} is restored, subject to filesystem exclusions and permissions.`,
      );
    }
    parts.push("Do not substitute the tool home for the user's home.");
  } else {
    parts.push(
      'When the user says "my home", use this absolute path for permitted files; access remains subject to filesystem policy and permissions.',
    );
  }
  return parts.join(" ");
}
