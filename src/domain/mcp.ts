import type { EnvironmentVariables, ToolPolicy } from "./policy.js";

export interface CodeModeConfig {
  readonly enabled: boolean;
  readonly timeoutMs: number;
}
export type McpExposure = "direct" | "codemode";
export interface McpToolRule extends ToolPolicy {
  readonly match: string;
}
interface McpServerBase {
  readonly id: string;
  readonly enabled: boolean;
  readonly exposure: McpExposure;
  readonly timeoutMs: number;
  readonly defaultPolicy: ToolPolicy;
  readonly toolRules: readonly McpToolRule[];
}
export interface McpHttpServerConfig extends McpServerBase {
  readonly transport: "http";
  readonly url: string;
  readonly headers: EnvironmentVariables;
  readonly headersFromEnv: EnvironmentVariables;
}
export interface McpStdioServerConfig extends McpServerBase {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: EnvironmentVariables;
  readonly envFromEnv: EnvironmentVariables;
}
export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;
export interface McpConfig {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
}
