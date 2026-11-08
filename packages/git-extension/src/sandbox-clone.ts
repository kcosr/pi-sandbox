import { constants } from "node:fs";
import { chmod, mkdtemp, open, rm, statfs, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  GIT_EXECUTABLE,
  gitCloneTarget,
  parseGitCloneArguments,
  parseGitCloneConfig,
  validateGitCloneRepository,
  type GitCloneArguments,
  type GitCloneContext,
  type GitExecutionPort,
} from "./core.js";

export const GIT_BUNDLE_MAXIMUM_BYTES = 512 * 1_048_576;
export const GIT_BUNDLE_CHUNK_BYTES = 256 * 1024;
const HOST_STAGING_ROOT = "/dev/shm";
const TMPFS_MAGIC = 0x01021994;

/** Borrowed, trusted capabilities. This package does not own a sandbox backend. */
export interface GitSandboxImportSession {
  writeChunk(chunk: Uint8Array): Promise<void>;
  finish(): Promise<string>;
  reserveDirectory(
    relativePath: string,
  ): Promise<{ readonly path: string; readonly displayPath: string }>;
  verifyDirectory(): Promise<void>;
  close(): Promise<void>;
}

export interface GitSandboxImportTarget {
  open(signal?: AbortSignal): Promise<GitSandboxImportSession>;
}

export interface GitSandboxCloneRuntime extends GitExecutionPort {
  readonly home: string;
  readonly imports: GitSandboxImportTarget;
}

export interface GitSandboxCloneContext extends GitCloneContext {
  readonly sandbox: GitSandboxCloneRuntime;
}

interface RepositoryMetadata {
  readonly objectFormat: "sha1" | "sha256";
  readonly symbolicHead?: string;
  readonly head?: string;
  readonly hasObjects: boolean;
}

type ExecutionResult = Awaited<ReturnType<GitExecutionPort["execute"]>>;

/** All local Git operations have a cleared environment and no network protocols. */
export function sandboxGitArguments(
  home: string,
  argv: readonly string[],
): readonly [string, ...string[]] {
  assertHome(home);
  return [
    "/usr/bin/env",
    "-i",
    `HOME=${home}`,
    "TMPDIR=/tmp",
    "PATH=/usr/bin:/bin",
    "LANG=C",
    "LC_ALL=C",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GIT_CONFIG_SYSTEM=/dev/null",
    "GIT_CONFIG_NOSYSTEM=1",
    "GIT_TERMINAL_PROMPT=0",
    "GIT_ATTR_NOSYSTEM=1",
    GIT_EXECUTABLE,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.file.allow=always",
    ...argv,
  ];
}

export function gitSandboxCloneTarget(repository: string, home: string): string {
  assertHome(home);
  return gitCloneTarget(repository, path.join(home, "repos"));
}

