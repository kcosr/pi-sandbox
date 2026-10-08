import { existsSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { expandManagedHomePaths } from "../../src/domain/index.js";
import { createBubblewrapExecutor, type SandboxExecutor } from "../../src/sandbox/index.js";
import { testSandboxWorkerCommand } from "../helpers/sandbox-worker.js";

const bubblewrapPath = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
const available = process.platform === "linux" && existsSync(bubblewrapPath);
const roots: string[] = [];
const executors: SandboxExecutor[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(parent = "/var/tmp") {
  const root = await mkdtemp(path.join(parent, "pi-sandbox-hidden-"));
  roots.push(root);
  const runs = path.join(root, "runs");
  const cwd = path.join(runs, "a");
  const sibling = path.join(runs, "b");
  const privateDirectory = path.join(cwd, "private");
  const transcripts = path.join(root, "transcripts");
  for (const directory of [cwd, sibling, privateDirectory, transcripts]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "secret.txt"), `secret:${directory}`);
  }
  await symlink(sibling, path.join(cwd, "absolute-sibling"));
  await symlink("../b", path.join(cwd, "relative-sibling"));
  await symlink(privateDirectory, path.join(cwd, "private-link"));
  await symlink(runs, path.join(root, "alias"));
  await writeFile(path.join(root, "visible.txt"), "ordinary host data");
  return { root, runs, cwd, sibling, privateDirectory, transcripts };
}

