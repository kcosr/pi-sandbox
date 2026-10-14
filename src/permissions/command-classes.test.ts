import { describe, expect, it } from "vitest";

import {
  commandClassPolicyViolation,
  commandClassPreconditionIssues,
  hasCommandClassPolicies,
  isStrictlyMorePermissive,
  joinPolicies,
} from "./command-classes.js";
import type { SubjectPolicy } from "./contracts.js";

const MODES = ["deny", "ask", "allow"] as const;
const GRANTS = ["never", "offer"] as const;
const POLICIES = MODES.flatMap((mode) =>
  GRANTS.filter((sessionGrant) => mode === "ask" || sessionGrant === "never").map(
    (sessionGrant) => ({ mode, sessionGrant }),
  ),
);

describe("command-class policy algebra", () => {
  it.each([
    ["deny", "never", "allow", "never", "allow", "never"],
    ["deny", "never", "ask", "offer", "ask", "offer"],
    ["ask", "never", "ask", "offer", "ask", "offer"],
    ["ask", "offer", "ask", "never", "ask", "offer"],
    ["ask", "offer", "allow", "never", "allow", "never"],
    ["allow", "never", "deny", "never", "allow", "never"],
    ["ask", "offer", "deny", "never", "ask", "offer"],
  ] as const)(
    "joins %s/%s with %s/%s as %s/%s",
    (mainMode, mainGrant, classMode, classGrant, mode, sessionGrant) => {
      expect(
        joinPolicies(
          { mode: mainMode, sessionGrant: mainGrant },
          { mode: classMode, sessionGrant: classGrant },
        ),
      ).toEqual({ mode, sessionGrant });
    },
  );

  it("never joins a disabled main policy", () => {
    const disabled: SubjectPolicy = { mode: "disabled", sessionGrant: "never" };
    expect(joinPolicies(disabled, { mode: "allow", sessionGrant: "never" })).toBe(disabled);
  });

  it("orders deny < ask/never < ask/offer < allow", () => {
    const order = [
      { mode: "deny", sessionGrant: "never" },
      { mode: "ask", sessionGrant: "never" },
      { mode: "ask", sessionGrant: "offer" },
      { mode: "allow", sessionGrant: "never" },
    ] as const;
    for (const [candidateIndex, candidate] of order.entries()) {
      for (const [baseIndex, base] of order.entries()) {
        expect(isStrictlyMorePermissive(candidate, base)).toBe(candidateIndex > baseIndex);
      }
    }
  });

  it("requires a strictly more permissive class under an available main policy", () => {
    for (const main of POLICIES) {
      for (const commandClass of POLICIES) {
        expect(commandClassPolicyViolation(main, commandClass)).toBe(
          isStrictlyMorePermissive(commandClass, main) ? undefined : "not_more_permissive",
        );
      }
    }
    expect(
      commandClassPolicyViolation(
        { mode: "disabled", sessionGrant: "never" },
        { mode: "allow", sessionGrant: "never" },
      ),
    ).toBe("main_disabled");
  });

  it("requires every read tool to allow before known read-only commands skip prompts", () => {
    const allow = { mode: "allow", sessionGrant: "never" } as const;
    const tools: Record<string, SubjectPolicy> = {
      read: allow,
      grep: { mode: "ask", sessionGrant: "offer" },
      find: allow,
      bash: {
        mode: "deny",
        sessionGrant: "never",
        commandClasses: { known_read_only: allow },
      },
    };
    expect(commandClassPreconditionIssues(tools, "config.tools")).toEqual([
      'config.tools.bash.known_read_only.mode "allow" requires config.tools.grep.mode "allow" (it is "ask")',
      'config.tools.bash.known_read_only.mode "allow" requires config.tools.ls.mode "allow" (it is not configured)',
    ]);
    expect(
      commandClassPreconditionIssues(
        {
          ...tools,
          bash: {
            mode: "deny",
            sessionGrant: "never",
            commandClasses: { known_read_only: { mode: "ask", sessionGrant: "never" } },
          },
        },
        "tools",
      ),
    ).toEqual([]);
    expect(commandClassPreconditionIssues({ read: allow }, "tools")).toEqual([]);
  });

  it("recognizes only non-empty class maps", () => {
    expect(hasCommandClassPolicies(undefined)).toBe(false);
    expect(hasCommandClassPolicies({ mode: "ask", sessionGrant: "never" })).toBe(false);
    expect(
      hasCommandClassPolicies({ mode: "ask", sessionGrant: "never", commandClasses: {} }),
    ).toBe(false);
    expect(
      hasCommandClassPolicies({
        mode: "deny",
        sessionGrant: "never",
        commandClasses: { known_read_only: { mode: "ask", sessionGrant: "never" } },
      }),
    ).toBe(true);
  });
});