/** Acquire on host tmpfs, then create a normal checkout through sandbox authority. */
export async function executeSandboxGitClone(
  arguments_: Readonly<GitCloneArguments>,
  context: GitSandboxCloneContext,
) {
  const { repository } = parseGitCloneArguments(arguments_);
  const config = parseGitCloneConfig(context.config);
  const parsed = validateGitCloneRepository(repository, config);
  if (!context.host || typeof context.host.execute !== "function")
    throw new Error("Git requires an explicit host execution port");
  const sandbox = context.sandbox;
  if (!sandbox || typeof sandbox.execute !== "function" || !sandbox.imports)
    throw new Error("Git sandbox destination is unavailable");
  const destination = gitSandboxCloneTarget(repository, sandbox.home);
  context.signal?.throwIfAborted();
  const storage = await statfs(HOST_STAGING_ROOT);
  if (storage.type !== TMPFS_MAGIC)
    throw new Error("Git sandbox cloning requires writable tmpfs at /dev/shm");

  const staging = await mkdtemp(path.join(HOST_STAGING_ROOT, "pi-git-"));
  let source: FileHandle | undefined;
  let session: GitSandboxImportSession | undefined;
  let failure: unknown;
  try {
    await chmod(staging, 0o700);
    // Check the directory actually created, not only the parent observed earlier.
    if ((await statfs(staging)).type !== TMPFS_MAGIC)
      throw new Error("Git sandbox cloning requires tmpfs staging");
    const bare = path.join(staging, "repository.git");
    const bundle = path.join(staging, "repository.bundle");
    const options = context.signal === undefined ? {} : { signal: context.signal };
    const hostGit = async (argv: readonly string[], accepted = [0]): Promise<ExecutionResult> => {
      context.signal?.throwIfAborted();
      const result = await context.host.execute({ argv: [GIT_EXECUTABLE, ...argv] }, options);
      requireSuccess(result, accepted);
      return result;
    };
    await hostGit([
      "-c",
      "protocol.allow=never",
      ...config.allowed_schemes.flatMap((scheme) => ["-c", `protocol.${scheme}.allow=always`]),
      "-c",
      "core.hooksPath=/dev/null",
      "clone",
      "--bare",
      "--template=",
      "--",
      repository,
      bare,
    ]);
    const metadata = await repositoryMetadata(hostGit, bare);
    let bundleSize = 0;
    if (metadata.hasObjects) {
      await hostGit(["-C", bare, "bundle", "create", bundle, "--all"]);
      source = await open(bundle, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await source.stat();
      if (!info.isFile() || info.size < 1 || info.size > GIT_BUNDLE_MAXIMUM_BYTES)
        throw new Error("Git bundle exceeds the 512 MiB transfer limit or is not a regular file");
      bundleSize = info.size;
    }

    context.signal?.throwIfAborted();
    session = await sandbox.imports.open(context.signal);
    const reserved = await session
      .reserveDirectory(`repos/${parsed.destinationName}`)
      .catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "import_destination_exists"
        )
          throw new Error(
            `Git clone destination already exists: ${destination}. Use the existing checkout, or inspect and remove it with the normal tools before retrying git_clone.`,
            { cause: error },
          );
        throw error;
      });
    if (
      reserved.displayPath !== destination ||
      !path.isAbsolute(reserved.path) ||
      reserved.path.includes("\0")
    )
      throw new Error("Git sandbox destination does not match its reserved directory");

    let importedBundle: string | undefined;
    if (source !== undefined) {
      const bytes = Buffer.alloc(GIT_BUNDLE_CHUNK_BYTES);
      let total = 0;
      while (true) {
        context.signal?.throwIfAborted();
        const { bytesRead } = await source.read(bytes, 0, bytes.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > GIT_BUNDLE_MAXIMUM_BYTES || total > bundleSize)
          throw new Error("Git bundle changed during transfer");
        await session.writeChunk(bytes.subarray(0, bytesRead));
      }
      if (total !== bundleSize || (await source.stat()).size !== bundleSize)
        throw new Error("Git bundle changed during transfer");
      importedBundle = await session.finish();
    }

    const sandboxGit = async (argv: readonly string[]): Promise<void> => {
      context.signal?.throwIfAborted();
      await session!.verifyDirectory();
      const result = await sandbox.execute(
        { argv: sandboxGitArguments(sandbox.home, argv) },
        options,
      );
      requireSuccess(result);
    };
    const branch = metadata.symbolicHead?.slice("refs/heads/".length);
    if (importedBundle === undefined) {
      await sandboxGit([
        "init",
        "--template=",
        `--object-format=${metadata.objectFormat}`,
        ...(branch === undefined ? [] : [`--initial-branch=${branch}`]),
        "--",
        reserved.path,
      ]);
      await sandboxGit(["-C", reserved.path, "remote", "add", "--", "origin", repository]);
    } else {
      await sandboxGit([
        "clone",
        "--no-checkout",
        "--template=",
        ...(branch !== undefined && metadata.head !== undefined ? [`--branch=${branch}`] : []),
        "--",
        importedBundle,
        reserved.path,
      ]);
      await sandboxGit(["-C", reserved.path, "remote", "set-url", "--", "origin", repository]);
    }

    if (metadata.symbolicHead !== undefined) {
      await sandboxGit(["-C", reserved.path, "symbolic-ref", "HEAD", metadata.symbolicHead]);
      await sandboxGit([
        "-C",
        reserved.path,
        "config",
        "--local",
        `branch.${branch!}.remote`,
        "origin",
      ]);
      await sandboxGit([
        "-C",
        reserved.path,
        "config",
        "--local",
        `branch.${branch!}.merge`,
        metadata.symbolicHead,
      ]);
      if (metadata.head !== undefined) {
        await sandboxGit([
          "-C",
          reserved.path,
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          `refs/remotes/origin/${branch!}`,
        ]);
      }
    } else if (metadata.head !== undefined) {
      await sandboxGit(["-C", reserved.path, "update-ref", "--no-deref", "HEAD", metadata.head]);
    }
    if (metadata.symbolicHead === undefined || metadata.head === undefined)
      await sandboxGit([
        "-C",
        reserved.path,
        "update-ref",
        "--no-deref",
        "-d",
        "refs/remotes/origin/HEAD",
      ]);
    if (metadata.head !== undefined)
      await sandboxGit(["-C", reserved.path, "reset", "--hard", "HEAD"]);
    await session.verifyDirectory();
    return {
      content: [{ type: "text" as const, text: `Cloned repository into ${destination}.` }],
      details: undefined,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupClone(staging, source, session, failure);
  }
}

