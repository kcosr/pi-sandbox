import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseGitCloneConfig, type GitExecutionPort } from "./core.js";
import {
  executeSandboxGitClone,
  GIT_BUNDLE_CHUNK_BYTES,
  GIT_BUNDLE_MAXIMUM_BYTES,
  gitSandboxCloneTarget,
  sandboxGitArguments,
  type GitSandboxCloneContext,
  type GitSandboxImportSession,
} from "./sandbox-clone.js";

const files = vi.hoisted(() => ({ statfs: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  files.statfs.mockImplementation(original.statfs);
  return { ...original, statfs: files.statfs };
});

afterEach(() => {
  files.statfs.mockClear();
});

function result(stdout = "", exitCode = 0, stderr = "") {
  return { exitCode, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function fixture(
  options: {
    readonly symbolicHead?: string | null;
    readonly head?: string | null;
    readonly refs?: string;
    readonly objectFormat?: string;
    readonly bytes?: Buffer;
    readonly oversized?: boolean;
  } = {},
) {
  const stages: string[] = [];
  const symbolicHead =
    options.symbolicHead === undefined ? "refs/heads/develop" : options.symbolicHead;
  const head = options.head === undefined ? "a".repeat(40) : options.head;
  const bytes = options.bytes ?? Buffer.from("fixture bundle");
  const host = vi.fn<GitExecutionPort["execute"]>().mockImplementation(async ({ argv }) => {
    if (argv.includes("clone")) {
      const stage = path.dirname(argv[argv.length - 1]!);
      expect(stage).toMatch(/^\/dev\/shm\/pi-git-/u);
      expect((await fs.stat(stage)).mode & 0o777).toBe(0o700);
      stages.push(stage);
      return result();
    }
    if (argv.includes("--show-object-format")) return result(options.objectFormat ?? "sha1");
    if (argv.includes("symbolic-ref"))
      return result(symbolicHead ?? "", symbolicHead === null ? 1 : 0);
    if (argv.includes("rev-parse")) return result(head ?? "", head === null ? 1 : 0);
    if (argv.includes("for-each-ref")) return result(options.refs ?? "refs/heads/develop");
    if (argv.includes("bundle")) {
      const bundle = argv[argv.indexOf("create") + 1]!;
      await fs.writeFile(bundle, bytes);
      if (options.oversized) await fs.truncate(bundle, GIT_BUNDLE_MAXIMUM_BYTES + 1);
      return result();
    }
    throw new Error(`Unexpected host Git command: ${argv.join(" ")}`);
  });
  const sandbox = vi.fn<GitExecutionPort["execute"]>().mockResolvedValue(result());
  const chunks: Buffer[] = [];
  const session = {
    writeChunk: vi.fn<GitSandboxImportSession["writeChunk"]>().mockImplementation((value) => {
      chunks.push(Buffer.from(value));
      return Promise.resolve();
    }),
    finish: vi.fn<GitSandboxImportSession["finish"]>().mockResolvedValue("/proc/2/fd/17"),
    reserveDirectory: vi.fn<GitSandboxImportSession["reserveDirectory"]>().mockResolvedValue({
      path: "/proc/2/fd/18",
      displayPath: "/run/pi-sandbox/home/repos/widget",
    }),
    verifyDirectory: vi.fn<GitSandboxImportSession["verifyDirectory"]>().mockResolvedValue(),
    close: vi.fn<GitSandboxImportSession["close"]>().mockResolvedValue(),
  };
  const open = vi.fn().mockResolvedValue(session);
  const config = parseGitCloneConfig({
    allowed_hosts: ["example.invalid"],
    allowed_schemes: ["https", "ssh"],
  });
  const context: GitSandboxCloneContext = {
    cwd: "/work",
    config,
    host: { execute: host },
    sandbox: { home: "/run/pi-sandbox/home", execute: sandbox, imports: { open } },
  };
  return { context, stages, host, sandbox, chunks, bytes, open, session };
}

const repository = "https://example.invalid/owner/widget.git";

describe.skipIf(process.platform !== "linux")("sandbox Git clone orchestration", () => {
  it("keeps host acquisition on private tmpfs and transfers bounded chunks before sandbox checkout", async () => {
    const f = fixture({ bytes: Buffer.alloc(GIT_BUNDLE_CHUNK_BYTES * 2 + 17, 0x5a) });
    const signal = new AbortController().signal;
    await expect(executeSandboxGitClone({ repository }, { ...f.context, signal })).resolves.toEqual(
      {
        content: [
          { type: "text", text: "Cloned repository into /run/pi-sandbox/home/repos/widget." },
        ],
        details: undefined,
      },
    );
    expect(f.host.mock.calls[0]![0].argv).toEqual([
      "/usr/bin/git",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "protocol.ssh.allow=always",
      "-c",
      "core.hooksPath=/dev/null",
      "clone",
      "--bare",
      "--template=",
      "--",
      repository,
      `${f.stages[0]}/repository.git`,
    ]);
    expect(f.chunks.map((value) => value.length)).toEqual([
      GIT_BUNDLE_CHUNK_BYTES,
      GIT_BUNDLE_CHUNK_BYTES,
      17,
    ]);
    expect(Buffer.concat(f.chunks)).toEqual(f.bytes);
    expect(f.open).toHaveBeenCalledExactlyOnceWith(signal);
    expect(f.session.reserveDirectory).toHaveBeenCalledExactlyOnceWith("repos/widget");
    const clone = f.sandbox.mock.calls.find(([request]) => request.argv.includes("clone"));
    expect(clone?.[0].argv).toEqual(
      sandboxGitArguments(f.context.sandbox.home, [
        "clone",
        "--no-checkout",
        "--template=",
        "--branch=develop",
        "--",
        "/proc/2/fd/17",
        "/proc/2/fd/18",
      ]),
    );
    expect(
      f.sandbox.mock.calls.some(
        ([request]) =>
          request.argv.slice(-5).join(" ") === `remote set-url -- origin ${repository}`,
      ),
    ).toBe(true);
    expect(
      f.sandbox.mock.calls.some(
        ([request]) =>
          request.argv.slice(-3).join(" ") ===
          "symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop",
      ),
    ).toBe(true);
    for (const call of [...f.host.mock.calls, ...f.sandbox.mock.calls])
      expect(call[1]?.signal).toBe(signal);
    expect(f.session.verifyDirectory).toHaveBeenCalledTimes(f.sandbox.mock.calls.length + 1);
    expect(f.session.close).toHaveBeenCalledOnce();
    await expect(fs.stat(f.stages[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves SSH locators and the same fixed host policy", async () => {
    const f = fixture();
    const ssh = "git@example.invalid:owner/widget.git";
    await executeSandboxGitClone({ repository: ssh }, f.context);
    expect(f.host.mock.calls[0]![0].argv).toContain(ssh);
    expect(f.sandbox.mock.calls.some(([request]) => request.argv.at(-1) === ssh)).toBe(true);
  });

  it("creates an empty repository with its unborn branch and SHA-256 format without a bundle", async () => {
    const f = fixture({
      head: null,
      refs: "",
      objectFormat: "sha256",
      symbolicHead: "refs/heads/new/default",
    });
    await executeSandboxGitClone({ repository }, f.context);
    expect(f.host.mock.calls.some(([request]) => request.argv.includes("bundle"))).toBe(false);
    expect(f.session.writeChunk).not.toHaveBeenCalled();
    expect(f.session.finish).not.toHaveBeenCalled();
    expect(f.sandbox.mock.calls[0]![0].argv).toEqual(
      sandboxGitArguments(f.context.sandbox.home, [
        "init",
        "--template=",
        "--object-format=sha256",
        "--initial-branch=new/default",
        "--",
        "/proc/2/fd/18",
      ]),
    );
    expect(
      f.sandbox.mock.calls.some(
        ([request]) =>
          request.argv.includes("branch.new/default.merge") &&
          request.argv.at(-1) === "refs/heads/new/default",
      ),
    ).toBe(true);
    expect(f.sandbox.mock.calls.some(([request]) => request.argv.includes("reset"))).toBe(false);
  });

  it("preserves a missing default branch while importing other refs without checkout", async () => {
    const f = fixture({ head: null, symbolicHead: "refs/heads/missing", refs: "refs/heads/other" });
    await executeSandboxGitClone({ repository }, f.context);
    expect(f.session.finish).toHaveBeenCalledOnce();
    expect(f.sandbox.mock.calls[0]![0].argv.some((value) => value.startsWith("--branch="))).toBe(
      false,
    );
    expect(
      f.sandbox.mock.calls.some(
        ([request]) => request.argv.slice(-3).join(" ") === "symbolic-ref HEAD refs/heads/missing",
      ),
    ).toBe(true);
    expect(f.sandbox.mock.calls.some(([request]) => request.argv.includes("reset"))).toBe(false);
  });

  it("restores detached HEAD without an origin/HEAD symbolic ref", async () => {
    const head = "b".repeat(64);
    const f = fixture({ objectFormat: "sha256", symbolicHead: null, head });
    await executeSandboxGitClone({ repository }, f.context);
    expect(
      f.sandbox.mock.calls.some(
        ([request]) => request.argv.slice(-4).join(" ") === `update-ref --no-deref HEAD ${head}`,
      ),
    ).toBe(true);
    expect(
      f.sandbox.mock.calls.some(
        ([request]) =>
          request.argv.slice(-4).join(" ") === "update-ref --no-deref -d refs/remotes/origin/HEAD",
      ),
    ).toBe(true);
  });

  it("rejects a bundle over the transfer limit before requesting an import", async () => {
    const f = fixture({ oversized: true });
    await expect(executeSandboxGitClone({ repository }, f.context)).rejects.toThrow("512 MiB");
    expect(f.open).not.toHaveBeenCalled();
    await expect(fs.stat(f.stages[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-tmpfs staging root before any host operation", async () => {
    const f = fixture();
    files.statfs.mockResolvedValueOnce({ type: 0 });
    await expect(executeSandboxGitClone({ repository }, f.context)).rejects.toThrow("tmpfs");
    expect(f.host).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing sandbox destination or start a sandbox command", async () => {
    const f = fixture();
    const cause = Object.assign(new Error("import_destination_exists"), {
      code: "import_destination_exists",
    });
    f.session.reserveDirectory.mockRejectedValue(cause);
    await expect(executeSandboxGitClone({ repository }, f.context)).rejects.toMatchObject({
      message:
        "Git clone destination already exists: /run/pi-sandbox/home/repos/widget. Use the existing checkout, or inspect and remove it with the normal tools before retrying git_clone.",
      cause,
    });
    expect(f.session.writeChunk).not.toHaveBeenCalled();
    expect(f.sandbox).not.toHaveBeenCalled();
    expect(f.session.close).toHaveBeenCalledOnce();
    await expect(fs.stat(f.stages[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops between chunks on cancellation and closes both temporary stores", async () => {
    const f = fixture({ bytes: Buffer.alloc(GIT_BUNDLE_CHUNK_BYTES + 1) });
    const controller = new AbortController();
    f.session.writeChunk.mockImplementation(() => {
      controller.abort(new Error("cancelled"));
      return Promise.resolve();
    });
    await expect(
      executeSandboxGitClone({ repository }, { ...f.context, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(f.session.writeChunk).toHaveBeenCalledOnce();
    expect(f.session.finish).not.toHaveBeenCalled();
    expect(f.sandbox).not.toHaveBeenCalled();
    expect(f.session.close).toHaveBeenCalledOnce();
    await expect(fs.stat(f.stages[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still deletes host staging if sandbox cleanup fails", async () => {
    const f = fixture();
    f.session.close.mockRejectedValue(new Error("worker unavailable"));
    await expect(executeSandboxGitClone({ repository }, f.context)).rejects.toThrow(
      "cleanup failed",
    );
    await expect(fs.stat(f.stages[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks immutable locator admission before acquisition", async () => {
    const f = fixture();
    for (const args of [
      { repository: "https://unapproved.invalid/owner/widget.git" },
      { repository: "http://example.invalid/owner/widget.git" },
      { repository, destination: "/host/work" },
    ])
      await expect(executeSandboxGitClone(args, f.context)).rejects.toThrow();
    expect(f.host).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
});

describe("sandbox Git command authority", () => {
  it("uses a fixed cleared environment, disabled hooks and only local file transport", () => {
    const argv = sandboxGitArguments("/run/pi-sandbox/home", ["--version"]);
    expect(argv.slice(0, 3)).toEqual(["/usr/bin/env", "-i", "HOME=/run/pi-sandbox/home"]);
    expect(argv).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(argv).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(argv).toContain("core.hooksPath=/dev/null");
    expect(argv).toContain("protocol.allow=never");
    expect(argv).toContain("protocol.file.allow=always");
    expect(argv.at(-1)).toBe("--version");
    expect(gitSandboxCloneTarget(repository, "/run/pi-sandbox/home")).toBe(
      "/run/pi-sandbox/home/repos/widget",
    );
    expect(() => sandboxGitArguments("relative", [])).toThrow("absolute sandbox home");
  });
});
