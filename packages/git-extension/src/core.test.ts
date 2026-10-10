import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeGitClone,
  GIT_CLONE_TOOL,
  gitCloneCallSummary,
  gitHostEnvironment,
  parseGitCloneConfig,
  type GitExecutionPort,
} from "./core.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-git-core-"));
  directories.push(cwd);
  const config = parseGitCloneConfig({ allowed_hosts: ["github.com"], allowed_schemes: ["https"] });
  const execute = vi.fn<GitExecutionPort["execute"]>().mockResolvedValue({
    exitCode: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("Cloning...\n"),
  });
  return { cwd, config, host: { execute }, execute };
}

describe("reusable Git core", () => {
  it("uses only the injected host port, fixed argv, launch child and exact signal", async () => {
    const runtime = await fixture();
    const controller = new AbortController();
    const args = { repository: "https://github.com/org/repo.git" };
    const pending = executeGitClone(args, { ...runtime, signal: controller.signal });
    args.repository = "https://evil.example/substituted.git";
    await expect(pending).resolves.toEqual({
      content: [{ type: "text", text: "Cloned repository into repo.\n\nCloning..." }],
      details: undefined,
    });
    expect(runtime.execute).toHaveBeenCalledExactlyOnceWith(
      {
        argv: [
          "/usr/bin/git",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "clone",
          "--",
          "https://github.com/org/repo.git",
          path.join(runtime.cwd, "repo"),
        ],
      },
      { signal: controller.signal },
    );
  });

  it("rejects missing execution ports and never starts an already cancelled invocation", async () => {
    const runtime = await fixture();
    const args = { repository: "https://github.com/org/repo.git" };
    await expect(executeGitClone(args, { ...runtime, host: undefined as never })).rejects.toThrow(
      "explicit host execution port",
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(executeGitClone(args, { ...runtime, signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it.each(["empty directory", "symlink"])(
    "refuses an existing %s without invoking Git",
    async (kind) => {
      const runtime = await fixture();
      const target = path.join(runtime.cwd, "repo");
      if (kind === "symlink") await symlink("missing", target);
      else await mkdir(target);
      await expect(
        executeGitClone({ repository: "https://github.com/org/repo.git" }, runtime),
      ).rejects.toThrow("already exists");
      expect(runtime.execute).not.toHaveBeenCalled();
    },
  );

  it("rejects destination and custom options rather than broadening the tool schema", async () => {
    const runtime = await fixture();
    await expect(
      executeGitClone(
        { repository: "https://github.com/org/repo.git", destination: "/elsewhere" },
        runtime,
      ),
    ).rejects.toThrow("only a repository");
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(GIT_CLONE_TOOL.executionMode).toBe("sequential");
    expect(GIT_CLONE_TOOL.parameters.additionalProperties).toBe(false);
  });

  it("sanitizes inherited Git configuration and forces the same restrictions as managed mode", () => {
    const environment = gitHostEnvironment({
      HOME: "/home/user",
      PATH: "/bin",
      GIT_CONFIG_COUNT: "99",
      GIT_SSH_COMMAND: "malicious",
      GIT_CONFIG_GLOBAL: "/custom",
      SSH_ASKPASS: "prompt",
      PI_SANDBOX_PRIVATE: "private",
      EMPTY: undefined,
    });
    expect(environment).toEqual({
      HOME: "/home/user",
      PATH: "/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_SSH: "/usr/bin/ssh",
      GIT_SSH_VARIANT: "ssh",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS_REQUIRE: "never",
    });
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it("bounds call summaries and excludes control sequences", () => {
    expect(gitCloneCallSummary({ repository: "https://github.com/org/repo.git" })).toBe(
      "https://github.com/org/repo.git",
    );
    for (const repository of ["", " ", "a\u001b[31m", "a\n", "a".repeat(1025), "é".repeat(513)])
      expect(gitCloneCallSummary({ repository })).toBeUndefined();
    expect(gitCloneCallSummary(null)).toBeUndefined();
    expect(gitCloneCallSummary({})).toBeUndefined();
  });

  it("rejects raw and encoded C1 controls before displaying names or starting Git", async () => {
    const runtime = await fixture();
    for (const control of ["\u0080", "\u009b", "\u009d", "\u009f"]) {
      const repository = `https://github.com/org/repo${control}31m.git`;
      expect(gitCloneCallSummary({ repository })).toBeUndefined();
      for (const name of [control, encodeURIComponent(control)])
        await expect(
          executeGitClone({ repository: `https://github.com/org/repo${name}31m.git` }, runtime),
        ).rejects.toThrow();
    }
    expect(runtime.execute).not.toHaveBeenCalled();
  });
});
