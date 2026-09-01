const REMOVED_VARIABLES = new Set([
  "BUN_OPTIONS",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PI_SANDBOX_CONFIG",
  "PI_SANDBOX_EXTENSION",
  "PI_SANDBOX_MANIFEST",
  "PI_SANDBOX_RUNTIME",
]);

export interface ManagedEnvironmentLease {
  restore(): void;
}

/** Remove runtime injection channels while retaining Pi's ordinary user-state variables. */
export function sanitizeManagedEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(environment)) {
    if (REMOVED_VARIABLES.has(name) || name.startsWith("PI_SANDBOX_")) {
      delete environment[name];
    }
  }
}

/** Apply root-managed Pi variables for one runtime lifetime and restore the caller exactly. */
export function applyManagedEnvironment(
  variables: Readonly<Record<string, string>>,
  environment: NodeJS.ProcessEnv = process.env,
): ManagedEnvironmentLease {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(variables)) {
    previous.set(name, environment[name]);
    environment[name] = value;
  }
  let restored = false;
  return Object.freeze({
    restore(): void {
      if (restored) return;
      restored = true;
      for (const [name, value] of previous) {
        if (value === undefined) delete environment[name];
        else environment[name] = value;
      }
    },
  });
}
