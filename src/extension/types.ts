import type { SandboxConfig, ToolName } from "../domain/index.js";
import type { HostCommandExecutor } from "../host/index.js";
import type { ManagedExtensionInstance, PiToolExtension } from "../managed-extensions/sdk.js";
import type { SandboxExecutor } from "../sandbox/index.js";
import type { AuditClient } from "../audit/client.js";

export interface ExtensionDependencies {
  readonly cwd: string;
  readonly configPath: string;
  readonly userStateDir: string;
  readonly activeTools?: readonly ToolName[];
  readonly loadConfig: () => Promise<SandboxConfig>;
  readonly onSessionStart?: (file: string | undefined) => Promise<void>;
  readonly executor: SandboxExecutor;
  readonly auditClient?: AuditClient;
  readonly managedExtensions?: readonly ManagedExtensionInstance[];
  readonly piToolExtensions?: readonly PiToolExtension[];
  readonly hostExecutors?: Readonly<Record<string, HostCommandExecutor>>;
}

export type { SandboxExecutor } from "../sandbox/index.js";
