import type { ResolvedMcpServer } from "../mcp/resolve.js";
import type { ManagedMcpPreferences } from "../mcp/preferences.js";
import type { ExecutionBackend, SandboxConfig } from "../domain/index.js";
import type { HostCommandExecutor } from "../../packages/sandbox-extension/src/runtime/host-command/index.js";
import type { ManagedExtensionInstance, PiToolExtension } from "../managed-extensions/sdk.js";
import type { SandboxExecutor } from "../../packages/sandbox-extension/src/runtime/index.js";
import type { SandboxExportSource } from "../../packages/sandbox-extension/src/runtime/export/contracts.js";
import type { SandboxImportTarget } from "../../packages/sandbox-extension/src/runtime/import/contracts.js";
import type { ExportAudit } from "../exports/contracts.js";
import type { ExtensionCommandContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuditClient } from "../audit/client.js";
import type { BashCommandAnalyzer } from "../permissions/bash/contracts.js";

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
  readonly getModelRuntime?: () => ModelRuntime;
  readonly toolArguments?: readonly string[];
  readonly loadConfig: () => Promise<SandboxConfig>;
  readonly onSessionStart?: (file: string | undefined) => Promise<void>;
  /** Await process-owned cleanup before Pi's normal quit path can call process.exit. */
  readonly onProcessShutdown?: () => Promise<void>;
  /** Runs while the TUI and private storage are still available, before normal quit. */
  readonly registerBeforeInteractiveQuit?: (
    handler: (ctx: ExtensionCommandContext, signal: AbortSignal) => Promise<boolean>,
  ) => void;
  /** Managed application metadata; not part of the reusable executor interface. */
  readonly executionBackend?: ExecutionBackend;
  /** Canonical effective OS account home, supplied only by the managed application. */
  readonly accountHome?: string;
  readonly executor: SandboxExecutor;
  /** Private user-command capability, never supplied to model tools. */
  readonly getExportSource?: () => SandboxExportSource | undefined;
  /** Trusted transfer capability for admitted managed operations, never a model tool. */
  readonly getImportTarget?: () => SandboxImportTarget | undefined;
  readonly exportAudit?: ExportAudit;
  /** Required exactly when the effective Bash policy has a command-class policy. */
  readonly bashAnalyzer?: BashCommandAnalyzer;
  readonly auditClient?: AuditClient;
  readonly managedExtensions?: readonly ManagedExtensionInstance[];
  readonly piToolExtensions?: readonly PiToolExtension[];
  readonly hostExecutors?: Readonly<Record<string, HostCommandExecutor>>;
}

export type { SandboxExecutor } from "../../packages/sandbox-extension/src/runtime/index.js";
