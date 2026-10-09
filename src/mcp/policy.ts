import type { McpServerConfig, ToolPolicy } from "../domain/index.js";

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
  return { policy: rule ?? server.defaultPolicy, rule: rule?.match ?? "default" };
}
