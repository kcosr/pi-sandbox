import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBubblewrapExecutor, type SandboxExecutor } from "../../src/sandbox/index.js";
import { testSandboxWorkerCommand } from "../helpers/sandbox-worker.js";

const bubblewrapPath = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
const available = process.platform === "linux" && existsSync(bubblewrapPath);
const roots: string[] = [];
const executors: SandboxExecutor[] = [];

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

describe.skipIf(!available)("hidden directories through real Bubblewrap", () => {
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

  it("fails closed on missing paths, files, symlinks, and symlink ancestors", async () => {
    const { root, cwd } = await fixture();
    for (const hiddenPath of [
      path.join(root, "missing"),
      path.join(root, "visible.txt"),
      path.join(root, "alias"),
      path.join(root, "alias", "b"),
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
