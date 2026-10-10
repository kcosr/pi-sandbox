import path from "node:path";
import { SandboxExecutionError, type SandboxResourceLimits } from "../contracts.js";
import { resolveSmolvmLimits, smolvmEnvironment } from "./request.js";

export interface SmolvmResources {
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly storageGiB: number;
  readonly overlayGiB: number;
}
export interface CreateSmolvmExecutorOptions {
  readonly cwd: string;
  readonly cwdWritable?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly limits?: SandboxResourceLimits;
  readonly smolvmPath: string;
  readonly imagePath: string;
  readonly imageSha256: string;
  /** Existing private host directory outside the project and other mounts. */
  readonly stateDirectory: string;
  readonly resources: SmolvmResources;
}
export function isWithin(parent: string, value: string): boolean {
  return parent === "/" || parent === value || value.startsWith(`${parent}/`);
}
export function assertSmolvmPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    /[\0\r\n:]/u.test(value)
  )
    throw new Error("smolvm_path_invalid");
}
export function validateSmolvmResources(resources: SmolvmResources): void {
  if (
    !resources ||
    typeof resources !== "object" ||
    Object.keys(resources).sort().join(",") !== "cpus,memoryMiB,overlayGiB,storageGiB"
  )
    throw new Error("smolvm_resources_invalid");
  for (const [value, min, max] of [
    [resources.cpus, 1, 32],
    [resources.memoryMiB, 256, 65536],
    [resources.storageGiB, 1, 64],
    [resources.overlayGiB, 1, 64],
  ] as const)
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error("smolvm_resources_invalid");
}
/** Pure validation is also used by managed configuration preflight. */
export function validateSmolvmOptions(options: CreateSmolvmExecutorOptions): void {
  try {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) =>
          ![
            "cwd",
            "cwdWritable",
            "environment",
            "limits",
            "smolvmPath",
            "imagePath",
            "imageSha256",
            "stateDirectory",
            "resources",
          ].includes(key),
      )
    )
      throw new Error("smolvm_options_invalid");
    for (const value of [
      options.cwd,
      options.smolvmPath,
      options.imagePath,
      options.stateDirectory,
    ])
      assertSmolvmPath(value);
    if (
      options.cwd === "/" ||
      options.stateDirectory === "/" ||
      !/^[a-f0-9]{64}$/u.test(options.imageSha256)
    )
      throw new Error("smolvm_options_invalid");
    if (options.cwdWritable !== undefined && typeof options.cwdWritable !== "boolean")
      throw new Error("smolvm_writable_invalid");
    if (
      [options.imagePath, path.dirname(options.smolvmPath), options.stateDirectory].some(
        (value) => isWithin(options.cwd, value) || isWithin(value, options.cwd),
      )
    )
      throw new Error("smolvm_trusted_storage_overlaps_workspace");
    validateSmolvmResources(options.resources);
    resolveSmolvmLimits(options.limits);
    smolvmEnvironment(options.environment);
  } catch (cause) {
    throw new SandboxExecutionError("sandbox_invalid_request", { cause });
  }
}
