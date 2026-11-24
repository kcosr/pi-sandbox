import type { ConfigurationSource } from "../service/endpoint.js";
import { compiledLayout } from "#pi-sandbox-compiled-layout";
import type { ToolBundle } from "../../packages/sandbox-extension/src/runtime/index.js";

export interface CompiledLayout {
  readonly configuration: ConfigurationSource;
  readonly nativeInventory?: Readonly<{ toolBundleSha256?: string; bubblewrapSha256?: string }>;
  readonly libexecDir: string;
  readonly launcherPath: string;
  readonly toolBundle?: ToolBundle;
  readonly hostTools?: Readonly<Partial<Record<"fd" | "rg", string>>>;
  readonly bubblewrap?: {
    readonly mode: "system" | "bundled";
    readonly path: string;
  };
}

export const buildLayout: CompiledLayout = compiledLayout;
