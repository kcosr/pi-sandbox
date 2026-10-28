import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  approvalPreview,
  approvalSubjectLabel,
  approvalUi,
  boundedDisplayText,
  prepareApprovalRequest,
  sessionGrantChoice,
  type SessionGrantScope,
} from "./index.js";

function prompting(answer: (choices: readonly string[]) => string | undefined) {
  const calls: Array<{ title: string; choices: readonly string[] }> = [];
  const ui = approvalUi({
    hasUI: true,
    ui: {
      select: (title: string, choices: string[]) => {
        calls.push({ title, choices });
        return Promise.resolve(answer(choices));
      },
    },
  } as unknown as ExtensionContext)!;
  return { ui, calls };
}

describe("approval presentation", () => {
  it("labels classified requests and leaves others unchanged", () => {
    expect(approvalSubjectLabel("bash", "known_read_only")).toBe("bash (known read-only)");
    expect(approvalSubjectLabel("bash", "unclassified")).toBe("bash");
    expect(approvalSubjectLabel("bash", "configured_command")).toBe("bash");
    expect(approvalSubjectLabel("write")).toBe("write");
    expect(approvalPreview("bash (known read-only)", { command: "ls\n-la" })).toBe(
      "bash (known read-only): ls -la",
    );
  });

  it("bounds display text, including the ellipsis, without splitting characters", () => {
    expect(boundedDisplayText("a\u001bb", 10)).toBe("a b");
    expect(boundedDisplayText("ééé", 6)).toBe("ééé");
    expect(boundedDisplayText("éééé", 7)).toBe("éé…");
    expect(boundedDisplayText("éééé", 6)).toBe("é…");
    expect(boundedDisplayText("éééé", 3)).toBe("…");
    const preview = approvalPreview("bash", { command: "x".repeat(2_000) });
    expect(preview).toBe(`bash: ${"x".repeat(1024)}…`);
  });

  it.each([
    [1024, "x".repeat(1024)],
    [1025, `${"x".repeat(1024)}…`],
    [1027, `${"x".repeat(1024)}…`],
  ])("keeps the 1024-byte approval preview boundary for %i bytes", (bytes, expected) => {
    expect(approvalPreview("bash", { command: "x".repeat(bytes) })).toBe(`bash: ${expected}`);
  });

  it("truncates approval previews on character boundaries", () => {
    expect(approvalPreview("bash", { command: `${"x".repeat(1023)}é` })).toBe(
      `bash: ${"x".repeat(1023)}…`,
    );
  });

  it.each([
    ["tool", "Allow for session"],
    ["known_read_only", "Allow known read-only commands for session"],
  ] as const)("labels the %s session choice", async (scope: SessionGrantScope, label) => {
    expect(sessionGrantChoice(scope)).toBe(label);
    const request = prepareApprovalRequest({
      subject: "bash",
      display: "bash (known read-only): ls",
      arguments: { command: "ls" },
      commandClass: "known_read_only",
    });
    const { ui, calls } = prompting((choices) => choices[1]);
    await expect(
      ui.prompt(
        { request, allowForSession: true, sessionGrantScope: scope },
        new AbortController().signal,
      ),
    ).resolves.toBe("allow_session");
    expect(calls[0]).toEqual({
      title: "Allow bash (known read-only): ls?",
      choices: ["Allow once", label, "Deny"],
    });
    const once = prompting((choices) => choices[1]);
    await expect(
      once.ui.prompt(
        { request, allowForSession: false, sessionGrantScope: scope },
        new AbortController().signal,
      ),
    ).resolves.toBe("deny");
    expect(once.calls[0]?.choices).toEqual(["Allow once", "Deny"]);
  });
});
