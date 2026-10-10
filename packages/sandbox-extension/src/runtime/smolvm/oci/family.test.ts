import type * as FsPromises from "node:fs/promises";
import type * as Lifecycle from "../lifecycle.js";
import type * as Cli from "../cli.js";
import type * as Transport from "./transport.js";
import { SmolvmCli } from "../cli.js";
import {
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxExecutionOptions,
} from "../../contracts.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import type {
  SmolvmOciFamilyOptions,
  SmolvmOciTerminalExit,
  SmolvmOciTerminalLauncher,
} from "./types.js";
import { SmolvmOciTerminalCleanupError } from "./types.js";
import { attachSmolvmOciMachine } from "./transport.js";
import { createConnection } from "node:net";
import { once } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSmolvmOciFamily, reopenSmolvmOciFamily } from "./family.js";

const mocks = vi.hoisted(() => ({
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
vi.mock("../runtime-release.js", () => ({
  verifySmolvmRuntime: () => Promise.resolve("b".repeat(64)),
  SMOLVM_VERSION: "1.25.4",
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
    captureMachineIdentity: () =>
      Promise.resolve({
        pid: 123,
        start: "42",
        executable: "/trusted/smolvm-bin",
        bootConfig: "/state/boot.json",
      }),
    assertMachineAlive: async () => {
      await mocks.alive?.();
    },
    stopMachine: async (cli: SmolvmCli, name: string) => {
      mocks.events.push(`stop:${name}`);
      await mocks.stop?.();
      if (mocks.failClose) throw Error("stop not confirmed");
      await actual.checkedCommand(cli, ["machine", "stop", "--name", name]);
    },
  };
});
vi.mock("../cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Cli>();
  const families = new Map<string, Map<string, { state: string; parent: string | null }>>();
  return {
    createStateEnvironment: actual.createStateEnvironment,
    SmolvmCli: class {
      readonly active = new Set<{ controller: AbortController; done: Promise<void> }>();
      readonly names: Map<string, { state: string; parent: string | null }>;
      readonly stateDirectory: string;
      constructor(options: { stateDirectory: string }) {
        this.stateDirectory = options.stateDirectory;
        mocks.lastStatePath = options.stateDirectory;
        this.names =
          families.get(this.stateDirectory) ??
          new Map<string, { state: string; parent: string | null }>();
        families.set(this.stateDirectory, this.names);
      }
      async run(request: SandboxCommandRequest, options: SandboxExecutionOptions = {}) {
        const argv = request.argv;
        const fs = await import("node:fs/promises");
        let out = "";
        const value = (key: string) => argv[argv.indexOf(key) + 1]!;
        if (argv[1] === "create") {
          mocks.recoveryPresentAtCreate = (
            await fs.stat(this.stateDirectory + "/recovery.json")
          ).isFile();
          this.names.set(value("--name"), { state: "stopped", parent: null });
        } else if (argv[1] === "start") {
          if (mocks.startFailure) throw mocks.startFailure;
          await fs.mkdir(this.stateDirectory + "/vms", { recursive: true });
          this.names.set(value("--name"), { state: "running", parent: null });
          for (const [name, size] of [
            ["storage.raw", 2],
            ["overlay.raw", 1],
          ] as const) {
            const file = await fs.open(this.stateDirectory + "/vms/" + name, "a");
            try {
              await file.truncate(size * 1024 ** 3);
            } finally {
              await file.close();
            }
          }
        } else if (argv[1] === "data-dir") out = this.stateDirectory + "/vms";
        else if (argv[1] === "ls")
          out = JSON.stringify(
            [...this.names].map(([name, r]) => ({
              name,
              pid: r.state === "stopped" ? null : 123,
              state: r.state,
              parent_machine: r.parent,
            })),
          );
        else if (argv[1] === "branch") {
          mocks.events.push(`branch:${value("--from")}`);
          this.names.get(value("--from"))!.state = "frozen";
          this.names.set(value("--name"), { state: "running", parent: value("--from") });
        } else if (argv[1] === "stop") this.names.get(value("--name"))!.state = "stopped";
        else if (argv[1] === "delete") this.names.delete(value("--name"));
        else if (argv[1] === "exec") {
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
async function fixture(patch: Partial<SmolvmOciFamilyOptions> = {}) {
  const dir = await mkdtemp("/var/tmp/oci-policy-");
  dirs.push(dir);
  const image = path.join(dir, "image.tar");
  await writeFile(image, "fixture");
  return createSmolvmOciFamily({
    smolvmPath: await realpath("/usr/bin/true"),
    imageArchive: image,
    imageSha256: createHash("sha256").update("fixture").digest("hex"),
    stateDirectory: dir,
    cwd: "/workspace",
    networkMode: "none",
    resources: { cpus: 1, memoryMiB: 512, storageGiB: 2, overlayGiB: 1 },
    ...patch,
  });
}
const suite = process.platform === "linux" && process.arch === "x64" ? describe : describe.skip;
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
          "candidate",
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
          HOME: path.join(family.statePath, "h"),
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
      expect(mocks.events).toEqual(["branch:candidate"]);
      await leafTerminal.close();
      await removal;
      expect(mocks.events).toEqual(["branch:candidate", `stop:${child}`]);
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
    expect(mocks.events).toEqual(["stop:candidate"]);
  });
  it("closes a family while a branch waits for a terminal without starting the branch", async () => {
    const family = await fixture();
    await family.openTerminal(family.sourceId, terminalFixture().options);
    const branch = family.branch(family.sourceId, { branchable: false });
    const rejected = expect(branch).rejects.toMatchObject({ code: "sandbox_closed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await family.close();
    await rejected;
    expect(mocks.events).toEqual(["stop:candidate"]);
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
    expect(mocks.events).toEqual(["stop:candidate"]);
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
    const rejected = expect(branching).rejects.toThrow("cleanup_unconfirmed");
    await expect(handle.close()).rejects.toThrow("exec reap unconfirmed");
    await rejected;
    expect(mocks.events).toEqual(["stop:candidate"]);
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
    expect(mocks.events).toEqual(["stop:candidate"]);
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
      expect(mocks.events).toEqual(["stop:candidate"]);
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
      expect(started).toEqual(["0", "1", "2", "3"]);
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
      expect(mocks.events).toEqual(["branch:candidate"]);
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
    expect(mocks.events).toEqual(["stop:candidate"]);
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
      expect(recovery.runtimeVersion).toBe("1.25.4");
      expect(recovery.runtimeIdentity).toBe("b".repeat(64));
      expect(recovery.environment).toMatchObject({
        HOME: path.join(family.statePath, "h"),
        XDG_CACHE_HOME: path.join(family.statePath, "c"),
      });
    } finally {
      await family.close();
    }
  });
  it("rejects a read-only mount exposing custom Pi state through an alias", async () => {
    const directory = await mkdtemp("/var/tmp/oci-control-");
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
    let closing: Promise<void> | undefined;
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
      expect(await family.branch(family.sourceId, { branchable: false })).toBe("branch-16");
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
        expect.objectContaining({ message: "stop not confirmed" }),
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
