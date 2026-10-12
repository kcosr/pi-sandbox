vi.mock("../platform.js", () => ({ verifySmolvmCapability: () => Promise.resolve() }));
import type * as HostTools from "../host-tools.js";
import type * as FsPromises from "node:fs/promises";
import type * as Lifecycle from "../lifecycle.js";
import type * as Transport from "./transport.js";
import { SmolvmCli } from "../cli.js";
import {
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxExecutionOptions,
} from "../../contracts.js";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import type {
  SmolvmOciFamilyOptions,
  SmolvmOciFamilyHooks,
  SmolvmOciTerminalExit,
  SmolvmOciTerminalLauncher,
} from "./types.js";
import { SmolvmOciTerminalCleanupError } from "./types.js";
import { attachSmolvmOciMachine } from "./transport.js";
import { createSmolvmEnvironment } from "../registry.js";
import { readJournal } from "./journal.js";
import { createConnection } from "node:net";
import { once } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSmolvmOciFamily,
  configureSmolvmOciFamily,
  reopenSmolvmOciFamily,
  deleteSmolvmOciFamily,
  readSmolvmOciFamily,
} from "./family.js";

const mocks = vi.hoisted(() => ({
  names: new Map<
    string,
    { state: string; parent: string | null; createdAt: number; image?: string; network?: boolean }
  >(),
  cache: "",
  hostToolsIdentity: "d".repeat(64),
  createFailure: false,
  branchFailure: false,
  updateFailure: false,
  updateNoop: false,
  failDelete: false,
  failList: false,
  runtimeIdentity: "b".repeat(64),
  calls: [] as string[][],
  failClose: false,
  recoveryPresentAtCreate: false,
  execSignal: null as NodeJS.Signals | null,
  startFailure: undefined as Error | undefined,
  failServerClose: false,
  failCliDispose: false,
  cliDisposeCalls: 0,
  lastStatePath: "",
  exec: undefined as
    | ((request: SandboxCommandRequest, options: SandboxExecutionOptions) => Promise<string>)
    | undefined,
  events: [] as string[],
  stop: undefined as (() => Promise<void>) | undefined,
  alive: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof FsPromises>();
  return {
    ...actual,
    // This suite exercises controller policy with a simulated CLI, not KVM.
    access: (file: Parameters<typeof actual.access>[0], mode?: number) =>
      file === "/dev/kvm" ? Promise.resolve() : actual.access(file, mode),
  };
});
vi.mock("../host-tools.js", async (importActual) => ({
  ...(await importActual<typeof HostTools>()),
  verifyHostTools: (options: { e2fsprogsDirectory?: string }) =>
    Promise.resolve(options.e2fsprogsDirectory ? mocks.hostToolsIdentity : undefined),
}));
vi.mock("../runtime-release.js", () => ({
  verifySmolvmRuntime: () => Promise.resolve(mocks.runtimeIdentity),
  SMOLVM_VERSION: "1.26.1",
}));
vi.mock("./transport.js", async (importActual) => {
  const actual = await importActual<typeof Transport>();
  return {
    ...actual,
    serveOciFamily: async (...args: Parameters<typeof actual.serveOciFamily>) => {
      const stop = await actual.serveOciFamily(...args);
      return async () => {
        await stop();
        if (mocks.failServerClose) throw new Error("server disposal failed");
      };
    },
  };
});
vi.mock("../lifecycle.js", async (importActual) => {
  const actual = await importActual<typeof Lifecycle>();
  return {
    ...actual,
    assertMachineAlive: async (...args: Parameters<typeof actual.assertMachineAlive>) => {
      await mocks.alive?.();
      await actual.assertMachineAlive(...args);
    },
    stopMachine: async (cli: SmolvmCli, name: string, identity: Lifecycle.MachineIdentity) => {
      mocks.events.push(`stop:${name}`);
      await mocks.stop?.();
      if (mocks.failClose) throw Error("stop not confirmed");
      await actual.stopMachine(cli, name, identity);
    },
  };
});
vi.mock("../cli.js", () => {
  return {
    SmolvmCli: class {
      readonly active = new Set<{ controller: AbortController; done: Promise<void> }>();
      readonly names = mocks.names;
      readonly environment: Record<string, string>;
      readonly stateDirectory: string;
      constructor(options: { stateDirectory: string; nativeEnvironment?: Record<string, string> }) {
        this.stateDirectory = options.stateDirectory;
        this.environment = options.nativeEnvironment ?? createSmolvmEnvironment();
        mocks.lastStatePath = options.stateDirectory;
      }
      async run(request: SandboxCommandRequest, options: SandboxExecutionOptions = {}) {
        const argv = request.argv;
        mocks.calls.push([...argv]);
        const fs = await import("node:fs/promises");
        let out = "";
        const value = (key: string) => argv[argv.indexOf(key) + 1]!;
        const nativeDir = path.join(
          mocks.cache,
          "smolvm/vms",
          createHash("sha256").update(value("--name")).digest("hex").slice(0, 16),
        );
        if (argv[1] === "create") {
          mocks.recoveryPresentAtCreate = (
            await fs.stat(this.stateDirectory + "/recovery.json")
          ).isFile();
          if (mocks.createFailure || this.names.has(value("--name")))
            return {
              exitCode: 1,
              signal: null,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("create collision"),
            };
          this.names.set(value("--name"), {
            state: "created",
            parent: null,
            createdAt: 42,
            network: argv.includes("--net"),
          });
        } else if (argv[1] === "start") {
          if (mocks.startFailure) throw mocks.startFailure;
          await fs.mkdir(nativeDir, { recursive: true });
          this.names.get(value("--name"))!.state = "running";
          for (const [name, size] of [
            ["storage.raw", 2],
            ["overlay.raw", 1],
          ] as const) {
            const file = await fs.open(path.join(nativeDir, name), "a");
            try {
              await file.truncate(size * 1024 ** 3);
            } finally {
              await file.close();
            }
          }
        } else if (argv[1] === "data-dir") out = nativeDir;
        else if (argv[1] === "ls" || argv[1] === "status") {
          if (argv[1] === "ls" && mocks.failList) throw Error("foreign probe blocked");
          const records = [...this.names].map(([name, r]) => ({
            name,
            pid: ["stopped", "created", "failed"].includes(r.state) ? null : 123,
            state: r.state,
            parent_machine: r.parent,
            created_at: r.createdAt,
            image: r.image ?? "fixture-image",
            network: r.network ?? false,
          }));
          if (argv[1] === "ls") out = JSON.stringify(records);
          else {
            const record = records.find((r) => r.name === value("--name"));
            if (!record)
              return {
                exitCode: 1,
                signal: null,
                stdout: Buffer.alloc(0),
                stderr: Buffer.from("not found"),
              };
            out = JSON.stringify(record);
          }
        } else if (argv[1] === "branch") {
          mocks.events.push(`branch:${value("--from")}`);
          if (argv.includes("--freeze-source")) this.names.get(value("--from"))!.state = "frozen";
          if (mocks.branchFailure)
            return {
              exitCode: 1,
              signal: null,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("branch failed"),
            };
          await fs.mkdir(nativeDir, { recursive: true });
          this.names.set(value("--name"), {
            state: "running",
            parent: value("--from"),
            createdAt: 42,
            network: this.names.get(value("--from"))!.network ?? false,
          });
          for (const [name, size] of [
            ["storage.raw", 2],
            ["overlay.raw", 1],
          ] as const) {
            const file = await fs.open(path.join(nativeDir, name), "a");
            await file.truncate(size * 1024 ** 3);
            await file.close();
          }
        } else if (argv[1] === "update") {
          if (mocks.updateFailure) throw Error("native update failed");
          if (!mocks.updateNoop) this.names.get(value("--name"))!.network = argv.includes("--net");
        } else if (argv[1] === "stop") {
          if (
            this.names.get(value("--name"))!.state === "frozen" &&
            [...this.names.values()].some((r) => r.parent === value("--name"))
          )
            return {
              exitCode: 1,
              signal: null,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("dependent children"),
            };
          this.names.get(value("--name"))!.state = "stopped";
        } else if (argv[1] === "delete") {
          if (
            mocks.failDelete ||
            [...this.names.values()].some((r) => r.parent === value("--name"))
          )
            return {
              exitCode: 1,
              signal: null,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("delete refused"),
            };
          this.names.delete(value("--name"));
          await fs.rm(nativeDir, { recursive: true, force: true });
        } else if (argv[1] === "exec") {
          const controller = new AbortController();
          const abort = () => controller.abort();
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) controller.abort();
          let finish!: () => void;
          const done = new Promise<void>((resolve) => {
            finish = resolve;
          });
          const active = { controller, done };
          this.active.add(active);
          try {
            if (controller.signal.aborted) throw new SandboxExecutionError("sandbox_aborted");
            const guest = JSON.parse(
              Buffer.from(argv.at(-1)!, "base64").toString(),
            ) as SandboxCommandRequest;
            out = mocks.exec
              ? await mocks.exec(guest, { ...options, signal: controller.signal })
              : "ready";
          } finally {
            this.active.delete(active);
            options.signal?.removeEventListener("abort", abort);
            finish();
          }
        }
        if (out) options?.onStdout?.(Buffer.from(out));
        return {
          exitCode: 0,
          signal: argv[1] === "exec" ? mocks.execSignal : null,
          stdout: Buffer.from(out),
          stderr: Buffer.alloc(0),
        };
      }
      async cancelActive() {
        const active = [...this.active];
        for (const entry of active) entry.controller.abort();
        await Promise.all(active.map((entry) => entry.done));
      }
      dispose() {
        mocks.cliDisposeCalls++;
        return mocks.failCliDispose
          ? Promise.reject(new Error("CLI disposal failed"))
          : Promise.resolve();
      }
    },
  };
});
const dirs: string[] = [];
beforeEach(async () => {
  const root = await realpath(await mkdtemp("/tmp/oci-shared-"));
  dirs.push(root);
  mocks.cache =
    process.platform === "darwin"
      ? path.join(root, "home/Library/Caches")
      : path.join(root, "cache");
  for (const [key, dir] of Object.entries({
    HOME: "home",
    XDG_CACHE_HOME: "cache",
    XDG_DATA_HOME: "data",
  })) {
    await mkdir(path.join(root, dir), { recursive: true });
    vi.stubEnv(key, path.join(root, dir));
  }
  vi.stubEnv("SMOLVM_CONFIG", path.join(root, "home/config.toml"));
  await mkdir(mocks.cache, { recursive: true });
  mocks.hostToolsIdentity = "d".repeat(64);
  mocks.names.clear();
  mocks.calls = [];
  mocks.createFailure = false;
  mocks.branchFailure = false;
  mocks.updateFailure = false;
  mocks.updateNoop = false;
  mocks.failDelete = false;
  mocks.failList = false;
  mocks.runtimeIdentity = "b".repeat(64);
});
afterEach(async () => {
  vi.restoreAllMocks();
  mocks.failClose = false;
  mocks.execSignal = null;
  mocks.startFailure = undefined;
  mocks.failServerClose = false;
  mocks.failCliDispose = false;
  mocks.cliDisposeCalls = 0;
  mocks.lastStatePath = "";
  mocks.exec = undefined;
  mocks.events = [];
  mocks.stop = undefined;
  mocks.alive = undefined;
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(
  patch: Partial<SmolvmOciFamilyOptions> = {},
  hooks: SmolvmOciFamilyHooks = {},
) {
  const dir = await realpath(await mkdtemp("/tmp/oci-policy-"));
  dirs.push(dir);
  const image = path.join(dir, "image.tar");
  await writeFile(image, "fixture");
  return createSmolvmOciFamily(
    {
      smolvmPath: await realpath("/usr/bin/true"),
      imageArchive: image,
      imageSha256: createHash("sha256").update("fixture").digest("hex"),
      stateDirectory: dir,
      cwd: "/workspace",
      networkMode: "none",
      resources: { cpus: 1, memoryMiB: 512, storageGiB: 2, overlayGiB: 1 },
      ...patch,
    },
    hooks,
  );
}
const suite = describe;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function terminalFixture() {
  const exit = deferred<SmolvmOciTerminalExit>();
  const write = vi.fn<(bytes: Uint8Array) => Promise<void>>(() => Promise.resolve());
  const resize = vi.fn();
  const close = vi.fn(() => {
    exit.resolve({ exitCode: null, signal: "SIGTERM" });
    return Promise.resolve();
  });
  const launch: SmolvmOciTerminalLauncher = vi.fn(() => ({
    completion: exit.promise,
    write,
    resize,
    close,
  }));
  return {
    exit,
    write,
    resize,
    close,
    launch,
    options: { terminalType: "xterm-256color", columns: 120, rows: 30, launch },
  };
}
suite("OCI family controller policy with a simulated CLI", () => {
  it("keeps sixteen terminals outside ordinary tool capacity and closes only the selected terminal", async () => {
    const family = await fixture();
    const terminals = Array.from({ length: 16 }, terminalFixture);
    try {
      const handles = await Promise.all(
        terminals.map((terminal) => family.openTerminal(family.sourceId, terminal.options)),
      );
      await expect(
        family.openTerminal(family.sourceId, terminalFixture().options),
      ).rejects.toMatchObject({ code: "sandbox_queue_full" });
      const ready = deferred<void>();
      const finish = deferred<string>();
      let count = 0;
      mocks.exec = () => {
        if (++count === 4) ready.resolve();
        return finish.promise;
      };
      const tools = Array.from({ length: 4 }, () =>
        family.execute(family.sourceId, { argv: ["/bin/true"] }),
      );
      await ready.promise;
      await handles[0]!.write(new Uint8Array([3]));
      handles[0]!.resize(80, 24);
      expect(terminals[0]!.write).toHaveBeenCalledWith(new Uint8Array([3]));
      expect(terminals[0]!.resize).toHaveBeenCalledWith(80, 24);
      await handles[0]!.close();
      expect(terminals[1]!.close).not.toHaveBeenCalled();
      expect(mocks.events).toEqual([]);
      expect(() => family.attachment(family.sourceId)).not.toThrow();
      finish.resolve("tool");
      expect((await Promise.all(tools)).every((r) => r.stdout.toString() === "tool")).toBe(true);
    } finally {
      await family.close();
    }
    expect(terminals.every((terminal) => terminal.close.mock.calls.length === 1)).toBe(true);
  });
  it("shares ordinary native storage between two families and leaves a foreign machine untouched", async () => {
    mocks.names.set("foreign", { state: "running", parent: null, createdAt: 9 });
    const first = await fixture({ namePrefix: "eval-source" });
    const second = await fixture({ namePrefix: "eval-source" });
    const attached = await attachSmolvmOciMachine(first.attachment(first.sourceId));
    expect((await attached.execute({ argv: ["/bin/true"] })).exitCode).toBe(0);
    await attached.close();
    expect(first.sourceId).toMatch(/^eval-source-[a-f0-9]{32}$/u);
    expect(second.sourceId).not.toBe(first.sourceId);
    const one = await readSmolvmOciFamily({ statePath: first.statePath });
    const two = await readSmolvmOciFamily({ statePath: second.statePath });
    expect(one.registry).toEqual(two.registry);
    expect(one.environment.HOME).toBe(process.env.HOME);
    const child = await first.branch(first.sourceId, { branchable: false, namePrefix: "reviewer" });
    expect(child).toMatch(/^reviewer-[a-f0-9]{32}$/u);
    expect(await first.close()).toEqual({ retained: false });
    expect(mocks.names.has(second.sourceId)).toBe(true);
    expect(mocks.names.get("foreign")?.state).toBe("running");
    await second.close();
    expect([...mocks.names.keys()]).toEqual(["foreign"]);
  });
  it("removes harmless prepared metadata if onPrepared rejects before native creation", async () => {
    let statePath = "";
    const expected = new Error("durable owner write failed");
    await expect(
      fixture(
        {},
        {
          onPrepared: (prepared) => {
            statePath = prepared.statePath;
            throw expected;
          },
        },
      ),
    ).rejects.toBe(expected);
    expect(mocks.calls).toHaveLength(0);
    await expect(stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("enforces the hostname prefix boundary before create or branch can mutate native state", async () => {
    await expect(fixture({ namePrefix: "x".repeat(32) })).rejects.toThrow(
      "smolvm_name_prefix_invalid",
    );
    expect(mocks.calls).toHaveLength(0);
    const family = await fixture({ namePrefix: "s".repeat(31) });
    expect(Buffer.byteLength(family.sourceId)).toBe(64);
    try {
      const calls = mocks.calls.length;
      await expect(
        family.branch(family.sourceId, { branchable: false, namePrefix: "x".repeat(32) }),
      ).rejects.toThrow("smolvm_name_prefix_invalid");
      expect(mocks.calls).toHaveLength(calls);
      expect(() => family.attachment(family.sourceId)).not.toThrow();
      const child = await family.branch(family.sourceId, {
        branchable: false,
        namePrefix: "c".repeat(31),
      });
      expect(Buffer.byteLength(child)).toBe(64);
    } finally {
      await family.close();
    }
  });
  it("persists intent before onPrepared and never adopts a colliding nonzero create", async () => {
    let preparedName = "";
    let preparedState = "";
    await expect(
      fixture(
        {},
        {
          onPrepared: async (prepared) => {
            preparedName = prepared.sourceId;
            preparedState = prepared.statePath;
            const journal = await readSmolvmOciFamily({ statePath: prepared.statePath });
            expect(journal.machines).toEqual([
              { name: prepared.sourceId, parent: null, status: "intent" },
            ]);
            expect(mocks.calls.some((argv) => argv[1] === "create")).toBe(false);
            mocks.names.set(prepared.sourceId, { state: "running", parent: null, createdAt: 5 });
          },
        },
      ),
    ).rejects.toThrow("retained state");
    expect(mocks.names.get(preparedName)).toEqual({ state: "running", parent: null, createdAt: 5 });
    expect(
      mocks.calls.some(
        (argv) => ["stop", "delete"].includes(argv[1]!) && argv.includes(preparedName),
      ),
    ).toBe(false);
    expect((await readSmolvmOciFamily({ statePath: preparedState })).machines[0]?.status).toBe(
      "uncertain",
    );
  });
  it("preserves failed startup and failed branch intents without adopting their records", async () => {
    mocks.startFailure = new Error("native start failed");
    await expect(fixture()).rejects.toThrow("retained state");
    expect(mocks.calls.some((argv) => ["stop", "delete"].includes(argv[1]!))).toBe(false);
    mocks.startFailure = undefined;
    const family = await fixture();
    mocks.branchFailure = true;
    await expect(family.branch(family.sourceId, { branchable: false })).rejects.toThrow(
      "smolvm_oci_branch_failed",
    );
    const journal = await readSmolvmOciFamily({ statePath: family.statePath });
    expect(journal.machines.at(-1)?.status).toBe("uncertain");
    await expect(deleteSmolvmOciFamily({ statePath: family.statePath })).rejects.toThrow(
      "uncertain",
    );
  });
  it("cleans known siblings after a failed branch while preserving its uncertain intent and parent", async () => {
    const family = await fixture();
    const sibling = await family.branch(family.sourceId, { branchable: false });
    mocks.names.set("foreign", { state: "running", parent: null, createdAt: 9 });
    mocks.calls = [];
    mocks.branchFailure = true;
    await expect(family.branch(family.sourceId, { branchable: false })).rejects.toThrow(
      "smolvm_oci_branch_failed",
    );
    expect(mocks.names.has(sibling)).toBe(false);
    expect(mocks.names.get(family.sourceId)?.state).toBe("frozen");
    expect(mocks.names.get("foreign")?.state).toBe("running");
    const journal = await readSmolvmOciFamily({ statePath: family.statePath });
    expect(journal.machines.map((m) => m.status)).toEqual(["running", "uncertain"]);
    expect(
      mocks.calls
        .filter((argv) => ["stop", "delete"].includes(argv[1]!))
        .every((argv) => argv.includes(sibling)),
    ).toBe(true);
  });
  it("preserves the original branch failure together with uncertain cleanup and recovery metadata", async () => {
    const family = await fixture();
    mocks.branchFailure = true;
    const error: unknown = await family
      .branch(family.sourceId, { branchable: false })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw Error("expected aggregate branch failure");
    expect(error.message).toContain(family.statePath);
    expect(error.errors[0]).toMatchObject({
      code: "sandbox_process_failed",
      cause: { message: "smolvm_command_failed: branch failed" },
    });
    expect(error.errors[1]).toBeInstanceOf(AggregateError);
    expect((error.errors[1] as AggregateError).message).toContain("cleanup_unconfirmed");
    expect(
      (await readSmolvmOciFamily({ statePath: family.statePath })).machines.at(-1)?.status,
    ).toBe("uncertain");
  });
  it("does not probe foreign machines during healthy guest calls", async () => {
    const family = await fixture();
    mocks.names.set("foreign", { state: "unreachable", parent: null, createdAt: 9 });
    mocks.failList = true;
    try {
      expect((await family.execute(family.sourceId, { argv: ["/bin/true"] })).exitCode).toBe(0);
      expect(() => family.attachment(family.sourceId)).not.toThrow();
    } finally {
      mocks.failList = false;
      await family.close();
    }
  });
  it("refuses replacement under a captured name before any lifecycle mutation", async () => {
    const family = await fixture();
    mocks.names.get(family.sourceId)!.createdAt++;
    await expect(family.close()).rejects.toThrow("cleanup_unconfirmed");
    expect(mocks.calls.some((argv) => ["stop", "delete"].includes(argv[1]!))).toBe(false);
  });
  it("returns the first close disposition and deletes a stopped retained journal through exact CLI names", async () => {
    const family = await fixture();
    mocks.names.set("foreign", { state: "running", parent: null, createdAt: 9 });
    expect(await family.close({ retainState: true })).toEqual({ retained: true });
    expect(await family.close()).toEqual({ retained: true });
    await deleteSmolvmOciFamily({ statePath: family.statePath });
    expect([...mocks.names.keys()]).toEqual(["foreign"]);
    await expect(stat(family.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("releases its delete claim after failure so exact stopped cleanup can be retried", async () => {
    const family = await fixture();
    await family.close({ retainState: true });
    mocks.failDelete = true;
    await expect(deleteSmolvmOciFamily({ statePath: family.statePath })).rejects.toThrow();
    await expect(stat(path.join(family.statePath, "controller.claim"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readSmolvmOciFamily({ statePath: family.statePath })).machines[0]?.status).toBe(
      "stopped",
    );
    mocks.failDelete = false;
    await deleteSmolvmOciFamily({ statePath: family.statePath });
    expect(mocks.names.has(family.sourceId)).toBe(false);
  });
  it("never releases another controller's claim after acquisition is refused", async () => {
    const family = await fixture();
    await family.close({ retainState: true });
    const claim = path.join(family.statePath, "controller.claim");
    await writeFile(claim, "other controller", { mode: 0o600 });
    await expect(deleteSmolvmOciFamily({ statePath: family.statePath })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(claim, "utf8")).toBe("other controller");
    await unlink(claim);
    await deleteSmolvmOciFamily({ statePath: family.statePath });
  });
  it("releases its delete claim even when native deletion and CLI disposal both fail", async () => {
    const family = await fixture();
    await family.close({ retainState: true });
    mocks.failDelete = true;
    mocks.failCliDispose = true;
    await expect(deleteSmolvmOciFamily({ statePath: family.statePath })).rejects.toBeInstanceOf(
      AggregateError,
    );
    await expect(stat(path.join(family.statePath, "controller.claim"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    mocks.failDelete = false;
    mocks.failCliDispose = false;
    await deleteSmolvmOciFamily({ statePath: family.statePath });
  });
  it.each(["image", "mount"])(
    "deletes stopped disks after the original %s input disappears or changes",
    async (input) => {
      const mount = await realpath(await mkdtemp("/tmp/oci-mount-"));
      dirs.push(mount, mount + "-old");
      const family = await fixture({
        mounts: [{ hostPath: mount, guestPath: "/inputs", readOnly: true }],
      });
      await family.retainForColdReopen();
      const journal = await readJournal(family.statePath);
      if (input === "image") await unlink(journal.options.imageArchive);
      else {
        await rename(mount, mount + "-old");
        await mkdir(mount);
      }
      await expect(reopenSmolvmOciFamily({ statePath: family.statePath })).rejects.toThrow();
      await deleteSmolvmOciFamily({ statePath: family.statePath });
      expect(mocks.names.has(family.sourceId)).toBe(false);
    },
  );
  it("binds selected disk tools on reopen but does not require them for stopped deletion", async () => {
    const family = await fixture({ e2fsprogsDirectory: "/trusted/disk-tools" });
    await family.retainForColdReopen();
    mocks.calls = [];
    mocks.hostToolsIdentity = "e".repeat(64);
    await expect(reopenSmolvmOciFamily({ statePath: family.statePath })).rejects.toThrow(
      "host_tools_binding_changed",
    );
    expect(mocks.calls.some((argv) => argv[1] === "start")).toBe(false);
    await deleteSmolvmOciFamily({ statePath: family.statePath });
    expect(mocks.names.has(family.sourceId)).toBe(false);
  });
  it("still requires the captured runtime and machine identity when deleting stopped disks", async () => {
    const family = await fixture();
    await family.close({ retainState: true });
    mocks.calls = [];
    mocks.runtimeIdentity = "c".repeat(64);
    await expect(deleteSmolvmOciFamily({ statePath: family.statePath })).rejects.toThrow(
      "runtime_binding_changed",
    );
    expect(mocks.calls).toEqual([]);
    mocks.runtimeIdentity = "b".repeat(64);
    mocks.names.get(family.sourceId)!.createdAt++;
    await expect(deleteSmolvmOciFamily({ statePath: family.statePath })).rejects.toMatchObject({
      cause: { message: "smolvm_machine_identity_changed" },
    });
    expect(mocks.calls.some((argv) => argv[1] === "delete")).toBe(false);
    await expect(stat(path.join(family.statePath, "controller.claim"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("lets native dependency protection preserve externally created descendants", async () => {
    const family = await fixture();
    mocks.names.set("foreign-child", { state: "running", parent: family.sourceId, createdAt: 9 });
    await expect(family.close()).rejects.toThrow("cleanup_unconfirmed");
    expect(mocks.names.has("foreign-child")).toBe(true);
    expect(mocks.calls.some((argv) => argv.includes("--cascade"))).toBe(false);
    expect(
      mocks.calls.some(
        (argv) => ["stop", "delete"].includes(argv[1]!) && argv.includes("foreign-child"),
      ),
    ).toBe(false);
  });
  it("reopens cold sources among foreign machines and refuses registry drift", async () => {
    const family = await fixture();
    const retained = await family.retainForColdReopen();
    expect(retained.version).toBe(3);
    expect(retained.sourceId).toBe(family.sourceId);
    mocks.names.set("foreign", { state: "running", parent: null, createdAt: 9 });
    vi.stubEnv("XDG_DATA_HOME", process.env.XDG_DATA_HOME + "-changed");
    await expect(reopenSmolvmOciFamily({ statePath: family.statePath })).rejects.toThrow(
      "registry_binding_changed",
    );
    vi.stubEnv("XDG_DATA_HOME", process.env.XDG_DATA_HOME!.replace(/-changed$/u, ""));
    const reopened = await reopenSmolvmOciFamily({ statePath: family.statePath });
    await reopened.close();
    expect(mocks.names.has("foreign")).toBe(true);
  });
  it("protects ordinary shared cache paths from guest mounts", async () => {
    await expect(
      fixture({ mounts: [{ hostPath: mocks.cache, guestPath: "/cache", readOnly: true }] }),
    ).rejects.toThrow("protected_mount");
  });
  it("launches only the fixed scoped guest shell and validates terminal and machine input", async () => {
    const family = await fixture();
    const terminal = terminalFixture();
    try {
      await expect(family.openTerminal("other", terminal.options)).rejects.toMatchObject({
        code: "sandbox_closed",
      });
      for (const patch of [
        { columns: 0 },
        { rows: 1001 },
        { terminalType: "xterm\nBAD=1" },
        { command: "/bin/sh" },
      ])
        await expect(
          family.openTerminal(family.sourceId, { ...terminal.options, ...patch }),
        ).rejects.toMatchObject({ code: "sandbox_invalid_request" });
      const handle = await family.openTerminal(family.sourceId, terminal.options);
      const launched = vi.mocked(terminal.launch).mock.calls[0]![0];
      const prefix = "\u001b]777;smolvm-terminal-ready;";
      expect(launched.readyMarker.startsWith(prefix)).toBe(true);
      expect(launched.readyMarker.endsWith("\u0007")).toBe(true);
      expect(launched.readyMarker.slice(prefix.length, -1)).toMatch(/^[a-f0-9]{48}$/u);
      expect(terminal.launch).toHaveBeenCalledWith({
        argv: [
          await realpath("/usr/bin/true"),
          "machine",
          "exec",
          "--name",
          family.sourceId,
          "--interactive",
          "--tty",
          "--workdir",
          "/workspace",
          "--user",
          "0",
          "--env",
          "TERM=xterm-256color",
          "--",
          "/bin/bash",
          "--noprofile",
          "--norc",
          "-c",
          'printf %s "$1"; exec /bin/bash -i',
          "terminal",
          launched.readyMarker,
        ],
        cwd: family.statePath,
        environment: expect.objectContaining({
          HOME: process.env.HOME,
          TERM: "xterm-256color",
        }) as unknown,
        columns: 120,
        rows: 30,
        readyMarker: launched.readyMarker,
        signal: expect.any(AbortSignal) as unknown,
      });
      expect(() => handle.resize(0, 24)).toThrow();
      await handle.close();
      const child = await family.branch(family.sourceId, { branchable: false });
      await expect(family.openTerminal(family.sourceId, terminal.options)).rejects.toMatchObject({
        code: "sandbox_closed",
      });
      const childHandle = await family.openTerminal(child, terminalFixture().options);
      await childHandle.close();
    } finally {
      await family.close();
    }
  });
  it("waits for a source terminal before freezing and blocks later terminal admission", async () => {
    const family = await fixture();
    const terminal = await family.openTerminal(family.sourceId, terminalFixture().options);
    try {
      const branching = family.branch(family.sourceId, { branchable: false });
      const later = family.openTerminal(family.sourceId, terminalFixture().options);
      const rejected = expect(later).rejects.toMatchObject({ code: "sandbox_closed" });
      await new Promise((r) => setTimeout(r, 10));
      expect(mocks.events).toEqual([]);
      await terminal.close();
      const child = await branching;
      await rejected;
      const leafTerminal = await family.openTerminal(child, terminalFixture().options);
      const removal = family.removeMachine(child);
      await new Promise((r) => setTimeout(r, 10));
      expect(mocks.events).toEqual([`branch:${family.sourceId}`]);
      await leafTerminal.close();
      await removal;
      expect(mocks.events).toEqual([`branch:${family.sourceId}`, `stop:${child}`]);
    } finally {
      await family.close();
    }
  });
  it("aborts a pending terminal startup during family close without a queue deadlock", async () => {
    const family = await fixture();
    const entered = deferred<void>();
    const terminal = terminalFixture();
    const opening = family.openTerminal(family.sourceId, {
      ...terminal.options,
      launch: async ({ signal }) => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new Error("launch aborted after cleanup");
      },
    });
    const rejected = expect(opening).rejects.toThrow("launch aborted");
    await entered.promise;
    await family.close();
    await rejected;
    expect(mocks.events).toEqual([`stop:${family.sourceId}`]);
  });
  it("closes a family while a branch waits for a terminal without starting the branch", async () => {
    const family = await fixture();
    await family.openTerminal(family.sourceId, terminalFixture().options);
    const branch = family.branch(family.sourceId, { branchable: false });
    const rejected = expect(branch).rejects.toMatchObject({ code: "sandbox_closed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await family.close();
    await rejected;
    expect(mocks.events).toEqual([`stop:${family.sourceId}`]);
  });
  it("isolates an active terminal abort and a failed launch from ordinary execution", async () => {
    const family = await fixture();
    const controller = new AbortController();
    const first = terminalFixture();
    const peer = terminalFixture();
    try {
      const terminal = await family.openTerminal(family.sourceId, {
        ...first.options,
        signal: controller.signal,
      });
      await family.openTerminal(family.sourceId, peer.options);
      controller.abort();
      await terminal.completion;
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(peer.close).not.toHaveBeenCalled();
      await expect(
        family.openTerminal(family.sourceId, {
          ...first.options,
          launch: () => Promise.reject(new Error("cleaned failed startup")),
        }),
      ).rejects.toThrow("cleaned failed startup");
      expect((await family.execute(family.sourceId, { argv: ["/bin/true"] })).exitCode).toBe(0);
      expect(mocks.events).toEqual([]);
    } finally {
      await family.close();
    }
  });
  it("retires the family and its terminals when a terminal open detects lost VM identity", async () => {
    const family = await fixture();
    const descriptor = family.attachment(family.sourceId);
    const peer = terminalFixture();
    await family.openTerminal(family.sourceId, peer.options);
    const failed = terminalFixture();
    const identityFailure = new SandboxExecutionError("sandbox_process_failed");
    mocks.alive = () => Promise.reject(identityFailure);
    await expect(family.openTerminal(family.sourceId, failed.options)).rejects.toBe(
      identityFailure,
    );
    expect(failed.launch).not.toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(mocks.events).toEqual([`stop:${family.sourceId}`]);
    expect(() => family.attachment(family.sourceId)).toThrow("sandbox_closed");
    await expect(family.execute(family.sourceId, { argv: ["/bin/true"] })).rejects.toMatchObject({
      code: "sandbox_closed",
    });
    expect((await stat(family.statePath)).isDirectory()).toBe(true);
    await expect(stat(descriptor.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await family.close();
  });
  it("retains state and reports a terminal cleanup failure without blocking family teardown", async () => {
    const family = await fixture();
    const terminal = terminalFixture();
    const handle = await family.openTerminal(family.sourceId, {
      ...terminal.options,
      launch: () => ({
        completion: terminal.exit.promise,
        write: terminal.write,
        resize: terminal.resize,
        close: () => Promise.reject(new Error("exec reap unconfirmed")),
      }),
    });
    const branching = family.branch(family.sourceId, { branchable: false });
    const rejected = expect(branching).rejects.toThrow("smolvm_oci_branch_failed");
    await expect(handle.close()).rejects.toThrow("exec reap unconfirmed");
    await rejected;
    expect(mocks.events).toEqual([`stop:${family.sourceId}`]);
    expect((await stat(family.statePath)).isDirectory()).toBe(true);
    terminal.exit.resolve({ exitCode: null, signal: "SIGKILL" });
  });
  it("retains recovery state after a launcher reports unconfirmed startup cleanup", async () => {
    const family = await fixture();
    const uncertain = new SmolvmOciTerminalCleanupError("unreaped startup client");
    await expect(
      family.openTerminal(family.sourceId, {
        ...terminalFixture().options,
        launch: () => Promise.reject(uncertain),
      }),
    ).rejects.toBe(uncertain);
    await expect(
      family.openTerminal(family.sourceId, terminalFixture().options),
    ).rejects.toMatchObject({ code: "sandbox_process_failed" });
    expect((await family.execute(family.sourceId, { argv: ["/bin/true"] })).exitCode).toBe(0);
    await expect(family.retainForColdReopen()).rejects.toThrow("cleanup_unconfirmed");
    await expect(family.close()).rejects.toThrow("cleanup_unconfirmed");
    expect(mocks.events).toEqual([`stop:${family.sourceId}`]);
    expect((await stat(family.statePath)).isDirectory()).toBe(true);
    await expect(stat(path.join(family.statePath, "cold-ready.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it.each(["abort", "timeout"])(
    "retires the family on %s during an admitted request's initial identity check before guest execution",
    async (mode) => {
      const family = await fixture();
      const initialCheck = deferred<void>();
      const finishCheck = deferred<void>();
      mocks.alive = () => {
        initialCheck.resolve();
        return finishCheck.promise;
      };
      const guestExecution = vi.fn(() => Promise.resolve("unexpected guest execution"));
      mocks.exec = guestExecution;
      const controller = new AbortController();
      const execution = family.execute(
        family.sourceId,
        { argv: ["/bin/true"], timeoutMs: 10000 },
        { signal: controller.signal },
      );
      const rejected = expect(execution).rejects.toMatchObject({
        code: mode === "abort" ? "sandbox_aborted" : "sandbox_timeout",
      });
      await initialCheck.promise;
      if (mode === "abort") controller.abort();
      else vi.spyOn(performance, "now").mockReturnValue(performance.now() + 10001);
      finishCheck.resolve();
      await rejected;
      expect(guestExecution).not.toHaveBeenCalled();
      expect(mocks.events).toEqual([`stop:${family.sourceId}`]);
      expect(() => family.attachment(family.sourceId)).toThrow();
      await expect(family.execute(family.sourceId, { argv: ["/bin/true"] })).rejects.toMatchObject({
        code: "sandbox_closed",
      });
    },
  );
  it("runs four requests concurrently and isolates queued cancellation", async () => {
    const family = await fixture();
    const started: string[] = [];
    const entered = deferred<void>();
    const commands = new Map<string, ReturnType<typeof deferred<string>>>();
    mocks.exec = async (request) => {
      const name = request.argv[1]!;
      started.push(name);
      const command = deferred<string>();
      commands.set(name, command);
      if (started.length === 4) entered.resolve();
      return command.promise;
    };
    try {
      const active = Array.from({ length: 4 }, (_, i) =>
        family.execute(family.sourceId, { argv: ["/bin/echo", String(i)] }),
      );
      await entered.promise;
      expect([...started].sort()).toEqual(["0", "1", "2", "3"]);
      const controller = new AbortController();
      const queued = family.execute(
        family.sourceId,
        { argv: ["/bin/echo", "queued"] },
        { signal: controller.signal },
      );
      const rejected = expect(queued).rejects.toMatchObject({ code: "sandbox_aborted" });
      controller.abort();
      await rejected;
      expect(started).not.toContain("queued");
      expect(mocks.events).toEqual([]);
      for (const [name, command] of commands) command.resolve(name);
      const results = await Promise.all(active);
      expect(results.map((r) => r.stdout.toString())).toEqual(["0", "1", "2", "3"]);
    } finally {
      for (const [name, command] of commands) command.resolve(name);
      await family.close();
    }
  });
  it("holds later requests behind an exclusive branch until active execution finishes", async () => {
    const family = await fixture();
    const started = deferred<void>();
    const release = deferred<string>();
    mocks.exec = () => {
      started.resolve();
      return release.promise;
    };
    try {
      const active = family.execute(family.sourceId, { argv: ["/bin/true"] });
      await started.promise;
      const branch = family.branch(family.sourceId, { branchable: false });
      const later = family.execute(family.sourceId, { argv: ["/bin/true"] });
      const rejected = expect(later).rejects.toMatchObject({ code: "sandbox_closed" });
      await Promise.resolve();
      expect(mocks.events).toEqual([]);
      release.resolve("complete");
      await active;
      const child = await branch;
      await rejected;
      expect(mocks.events).toEqual([`branch:${family.sourceId}`]);
      mocks.exec = undefined;
      expect((await family.execute(child, { argv: ["/bin/true"] })).exitCode).toBe(0);
    } finally {
      await family.close();
    }
  });
  it("retires peers on active cancellation and awaits VM cleanup before settling them", async () => {
    const family = await fixture();
    const allStarted = deferred<void>();
    const cleanupStarted = deferred<void>();
    const finishCleanup = deferred<void>();
    let started = 0;
    mocks.exec = (_request, options) =>
      new Promise((_resolve, reject) => {
        if (++started === 4) allStarted.resolve();
        const abort = () => reject(new SandboxExecutionError("sandbox_aborted"));
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    mocks.stop = () => {
      cleanupStarted.resolve();
      return finishCleanup.promise;
    };
    const controller = new AbortController();
    let settled = 0;
    const active = Array.from({ length: 4 }, (_, i) =>
      family
        .execute(
          family.sourceId,
          { argv: ["/bin/sleep", "60"] },
          i === 0 ? { signal: controller.signal } : {},
        )
        .finally(() => {
          settled++;
        }),
    );
    const results = Promise.allSettled(active);
    await allStarted.promise;
    const queued = family.execute(family.sourceId, { argv: ["/bin/true"] });
    const rejected = expect(queued).rejects.toMatchObject({ code: "sandbox_closed" });
    controller.abort();
    await cleanupStarted.promise;
    expect(settled).toBe(0);
    expect(started).toBe(4);
    await rejected;
    finishCleanup.resolve();
    const terminal = await results;
    expect(terminal.every((r) => r.status === "rejected")).toBe(true);
    expect(mocks.events).toEqual([`stop:${family.sourceId}`]);
    await expect(family.execute(family.sourceId, { argv: ["/bin/true"] })).rejects.toMatchObject({
      code: "sandbox_closed",
    });
  });
  it("writes scoped recovery information before launching the VM", async () => {
    const family = await fixture();
    try {
      expect(mocks.recoveryPresentAtCreate).toBe(true);
      const recovery = JSON.parse(
        await readFile(path.join(family.statePath, "recovery.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(recovery.runtimeVersion).toBe("1.26.1");
      expect(recovery.runtimeIdentity).toBe("b".repeat(64));
      expect(recovery.environment).toMatchObject({
        HOME: process.env.HOME,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      });
    } finally {
      await family.close();
    }
  });
  it("rejects a read-only mount exposing custom Pi state through an alias", async () => {
    const directory = await realpath(await mkdtemp("/tmp/oci-control-"));
    dirs.push(directory);
    const control = path.join(directory, "actual");
    const alias = path.join(directory, "alias");
    await mkdir(control);
    await symlink(control, alias);
    vi.stubEnv("PI_CODING_AGENT_DIR", alias);
    await expect(
      fixture({ mounts: [{ hostPath: control, guestPath: "/input", readOnly: true }] }),
    ).rejects.toThrow("protected_mount");
  });
  it("retires the family when the host CLI is terminated by a signal", async () => {
    const family = await fixture();
    mocks.execSignal = "SIGTERM";
    await expect(family.execute(family.sourceId, { argv: ["/bin/true"] })).rejects.toMatchObject({
      code: "sandbox_process_failed",
    });
    expect(() => family.attachment(family.sourceId)).toThrow();
    expect((await stat(family.statePath)).isDirectory()).toBe(true);
  });
  it("requires explicit branchability and rejects branching a leaf without retiring it", async () => {
    const family = await fixture();
    try {
      await expect(family.branch(family.sourceId, undefined as never)).rejects.toMatchObject({
        code: "sandbox_invalid_request",
      });
      const leaf = await family.branch(family.sourceId, { branchable: false });
      await expect(family.branch(leaf, { branchable: true })).rejects.toMatchObject({
        code: "sandbox_invalid_request",
      });
      expect((await family.execute(leaf, { argv: ["/bin/true"] })).exitCode).toBe(0);
    } finally {
      await family.close();
    }
  });
  it("can close during output without deadlocking active admission", async () => {
    const family = await fixture();
    let closing: Promise<{ readonly retained: boolean }> | undefined;
    const execution = family.execute(
      family.sourceId,
      { argv: ["/bin/true"] },
      {
        onStdout: () => {
          closing = family.close();
        },
      },
    );
    await expect(execution).rejects.toMatchObject({ code: "sandbox_closed" });
    await closing;
    expect(() => family.attachment(family.sourceId)).toThrow();
    await expect(stat(family.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses an externally restarted cold source before claiming or stopping it", async () => {
    const family = await fixture();
    const leaf = await family.branch(family.sourceId, { branchable: false });
    await family.removeMachine(leaf);
    await family.retainForColdReopen();
    const external = new SmolvmCli({
      smolvmPath: "/trusted/smolvm",
      stateDirectory: family.statePath,
    });
    await external.run({ argv: ["machine", "start", "--name", family.sourceId] });
    await expect(reopenSmolvmOciFamily({ statePath: family.statePath })).rejects.toThrow(
      "cold_source_not_stopped",
    );
    expect((await stat(path.join(family.statePath, "cold-ready.json"))).isFile()).toBe(true);
    await external.run({ argv: ["machine", "stop", "--name", family.sourceId] });
    await external.dispose();
    const reopened = await reopenSmolvmOciFamily({ statePath: family.statePath });
    await reopened.close();
  });
  it("only seals a child-free source, atomically claims it and revokes old tokens", async () => {
    const family = await fixture();
    const old = family.attachment(family.sourceId);
    const child = await family.branch(family.sourceId, { branchable: false });
    await expect(family.retainForColdReopen()).rejects.toMatchObject({
      code: "sandbox_invalid_request",
    });
    await family.removeMachine(child);
    const retained = await family.retainForColdReopen();
    expect(retained.mode).toBe("cold");
    const attempts = await Promise.allSettled([
      reopenSmolvmOciFamily({ statePath: retained.statePath }),
      reopenSmolvmOciFamily({ statePath: retained.statePath }),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const reopened = attempts.find((r) => r.status === "fulfilled");
    if (reopened?.status !== "fulfilled") throw Error("expected cold open");
    try {
      expect(reopened.value.attachment(reopened.value.sourceId).token).not.toBe(old.token);
      await expect(attachSmolvmOciMachine(old)).rejects.toMatchObject({
        code: "sandbox_invalid_request",
      });
      await expect(reopenSmolvmOciFamily({ statePath: retained.statePath })).rejects.toBeDefined();
    } finally {
      await reopened.value.close();
    }
    await expect(stat(retained.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("releases the controller claim if the atomic cold receipt claim is refused", async () => {
    const family = await fixture();
    await family.retainForColdReopen();
    const staleClaim = path.join(family.statePath, "cold-claimed.json");
    await writeFile(staleClaim, "existing receipt claim", { mode: 0o600 });
    await expect(reopenSmolvmOciFamily({ statePath: family.statePath })).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(stat(path.join(family.statePath, "controller.claim"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(mocks.names.get(family.sourceId)?.state).toBe("stopped");
    await unlink(staleClaim);
    const reopened = await reopenSmolvmOciFamily({ statePath: family.statePath });
    await reopened.close();
  });
  it("keeps the recovery journal bounded through repeated branch/delete and cold-reopen cycles", async () => {
    let family = await fixture({ namePrefix: "s".repeat(31) });
    const statePath = family.statePath;
    const initialSize = (await stat(path.join(statePath, "recovery.json"))).size;
    for (let generation = 0; generation < 4; generation++) {
      for (let index = 0; index < 40; index++) {
        const child = await family.branch(family.sourceId, {
          branchable: false,
          namePrefix: "c".repeat(31),
        });
        await family.removeMachine(child);
      }
      expect((await readSmolvmOciFamily({ statePath })).machines).toHaveLength(1);
      expect((await stat(path.join(statePath, "recovery.json"))).size).toBe(initialSize);
      await family.retainForColdReopen();
      family = await reopenSmolvmOciFamily({ statePath });
    }
    await family.close();
  }, 30000);
  it("retains and repeatedly reopens a writable child-free original", async () => {
    let family = await fixture();
    const originalPath = family.statePath;
    for (let index = 0; index < 2; index++) {
      const terminal = await family.openTerminal(family.sourceId, terminalFixture().options);
      const retention = family.retainForColdReopen();
      await terminal.close();
      expect((await retention).statePath).toBe(originalPath);
      family = await reopenSmolvmOciFamily({ statePath: originalPath });
      expect((await family.execute(family.sourceId, { argv: ["/bin/true"] })).exitCode).toBe(0);
    }
    await family.close();
  });
  it("does not mark unacknowledged or ordinary forensic retention reopenable", async () => {
    const family = await fixture();
    const child = await family.branch(family.sourceId, { branchable: false });
    await family.removeMachine(child);
    mocks.failClose = true;
    await expect(family.retainForColdReopen()).rejects.toThrow("cleanup_unconfirmed");
    await expect(stat(path.join(family.statePath, "cold-ready.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(reopenSmolvmOciFamily({ statePath: family.statePath })).rejects.toBeDefined();
    mocks.failClose = false;
    const forensic = await fixture();
    await forensic.close({ retainState: true });
    await expect(reopenSmolvmOciFamily({ statePath: forensic.statePath })).rejects.toBeDefined();
  });
  it("rejects changed image and runtime bindings before consuming a ready record", async () => {
    const family = await fixture();
    const child = await family.branch(family.sourceId, { branchable: false });
    await family.removeMachine(child);
    await family.retainForColdReopen();
    const ready = path.join(family.statePath, "cold-ready.json");
    const fs = await import("node:fs/promises");
    const record = JSON.parse(await fs.readFile(ready, "utf8")) as {
      options: { imageArchive: string };
      runtimeIdentity: string;
    };
    await fs.writeFile(record.options.imageArchive, "changed");
    await expect(reopenSmolvmOciFamily({ statePath: family.statePath })).rejects.toThrow(
      "image_digest_mismatch",
    );
    await fs.writeFile(record.options.imageArchive, "fixture");
    record.runtimeIdentity = "0".repeat(64);
    await fs.writeFile(ready, JSON.stringify(record));
    await expect(reopenSmolvmOciFamily({ statePath: family.statePath })).rejects.toThrow(
      "binding_changed",
    );
  });
  it("rejects structural machine capacity without retiring the usable family", async () => {
    const family = await fixture();
    try {
      let child = "";
      for (let i = 0; i < 15; i++)
        child = await family.branch(family.sourceId, { branchable: false });
      await expect(family.branch(family.sourceId, { branchable: false })).rejects.toMatchObject({
        code: "sandbox_invalid_request",
      });
      expect((await family.execute(child, { argv: ["/bin/true"] })).exitCode).toBe(0);
      await family.removeMachine(child);
      expect(await family.branch(family.sourceId, { branchable: false })).toMatch(
        /^pi-[a-f0-9]{32}$/u,
      );
    } finally {
      await family.close();
    }
  });
  it("revokes attachment sockets but preserves state when normal shutdown fails", async () => {
    const family = await fixture();
    const descriptor = family.attachment(family.sourceId);
    const socket = createConnection(descriptor.socketPath);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    const closed = once(socket, "close");
    mocks.failClose = true;
    await expect(family.close()).rejects.toThrow("cleanup_unconfirmed");
    await closed;
    expect((await stat(family.statePath)).isDirectory()).toBe(true);
    await expect(stat(descriptor.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["create", "reopen"])(
    "preserves the %s failure together with a cleanup failure and recovery path",
    async (operation) => {
      let reopenPath: string | undefined;
      if (operation === "reopen") {
        const family = await fixture();
        const child = await family.branch(family.sourceId, { branchable: false });
        await family.removeMachine(child);
        reopenPath = (await family.retainForColdReopen()).statePath;
      }
      const startup = new Error("specific startup failure");
      mocks.startFailure = startup;
      mocks.failClose = true;
      const pending = reopenPath ? reopenSmolvmOciFamily({ statePath: reopenPath }) : fixture();
      const error: unknown = await pending.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("expected aggregate failure");
      expect(error.message).toContain(mocks.lastStatePath);
      expect(error.message).toContain("recovery.json");
      expect(error.errors[0]).toBe(startup);
      expect(error.errors[1]).toBeInstanceOf(AggregateError);
      expect((error.errors[1] as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("cleanup_uncertain") as unknown,
        }),
      ]);
      expect((await stat(mocks.lastStatePath)).isDirectory()).toBe(true);
    },
  );
  it("preserves VM, server, and CLI cleanup failures without losing recovery guidance", async () => {
    const family = await fixture();
    const descriptor = family.attachment(family.sourceId);
    mocks.failClose = true;
    mocks.failServerClose = true;
    mocks.failCliDispose = true;
    const error: unknown = await family.close().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("expected aggregate failure");
    expect(error.message).toContain(family.statePath);
    expect(error.message).toContain("recovery.json");
    expect(error.errors).toEqual([
      expect.objectContaining({ message: "stop not confirmed" }),
      expect.objectContaining({ message: "server disposal failed" }),
      expect.objectContaining({ message: "CLI disposal failed" }),
    ]);
    expect(mocks.cliDisposeCalls).toBe(1);
    expect((await stat(family.statePath)).isDirectory()).toBe(true);
    await expect(stat(descriptor.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("independently owned prepared families", () => {
  it("copies nested continuing sources with separate capabilities, journals and inherited topology", async () => {
    const root = await fixture({ networkMode: "host" });
    const prepared = vi.fn(async ({ statePath }: { statePath: string }) => {
      const journal = await readJournal(statePath);
      expect(journal.machines[0]?.status).toBe("intent");
      expect(mocks.names.has(journal.sourceId)).toBe(false);
    });
    const child = await root.copyFamily({ namePrefix: "prepared" }, { onPrepared: prepared });
    const sibling = await root.copyFamily();
    const candidate = await child.copyFamily({ namePrefix: "candidate" });
    try {
      expect(prepared).toHaveBeenCalledOnce();
      expect([root.depth, child.depth, candidate.depth]).toEqual([0, 1, 2]);
      expect(child.configuration).toEqual({ ...root.configuration, namePrefix: "prepared" });
      const altered = child.configuration;
      (altered.resources as { cpus: number }).cpus = 6;
      expect(child.configuration.resources.cpus).toBe(1);
      expect(mocks.names.get(root.sourceId)?.state).toBe("running");
      expect(mocks.names.get(child.sourceId)?.state).toBe("running");
      expect(
        mocks.calls.filter((a) => a[1] === "branch").every((a) => !a.includes("--freeze-source")),
      ).toBe(true);
      const parentJournal = await readJournal(root.statePath);
      const journal = await readJournal(candidate.statePath);
      expect(parentJournal.machines.map((m) => m.name)).toEqual([root.sourceId]);
      expect(journal.machines.map((m) => m.name)).toEqual([candidate.sourceId]);
      expect(journal.borrowedAncestors.map((a) => a.identity.name)).toEqual([
        root.sourceId,
        child.sourceId,
      ]);
      const rootAttachment = root.attachment(root.sourceId);
      const childAttachment = child.attachment(child.sourceId);
      expect(childAttachment.socketPath).not.toBe(rootAttachment.socketPath);
      expect(childAttachment.token).not.toBe(rootAttachment.token);
      const judge = await candidate.branch(candidate.sourceId, { branchable: false });
      await candidate.removeMachine(judge);
      await candidate.close();
      expect(mocks.names.get(child.sourceId)?.state).toBe("running");
      expect(mocks.names.get(sibling.sourceId)?.state).toBe("running");
      await expect(root.execute(root.sourceId, { argv: ["/bin/true"] })).resolves.toMatchObject({
        exitCode: 0,
      });
    } finally {
      await candidate.close();
      await sibling.close();
      await child.close();
      await root.close();
    }
  });
  it("retains parents with independent descendants and reopens a deep original while ancestors stay stopped", async () => {
    const root = await fixture();
    const child = await root.copyFamily();
    const candidate = await child.copyFamily();
    const leaf = await candidate.retainForColdReopen();
    await child.retainForColdReopen();
    await root.retainForColdReopen();
    await expect(deleteSmolvmOciFamily({ statePath: root.statePath })).rejects.toThrow(
      "dependencies_pending",
    );
    expect(mocks.calls.some((a) => a[1] === "delete" && a.includes(root.sourceId))).toBe(false);
    const reopened = await reopenSmolvmOciFamily({ statePath: leaf.statePath });
    expect(reopened.depth).toBe(2);
    expect(mocks.names.get(root.sourceId)?.state).toBe("stopped");
    expect(mocks.names.get(child.sourceId)?.state).toBe("stopped");
    await reopened.close();
    await deleteSmolvmOciFamily({ statePath: child.statePath });
    await deleteSmolvmOciFamily({ statePath: root.statePath });
    expect(mocks.names.size).toBe(0);
  });
  it.each(["creation", "image", "parent", "missing"])(
    "rejects a changed borrowed ancestor's %s before consuming the cold receipt",
    async (change) => {
      const root = await fixture();
      const child = await root.copyFamily();
      const retained = await child.retainForColdReopen();
      const original = { ...mocks.names.get(root.sourceId)! };
      if (change === "creation") mocks.names.get(root.sourceId)!.createdAt++;
      if (change === "image") mocks.names.get(root.sourceId)!.image = "different-image";
      if (change === "parent") mocks.names.get(root.sourceId)!.parent = "foreign";
      if (change === "missing") mocks.names.delete(root.sourceId);
      await expect(reopenSmolvmOciFamily({ statePath: retained.statePath })).rejects.toThrow();
      await expect(stat(path.join(retained.statePath, "cold-ready.json"))).resolves.toBeDefined();
      mocks.names.set(root.sourceId, original);
      const reopened = await reopenSmolvmOciFamily({ statePath: retained.statePath });
      await reopened.close();
      await root.close();
    },
  );
  it("refuses ancestor-directory replacement but permits cleanup of the owned child", async () => {
    const root = await fixture();
    const child = await root.copyFamily();
    await child.retainForColdReopen();
    const ancestor = (await readJournal(child.statePath)).borrowedAncestors[0]!.identity;
    const directory = ancestor.dataDirectory!;
    await rename(directory, directory + ".saved");
    await mkdir(directory);
    try {
      await expect(reopenSmolvmOciFamily({ statePath: child.statePath })).rejects.toThrow();
      await deleteSmolvmOciFamily({ statePath: child.statePath });
      expect(mocks.names.has(root.sourceId)).toBe(true);
    } finally {
      await rm(directory, { recursive: true });
      await rename(directory + ".saved", directory);
      await root.close();
    }
  });
  it("rejects a broken ancestry chain before any native operation", async () => {
    const root = await fixture();
    const child = await root.copyFamily();
    const grandchild = await child.copyFamily();
    await grandchild.retainForColdReopen();
    const file = path.join(grandchild.statePath, "recovery.json");
    const original = await readFile(file, "utf8");
    const journal = await readJournal(grandchild.statePath);
    const altered = structuredClone(journal);
    (altered.borrowedAncestors[1]!.identity as { parent: string | null }).parent = null;
    await writeFile(file, JSON.stringify(altered));
    const calls = mocks.calls.length;
    await expect(reopenSmolvmOciFamily({ statePath: grandchild.statePath })).rejects.toThrow(
      "ancestor_binding_invalid",
    );
    expect(mocks.calls).toHaveLength(calls);
    await writeFile(file, original);
    await deleteSmolvmOciFamily({ statePath: grandchild.statePath });
    await child.close();
    await root.close();
  });
  it("refuses changed host boot bindings before copying without stopping the source", async () => {
    const root = await fixture();
    mocks.runtimeIdentity = "e".repeat(64);
    await expect(root.copyFamily()).rejects.toThrow("copy_binding_changed");
    expect(mocks.calls.some((a) => a[1] === "branch")).toBe(false);
    expect(mocks.names.get(root.sourceId)?.state).toBe("running");
    mocks.runtimeIdentity = "b".repeat(64);
    await root.close();
  });
  it("allows ancestor cold boots and network edits without invalidating an existing child", async () => {
    const root = await fixture();
    const child = await root.copyFamily();
    await child.retainForColdReopen();
    await root.retainForColdReopen();
    await configureSmolvmOciFamily({ statePath: root.statePath, networkMode: "host" });
    const parent = await reopenSmolvmOciFamily({ statePath: root.statePath });
    const reopened = await reopenSmolvmOciFamily({ statePath: child.statePath });
    expect(reopened.configuration.networkMode).toBe("none");
    expect(parent.configuration.networkMode).toBe("host");
    await reopened.close();
    await parent.close();
  });
  it("rejects copy topology overrides and frozen sources without retiring the parent", async () => {
    const root = await fixture();
    await expect(root.copyFamily({ networkMode: "host" } as never)).rejects.toThrow(
      "sandbox_invalid_request",
    );
    const reviewer = await root.branch(root.sourceId, { branchable: false });
    await expect(root.copyFamily()).rejects.toThrow("sandbox_invalid_request");
    await root.removeMachine(reviewer);
    await root.close();
  });
  it("keeps a failed native copy's uncertain journal separate and leaves parent and sibling alive", async () => {
    const root = await fixture();
    const sibling = await root.copyFamily();
    let failedPath = "";
    mocks.branchFailure = true;
    await expect(
      root.copyFamily(
        {},
        {
          onPrepared: ({ statePath }) => {
            failedPath = statePath;
          },
        },
      ),
    ).rejects.toThrow("copy_failed");
    mocks.branchFailure = false;
    const failed = await readJournal(failedPath);
    expect(failed.machines).toMatchObject([
      { status: "uncertain", parent: root.sourceId, identity: null },
    ]);
    expect(mocks.names.get(root.sourceId)?.state).toBe("running");
    expect(mocks.names.get(sibling.sourceId)?.state).toBe("running");
    await root.execute(root.sourceId, { argv: ["/bin/true"] });
    await sibling.close();
    await root.close();
  });
  it("does not start a copy after parent close races its preparation hook", async () => {
    const root = await fixture();
    const entered = deferred<void>();
    const proceed = deferred<void>();
    let copiedPath = "";
    const pending = root.copyFamily(
      {},
      {
        onPrepared: async ({ statePath }) => {
          copiedPath = statePath;
          entered.resolve();
          await proceed.promise;
        },
      },
    );
    const rejected = expect(pending).rejects.toThrow("sandbox_closed");
    await entered.promise;
    const close = root.close();
    proceed.resolve();
    await rejected;
    await close;
    expect(mocks.calls.some((a) => a[1] === "branch")).toBe(false);
    expect(mocks.names.size).toBe(0);
    await expect(stat(copiedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cleans a newly running copy before resolving parent close and never hands it off", async () => {
    const root = await fixture();
    const entered = deferred<void>();
    const proceed = deferred<void>();
    mocks.exec = async () => {
      entered.resolve();
      await proceed.promise;
      return "ready";
    };
    const pending = root.copyFamily();
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    const close = root.close();
    proceed.resolve();
    await rejected;
    await close;
    expect(mocks.names.size).toBe(0);
  });
  it("cancels a copied family without retiring the source or sibling", async () => {
    const root = await fixture();
    const child = await root.copyFamily();
    const sibling = await root.copyFamily();
    const started = deferred<void>();
    mocks.exec = async (_r, { signal }) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new SandboxExecutionError("sandbox_aborted");
    };
    const abort = new AbortController();
    const execution = child.execute(
      child.sourceId,
      { argv: ["/bin/sleep", "10"] },
      { signal: abort.signal },
    );
    const rejected = expect(execution).rejects.toThrow("sandbox_aborted");
    await started.promise;
    abort.abort();
    await rejected;
    mocks.exec = undefined;
    expect(mocks.names.get(root.sourceId)?.state).toBe("running");
    expect(mocks.names.get(sibling.sourceId)?.state).toBe("running");
    await sibling.close();
    // Cancellation retains the child's stopped forensic record until explicit deletion.
    await deleteSmolvmOciFamily({ statePath: child.statePath });
    await root.close();
  });
  it("accounts for borrowed ancestors in the native depth limit for copies and reviewers", async () => {
    const root = await fixture();
    const tree = [root];
    try {
      for (let i = 1; i <= 32; i++) tree.push(await tree.at(-1)!.copyFamily());
      expect(tree.at(-1)!.depth).toBe(32);
      const branches = mocks.calls.filter((a) => a[1] === "branch").length;
      await expect(tree.at(-1)!.copyFamily()).rejects.toThrow("sandbox_invalid_request");
      await expect(
        tree.at(-1)!.branch(tree.at(-1)!.sourceId, { branchable: false }),
      ).rejects.toThrow("sandbox_invalid_request");
      expect(mocks.calls.filter((a) => a[1] === "branch")).toHaveLength(branches);
    } finally {
      for (const f of tree.reverse()) await f.close();
    }
  }, 20000);
  it("refuses old journal and receipt shapes without altering either", async () => {
    const root = await fixture();
    await root.retainForColdReopen();
    const journalPath = path.join(root.statePath, "recovery.json");
    const readyPath = path.join(root.statePath, "cold-ready.json");
    const journal = await readFile(journalPath, "utf8");
    const receipt = await readFile(readyPath, "utf8");
    await writeFile(journalPath, JSON.stringify({ ...JSON.parse(journal), version: 2 }));
    await expect(readSmolvmOciFamily({ statePath: root.statePath })).rejects.toThrow(
      "journal_invalid",
    );
    expect((JSON.parse(await readFile(journalPath, "utf8")) as { version: unknown }).version).toBe(
      2,
    );
    await writeFile(journalPath, journal);
    await writeFile(readyPath, JSON.stringify({ ...JSON.parse(receipt), version: 2 }));
    await expect(reopenSmolvmOciFamily({ statePath: root.statePath })).rejects.toThrow(
      "cold_state_invalid",
    );
    expect((JSON.parse(await readFile(readyPath, "utf8")) as { version: unknown }).version).toBe(2);
    await writeFile(readyPath, receipt);
    await deleteSmolvmOciFamily({ statePath: root.statePath });
  });
});

describe("stopped family network configuration", () => {
  it("switches online preparation to offline copying without a temporary online candidate", async () => {
    const root = await fixture({ networkMode: "host" });
    await root.retainForColdReopen();
    const descriptor = await configureSmolvmOciFamily({
      statePath: root.statePath,
      networkMode: "none",
    });
    expect(descriptor.version).toBe(3);
    expect(mocks.names.get(root.sourceId)).toMatchObject({ state: "stopped", network: false });
    const parent = await reopenSmolvmOciFamily({ statePath: root.statePath });
    const candidate = await parent.copyFamily();
    expect(candidate.configuration.networkMode).toBe("none");
    expect(mocks.names.get(candidate.sourceId)?.network).toBe(false);
    await candidate.close();
    await parent.close();
  });
  it("refuses a live controller and unsupported overrides without updating native settings", async () => {
    const root = await fixture();
    await expect(
      configureSmolvmOciFamily({ statePath: root.statePath, networkMode: "host" }),
    ).rejects.toThrow();
    await root.retainForColdReopen();
    await expect(
      configureSmolvmOciFamily({
        statePath: root.statePath,
        networkMode: "host",
        cpus: 2,
      } as never),
    ).rejects.toThrow("sandbox_invalid_request");
    expect(mocks.calls.some((a) => a[1] === "update")).toBe(false);
    await deleteSmolvmOciFamily({ statePath: root.statePath });
  });
  it("requires the native stopped status to confirm a successful update", async () => {
    const root = await fixture();
    await root.retainForColdReopen();
    mocks.updateNoop = true;
    await expect(
      configureSmolvmOciFamily({ statePath: root.statePath, networkMode: "host" }),
    ).rejects.toThrow("network_update_unconfirmed");
    expect((await readJournal(root.statePath)).machines[0]?.status).toBe("uncertain");
    await expect(stat(path.join(root.statePath, "cold-ready.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("withdraws the receipt and records uncertainty if native update fails", async () => {
    const root = await fixture();
    await root.retainForColdReopen();
    mocks.updateFailure = true;
    await expect(
      configureSmolvmOciFamily({ statePath: root.statePath, networkMode: "host" }),
    ).rejects.toThrow("native update failed");
    const record = await readJournal(root.statePath);
    expect(record.machines[0]?.status).toBe("uncertain");
    expect(record.options.networkMode).toBe("none");
    await expect(stat(path.join(root.statePath, "cold-ready.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(root.statePath, "cold-claimed.json"))).resolves.toBeDefined();
    await expect(reopenSmolvmOciFamily({ statePath: root.statePath })).rejects.toThrow();
    await expect(deleteSmolvmOciFamily({ statePath: root.statePath })).rejects.toThrow(
      "cleanup_uncertain",
    );
  });
});
