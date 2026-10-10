import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  FrozenJsonObject,
  HostCommandExecutor,
  ManagedToolExecutionContext,
} from "../contracts.js";
import { gitCloneExtension, parseGitCloneConfig } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-sandbox-git-clone-"));
  temporaryDirectories.push(directory);
  return directory;
}

function tool() {
  const definition = gitCloneExtension.tools[0];
  if (definition === undefined) throw new Error("git clone tool is missing");
  return definition;
}

function context(
  cwd: string,
  config: FrozenJsonObject,
  execute = vi.fn<HostCommandExecutor["execute"]>(() =>
    Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("Cloning into checkout...\n"),
    }),
  ),
): { readonly context: ManagedToolExecutionContext; readonly execute: typeof execute } {
  return {
    context: {
      cwd,
      config,
      signal: new AbortController().signal,
      host: { execute },
    },
    execute,
  };
}

const CONFIG = parseGitCloneConfig(
  {
    allowed_hosts: ["github.com", "xn--r8jz45g.xn--zckzah", "[::1]"],
    allowed_schemes: ["http", "https", "ssh"],
  },
  "config.extensions.git",
);

describe("built-in Git clone managed extension", () => {
  it("selects only validated locator and the same derived destination for tool logging", () => {
    expect(
      tool().auditTarget?.({ repository: "git@github.com:owner/project.git" }, "/work"),
    ).toEqual({
      repository: "git@github.com:owner/project.git",
      path: "/work/project",
    });
    expect(() =>
      tool().auditTarget?.(
        { repository: "https://user:secret@github.com/owner/project.git" },
        "/work",
      ),
    ).toThrow();
    expect(() =>
      tool().auditTarget?.(
        { repository: "https://github.com/owner/project.git?token=secret" },
        "/work",
      ),
    ).toThrow();
  });
  it("declares one narrow tool and a hardened host environment", () => {
    expect(gitCloneExtension).toMatchObject({ id: "git", version: "1.2.0", apiVersion: 3 });
    expect(gitCloneExtension.hostEnvironment).toEqual({
      variables: [],
      removeInherited: ["SSH_ASKPASS"],
      removeInheritedPrefixes: ["GIT_"],
      fixed: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_SSH: "/usr/bin/ssh",
        GIT_SSH_VARIANT: "ssh",
        GIT_TERMINAL_PROMPT: "0",
        SSH_ASKPASS_REQUIRE: "never",
      },
    });
    expect(gitCloneExtension.requiredHostExecutables(CONFIG)).toEqual([
      "/usr/bin/git",
      "/usr/bin/ssh",
    ]);
    expect(gitCloneExtension.tools).toHaveLength(1);
    expect(tool()).toMatchObject({
      name: "git_clone",
      executionMode: "sequential",
      parameters: {
        type: "object",
        required: ["repository"],
        additionalProperties: false,
      },
    });
    expect(tool().formatCall?.({ repository: "git@github.com:owner/project.git" })).toBe(
      "git@github.com:owner/project.git",
    );
    expect(tool().formatCall?.({})).toBeUndefined();
  });

  it("requires SSH only when an SSH locator is configured", () => {
    const httpOnly = parseGitCloneConfig(
      { allowed_hosts: ["github.com"], allowed_schemes: ["https"] },
      "config.extensions.git",
    );
    expect(gitCloneExtension.requiredHostExecutables(httpOnly)).toEqual(["/usr/bin/git"]);
  });

  it("strictly parses and deeply freezes administrator configuration", () => {
    expect(CONFIG).toEqual({
      allowed_hosts: ["github.com", "xn--r8jz45g.xn--zckzah", "[::1]"],
      allowed_schemes: ["http", "https", "ssh"],
    });
    expect(Object.isFrozen(CONFIG)).toBe(true);
    expect(Object.isFrozen(CONFIG.allowed_hosts)).toBe(true);

    const invalid = [
      {},
      { allowed_hosts: ["github.com"], allowed_schemes: ["https"], extra: true },
      { allowed_hosts: [], allowed_schemes: ["https"] },
      { allowed_hosts: ["GitHub.com"], allowed_schemes: ["https"] },
      { allowed_hosts: ["github.com."], allowed_schemes: ["https"] },
      { allowed_hosts: ["github.com", "github.com"], allowed_schemes: ["https"] },
      { allowed_hosts: ["github.com:443"], allowed_schemes: ["https"] },
      { allowed_hosts: ["github.com"], allowed_schemes: [] },
      { allowed_hosts: ["github.com"], allowed_schemes: ["git"] },
      { allowed_hosts: ["github.com"], allowed_schemes: ["ssh", "ssh"] },
    ];
    for (const value of invalid) {
      expect(() => parseGitCloneConfig(value, "config.extensions.git")).toThrow();
    }
  });

  it.each([
    ["https://GitHub.COM:8443/org/http-repo.git", "http-repo"],
    ["http://github.com/org/plain-repo/", "plain-repo"],
    ["ssh://git@GITHUB.com:2222/org/ssh-repo.git", "ssh-repo"],
    ["git@github.com:org/scp-repo.git", "scp-repo"],
    ["git@例え.テスト:org/idna-repo.git", "idna-repo"],
    ["git@[::1]:org/ip-repo.git", "ip-repo"],
  ])("clones accepted locator %s into only its derived child %s", async (repository, name) => {
    const cwd = await temporaryDirectory();
    const fixture = context(cwd, CONFIG);

    const result = await tool().execute({ repository }, fixture.context);

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.execute).toHaveBeenCalledWith(
      {
        argv: [
          "/usr/bin/git",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.http.allow=always",
          "-c",
          "protocol.https.allow=always",
          "-c",
          "protocol.ssh.allow=always",
          "clone",
          "--",
          repository,
          path.join(cwd, name),
        ],
      },
      { signal: fixture.context.signal },
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: `Cloned repository into ${name}.\n\nCloning into checkout...`,
      },
    ]);
  });

  it.each([
    "/local/repository",
    "./relative-repository",
    "file:///tmp/repository.git",
    "git://github.com/org/repository.git",
    "ext::sh -c exploit",
    "https://evil.example/org/repository.git",
    "https://github.com.evil.example/org/repository.git",
    "https://github.com@evil.example/org/repository.git",
    "https://github.com\\@evil.example/org/repository.git",
    "https://user:password@github.com/org/repository.git",
    "https://github.com/org/repository.git?ref=main",
    "https://github.com/org/repository.git#main",
    "https://github.com/org/.git",
    "https://github.com/org/%2e%2e.git",
    "git@github.com:org/repository.git#fragment",
    "git@github.com:org/repo\n.git",
  ])("rejects invalid or unauthorized locator %s before execution", async (repository) => {
    const cwd = await temporaryDirectory();
    const fixture = context(cwd, CONFIG);

    await expect(tool().execute({ repository }, fixture.context)).rejects.toBeInstanceOf(Error);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("applies scheme policy independently from host policy", async () => {
    const cwd = await temporaryDirectory();
    const config = parseGitCloneConfig(
      { allowed_hosts: ["github.com"], allowed_schemes: ["https"] },
      "config.extensions.git",
    );
    const fixture = context(cwd, config);
    await expect(
      tool().execute({ repository: "git@github.com:org/repository.git" }, fixture.context),
    ).rejects.toThrow("scheme is not allowed: ssh");
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("enables only the administrator-configured Git protocols", async () => {
    const cwd = await temporaryDirectory();
    const config = parseGitCloneConfig(
      { allowed_hosts: ["github.com"], allowed_schemes: ["https"] },
      "config.extensions.git",
    );
    const fixture = context(cwd, config);

    await tool().execute({ repository: "https://github.com/org/repository.git" }, fixture.context);

    expect(fixture.execute).toHaveBeenCalledWith(
      {
        argv: [
          "/usr/bin/git",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "clone",
          "--",
          "https://github.com/org/repository.git",
          path.join(cwd, "repository"),
        ],
      },
      { signal: fixture.context.signal },
    );
  });

  it("rejects an existing derived destination, including a symlink", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, path.join(cwd, "repository"));
    const fixture = context(cwd, CONFIG);

    await expect(
      tool().execute({ repository: "https://github.com/org/repository.git" }, fixture.context),
    ).rejects.toThrow("destination already exists: repository");
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("reports bounded Git stderr when clone exits unsuccessfully", async () => {
    const cwd = await temporaryDirectory();
    const execute = vi.fn<HostCommandExecutor["execute"]>(() =>
      Promise.resolve({
        exitCode: 128,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("fatal: repository not found\n"),
      }),
    );
    const fixture = context(cwd, CONFIG, execute);

    await expect(
      tool().execute({ repository: "https://github.com/org/missing.git" }, fixture.context),
    ).rejects.toThrow("git clone failed: fatal: repository not found");
  });
});
