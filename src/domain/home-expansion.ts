import { parseManagedEnvironment } from "./environment.js";
import { isNormalizedAbsoluteFilePath, isReservedHiddenDirectoryPath } from "./paths.js";
import type { EnvironmentVariables, FilesystemConfig, ManagedEnvironment } from "./policy.js";

/** Resolve the effective policy once, after broker overlays and before applying its environment. */
export function expandManagedHomePaths(
  filesystem: FilesystemConfig,
  environment: ManagedEnvironment,
  getHomeDirectory: () => string,
): Readonly<{ filesystem: FilesystemConfig; environment: ManagedEnvironment }> {
  let home: string | undefined;
  function expand(value: string): string {
    if (value !== "~" && !value.startsWith("~/")) return value;
    if (home === undefined) {
      const accountHome = getHomeDirectory();
      if (accountHome !== "/" && !isNormalizedAbsoluteFilePath(accountHome)) {
        throw new Error("The invoking account home directory must be a normalized absolute path");
      }
      home = accountHome;
    }
    return value === "~" ? home : `${home === "/" ? "" : home}${value.slice(1)}`;
  }

  const hiddenPaths = filesystem.hiddenPaths.map(expand);
  if (
    !hiddenPaths.every(isNormalizedAbsoluteFilePath) ||
    new Set(hiddenPaths).size !== hiddenPaths.length
  ) {
    throw new Error(
      "Expanded filesystem.hidden_paths must contain unique normalized absolute paths",
    );
  }
  if (hiddenPaths.some(isReservedHiddenDirectoryPath)) {
    throw new Error(
      "Expanded filesystem.hidden_paths must not overlap private system paths or hide /tmp",
    );
  }

  function expandVariables(variables: EnvironmentVariables): EnvironmentVariables {
    return Object.fromEntries(
      Object.entries(variables).map(([name, value]) => [name, expand(value)]),
    );
  }

  const expandedEnvironment = parseManagedEnvironment({
    pi: expandVariables(environment.pi),
    sandbox: expandVariables(environment.sandbox),
    extensions: Object.fromEntries(
      Object.entries(environment.extensions).map(([id, variables]) => [
        id,
        expandVariables(variables),
      ]),
    ),
  });
  return Object.freeze({
    filesystem: Object.freeze({
      cwdWritable: filesystem.cwdWritable,
      hiddenPaths: Object.freeze(hiddenPaths.sort()),
    }),
    environment: expandedEnvironment,
  });
}
