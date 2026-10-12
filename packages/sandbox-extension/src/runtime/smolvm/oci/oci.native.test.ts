import {
  nativeSmolvmHostTools,
  nativeHostProcessAlive,
  assertNoFixtureLayerAttachments,
} from "../../../../../../tests/fixtures/smolvm-native-host.js";
import { removeStoppedPrivateState } from "../private-state.js";
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SandboxCommandRequest } from "../../contracts.js";
import {
  createSmolvmOciFamily,
  configureSmolvmOciFamily,
  reopenSmolvmOciFamily,
  deleteSmolvmOciFamily,
  readSmolvmOciFamily,
} from "./family.js";
import { SmolvmCli } from "../cli.js";
import { checkedCommand, listMachines } from "../lifecycle.js";
import { attachSmolvmOciMachine } from "./transport.js";
import type { SmolvmOciFamily, SmolvmOciFamilyOptions } from "./types.js";

const required = process.env.PI_SANDBOX_REQUIRE_SMOLVM === "1";
const configured = !!process.env.PI_SANDBOX_SMOLVM_OCI_IMAGE;
const suite = required || configured ? describe : describe.skip;
const dirs: string[] = [];
const families: SmolvmOciFamily[] = [];
let options: SmolvmOciFamilyOptions;
let suiteRoot: string | undefined;
let cleanupFailed = false;
beforeAll(async () => {
  if (!required && !configured) return;
  if (
    !(
      (process.platform === "linux" && process.arch === "x64") ||
      (process.platform === "darwin" && process.arch === "arm64")
    ) ||
    !process.env.PI_SANDBOX_SMOLVM_BIN ||
    !process.env.PI_SANDBOX_SMOLVM_OCI_IMAGE ||
    !process.env.PI_SANDBOX_SMOLVM_OCI_SHA256
  )
    throw Error(
      "OCI qualification requires a supported host, pinned smolvm path, image and checksum",
    );
  suiteRoot = await realpath(await mkdtemp("/tmp/oci-suite-"));
  for (const [key, dir] of Object.entries({ HOME: "h", XDG_DATA_HOME: "d", XDG_CACHE_HOME: "c" })) {
    await mkdir(path.join(suiteRoot, dir), { mode: 0o700 });
    vi.stubEnv(key, path.join(suiteRoot, dir));
  }
  vi.stubEnv("SMOLVM_CONFIG", path.join(suiteRoot, "config.toml"));
  await writeFile(path.join(suiteRoot, "config.toml"), "", { mode: 0o600 });
});
async function opts() {
  const state = await realpath(await mkdtemp("/tmp/oci-t-"));
  dirs.push(state);
  options = {
    ...nativeSmolvmHostTools(),
    smolvmPath: process.env.PI_SANDBOX_SMOLVM_BIN!,
    imageArchive: process.env.PI_SANDBOX_SMOLVM_OCI_IMAGE!,
    imageSha256: process.env.PI_SANDBOX_SMOLVM_OCI_SHA256!,
    stateDirectory: state,
    cwd: "/workspace",
    networkMode: "none",
    resources: { cpus: 1, memoryMiB: 512, storageGiB: 2, overlayGiB: 1 },
  };
  return options;
}
async function make() {
  const f = await createSmolvmOciFamily(await opts());
  families.push(f);
  return f;
}
const alive = nativeHostProcessAlive;
async function gone(pids: number[]) {
  for (let n = 0; n < 400; n++) {
    if (!(await Promise.all(pids.map(alive))).some(Boolean)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("fixture VM processes survived");
}
async function nativeDirectories(statePath: string): Promise<string[]> {
  const metadata = await readSmolvmOciFamily({ statePath });
  const cli = new SmolvmCli({ smolvmPath: metadata.runtime, stateDirectory: statePath });
  try {
    const directories = [];
    for (const machine of metadata.machines.filter((m) => m.status !== "deleted"))
      directories.push(
        (await checkedCommand(cli, ["machine", "data-dir", "--name", machine.name])).stdout
          .toString()
          .trim(),
      );
    return directories;
  } finally {
    await cli.dispose();
  }
}
async function vmPids(statePath: string): Promise<number[]> {
  return Promise.all(
    (await nativeDirectories(statePath)).map(async (directory) =>
      Number((await readFile(path.join(directory, "agent.pid"), "utf8")).split("\n")[0]),
    ),
  );
}

function readyBarrier(count: number) {
  let ready!: () => void;
  const promise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const seen = new Set<number>();
  const output: string[] = [];
  return {
    promise,
    onStdout(index: number) {
      return (bytes: Buffer) => {
        output[index] = (output[index] ?? "") + bytes.toString();
        if (output[index].includes(`ready-${index}\n`)) seen.add(index);
        if (seen.size === count) ready();
      };
    },
  };
}
async function controlledFamily() {
  const input = await realpath(await mkdtemp("/tmp/oci-parallel-"));
  dirs.push(input);
  const family = await createSmolvmOciFamily({
    ...(await opts()),
    mounts: [{ hostPath: input, guestPath: "/control", readOnly: true }],
  });
  families.push(family);
  return { family, input };
}
async function diskFiles(
  root: string,
): Promise<{ name: string; bytes: number; allocated: number }[]> {
  const result: { name: string; bytes: number; allocated: number }[] = [];
  for (const dir of await readdir(root, { withFileTypes: true })) {
    const p = path.join(root, dir.name);
    if (dir.isDirectory()) result.push(...(await diskFiles(p)));
    else if (/\.(?:qcow2|raw)$/u.test(p)) {
      const s = await stat(p);
      result.push({ name: p, bytes: s.size, allocated: s.blocks * 512 });
    }
  }
  return result;
}
afterEach(async () => {
  let failed = false;
  for (const f of families.splice(0).reverse()) {
    try {
      const disposition = await f.close();
      if (disposition.retained) {
        try {
          await stat(f.statePath);
          await deleteSmolvmOciFamily({ statePath: f.statePath });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      failed = true;
      cleanupFailed = true;
      console.error("Retaining unconfirmed native fixture", f.statePath, error);
    }
  }
  if (suiteRoot) {
    const cli = new SmolvmCli({
      smolvmPath: process.env.PI_SANDBOX_SMOLVM_BIN!,
      stateDirectory: suiteRoot,
    });
    try {
      if ((await listMachines(cli)).length) failed = cleanupFailed = true;
    } finally {
      await cli.dispose();
    }
  }
  const paths = dirs.splice(0);
  if (!failed) for (const dir of paths) await rm(dir, { recursive: true, force: true });
  else throw Error("Native fixture cleanup unconfirmed; state retained for inspection");
});
afterAll(async () => {
  if (!suiteRoot) return;
  const cli = new SmolvmCli({
    smolvmPath: process.env.PI_SANDBOX_SMOLVM_BIN!,
    stateDirectory: suiteRoot,
  });
  try {
    if ((await listMachines(cli)).length) cleanupFailed = true;
  } finally {
    await cli.dispose();
  }
  if (!cleanupFailed) {
    assertNoFixtureLayerAttachments(suiteRoot);
    await rm(suiteRoot, { recursive: true, force: true });
  } else console.error("Native test registry retained", suiteRoot);
  vi.unstubAllEnvs();
  if (cleanupFailed) throw Error("Native registry cleanup unconfirmed");
});
suite("OCI native family", () => {
  it("overlaps four calls across direct and borrowed access with separate binary streams", async () => {
    const { family: f, input } = await controlledFamily();
    const client = await attachSmolvmOciMachine(f.attachment(f.sourceId));
    try {
      const ready = readyBarrier(4);
      const results = Promise.all(
        Array.from({ length: 4 }, (_, index) => {
          const request: SandboxCommandRequest = {
            argv: [
              "/bin/bash",
              "-c",
              'printf "ready-%s\\n" "$1"; while test ! -e /control/release; do sleep .02; done; cat; printf "err-%s" "$1" >&2; exit "$1"',
              "parallel",
              String(index),
            ],
            stdin: Buffer.from([index, 255, 0]),
            timeoutMs: 20000,
          };
          const execution = { onStdout: ready.onStdout(index) };
          return index % 2
            ? client.execute(request, execution)
            : f.execute(f.sourceId, request, execution);
        }),
      );
      await Promise.race([
        ready.promise,
        results.then(() => {
          throw Error("parallel commands completed before their release barrier");
        }),
      ]);
      await writeFile(path.join(input, "release"), "ready");
      for (const [index, result] of (await results).entries()) {
        expect(result.exitCode).toBe(index);
        expect(result.stdout).toEqual(
          Buffer.concat([Buffer.from(`ready-${index}\n`), Buffer.from([index, 255, 0])]),
        );
        expect(result.stderr.toString()).toBe(`err-${index}`);
      }
    } finally {
      await client.close();
    }
    expect((await f.execute(f.sourceId, { argv: ["/bin/true"] })).exitCode).toBe(0);
  }, 120000);

  it("keeps branch exclusive while allowing sibling attachments to execute concurrently", async () => {
    const { family: f, input } = await controlledFamily();
    const ready = readyBarrier(1);
    const active = f.execute(
      f.sourceId,
      {
        argv: [
          "/bin/bash",
          "-c",
          "echo ready-0; while test ! -e /control/branch; do sleep .02; done; echo committed >/workspace/pre-branch",
        ],
        timeoutMs: 20000,
      },
      { onStdout: ready.onStdout(0) },
    );
    await Promise.race([
      ready.promise,
      active.then(() => {
        throw Error("active command completed before branch barrier");
      }),
    ]);
    const branch = f.branch(f.sourceId, { branchable: false });
    const afterBranch = expect(
      f.execute(f.sourceId, {
        argv: ["/bin/bash", "-c", "echo wrong >/workspace/post-branch"],
      }),
    ).rejects.toMatchObject({ code: "sandbox_closed" });
    await writeFile(path.join(input, "branch"), "ready");
    expect((await active).exitCode).toBe(0);
    const left = await branch;
    await afterBranch;
    expect(
      (
        await f.execute(left, {
          argv: ["/bin/bash", "-c", "test ! -e /workspace/post-branch; cat /workspace/pre-branch"],
        })
      ).stdout.toString(),
    ).toBe("committed\n");
    const right = await f.branch(f.sourceId, { branchable: false });
    const clients = await Promise.all(
      [left, right].map((id) => attachSmolvmOciMachine(f.attachment(id))),
    );
    try {
      const siblings = readyBarrier(2);
      const results = Promise.all(
        clients.map((client, index) =>
          client.execute(
            {
              argv: [
                "/bin/bash",
                "-c",
                'printf "ready-%s\\n" "$1"; while test ! -e /control/siblings; do sleep .02; done; echo "$1" >/workspace/private; cat /workspace/private',
                "sibling",
                String(index),
              ],
              timeoutMs: 20000,
            },
            { onStdout: siblings.onStdout(index) },
          ),
        ),
      );
      await Promise.race([
        siblings.promise,
        results.then(() => {
          throw Error("sibling calls completed before their release barrier");
        }),
      ]);
      await writeFile(path.join(input, "siblings"), "ready");
      for (const [index, result] of (await results).entries()) {
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe(`ready-${index}\n${index}\n`);
      }
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
    await f.removeMachine(right);
    await f.removeMachine(left);
  }, 180000);

  it("active cancellation interrupts parallel calls and queued work before retiring the VM", async () => {
    const f = await make();
    const pids = await vmPids(f.statePath);
    expect(pids).toHaveLength(1);
    const client = await attachSmolvmOciMachine(f.attachment(f.sourceId));
    const controller = new AbortController();
    const ready = readyBarrier(4);
    const calls = Array.from({ length: 4 }, (_, index) => {
      const request: SandboxCommandRequest = {
        argv: ["/bin/bash", "-c", `echo ready-${index}; sleep 60`],
        timeoutMs: 20000,
      };
      const execution = {
        onStdout: ready.onStdout(index),
        ...(index === 0 ? { signal: controller.signal } : {}),
      };
      return index % 2
        ? client.execute(request, execution)
        : f.execute(f.sourceId, request, execution);
    });
    const results = Promise.allSettled(calls);
    try {
      await Promise.race([
        ready.promise,
        results.then(() => {
          throw Error("parallel calls failed to reach the cancellation barrier");
        }),
      ]);
      const queued = expect(f.execute(f.sourceId, { argv: ["/bin/true"] })).rejects.toMatchObject({
        code: "sandbox_closed",
      });
      controller.abort();
      for (const result of await results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({
            code: expect.stringMatching(/^sandbox_(?:aborted|closed)$/u) as unknown,
          });
      }
      await queued;
      await f.close();
      await gone(pids);
      expect((await stat(f.statePath)).isDirectory()).toBe(true);
      expect(() => f.attachment(f.sourceId)).toThrow();
    } finally {
      await client.close();
    }
  }, 120000);

  it("permits explicit network-enabled access to a host TCP fixture", async () => {
    const hostAddress = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    if (!hostAddress) throw Error("Host TCP control requires a non-loopback IPv4 interface");
    const server = createServer((socket) => socket.end("local-network-control"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, hostAddress, resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("fixture listen failed");
      const f = await createSmolvmOciFamily({ ...(await opts()), networkMode: "host" });
      families.push(f);
      const result = await f.execute(f.sourceId, {
        argv: [
          "/usr/bin/node",
          "-e",
          "const s=require('net').connect(Number(process.argv[1]),process.argv[2]);s.on('data',b=>process.stdout.write(b));s.on('error',()=>process.exit(2));s.setTimeout(3000,()=>process.exit(3))",
          String(address.port),
          hostAddress,
        ],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("local-network-control");
      await f.close();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 120000);
  it("cold reopens retained source disks with fresh authority and without old guest processes", async () => {
    const options = await opts();
    const input = await realpath(await mkdtemp("/tmp/oci-input-"));
    dirs.push(input);
    await writeFile(path.join(input, "readonly"), "same-input");
    const f = await createSmolvmOciFamily({
      ...options,
      mounts: [{ hostPath: input, guestPath: "/inputs", readOnly: true }],
    });
    families.push(f);
    const old = f.attachment(f.sourceId);
    const before = await f.execute(f.sourceId, {
      argv: [
        "/bin/bash",
        "-c",
        "set -eu; echo source >/workspace/candidate; echo system-change >/etc/cold-proof; (nohup /bin/bash -c 'while :; do echo tick >>/workspace/writer; sleep .1; done' >/dev/null 2>&1 </dev/null &); cat /proc/sys/kernel/random/boot_id",
      ],
    });
    expect(before.exitCode).toBe(0);
    const child = await f.branch(f.sourceId, { branchable: false });
    await f.execute(child, { argv: ["/bin/bash", "-c", "echo reviewer >/workspace/candidate"] });
    await f.removeMachine(child);
    const retained = await f.retainForColdReopen();
    expect(retained).toEqual({
      version: 3,
      sourceId: f.sourceId,
      registry: (await readSmolvmOciFamily({ statePath: f.statePath })).registry,
      mode: "cold",
      statePath: f.statePath,
      imageSha256: options.imageSha256,
      cwd: "/workspace",
    });
    const reopened = await reopenSmolvmOciFamily({ statePath: f.statePath });
    families.push(reopened);
    expect(reopened.attachment(reopened.sourceId).token).not.toBe(old.token);
    await expect(attachSmolvmOciMachine(old)).rejects.toMatchObject({
      code: "sandbox_invalid_request",
    });
    const after = await reopened.execute(reopened.sourceId, {
      argv: [
        "/bin/bash",
        "-c",
        "set -eu; test $(cat /workspace/candidate) = source; test $(cat /etc/cold-proof) = system-change; test $(cat /inputs/readonly) = same-input; if echo wrong >/inputs/readonly; then exit 77; fi; n=$(wc -l </workspace/writer); sleep .3; test $n = $(wc -l </workspace/writer); cat /proc/sys/kernel/random/boot_id",
      ],
    });
    expect(after.exitCode).toBe(0);
    expect(after.stdout.toString()).not.toBe(before.stdout.toString());
    const next = await reopened.branch(reopened.sourceId, { branchable: false });
    expect(
      (
        await reopened.execute(next, { argv: ["/bin/cat", "/workspace/candidate"] })
      ).stdout.toString(),
    ).toBe("source\n");
    await reopened.removeMachine(next);
    await reopened.retainForColdReopen();
    const last = await reopenSmolvmOciFamily({ statePath: f.statePath });
    families.push(last);
    expect(
      (
        await last.execute(last.sourceId, { argv: ["/bin/cat", "/etc/cold-proof"] })
      ).stdout.toString(),
    ).toBe("system-change\n");
    await last.close();
    await expect(stat(f.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(input, "readonly"), "utf8")).toBe("same-input");
  }, 180000);
  it("classifies unexpected VMM death as infrastructure failure without restarting", async () => {
    const f = await make();
    const recorded = await vmPids(f.statePath);
    expect(recorded).toHaveLength(1);
    expect(await alive(recorded[0]!)).toBe(true);
    process.kill(recorded[0]!, "SIGKILL");
    await gone(recorded);
    if (process.platform === "darwin") {
      await expect(f.execute(f.sourceId, { argv: ["/bin/true"] })).rejects.toThrow();
      await expect(f.close()).rejects.toThrow("cleanup_unconfirmed");
      expect((await stat(f.statePath)).isDirectory()).toBe(true);
      const cli = new SmolvmCli({ smolvmPath: options.smolvmPath, stateDirectory: f.statePath });
      try {
        expect((await listMachines(cli)).find((m) => m.name === f.sourceId)?.state).toBe("stopped");
        await gone(recorded);
        await checkedCommand(cli, ["machine", "delete", "--name", f.sourceId, "--force"]);
        expect((await listMachines(cli)).some((m) => m.name === f.sourceId)).toBe(false);
      } finally {
        await cli.dispose();
      }
      await removeStoppedPrivateState(f.statePath);
      families.splice(families.indexOf(f), 1);
      return;
    }
    await expect(f.execute(f.sourceId, { argv: ["/bin/true"] })).rejects.toMatchObject({
      code: "sandbox_process_failed",
    });
    await f.close();
    expect((await stat(f.statePath)).isDirectory()).toBe(true);
    expect(() => f.attachment(f.sourceId)).toThrow();
  }, 120000);
  it("preserves whole-workload changes in isolated CoW branches with read-only inputs and scoped tools", async () => {
    const options = await opts();
    const input = await realpath(await mkdtemp("/tmp/oci-input-"));
    dirs.push(input);
    await writeFile(path.join(input, "library.txt"), "host-input");
    const f = await createSmolvmOciFamily({
      ...options,
      mounts: [{ hostPath: input, guestPath: "/inputs", readOnly: true }],
    });
    families.push(f);
    const descriptor = f.attachment(f.sourceId);
    const client = await attachSmolvmOciMachine(descriptor);
    const output: Buffer[] = [];
    const source = await client.execute(
      {
        argv: [
          "/bin/bash",
          "-c",
          (process.platform === "darwin"
            ? "set -eu; cat /etc/os-release; test $(uname -m) = aarch64; command -v node python3 gcc make git file; "
            : "set -eu; cat /etc/os-release; test $(uname -m) = x86_64; command -v node python3 rg fd gcc make git file; ") +
            "echo original >/etc/eval-marker; mkdir -p /workspace/project; printf '#include <stdio.h>\\nint main(){puts(\"build-ok\");}\\n' >/workspace/project/test.c; gcc /workspace/project/test.c -o /workspace/project/test; /workspace/project/test; test $(cat /inputs/library.txt) = host-input; if echo bad >/inputs/library.txt; then exit 50; fi; /usr/bin/node -e \"const s=require('node:net').connect(443,'1.1.1.1');s.on('connect',()=>process.exit(51));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),500)\"; sync",
        ],
        maxOutputBytes: 1048576,
      },
      { onStdout: (b) => output.push(b) },
    );
    expect(source.exitCode).toBe(0);
    expect(Buffer.concat(output)).toEqual(source.stdout);
    expect(source.stdout.toString()).toContain("build-ok");
    expect(await readFile(path.join(input, "library.txt"), "utf8")).toBe("host-input");
    const bytes = Buffer.from([0, 1, 255, 13, 10]);
    expect((await client.execute({ argv: ["/bin/cat"], stdin: bytes })).stdout).toEqual(bytes);
    await expect(
      attachSmolvmOciMachine({ ...descriptor, token: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "sandbox_invalid_request" });
    await expect(
      client.execute({ argv: ["/bin/true"], cwd: "/workspace/../etc" }),
    ).rejects.toMatchObject({ code: "sandbox_invalid_request" });
    await expect(
      client.execute({ argv: ["/bin/true"], environment: { NODE_OPTIONS: "--inspect" } }),
    ).rejects.toMatchObject({ code: "sandbox_invalid_request" });
    await client.close();
    expect((await f.execute(f.sourceId, { argv: ["/bin/true"] })).exitCode).toBe(0);
    const reviewer = await f.branch(f.sourceId, { branchable: false });
    expect(() => f.attachment(f.sourceId)).toThrow();
    expect(
      (
        await f.execute(reviewer, {
          argv: [
            "/bin/bash",
            "-c",
            "test $(cat /etc/eval-marker) = original; /workspace/project/test; echo reviewer >/etc/eval-marker; dd if=/dev/urandom of=/workspace/growth bs=1M count=8 2>/dev/null; sync",
          ],
        })
      ).exitCode,
    ).toBe(0);
    const collector = await f.branch(f.sourceId, { branchable: false });
    expect(
      (
        await f.execute(collector, {
          argv: [
            "/bin/bash",
            "-c",
            "test $(cat /etc/eval-marker) = original; test ! -e /workspace/growth; /workspace/project/test",
          ],
        })
      ).exitCode,
    ).toBe(0);
    const disks = (await Promise.all((await nativeDirectories(f.statePath)).map(diskFiles))).flat();
    const overlays = disks.filter((d) => d.name.endsWith(".qcow2"));
    if (process.platform === "darwin") {
      expect(overlays).toHaveLength(0);
      const raw = disks.filter((d) => d.name.endsWith(".raw"));
      expect(raw.length).toBeGreaterThanOrEqual(6);
      expect(raw.every((d) => [1073741824, 2147483648].includes(d.bytes))).toBe(true);
    } else {
      expect(overlays.length).toBeGreaterThanOrEqual(4);
      expect(overlays.reduce((a, d) => a + d.allocated, 0)).toBeLessThan(80 * 1048576);
    }
    console.info(
      "OCI disk evidence",
      JSON.stringify({
        rawBaseAllocated: disks
          .filter((d) => d.name.endsWith(".raw"))
          .reduce((n, d) => n + d.allocated, 0),
        childOverlayAllocated: overlays.reduce((n, d) => n + d.allocated, 0),
        childOverlayCount: overlays.length,
        mutatedBytes: 8 * 1048576,
      }),
    );
    for (const overlay of overlays) {
      const header = await readFile(overlay.name);
      expect(header.subarray(0, 4)).toEqual(Buffer.from([0x51, 0x46, 0x49, 0xfb]));
      const offset = Number(header.readBigUInt64BE(8));
      const length = header.readUInt32BE(16);
      expect(length).toBeGreaterThan(0);
      expect(header.subarray(offset, offset + length).toString()).toContain(
        path.join(process.env.XDG_CACHE_HOME!, "smolvm/vms"),
      );
    }
    await expect(
      attachSmolvmOciMachine({ ...f.attachment(reviewer), token: f.attachment(collector).token }),
    ).rejects.toMatchObject({ code: "sandbox_invalid_request" });
    await f.removeMachine(collector);
    expect(() => f.attachment(collector)).toThrow();
    await f.removeMachine(reviewer);
    await expect(f.removeMachine(f.sourceId)).rejects.toMatchObject({
      code: "sandbox_invalid_request",
    });
    await f.close();
    await expect(stat(f.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 180000);
  it("refuses aliases and mounts that expose runtime state or credentials", async () => {
    const o = await opts();
    const alias = path.join(o.stateDirectory, "alias.tar");
    await symlink(o.imageArchive, alias);
    await expect(createSmolvmOciFamily({ ...o, imageArchive: alias })).rejects.toMatchObject({
      code: "sandbox_invalid_request",
    });
    for (const hostPath of ["/", o.stateDirectory])
      await expect(
        createSmolvmOciFamily({
          ...o,
          mounts: [{ hostPath, guestPath: "/input", readOnly: true }],
        }),
      ).rejects.toThrow("protected_mount");
    await expect(createSmolvmOciFamily({ ...o, imageSha256: "0".repeat(64) })).rejects.toThrow(
      "image_digest_mismatch",
    );
  }, 30000);
  it("cancellation retires the complete boundary and retains forensic state", async () => {
    const f = await make();
    const c = await attachSmolvmOciMachine(f.attachment(f.sourceId));
    const controller = new AbortController();
    const result = c.execute(
      { argv: ["/bin/bash", "-c", "echo started; sleep 60"] },
      { signal: controller.signal, onStdout: () => controller.abort() },
    );
    await expect(result).rejects.toMatchObject({
      code: expect.stringMatching(/^sandbox_(?:aborted|closed)$/u) as unknown,
    });
    await f.close();
    expect((await stat(f.statePath)).isDirectory()).toBe(true);
    expect(() => f.attachment(f.sourceId)).toThrow();
    await c.close();
  }, 120000);
  it.each(["timeout", "output"])(
    "%s failure retires the boundary",
    async (mode) => {
      const f = await make();
      await expect(
        f.execute(
          f.sourceId,
          mode === "timeout"
            ? { argv: ["/bin/sleep", "60"], timeoutMs: 100 }
            : {
                argv: ["/usr/bin/node", "-e", "process.stdout.write('x'.repeat(100000))"],
                maxOutputBytes: 16,
              },
        ),
      ).rejects.toMatchObject({
        code: mode === "timeout" ? "sandbox_timeout" : "sandbox_output_limit_exceeded",
      });
      await f.close();
      expect((await stat(f.statePath)).isDirectory()).toBe(true);
    },
    120000,
  );
  it("can branch a branchable implementer into independent leaf reviewers", async () => {
    const f = await make();
    await f.execute(f.sourceId, { argv: ["/bin/bash", "-c", "echo prepared >/workspace/stage"] });
    const implementer = await f.branch(f.sourceId, { branchable: true });
    await f.execute(implementer, {
      argv: ["/bin/bash", "-c", "echo implemented >/workspace/stage"],
    });
    const reviewer = await f.branch(implementer, { branchable: false });
    expect(
      (await f.execute(reviewer, { argv: ["/bin/cat", "/workspace/stage"] })).stdout.toString(),
    ).toBe("implemented\n");
    await expect(f.branch(reviewer, { branchable: false })).rejects.toMatchObject({
      code: "sandbox_invalid_request",
    });
    await expect(f.removeMachine(implementer)).rejects.toMatchObject({
      code: "sandbox_invalid_request",
    });
    await f.removeMachine(reviewer);
    await f.removeMachine(implementer);
    await f.close();
  }, 180000);
  it("copies prepared trees into independent families, retains ancestors and reopens a deep candidate", async () => {
    const root = await make();
    const write = (family: SmolvmOciFamily, value: string) =>
      family.execute(family.sourceId, {
        argv: ["/bin/bash", "-c", `printf '%s' '${value}' >/workspace/prepared-marker`],
      });
    const read = async (family: SmolvmOciFamily, id = family.sourceId) =>
      (
        await family.execute(id, { argv: ["/bin/cat", "/workspace/prepared-marker"] })
      ).stdout.toString();
    const copy = async (source: SmolvmOciFamily) => {
      const next = await source.copyFamily();
      families.push(next);
      return next;
    };
    await write(root, "root");
    const prepared = await copy(root);
    await write(prepared, "prepared");
    const sibling = await copy(root);
    await write(root, "later-root");
    expect(await read(prepared)).toBe("prepared");
    expect(await read(sibling)).toBe("root");
    // A cold preparation boundary drops transient preparation processes. Network
    // topology is selected while stopped and inherited by every later copy.
    await prepared.retainForColdReopen();
    await configureSmolvmOciFamily({ statePath: prepared.statePath, networkMode: "host" });
    await configureSmolvmOciFamily({ statePath: prepared.statePath, networkMode: "none" });
    const reopenedPrepared = await reopenSmolvmOciFamily({ statePath: prepared.statePath });
    families.push(reopenedPrepared);
    const candidate = await copy(reopenedPrepared);
    expect(candidate.depth).toBe(2);
    expect(candidate.configuration.networkMode).toBe("none");
    const statusCli = new SmolvmCli({
      smolvmPath: options.smolvmPath,
      stateDirectory: candidate.statePath,
    });
    try {
      const status: unknown = JSON.parse(
        (
          await checkedCommand(statusCli, [
            "machine",
            "status",
            "--name",
            candidate.sourceId,
            "--json",
          ])
        ).stdout.toString(),
      );
      expect(status).toMatchObject({ network: false });
    } finally {
      await statusCli.dispose();
    }
    await write(candidate, "candidate");
    const judge = await candidate.branch(candidate.sourceId, { branchable: false });
    expect(await read(candidate, judge)).toBe("candidate");
    await candidate.execute(judge, {
      argv: ["/bin/bash", "-c", "echo judge >/workspace/prepared-marker"],
    });
    await candidate.removeMachine(judge);
    await candidate.retainForColdReopen();
    await reopenedPrepared.retainForColdReopen();
    await sibling.retainForColdReopen();
    await root.retainForColdReopen();
    await expect(deleteSmolvmOciFamily({ statePath: root.statePath })).rejects.toThrow(
      "dependencies_pending",
    );
    const reopened = await reopenSmolvmOciFamily({ statePath: candidate.statePath });
    families.push(reopened);
    expect(await read(reopened)).toBe("candidate");
    await reopened.close();
  }, 300000);
});
