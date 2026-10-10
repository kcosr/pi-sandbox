import { expandAccountValue, type AccountIdentity } from "./account-macros.js";
import { parseManagedEnvironment } from "./environment.js";
import {
  isNormalizedAbsoluteFilePath,
  isReservedHiddenDirectoryPath,
} from "../../packages/sandbox-extension/src/runtime/paths.js";
import type {
  EnvironmentVariables,
  FilesystemConfig,
  ManagedEnvironment,
  SmolvmConfig,
} from "./policy.js";

/** Resolve the effective policy once, after broker overlays and before applying its environment. */
export function expandManagedHomePaths(
  filesystem: FilesystemConfig,
  environment: ManagedEnvironment,
  getIdentity: () => AccountIdentity,
  smolvm?: SmolvmConfig,
): Readonly<{
  filesystem: FilesystemConfig;
  environment: ManagedEnvironment;
  smolvm?: SmolvmConfig;
}> {
  let identity: AccountIdentity | undefined;
  const account = (): AccountIdentity => (identity ??= getIdentity());
  const expand = (value: string): string => expandAccountValue(value, account);

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
  const stateDirectory = smolvm === undefined ? undefined : expand(smolvm.stateDirectory);
  if (
    stateDirectory !== undefined &&
    (!isNormalizedAbsoluteFilePath(stateDirectory) ||
      stateDirectory.includes(":") ||
      Buffer.byteLength(stateDirectory) > 48)
  ) {
    throw new Error(
      "Expanded smolvm.state_directory must be a normalized absolute path below / of at most 48 bytes without colons",
    );
  }
  return Object.freeze({
    filesystem: Object.freeze({
      cwdWritable: filesystem.cwdWritable,
      hiddenPaths: Object.freeze(hiddenPaths.sort()),
    }),
    environment: expandedEnvironment,
    ...(smolvm !== undefined && stateDirectory !== undefined
      ? { smolvm: Object.freeze({ ...smolvm, stateDirectory }) }
      : {}),
  });
}
