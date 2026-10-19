import type { McpApprovalPolicy, McpServerConfig, ToolPolicy } from "../domain/index.js";

/** Linear-space whole-string '*' matching; no regular expression compilation. */
export function matchesMcpPattern(pattern: string, value: string): boolean {
  let p = 0,
    v = 0,
    star = -1,
    restart = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === value[v]) {
      p++;
      v++;
    } else if (pattern[p] === "*") {
      star = p++;
      restart = v;
    } else if (star !== -1) {
      p = star + 1;
      v = ++restart;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

export function mcpSubject(server: string, tool: string): string {
  return JSON.stringify(["mcp", server, tool]);
}

export function resolveMcpPolicy(
  server: McpServerConfig,
  rawName: string,
): { policy: ToolPolicy; rule: string } {
  const rule = server.toolRules.find((rule) => matchesMcpPattern(rule.match, rawName));
  const global = rule ?? server.defaultPolicy;
  const globalRule = rule?.match ?? "default";
  let explicit: McpApprovalPolicy | undefined;
  for (const layer of server.policyLayers ?? []) {
    const contribution =
      layer.toolRules.find((entry) => matchesMcpPattern(entry.match, rawName)) ??
      layer.defaultPolicy;
    if (contribution && (!explicit || approvalRank(contribution) > approvalRank(explicit)))
      explicit = contribution;
  }
  if (!explicit) return { policy: global, rule: globalRule };
  return {
    policy: Object.freeze({
      mode: explicit.mode,
      sessionGrant: explicit.sessionGrant,
      audit: global.audit,
    }),
    rule: `identity override (global audit: ${globalRule})`,
  };
}

function approvalRank(policy: McpApprovalPolicy): number {
  switch (policy.mode) {
    case "disabled":
      return 0;
    case "deny":
      return 1;
    case "ask":
      return policy.sessionGrant === "offer" ? 3 : 2;
    case "allow":
      return 4;
  }
}
