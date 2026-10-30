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

function prompting(
  answer: (choices: readonly string[]) => string | undefined,
  analysisIssue?: string,
) {
  const calls: Array<{ title: string; choices: readonly string[] }> = [];
  const ui = approvalUi(
    {
      hasUI: true,
      ui: {
        select: (title: string, choices: string[]) => {
          calls.push({ title, choices });
          return Promise.resolve(answer(choices));
        },
      },
    } as unknown as ExtensionContext,
    analysisIssue,
  )!;
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
    ["Allow once", "allow_once"],
    ["Allow for session", "allow_session"],
    ["Deny", "deny"],
    [undefined, "deny"],
  ] as const)(
    "explains an unclassified request without changing the %s choice",
    async (answer, decision) => {
      const request = prepareApprovalRequest({
        subject: "bash",
        display: "bash: sed -n '1p' input",
        arguments: { command: "sed -n '1p' input" },
        commandClass: "unclassified",
      });
      const before = JSON.stringify(request);
      const { ui, calls } = prompting(() => answer, "sed was not found on PATH");
      await expect(
        ui.prompt(
          { request, allowForSession: true, sessionGrantScope: "tool" },
          new AbortController().signal,
        ),
      ).resolves.toBe(decision);
      expect(calls).toEqual([
        {
          title:
            "Allow bash: sed -n '1p' input?\n\nAutomatic approval unavailable:\nsed was not found on PATH",
          choices: ["Allow once", "Allow for session", "Deny"],
        },
      ]);
      expect(JSON.stringify(request)).toBe(before);
    },
  );

  it("bounds and sanitizes the reason independently of the command preview", async () => {
    const display = approvalPreview("bash", { command: "x".repeat(2_000) });
    const request = prepareApprovalRequest({
      subject: "bash",
      display,
      arguments: { command: "x".repeat(2_000) },
      commandClass: "unclassified",
    });
    const issue = `bad\n\u001b\u202e${"é".repeat(400)}`;
    const { ui, calls } = prompting(() => "Deny", issue);
    await ui.prompt(
      { request, allowForSession: false, sessionGrantScope: "tool" },
      new AbortController().signal,
    );
    const prefix = `Allow ${display}?\n\nAutomatic approval unavailable:\n`;
    expect(calls[0]?.title.startsWith(prefix)).toBe(true);
    const shownIssue = calls[0]!.title.slice(prefix.length);
    expect(shownIssue).toBe(`bad   ${"é".repeat(251)}…`);
    expect(Buffer.byteLength(shownIssue)).toBeLessThanOrEqual(512);
    expect(shownIssue).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(calls[0]?.choices).toEqual(["Allow once", "Deny"]);
  });

  it("does not attach an issue to other request classes or tools", async () => {
    const requests = [
      prepareApprovalRequest({
        subject: "bash",
        display: "bash: ls",
        arguments: { command: "ls" },
      }),
      prepareApprovalRequest({
        subject: "bash",
        display: "bash (known read-only): ls",
        arguments: { command: "ls" },
        commandClass: "known_read_only",
      }),
      prepareApprovalRequest({
        subject: "bash",
        display: "bash: utility --read",
        arguments: { command: "utility --read" },
        commandClass: "configured_command",
        commandStages: [
          { command: "utility", knownReadOnly: false, commandSets: ["utility_read"] },
        ],
      }),
      prepareApprovalRequest({
        subject: "write",
        display: "write: file",
        arguments: { path: "file" },
        commandClass: "unclassified",
      }),
    ];
    const { ui, calls } = prompting(() => "Deny", "irrelevant issue");
    for (const request of requests) {
      await ui.prompt(
        { request, allowForSession: false, sessionGrantScope: "tool" },
        new AbortController().signal,
      );
    }
    expect(calls.map(({ title }) => title)).toEqual(
      requests.map(({ display }) => `Allow ${display}?`),
    );
  });

  it.each([undefined, ""])("omits the diagnostic when no issue is supplied: %s", async (issue) => {
    const request = prepareApprovalRequest({
      subject: "bash",
      display: "bash: command",
      arguments: { command: "command" },
      commandClass: "unclassified",
    });
    const { ui, calls } = prompting(() => "Deny", issue);
    await ui.prompt(
      { request, allowForSession: false, sessionGrantScope: "tool" },
      new AbortController().signal,
    );
    expect(calls[0]?.title).toBe("Allow bash: command?");
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
