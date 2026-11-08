import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBubblewrapExecutor } from "../../sandbox-extension/src/runtime/bubblewrap-executor.js";
import type { SandboxExecutor } from "../../sandbox-extension/src/runtime/contracts.js";
import { createHostCommandExecutor } from "../../sandbox-extension/src/runtime/host-command/host-command-executor.js";
import type { SandboxImportTarget } from "../../sandbox-extension/src/runtime/import/contracts.js";
import { testSandboxWorkerCommand } from "../../../tests/helpers/sandbox-worker.js";
import { gitHostEnvironment, parseGitCloneConfig, type GitExecutionPort } from "./core.js";
import { executeSandboxGitClone, sandboxGitArguments } from "./sandbox-clone.js";

const bubblewrapPath = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
const available =
  process.platform === "linux" && existsSync(bubblewrapPath) && existsSync("/usr/bin/git");

describe.skipIf(!available)("sandbox clone through real Git HTTP and Bubblewrap", () => {
  let root: string;
  let cwd: string;
  let fixtures: string;
  let server: Server;
  let origin: string;
  let executor: SandboxExecutor;
  let imports: SandboxImportTarget;
  let host: ReturnType<typeof createHostCommandExecutor>;
  const commits = new Map<string, string>();

  function git(argv: readonly string[]) {
    return execFileSync("/usr/bin/git", [...argv], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();
  }

  beforeAll(async () => {
    root = await mkdtemp("/var/tmp/pi-git-sandbox-native-");
    cwd = path.join(root, "workspace");
    fixtures = path.join(root, "fixtures");
    await mkdir(cwd);
    await mkdir(fixtures);
    await writeFile(path.join(cwd, "host-input"), "unchanged");
    for (const name of ["normal", "sha256", "empty", "missing", "detached"]) {
      const seed = path.join(fixtures, `${name}-seed`);
      git([
        "init",
        "--quiet",
        "--initial-branch=develop",
        `--object-format=${name === "sha256" ? "sha256" : "sha1"}`,
        seed,
      ]);
      if (name !== "empty") {
        await writeFile(path.join(seed, "README.md"), `${name} fixture\n`);
        // An incompressible fixture crosses the transfer chunk boundary.
        if (name === "normal")
          await writeFile(path.join(seed, "payload.bin"), randomBytes(300_000));
        git(["-C", seed, "add", "."]);
        git(["-C", seed, "commit", "--quiet", "-m", "initial"]);
        git(["-C", seed, "branch", "feature"]);
        git(["-C", seed, "tag", "v1"]);
        if (name === "detached") {
          git(["-C", seed, "checkout", "--quiet", "--detach"]);
          await writeFile(path.join(seed, "detached.txt"), "detached commit\n");
          git(["-C", seed, "add", "."]);
          git(["-C", seed, "commit", "--quiet", "-m", "detached"]);
        }
        commits.set(name, git(["-C", seed, "rev-parse", "HEAD"]));
      }
      const remote = path.join(fixtures, `${name}.git`);
      git(["clone", "--quiet", "--bare", "--", seed, remote]);
      if (name === "missing") git(["-C", remote, "symbolic-ref", "HEAD", "refs/heads/missing"]);
    }
    const backend = path.join(git(["--exec-path"]), "git-http-backend");
    server = createServer((request, response) => {
      const url = new URL(request.url!, "http://127.0.0.1");
      const child = spawn(backend, [], {
        env: {
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_PROJECT_ROOT: fixtures,
          GIT_HTTP_EXPORT_ALL: "1",
          GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method!,
          CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
          CONTENT_LENGTH: String(request.headers["content-length"] ?? ""),
          REMOTE_ADDR: "127.0.0.1",
          SERVER_PROTOCOL: "HTTP/1.1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.resume();
      child.stdin.on("error", () => undefined);
      child.on("error", () => {
        response.statusCode = 500;
        response.end();
      });
      child.on("close", (code) => {
        if (response.writableEnded) return;
        const output = Buffer.concat(chunks);
        const boundary = output.indexOf("\r\n\r\n");
        if (code !== 0 || boundary < 0) {
          response.statusCode = 500;
          response.end();
          return;
        }
        for (const header of output.subarray(0, boundary).toString().split("\r\n")) {
          const separator = header.indexOf(":");
          const name = header.slice(0, separator);
          const value = header.slice(separator + 1).trim();
          if (name.toLowerCase() === "status") response.statusCode = Number(value.split(" ")[0]);
          else response.setHeader(name, value);
        }
        response.end(output.subarray(boundary + 4));
      });
      request.pipe(child.stdin);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("HTTP fixture unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    executor = await createBubblewrapExecutor({
      cwd,
      cwdWritable: false,
      networkMode: "none",
      bubblewrapPath,
      hiddenPaths: [fixtures],
      environment: { GIT_DIR: path.join(cwd, "host-input"), GIT_WORK_TREE: cwd },
      workerCommand: testSandboxWorkerCommand(),
      onImportTarget(target) {
        imports = target;
      },
    });
    host = createHostCommandExecutor({
      cwd,
      environment: gitHostEnvironment({ PATH: "/usr/bin:/bin", HOME: root }),
    });
  }, 30_000);

  afterAll(async () => {
    await host?.close();
    await executor?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function sandboxGit(name: string, argv: string[]) {
    return executor.execute({
      argv: sandboxGitArguments(executor.home, [
        "-C",
        path.join(executor.home, "repos", name),
        ...argv,
      ]),
    });
  }

  it.each(["normal", "sha256", "empty", "missing", "detached"])(
    "imports %s with correct Git state and no host checkout",
    async (name) => {
      const repository = `${origin}/${name}.git`;
      const stages: string[] = [];
      const observedHost: GitExecutionPort = {
        execute(request, options) {
          if (request.argv.includes("clone")) stages.push(path.dirname(request.argv.at(-1)!));
          return host.execute(request, options);
        },
      };
      const result = await executeSandboxGitClone(
        { repository },
        {
          cwd,
          config: parseGitCloneConfig({ allowed_hosts: ["127.0.0.1"], allowed_schemes: ["http"] }),
          host: observedHost,
          sandbox: { home: executor.home, execute: executor.execute.bind(executor), imports },
        },
      );
      expect(result.content[0]!.text).toContain(`${executor.home}/repos/${name}`);
      expect(
        (await sandboxGit(name, ["remote", "get-url", "origin"])).stdout.toString().trim(),
      ).toBe(repository);
      const symbolic = await sandboxGit(name, ["symbolic-ref", "--quiet", "HEAD"]);
      if (name === "detached") expect(symbolic.exitCode).toBe(1);
      else
        expect(symbolic.stdout.toString().trim()).toBe(
          name === "missing" ? "refs/heads/missing" : "refs/heads/develop",
        );
      if (name === "empty" || name === "missing") {
        expect(
          (await sandboxGit(name, ["rev-parse", "--verify", "--quiet", "HEAD"])).exitCode,
        ).toBe(1);
      } else {
        expect((await sandboxGit(name, ["rev-parse", "HEAD"])).stdout.toString().trim()).toBe(
          commits.get(name),
        );
        expect((await sandboxGit(name, ["status", "--porcelain"])).stdout.toString()).toBe("");
        expect((await sandboxGit(name, ["tag"])).stdout.toString().trim()).toBe("v1");
        expect((await sandboxGit(name, ["branch", "--remotes"])).stdout.toString()).toContain(
          "origin/feature",
        );
      }
      if (name === "normal") {
        expect(
          (await sandboxGit(name, ["symbolic-ref", "refs/remotes/origin/HEAD"])).stdout
            .toString()
            .trim(),
        ).toBe("refs/remotes/origin/develop");
        expect(
          (await sandboxGit(name, ["config", "branch.develop.merge"])).stdout.toString().trim(),
        ).toBe("refs/heads/develop");
      }
      if (name === "sha256")
        expect(
          (await sandboxGit(name, ["rev-parse", "--show-object-format"])).stdout.toString().trim(),
        ).toBe("sha256");
      expect(await readdir(cwd)).toEqual(["host-input"]);
      expect(await readFile(path.join(cwd, "host-input"), "utf8")).toBe("unchanged");
      for (const stage of stages) expect(existsSync(stage)).toBe(false);
    },
    30_000,
  );
});
