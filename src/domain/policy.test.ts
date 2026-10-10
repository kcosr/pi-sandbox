import { describe, expect, it } from "vitest";

import {
  NETWORK_MODES,
  POLICY_MODES,
  SESSION_GRANT_POLICIES,
  TOOL_NAMES,
  isToolName,
} from "./index.js";

describe("policy domain", () => {
  it("defines exactly the seven supported Pi tools", () => {
    expect(TOOL_NAMES).toEqual(["read", "grep", "find", "ls", "write", "edit", "bash"]);
  });

  it("defines only end-state policy and session-grant values", () => {
    expect(POLICY_MODES).toEqual(["allow", "ask", "deny", "disabled"]);
    expect(SESSION_GRANT_POLICIES).toEqual(["never", "offer"]);
    expect(NETWORK_MODES).toEqual(["none", "local", "host"]);
  });

  it("recognizes tool names without treating user shell as a tool", () => {
    expect(isToolName("read")).toBe(true);
    expect(isToolName("user_shell")).toBe(false);
    expect(isToolName("download")).toBe(false);
    expect(isToolName("download", [...TOOL_NAMES, "download"])).toBe(true);
  });
});
