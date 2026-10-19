import type { EnvironmentVariables, ToolPolicy } from "./policy.js";

export interface CodeModeConfig {
  readonly enabled: boolean;
  readonly timeoutMs: number;
}
export type McpExposure = "direct" | "codemode";
export interface McpToolRule extends ToolPolicy {
  readonly match: string;
}
export type McpApprovalPolicy = Pick<ToolPolicy, "mode" | "sessionGrant">;
export interface McpApprovalRule extends McpApprovalPolicy {
  readonly match: string;
}
/** One matched administrator record, retaining its own first-match/default semantics. */
export interface McpPolicyLayer {
  readonly defaultPolicy?: McpApprovalPolicy;
  readonly toolRules: readonly McpApprovalRule[];
}
export interface McpServerOverride {
  readonly enabled?: boolean;
  readonly policyLayers?: readonly McpPolicyLayer[];
}

export function isMcpToolPattern(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 128 &&
    !/[\p{Cc}\p{Cs}\s?[\]{}\\]/u.test(value)
  );
}

interface McpServerBase {
  readonly id: string;
  readonly enabled: boolean;
  readonly exposure: McpExposure;
  readonly timeoutMs: number;
  readonly defaultPolicy: ToolPolicy;
  readonly toolRules: readonly McpToolRule[];
  /** Broker-only approval contributions; never authored in the main configuration. */
  readonly policyLayers?: readonly McpPolicyLayer[];
}
export interface McpHttpServerConfig extends McpServerBase {
  readonly transport: "http";
  readonly url: string;
  readonly headers: EnvironmentVariables;
  readonly headersFromEnv: EnvironmentVariables;
  readonly bearerTokenFromEnv?: string;
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
