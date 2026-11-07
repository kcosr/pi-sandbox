import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PolicyEngine, approvalUi, prepareApprovalRequest } from "../permissions/index.js";
import { withManagedChild } from "./invocation.js";

describe("managed child authorization", () => {
  it("uses root UI and shares a grant across siblings and the parent", async () => {
    const prompts: string[] = [];
    const root = {
      hasUI: true,
      ui: {
        select: (title: string) => {
          prompts.push(title);
          return Promise.resolve("Allow for session");
        },
      },
    } as unknown as ExtensionContext;
    const headless = { hasUI: false } as ExtensionContext;
    const engine = new PolicyEngine({ write: { mode: "ask", sessionGrant: "offer" } });
    const request = prepareApprovalRequest({
      subject: "write",
      display: "write: /workspace/file",
      arguments: { path: "file" },
    });
    const invoke = (id: string) =>
      withManagedChild(
        {
          childId: id,
          childTaskId: `task-${id}`,
          childSessionId: `session-${id}`,
          label: "inspect\u001b code",
          rootContext: root,
          isCurrent: () => true,
          setActivity: () => undefined,
        },
        () => engine.evaluate(request, { ui: approvalUi(headless)! }),
      );
    expect(
      (await Promise.all([invoke("one"), invoke("two")])).every((decision) => decision.allowed),
    ).toBe(true);
    expect((await engine.evaluate(request)).allowed).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Subagent one");
    expect(prompts[0]).not.toContain("\u001b");
    engine.clearSessionGrants();
    await invoke("later");
    expect(prompts).toHaveLength(2);
  });

  it("rejects an invalidated child before a stale UI answer becomes consent", async () => {
    let live = true;
    const root = {
      hasUI: true,
      ui: {
        select: () => {
          live = false;
          return Promise.resolve("Allow once");
        },
      },
    } as unknown as ExtensionContext;
    const engine = new PolicyEngine({ write: { mode: "ask", sessionGrant: "never" } });
    const request = prepareApprovalRequest({ subject: "write", display: "write", arguments: {} });
    const decision = await withManagedChild(
      {
        childId: "one",
        childTaskId: "task",
        childSessionId: "session",
        label: "work",
        rootContext: root,
        isCurrent: () => live,
        setActivity: () => undefined,
      },
      () => engine.evaluate(request, { ui: approvalUi({ hasUI: false } as ExtensionContext)! }),
    );
    expect(decision.allowed).toBe(false);
  });
});