describe.skipIf(!available)("hidden paths through real Bubblewrap", () => {
  it.each([false, true])(
    "expands home masks independently of CWD and preserves the workspace exception (inside=%s)",
    async (insideHome) => {
      const { root, runs, cwd, privateDirectory } = await fixture();
      const launch = insideHome ? cwd : path.join(root, "outside-home-workspace");
      await mkdir(launch, { recursive: true });
      const expanded = expandManagedHomePaths(
        { cwdWritable: true, hiddenPaths: ["~", "~/a/private"] },
        { pi: {}, sandbox: { ACCOUNT_CACHE: "~/cache" }, extensions: {} },
        () => runs,
      );
      const executor = await createBubblewrapExecutor({
        cwd: launch,
        bubblewrapPath,
        ...expanded.filesystem,
        environment: expanded.environment.sandbox,
        workerCommand: testSandboxWorkerCommand(),
      });
      executors.push(executor);
      await executor.probe();
      const result = await executor.execute({
        argv: [
          "/bin/bash",
          "-c",
          'printf "%s\\n" "$ACCOUNT_CACHE"; ls -A -- "$1"',
          "home-expansion-test",
          runs,
        ],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(`${runs}/cache\n${insideHome ? "a\n" : ""}`);
      if (insideHome) {
        const contents = await executor.execute({
          argv: ["/bin/bash", "-c", "cat secret.txt; ls -A private"],
        });
        expect(contents.exitCode).toBe(0);
        expect(contents.stdout.toString()).toBe(`secret:${cwd}`);
      }
      expect(await readFile(path.join(privateDirectory, "secret.txt"), "utf8")).toBe(
        `secret:${privateDirectory}`,
      );
    },
  );

  it.each([
    [true, "/var/tmp"],
    [false, "/var/tmp"],
    [true, "/tmp"],
    [false, "/tmp"],
  ] as const)(
    "hides other runs and transcripts while restoring CWD (writable=%s, parent=%s)",
    async (cwdWritable, parent) => {
      const { root, runs, cwd, sibling, privateDirectory, transcripts } = await fixture(parent);
      const executor = await createBubblewrapExecutor({
        cwd,
        cwdWritable,
        bubblewrapPath,
        hiddenPaths: [sibling, privateDirectory, runs, transcripts],
        workerCommand: testSandboxWorkerCommand(),
      });
      executors.push(executor);
      await executor.probe();
      const execute = (script: string, ...args: string[]) =>
        executor.execute({ argv: ["/bin/bash", "-c", script, "hidden-test", ...args] });
      const visible = await execute(
        'pwd && cat secret.txt && cat "$1" && /bin/echo utility-result',
        parent === "/tmp" ? "/etc/os-release" : path.join(root, "visible.txt"),
      );
      expect(visible.exitCode).toBe(0);
      expect(visible.stdout.toString()).toContain(cwd);
      expect(visible.stdout.toString()).toContain(`secret:${cwd}`);
      expect(visible.stdout.toString()).toContain(
        parent === "/tmp" ? "NAME=" : "ordinary host data",
      );
      expect(visible.stdout.toString()).toContain("utility-result");
      for (const target of [
        path.join(sibling, "secret.txt"),
        "../b/secret.txt",
        "absolute-sibling/secret.txt",
        "relative-sibling/secret.txt",
        "private/secret.txt",
        "private-link/secret.txt",
        path.join(transcripts, "secret.txt"),
        path.join(root, "alias", "b", "secret.txt"),
      ]) {
        const read = await execute('cat -- "$1"', target);
        expect(read.exitCode, target).not.toBe(0);
        expect(read.stdout.toString(), target).toBe("");
      }
      const parentList = await execute(
        'ls -A -- "$1"; ls -A -- "$2"; ls -A -- "$3"',
        runs,
        privateDirectory,
        transcripts,
      );
      expect(parentList.exitCode).toBe(0);
      expect(parentList.stdout.toString()).toBe("a\n");
      for (const target of [
        path.join(runs, "created"),
        path.join(privateDirectory, "created"),
        path.join(transcripts, "created"),
      ]) {
        expect(
          (await execute('chmod 777 "${1%/*}"; printf nope > "$1"', target)).exitCode,
        ).not.toBe(0);
        expect(existsSync(target)).toBe(false);
      }
      const write = await execute("printf own > output.txt");
      expect(write.exitCode === 0).toBe(cwdWritable);
      if (cwdWritable) expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("own");
      const temporary = await execute(
        "printf temporary > /tmp/hidden-mask-test; printf runtime > /run/pi-sandbox/state/hidden-mask-test",
      );
      expect(temporary.exitCode).toBe(0);
      expect(await readFile(path.join(privateDirectory, "secret.txt"), "utf8")).toBe(
        `secret:${privateDirectory}`,
      );
      expect(await readFile(path.join(sibling, "secret.txt"), "utf8")).toBe(`secret:${sibling}`);
    },
  );

  it.each([
    [true, "/var/tmp"],
    [false, "/var/tmp"],
    [true, "/tmp"],
    [false, "/tmp"],
  ] as const)(
    "masks regular files and preserves host content (writable=%s, parent=%s)",
    async (cwdWritable, parent) => {
      const { root, cwd, runs, privateDirectory } = await fixture(parent);
      const hiddenFile = path.join(cwd, "credentials");
      const siblingFile = path.join(root, "visible.txt");
      const redundantFile = path.join(privateDirectory, "secret.txt");
      await writeFile(hiddenFile, "private credential");
      const originalFileMode = (await stat(hiddenFile)).mode;
      await symlink(hiddenFile, path.join(cwd, "credential-link"));
      const executor = await createBubblewrapExecutor({
        cwd,
        cwdWritable,
        bubblewrapPath,
        hiddenPaths: [hiddenFile, siblingFile, runs, privateDirectory, redundantFile],
        workerCommand: testSandboxWorkerCommand(),
      });
      executors.push(executor);
      await executor.probe();
      const execute = (script: string, ...args: string[]) =>
        executor.execute({ argv: ["/bin/bash", "-c", script, "hidden-file-test", ...args] });
      for (const target of [hiddenFile, "credentials", "credential-link", siblingFile]) {
        const result = await execute('test -f "$1" && ! test -s "$1" && cat -- "$1"', target);
        expect(result.exitCode, target).toBe(0);
        expect(result.stdout.toString(), target).toBe("");
        for (const script of [
          'printf changed > "$1"',
          'chmod 777 "$1"; printf changed > "$1"',
          ...(target === "credential-link" ? [] : ['rm -- "$1"', 'mv -- "$1" "$1-renamed"']),
        ]) {
          expect((await execute(script, target)).exitCode, `${script} ${target}`).not.toBe(0);
        }
      }
      if (cwdWritable) {
        expect(
          (await execute("printf replacement > replacement; mv -f replacement credentials"))
            .exitCode,
        ).not.toBe(0);
        expect(
          (await execute("printf replacement > replacement; cp replacement credentials")).exitCode,
        ).not.toBe(0);
        expect(
          (await execute('rm -f credentials; ln -s "$1" credentials', siblingFile)).exitCode,
        ).not.toBe(0);
      }
      expect(await readFile(hiddenFile, "utf8")).toBe("private credential");
      expect((await stat(hiddenFile)).mode).toBe(originalFileMode);
      expect(await readFile(siblingFile, "utf8")).toBe("ordinary host data");
      expect(await readFile(redundantFile, "utf8")).toBe(`secret:${privateDirectory}`);
      const stillMasked = await execute('cat credentials "$1"', siblingFile);
      expect(stillMasked.exitCode).toBe(0);
      expect(stillMasked.stdout.toString()).toBe("");
    },
  );

  it("closes file-mask input descriptors when the worker fails to start", async () => {
    const { root, cwd } = await fixture();
    await expect(
      createBubblewrapExecutor({
        cwd,
        bubblewrapPath,
        hiddenPaths: [path.join(root, "visible.txt"), path.join(cwd, "secret.txt")],
        workerCommand: ["/bin/false"],
      }),
    ).rejects.toMatchObject({ code: "sandbox_start_failed" });
  });

  it("starts file masks when the host executor runs under Bun", async () => {
    const { root, cwd } = await fixture();
    const hiddenPaths = [path.join(root, "visible.txt"), path.join(cwd, "secret.txt")];
    const workerCommand = testSandboxWorkerCommand();
    const source = `
      import { createBubblewrapExecutor } from ${JSON.stringify(path.resolve("src/sandbox/bubblewrap-executor.ts"))};
      const executor = await createBubblewrapExecutor(${JSON.stringify({ cwd, bubblewrapPath, hiddenPaths, workerCommand })});
      try {
        const result = await executor.execute({ argv: ["/bin/cat", ${hiddenPaths.map((target) => JSON.stringify(target)).join(", ")}] });
        if (result.exitCode !== 0 || result.stdout.length !== 0) throw new Error("Bun file masks did not hide contents");
        console.log("bun-file-masks-ok");
      } finally {
        await executor.close();
      }
    `;
    const { stdout } = await execFileAsync(workerCommand[0], ["--eval", source], {
      timeout: 12_000,
    });
    expect(stdout.trim()).toBe("bun-file-masks-ok");
  }, 15_000);

  it("fails closed on missing paths, special files, symlinks, and symlink ancestors", async () => {
    const { root, cwd } = await fixture();
    const fifo = path.join(root, "fifo");
    expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
    const fileLink = path.join(root, "file-link");
    await symlink(path.join(root, "visible.txt"), fileLink);
    for (const hiddenPath of [
      path.join(root, "missing"),
      fifo,
      fileLink,
      path.join(root, "alias"),
      path.join(root, "alias", "b"),
      path.join(root, "alias", "a", "secret.txt"),
    ]) {
      await expect(
        createBubblewrapExecutor({
          cwd,
          bubblewrapPath,
          hiddenPaths: [hiddenPath],
          workerCommand: testSandboxWorkerCommand(),
        }),
      ).rejects.toMatchObject({ code: "sandbox_start_failed" });
    }
  });
});
