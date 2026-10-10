import type { ResolvedMcpServer } from "../mcp/resolve.js";
import type { ManagedMcpPreferences } from "../mcp/preferences.js";
import type { SandboxConfig } from "../domain/index.js";
import type { HostCommandExecutor } from "../../packages/sandbox-extension/src/runtime/host-command/index.js";
import type { ManagedExtensionInstance, PiToolExtension } from "../managed-extensions/sdk.js";
import type { SandboxExecutor } from "../../packages/sandbox-extension/src/runtime/index.js";
import type { AuditClient } from "../audit/client.js";

export interface ExtensionDependencies {
  readonly features?: {
    readonly config: SandboxConfig;
    readonly servers: readonly ResolvedMcpServer[];
    readonly mcpPreferences?: ManagedMcpPreferences;
    readonly selected: (name: string) => boolean;
  };
  readonly cwd: string;
  readonly configPath: string;
  readonly userStateDir: string;
  readonly toolArguments?: readonly string[];
  readonly loadConfig: () => Promise<SandboxConfig>;
  readonly onSessionStart?: (file: string | undefined) => Promise<void>;
  readonly executor: SandboxExecutor;
  readonly auditClient?: AuditClient;
  readonly managedExtensions?: readonly ManagedExtensionInstance[];
  readonly piToolExtensions?: readonly PiToolExtension[];
  readonly hostExecutors?: Readonly<Record<string, HostCommandExecutor>>;
}

export type { SandboxExecutor } from "../../packages/sandbox-extension/src/runtime/index.js";
