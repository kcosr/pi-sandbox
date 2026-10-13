import { compiledLayout } from "#pi-sandbox-compiled-layout";

export interface CompiledLayout {
  readonly allowConfigOverride: boolean;
  readonly configDir: string;
  readonly configPath: string;
  readonly defaultModelsPath: string;
  readonly libexecDir: string;
  readonly launcherPath: string;
  readonly identitySocketPath: string;
  readonly auditSocketPath: string;
  readonly serviceDir?: string;
  readonly bubblewrap?: {
    readonly mode: "system" | "bundled";
    readonly path: string;
  };
}

export const buildLayout: CompiledLayout = compiledLayout;
