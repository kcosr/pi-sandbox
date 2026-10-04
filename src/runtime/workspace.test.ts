import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceBoundary } from "./workspace.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("process workspace boundary", () => {
  it("requires the canonical launch spelling and rejects aliases that change context ancestry", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-workspace-"));
    roots.push(root);
    const workspace = join(root, "run-a");
    const sibling = join(root, "run-b");
    const alias = join(root, "alias");
    mkdirSync(workspace);
    mkdirSync(sibling);
    symlinkSync(workspace, alias);
    const boundary = createWorkspaceBoundary(alias);
    expect(boundary.cwd).toBe(workspace);
    expect(() => boundary.validateSessionCwd(workspace)).not.toThrow();
    expect(() => boundary.validateSessionCwd(alias)).toThrow("launch workspace");
    expect(() => boundary.validateSessionCwd(`${workspace}/../run-a`)).toThrow("launch workspace");
    expect(() => boundary.validateSessionCwd(sibling)).toThrow("launch workspace");
    expect(() => boundary.validateSessionCwd(".")).toThrow("launch workspace");
    expect(() => boundary.validateSessionCwd(join(root, "missing"))).toThrow();
    unlinkSync(alias);
    symlinkSync(sibling, alias);
    expect(() => boundary.validateSessionCwd(alias)).toThrow("launch workspace");
    renameSync(workspace, join(root, "moved"));
    symlinkSync(sibling, workspace);
    expect(() => boundary.validateSessionCwd(workspace)).toThrow("launch workspace");
  });
});
