import type { EnvironmentVariables, ManagedEnvironment } from "./policy.js";

export const MAXIMUM_ENVIRONMENT_VARIABLES_PER_SCOPE = 128;
export const MAXIMUM_ENVIRONMENT_EXTENSIONS = 64;
export const MAXIMUM_ENVIRONMENT_VARIABLES = 256;
export const MAXIMUM_ENVIRONMENT_BYTES = 64 * 1024;
export const MAXIMUM_ENVIRONMENT_NAME_BYTES = 128;
export const MAXIMUM_ENVIRONMENT_VALUE_BYTES = 8192;

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const RESERVED_ENVIRONMENT_NAMES = new Set([
  "BASH_ENV",
  "BUN_OPTIONS",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PI_SANDBOX_CONFIG",
  "PI_SANDBOX_EXTENSION",
  "PI_SANDBOX_MANIFEST",
  "PI_SANDBOX_RUNTIME",
  "SHELLOPTS",
]);
const FIXED_SANDBOX_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_TERMINAL_PROMPT",
  "NO_COLOR",
]);

export function emptyManagedEnvironment(): ManagedEnvironment {
  return Object.freeze({
    pi: Object.freeze({}),
    sandbox: Object.freeze({}),
    extensions: Object.freeze({}),
  });
}

export function parseManagedEnvironment(value: unknown): ManagedEnvironment {
  if (!isRecord(value) || !hasExactKeys(value, ["pi", "sandbox", "extensions"])) {
    throw new Error("managed_environment_invalid");
  }
  const pi = parseEnvironmentVariables(value.pi, false);
  const sandbox = parseEnvironmentVariables(value.sandbox, true);
  if (
    !isRecord(value.extensions) ||
    Object.keys(value.extensions).length > MAXIMUM_ENVIRONMENT_EXTENSIONS
  ) {
    throw new Error("managed_environment_invalid");
  }
  const extensions: Record<string, EnvironmentVariables> = {};
  for (const extensionId of Object.keys(value.extensions)) {
    if (!EXTENSION_ID_PATTERN.test(extensionId)) throw new Error("managed_environment_invalid");
    extensions[extensionId] = parseEnvironmentVariables(value.extensions[extensionId], false);
  }
  const environment = Object.freeze({
    pi,
    sandbox,
    extensions: Object.freeze(extensions),
  });
  validateAggregateLimits(environment);
  return environment;
}

export function overlayManagedEnvironment(
  base: ManagedEnvironment,
  override: ManagedEnvironment,
): ManagedEnvironment {
  const extensionIds = new Set([
    ...Object.keys(base.extensions),
    ...Object.keys(override.extensions),
  ]);
  return parseManagedEnvironment({
    pi: { ...base.pi, ...override.pi },
    sandbox: { ...base.sandbox, ...override.sandbox },
    extensions: Object.fromEntries(
      [...extensionIds].map((extensionId) => [
        extensionId,
        { ...base.extensions[extensionId], ...override.extensions[extensionId] },
      ]),
    ),
  });
}

function parseEnvironmentVariables(value: unknown, sandbox: boolean): EnvironmentVariables {
  if (!isRecord(value) || Object.keys(value).length > MAXIMUM_ENVIRONMENT_VARIABLES_PER_SCOPE) {
    throw new Error("managed_environment_invalid");
  }
  const variables: Record<string, string> = {};
  for (const [name, variableValue] of Object.entries(value)) {
    if (
      !ENVIRONMENT_NAME_PATTERN.test(name) ||
      Buffer.byteLength(name) > MAXIMUM_ENVIRONMENT_NAME_BYTES ||
      RESERVED_ENVIRONMENT_NAMES.has(name) ||
      name.startsWith("PI_SANDBOX_") ||
      (sandbox && FIXED_SANDBOX_ENVIRONMENT_NAMES.has(name)) ||
      typeof variableValue !== "string" ||
      variableValue.includes("\0") ||
      Buffer.byteLength(variableValue) > MAXIMUM_ENVIRONMENT_VALUE_BYTES
    ) {
      throw new Error("managed_environment_invalid");
    }
    variables[name] = variableValue;
  }
  return Object.freeze(variables);
}

function validateAggregateLimits(environment: ManagedEnvironment): void {
  const scopes = [environment.pi, environment.sandbox, ...Object.values(environment.extensions)];
  const variableCount = scopes.reduce((total, scope) => total + Object.keys(scope).length, 0);
  const environmentBytes = scopes.reduce(
    (total, scope) =>
      total +
      Object.entries(scope).reduce(
        (scopeTotal, [name, value]) =>
          scopeTotal + Buffer.byteLength(name) + Buffer.byteLength(value),
        0,
      ),
    0,
  );
  if (
    variableCount > MAXIMUM_ENVIRONMENT_VARIABLES ||
    environmentBytes > MAXIMUM_ENVIRONMENT_BYTES
  ) {
    throw new Error("managed_environment_invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
