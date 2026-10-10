import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createSmolvmExecutor } from "../../packages/sandbox-extension/src/runtime/smolvm/packed.js";
import type { SandboxExecutor } from "../../packages/sandbox-extension/src/runtime/contracts.js";

const runtime = process.env.PI_SANDBOX_SMOLVM_BIN;
const image = process.env.PI_SANDBOX_SMOLVM_IMAGE;
const digest = process.env.PI_SANDBOX_SMOLVM_IMAGE_SHA256;
const enabled =
  process.platform === "linux" && process.arch === "x64" && !!runtime && !!image && !!digest;
if (process.env.PI_SANDBOX_REQUIRE_SMOLVM === "1" && !enabled)
  throw new Error("Required smolvm packed tests need Linux x64 and explicit runtime/image/SHA256");

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Guest concurrency barrier timed out");
    await delay(20);
  }
}

async function fixture(
  action: (vm: SandboxExecutor, cwd: string, root: string) => Promise<void>,
  writable = true,
) {
  const root = await mkdtemp("/var/tmp/psvm-");
  const cwd = path.join(root, "project");
  const state = path.join(root, "state");
  await mkdir(cwd);
  await mkdir(state, { mode: 0o700 });
  await writeFile(path.join(root, "host-only"), "host secret fixture");
  const vm = await createSmolvmExecutor({
    cwd,
    cwdWritable: writable,
    stateDirectory: state,
    smolvmPath: runtime!,
    imagePath: image!,
    imageSha256: digest!,
    resources: { cpus: 1, memoryMiB: 512, storageGiB: 1, overlayGiB: 1 },
    environment: { FIXTURE_VALUE: "configured" },
  });
  try {
    await action(vm, cwd, root);
  } finally {
    await vm.close();
    expect(await readdir(state)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(!enabled)("native packed smolvm", () => {
  it("overlaps four commands with independent streams and isolates queued cancellation/deadlines", async () => {
    await fixture(async (vm, cwd) => {
      const output = ["", "", "", ""];
      const errorOutput = ["", "", "", ""];
      const running = output.map((_, index) =>
        vm.execute(
          {
            argv: [
              "/bin/bash",
              "-c",
              'printf "ready-%s\\n" "$1"; cat > "input-$1"; while ! test -f release; do sleep .02; done; cat "input-$1"; printf "error-%s" "$1" >&2; exit "$1"',
              "fixture",
              String(index),
            ],
            stdin: Buffer.from(`payload-${index}\0`),
            timeoutMs: 30000,
          },
          {
            onStdout: (chunk) => {
              output[index] += chunk.toString();
            },
            onStderr: (chunk) => {
              errorOutput[index] += chunk.toString();
            },
          },
        ),
      );
      const settled = Promise.allSettled(running);
      await waitFor(() => output.every((value, index) => value.includes(`ready-${index}\n`)));
      await expect(
        vm.execute({ argv: ["/bin/touch", "timed-out"], timeoutMs: 100 }),
      ).rejects.toMatchObject({ code: "sandbox_timeout" });
      const controller = new AbortController();
      const queued = vm.execute(
        { argv: ["/bin/touch", "cancelled"] },
        { signal: controller.signal },
      );
      const rejection = expect(queued).rejects.toMatchObject({ code: "sandbox_aborted" });
      controller.abort();
      await rejection;
      await writeFile(path.join(cwd, "release"), "go");
      const results = await settled;
      for (const [index, result] of results.entries()) {
        expect(result.status).toBe("fulfilled");
        if (result.status !== "fulfilled") throw result.reason;
        expect(result.value.exitCode).toBe(index);
        expect(result.value.stdout.toString()).toBe(`ready-${index}\npayload-${index}\0`);
        expect(result.value.stderr.toString()).toBe(`error-${index}`);
        expect(output[index]).toBe(result.value.stdout.toString());
        expect(errorOutput[index]).toBe(result.value.stderr.toString());
      }
      expect(await readdir(cwd)).not.toContain("timed-out");
      expect(await readdir(cwd)).not.toContain("cancelled");
      expect((await vm.execute({ argv: ["/bin/true"] })).exitCode).toBe(0);
    });
  }, 180000);

  it("drains continuing background output and completes quiet inherited pipes", async () => {
    await fixture(async (vm) => {
      const result = await vm.execute({
        argv: ["/bin/bash", "-c", "(for n in 1 2 3 4 5 6; do printf tick; sleep .03; done) &"],
        timeoutMs: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("tick".repeat(6));
      expect(
        (await vm.execute({ argv: ["/bin/bash", "-c", "sleep 60 &"], timeoutMs: 5000 })).exitCode,
      ).toBe(0);
      expect((await vm.execute({ argv: ["/bin/true"] })).exitCode).toBe(0);
    });
  }, 180000);
  it("rejects a project containing host control state through a directory alias", async () => {
    const root = await mkdtemp("/var/tmp/psalias-");
    const cwd = path.join(root, "project");
    const state = path.join(root, "state");
    const alias = path.join(root, "agent-state");
    const original = process.env.PI_CODING_AGENT_DIR;
    try {
      await mkdir(cwd);
      await mkdir(state, { mode: 0o700 });
      await mkdir(path.join(cwd, "control"));
      await symlink(path.join(cwd, "control"), alias);
      process.env.PI_CODING_AGENT_DIR = alias;
      await expect(
        createSmolvmExecutor({
          cwd,
          stateDirectory: state,
          smolvmPath: runtime!,
          imagePath: image!,
          imageSha256: digest!,
          resources: { cpus: 1, memoryMiB: 512, storageGiB: 1, overlayGiB: 1 },
        }),
      ).rejects.toThrow("smolvm_workspace_exposes_host_control_state");
      expect(await readdir(state)).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = original;
      await rm(root, { recursive: true, force: true });
    }
  });
  it("shares only the project, streams binary input, and retains background work until close", async () => {
    await fixture(async (vm, cwd, root) => {
      const input = Buffer.alloc(2 * 1048576, 0xa5);
      const output: Buffer[] = [];
      const binary = await vm.execute(
        { argv: ["/bin/cat"], stdin: input, maxOutputBytes: input.length + 1024 },
        { onStdout: (chunk) => output.push(chunk) },
      );
      expect(binary.exitCode).toBe(0);
      expect(binary.stdout.equals(input)).toBe(true);
      expect(Buffer.concat(output).equals(input)).toBe(true);
      const command = await vm.execute({
        argv: [
          "/bin/bash",
          "-c",
          'printf "$FIXTURE_VALUE" > value; test ! -e "$1/host-only"; test ! -e "$1/state"; test -z "$SSH_AUTH_SOCK"',
          "fixture",
          root,
        ],
      });
      expect(command.exitCode).toBe(0);
      expect(await readFile(path.join(cwd, "value"), "utf8")).toBe("configured");
      await writeFile(
        path.join(cwd, "server.cjs"),
        "const server=require('http').createServer((req,res)=>res.end('guest-local'));server.listen(0,'127.0.0.1',()=>require('fs').writeFileSync('server.port',String(server.address().port)));",
      );
      expect(
        (
          await vm.execute({
            argv: ["/bin/bash", "-c", "/usr/bin/node server.cjs >server.log 2>&1 &"],
          })
        ).exitCode,
      ).toBe(0);
      const local = await vm.execute({
        argv: [
          "/usr/bin/node",
          "-e",
          "const fs=require('fs');function connect(){if(!fs.existsSync('server.port'))return setTimeout(connect,20);require('http').get('http://127.0.0.1:'+fs.readFileSync('server.port','utf8'),r=>r.pipe(process.stdout)).on('error',()=>process.exit(1));}connect();",
        ],
        timeoutMs: 5000,
      });
      expect(local.exitCode, local.stderr.toString()).toBe(0);
      expect(local.stdout.toString()).toBe("guest-local");
      const started = await vm.execute({
        argv: [
          "/bin/bash",
          "-c",
          "(while :; do printf x >> heartbeat; sleep 0.05; done) >/dev/null 2>&1 &",
        ],
      });
      expect(started.exitCode).toBe(0);
      await delay(150);
      const first = (await readFile(path.join(cwd, "heartbeat"))).length;
      await vm.execute({ argv: ["/bin/true"] });
      await delay(150);
      expect((await readFile(path.join(cwd, "heartbeat"))).length).toBeGreaterThan(first);
      await vm.close();
      const stopped = await readFile(path.join(cwd, "heartbeat"));
      await delay(150);
      expect(await readFile(path.join(cwd, "heartbeat"))).toEqual(stopped);
      await expect(vm.execute({ argv: ["/bin/true"] })).rejects.toMatchObject({
        code: "sandbox_closed",
      });
    });
  }, 180000);
  it("denies project writes with a read-only mount and denies host loopback", async () => {
    const server = createServer((socket) => socket.end("host only"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    try {
      await fixture(async (vm) => {
        expect(
          (await vm.execute({ argv: ["/bin/sh", "-c", "echo forbidden > value"] })).exitCode,
        ).not.toBe(0);
        const script =
          "const s=require('net').connect(Number(process.argv[1]),'127.0.0.1');s.setTimeout(1000,()=>process.exit(0));s.on('connect',()=>process.exit(9));s.on('error',()=>process.exit(0))";
        expect(
          (await vm.execute({ argv: ["/usr/bin/node", "-e", script, String(address.port)] }))
            .exitCode,
        ).toBe(0);
      }, false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 180000);
  it("retires the VM after timeout", async () => {
    await fixture(async (vm) => {
      await expect(
        vm.execute({ argv: ["/bin/sleep", "60"], timeoutMs: 100 }),
      ).rejects.toMatchObject({ code: "sandbox_timeout" });
      await expect(vm.execute({ argv: ["/bin/true"] })).rejects.toMatchObject({
        code: "sandbox_closed",
      });
    });
  }, 180000);
  it("cancels active work and closes exactly once", async () => {
    await fixture(async (vm, cwd) => {
      await vm.execute({
        argv: [
          "/bin/bash",
          "-c",
          "(while :; do printf x >> heartbeat; sleep .05; done) >/dev/null 2>&1 &",
        ],
      });
      const controller = new AbortController();
      let ready = 0;
      const running = Array.from({ length: 4 }, (_, index) =>
        vm.execute(
          { argv: ["/bin/bash", "-c", "printf ready; sleep 60"] },
          {
            ...(index === 0 ? { signal: controller.signal } : {}),
            onStdout: () => {
              ready++;
            },
          },
        ),
      );
      const queued = vm.execute({ argv: ["/bin/touch", "must-not-run"] });
      const settled = Promise.allSettled([...running, queued]);
      await waitFor(() => ready === 4);
      controller.abort();
      const results = await settled;
      expect(results.map((result) => result.status)).toEqual(Array(5).fill("rejected"));
      expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "sandbox_aborted" } });
      await Promise.all([vm.close(), vm.close()]);
      const stopped = await readFile(path.join(cwd, "heartbeat"));
      await delay(150);
      expect(await readFile(path.join(cwd, "heartbeat"))).toEqual(stopped);
      expect(await readdir(cwd)).not.toContain("must-not-run");
    });
  }, 180000);
  it("close cancels admitted work and rejects queued work before deleting state", async () => {
    await fixture(async (vm) => {
      let ready = 0;
      const active = Array.from({ length: 4 }, () =>
        vm.execute(
          { argv: ["/bin/bash", "-c", "printf ready; sleep 60"] },
          {
            onStdout: () => {
              ready++;
            },
          },
        ),
      );
      const queued = vm.execute({ argv: ["/bin/true"] });
      const settled = Promise.allSettled([...active, queued]);
      await waitFor(() => ready === 4);
      await vm.close();
      const results = await settled;
      expect(results.map((result) => result.status)).toEqual(Array(5).fill("rejected"));
    });
  }, 180000);
});
