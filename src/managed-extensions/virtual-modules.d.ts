declare module "pi-sandbox:compiled-extensions" {
  /** Replaced by the release composer; ordinary source builds provide no records. */
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- ambient virtual modules cannot use a top-level type import
  export const compiledExtensions: readonly import("./contracts.js").CompiledExtensionRecord[];
}