async function cleanupClone(
  staging: string,
  source: FileHandle | undefined,
  session: GitSandboxImportSession | undefined,
  failure: unknown,
): Promise<void> {
  const closed = await Promise.allSettled([source?.close(), session?.close()]);
  const removed = await Promise.allSettled([rm(staging, { recursive: true, force: true })]);
  const errors = [...closed, ...removed].flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (errors.length)
    throw new AggregateError(
      failure === undefined ? errors : [failure, ...errors],
      "Git clone temporary storage cleanup failed",
    );
}

async function repositoryMetadata(
  git: (argv: readonly string[], accepted?: number[]) => Promise<ExecutionResult>,
  bare: string,
): Promise<RepositoryMetadata> {
  const format = decode((await git(["-C", bare, "rev-parse", "--show-object-format"])).stdout);
  if (format !== "sha1" && format !== "sha256") throw new Error("Unsupported Git object format");
  const symbolic = await git(["-C", bare, "symbolic-ref", "--quiet", "HEAD"], [0, 1]);
  const symbolicHead = symbolic.exitCode === 0 ? decode(symbolic.stdout) : undefined;
  if (
    symbolicHead !== undefined &&
    (!symbolicHead.startsWith("refs/heads/") ||
      symbolicHead.length > 1024 ||
      Array.from(symbolicHead).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x20 || code === 0x7f;
      }))
  )
    throw new Error("Unsupported Git default branch");
  const resolved = await git(["-C", bare, "rev-parse", "--verify", "--quiet", "HEAD"], [0, 1]);
  const head = resolved.exitCode === 0 ? decode(resolved.stdout) : undefined;
  if (head !== undefined && !(format === "sha1" ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(head))
    throw new Error("Invalid Git HEAD object");
  const refs = decode(
    (await git(["-C", bare, "for-each-ref", "--count=1", "--format=%(refname)"])).stdout,
  );
  return {
    objectFormat: format,
    ...(symbolicHead === undefined ? {} : { symbolicHead }),
    ...(head === undefined ? {} : { head }),
    hasObjects: head !== undefined || refs.length > 0,
  };
}

function requireSuccess(result: ExecutionResult, accepted: readonly number[] = [0]): void {
  if (result.exitCode !== null && accepted.includes(result.exitCode)) return;
  throw new Error(
    `git clone failed: ${decode(result.stderr) || decode(result.stdout) || `terminated by ${result.signal ?? "unknown signal"}`}`,
  );
}

function decode(value: Uint8Array): string {
  return Buffer.from(value).toString("utf8").trim();
}

function assertHome(home: string): void {
  if (!path.isAbsolute(home) || path.normalize(home) !== home || home.includes("\0"))
    throw new Error("Git requires a canonical absolute sandbox home");
}
