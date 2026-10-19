import { describe, expect, it } from "vitest";
import { isMcpToolPattern, type McpApprovalPolicy, type McpServerConfig } from "../domain/index.js";
import { resolveMcpPolicy } from "./policy.js";

const disabled = { mode: "disabled", sessionGrant: "never" } as const;
const deny = { mode: "deny", sessionGrant: "never" } as const;
const ask = { mode: "ask", sessionGrant: "never" } as const;
const offer = { mode: "ask", sessionGrant: "offer" } as const;
const allow = { mode: "allow", sessionGrant: "never" } as const;
const base: McpServerConfig = {
  id: "docs",
  enabled: true,
  transport: "http",
  url: "https://example.com/mcp",
  exposure: "direct",
  timeoutMs: 1000,
  headers: {},
  headersFromEnv: {},
  defaultPolicy: { ...deny, audit: true },
  toolRules: [{ match: "quiet_*", ...disabled, audit: false }],
};

describe("MCP identity policy resolution", () => {
  it("inherits global first-match policy when no layer contributes", () => {
    const server = {
      ...base,
      policyLayers: [{ toolRules: [{ match: "search_*", ...allow }] }],
    };
    expect(resolveMcpPolicy(server, "quiet_tool")).toEqual({
      policy: base.toolRules[0],
      rule: "quiet_*",
    });
    expect(resolveMcpPolicy(server, "other")).toEqual({
      policy: base.defaultPolicy,
      rule: "default",
    });
  });

  it("resolves each layer's ordered exceptions before joining its fallback with other layers", () => {
    const layers = [
      { defaultPolicy: allow, toolRules: [{ match: "secret_*", ...deny }] },
      { defaultPolicy: ask, toolRules: [] },
    ];
    for (const policyLayers of [layers, [...layers].reverse()]) {
      const server = { ...base, policyLayers };
      expect(resolveMcpPolicy(server, "secret_key").policy).toEqual({ ...ask, audit: true });
      expect(resolveMcpPolicy(server, "other").policy).toEqual({ ...allow, audit: true });
    }
    expect(resolveMcpPolicy({ ...base, policyLayers: [layers[0]!] }, "secret_key").policy).toEqual({
      ...deny,
      audit: true,
    });
  });

  it("keeps first-match ordering inside a layer and rejects file-priority semantics", () => {
    const layer = {
      toolRules: [
        { match: "secret_*", ...disabled },
        { match: "*", ...allow },
      ],
    };
    expect(resolveMcpPolicy({ ...base, policyLayers: [layer] }, "secret_x").policy.mode).toBe(
      "disabled",
    );
    expect(
      resolveMcpPolicy(
        { ...base, policyLayers: [{ toolRules: [...layer.toolRules].reverse() }] },
        "secret_x",
      ).policy.mode,
    ).toBe("allow");
    for (const policyLayers of [
      [layer, { defaultPolicy: offer, toolRules: [] }],
      [{ defaultPolicy: offer, toolRules: [] }, layer],
    ]) {
      expect(resolveMcpPolicy({ ...base, policyLayers }, "secret_x").policy).toEqual({
        ...offer,
        audit: true,
      });
    }
  });

  it("joins whole approval pairs across all five ranks, independently of order", () => {
    const pairs: readonly McpApprovalPolicy[] = [disabled, deny, ask, offer, allow];
    for (let a = 0; a < pairs.length; a++) {
      for (let b = 0; b < pairs.length; b++) {
        const server = {
          ...base,
          policyLayers: [
            { defaultPolicy: pairs[a]!, toolRules: [] },
            { toolRules: [{ match: "*", ...pairs[b]! }] },
          ],
        };
        expect(resolveMcpPolicy(server, "tool").policy).toEqual({
          ...pairs[Math.max(a, b)]!,
          audit: true,
        });
      }
    }
  });

  it("explicit defaults replace global restrictions while audit follows the global raw-name match", () => {
    const server = { ...base, policyLayers: [{ defaultPolicy: allow, toolRules: [] }] };
    expect(resolveMcpPolicy(server, "quiet_new_tool")).toEqual({
      policy: { ...allow, audit: false },
      rule: "identity override (global audit: quiet_*)",
    });
    expect(resolveMcpPolicy(server, "new_tool")).toEqual({
      policy: { ...allow, audit: true },
      rule: "identity override (global audit: default)",
    });
    expect(
      resolveMcpPolicy(
        {
          ...base,
          defaultPolicy: { ...allow, audit: true },
          policyLayers: [{ defaultPolicy: disabled, toolRules: [] }],
        },
        "tool",
      ).policy,
    ).toEqual({ ...disabled, audit: true });
  });
});

describe("shared MCP pattern grammar", () => {
  it.each([
    "",
    "a?",
    "a[",
    "a]",
    "a{",
    "a}",
    "a\\",
    "a b",
    "a\t",
    "a\n",
    "a\u007f",
    "a\u0085",
    "a\u00a0",
    "a\u2028",
    "a\ufeff",
    "\ud800",
    "a".repeat(129),
  ])("rejects unsupported pattern %j", (pattern) => expect(isMcpToolPattern(pattern)).toBe(false));
  it.each(["*", "search_*", "a.b", "a+b", "a$", "a^", "a(b)", "a|b", "é".repeat(64)])(
    "accepts literal/star pattern %j",
    (pattern) => expect(isMcpToolPattern(pattern)).toBe(true),
  );
});
