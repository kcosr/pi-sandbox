import type { SandboxConfig, ToolName } from "../domain/index.js";
import type { HostCommandExecutor } from "../host/index.js";
import type { ManagedExtensionInstance, PiToolExtension } from "../managed-extensions/sdk.js";
import type { SandboxExecutor } from "../sandbox/index.js";

export interface ExtensionDependencies {
  readonly cwd: string;
  readonly configPath: string;
  readonly userStateDir: string;
  readonly activeTools?: readonly ToolName[];
  readonly loadConfig: () => Promise<SandboxConfig>;
  readonly executor: SandboxExecutor;
  readonly managedExtensions?: readonly ManagedExtensionInstance[];
  readonly piToolExtensions?: readonly PiToolExtension[];
  readonly hostExecutors?: Readonly<Record<string, HostCommandExecutor>>;
}

export type { SandboxExecutor } from "../sandbox/index.js";
