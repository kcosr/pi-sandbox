import { createCodemodeExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CodeModeConfig } from "../domain/mcp.js";

/** Generic limits supported by the pinned, patched Pi code-mode factory. */
export interface ManagedCodemodeOptions {
  readonly inlineBudget: 3000;
  readonly models: false;
  readonly executionLimits: {
    readonly timeoutMs: number;
    readonly maxSourceBytes: number;
    readonly maxCalls: number;
    readonly maxConcurrentCalls: number;
    readonly maxOutputBytes: number;
    readonly inlineOnly: true;
  };
}

export function managedCodemodeOptions(config: CodeModeConfig): ManagedCodemodeOptions {
  return {
    inlineBudget: 3000,
    models: false,
    executionLimits: {
      timeoutMs: config.timeoutMs,
      maxSourceBytes: 256 * 1024,
      maxCalls: 256,
      maxConcurrentCalls: 16,
      maxOutputBytes: 16 * 1024 * 1024,
      inlineOnly: true,
    },
  };
}

/** The application invokes this through its normal managed extension composition. */
export function createManagedCodemodeExtension(
  config: CodeModeConfig,
  factory: (options: ManagedCodemodeOptions) => ExtensionFactory = createCodemodeExtension,
): ExtensionFactory | undefined {
  return config.enabled ? factory(managedCodemodeOptions(config)) : undefined;
}
