import type { CompiledExtensionRecord } from "./contracts.js";

/** Source-test fallback; release builds replace the virtual module with composed extensions. */
export const compiledExtensions: readonly CompiledExtensionRecord[] = Object.freeze([]);
