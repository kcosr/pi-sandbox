// Bun-only trusted PTY fixture. The public controller remains runtime-neutral.
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  createSmolvmOciFamily,
  reopenSmolvmOciFamily,
} from "../../packages/sandbox-extension/src/runtime/smolvm/oci/family.js";
import type {
  SmolvmOciFamily,
  SmolvmOciTerminal,
  SmolvmOciTerminalLauncher,
} from "../../packages/sandbox-extension/src/runtime/smolvm/oci/types.js";

declare const Bun: {
  Terminal: new (options: {
    cols: number;
    rows: number;
    data(terminal: unknown, bytes: Uint8Array): void;
  }) => { write(bytes: Uint8Array): void; resize(cols: number, rows: number): void; close(): void };
  spawn(
    argv: readonly string[],
    options: { cwd: string; env: Readonly<Record<string, string>>; terminal: unknown },
  ): {
    pid: number;
    exited: Promise<number>;
    signalCode: string | null;
    kill(signal: string): void;
  };
};

const state = await mkdtemp("/var/tmp/oci-term-");
let family: SmolvmOciFamily | undefined;
const checks: string[] = [];
let safeToRemove = false;
async function until(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > end) throw Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function fixture() {
  let output = "";
  let pid = 0;
  const launch: SmolvmOciTerminalLauncher = async (request) => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const terminal = new Bun.Terminal({
      cols: request.columns,
      rows: request.rows,
      data(_terminal, bytes) {
        output += Buffer.from(bytes).toString();
        if (output.length > 4 * 1024 * 1024) throw Error("fixture output overflow");
        if (output.includes(request.readyMarker)) {
          output = output.replace(request.readyMarker, "");
          resolveReady();
        }
      },
    });
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(request.argv, { cwd: request.cwd, env: request.environment, terminal });
    } catch (error) {
      terminal.close();
      throw error;
    }
    pid = child.pid;
    let closePromise: Promise<void> | undefined;
    const completion = child.exited
      .then((exitCode) => ({ exitCode, signal: child.signalCode }))
      .finally(() => {
        terminal.close();
        request.signal.removeEventListener("abort", abort);
      });
    const close = () =>
      (closePromise ??= (async () => {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        try {
          await completion;
        } finally {
          clearTimeout(timer);
        }
      })());
    const abort = () => {
      void close();
    };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) void close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        completion.then(() => {
          throw Error("exec exited before ready");
        }),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error("guest ready timeout")), 15000);
        }),
      ]);
    } catch (error) {
      await close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return {
      completion,
      write: (bytes) => {
        terminal.write(bytes);
        return Promise.resolve();
      },
      resize: (columns, rows) => {
        terminal.resize(columns, rows);
        child.kill("SIGWINCH");
      },
      close,
    };
  };
  return {
    launch,
    options: { launch, terminalType: "xterm-256color", columns: 91, rows: 27 },
    output: () => output,
    pid: () => pid,
    clear: () => {
      output = "";
    },
  };
}
const encode = (text: string) => new TextEncoder().encode(text);
async function ready(terminal: SmolvmOciTerminal, f: ReturnType<typeof fixture>) {
  await terminal.write(encode("stty -echo; printf '\\n__READY_%s__\\n' terminal\n"));
  await until(() => f.output().includes("__READY_terminal__"), "guest terminal ready").catch(
    (error) => {
      console.error("PTY output:", JSON.stringify(f.output()));
      throw error;
    },
  );
  f.clear();
}
async function command(
  terminal: SmolvmOciTerminal,
  f: ReturnType<typeof fixture>,
  command: string,
  marker: string,
) {
  await terminal.write(encode(`${command}; printf '\\n__DONE_%s__\\n' ${marker}\n`));
  await until(() => f.output().includes(`__DONE_${marker}__`), marker);
}
async function pids(directory: string): Promise<number[]> {
  const result: number[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await pids(file)));
    else if (entry.name === "agent.pid")
      result.push(Number((await readFile(file, "utf8")).split("\n")[0]));
  }
  return result;
}
try {
  family = await createSmolvmOciFamily({
    smolvmPath: process.env.PI_SANDBOX_SMOLVM_BIN!,
    imageArchive: process.env.PI_SANDBOX_SMOLVM_OCI_IMAGE!,
    imageSha256: process.env.PI_SANDBOX_SMOLVM_OCI_SHA256!,
    stateDirectory: state,
    cwd: "/workspace",
    networkMode: "none",
    resources: { cpus: 1, memoryMiB: 512, storageGiB: 2, overlayGiB: 1 },
  });
  const first = fixture();
  const second = fixture();
  const one = await family.openTerminal(family.sourceId, first.options);
  const two = await family.openTerminal(family.sourceId, second.options);
  await ready(one, first);
  await ready(two, second);
  await command(one, first, "stty size; printf '%s\\n' \"$TERM\"; pwd", "size");
  assert.match(first.output(), /27 91/);
  assert.match(first.output(), /xterm-256color/);
  assert.match(first.output(), /\/workspace/);
  one.resize(113, 35);
  first.clear();
  await command(
    one,
    first,
    'for i in $(seq 1 100); do size=$(stty size); if [ "$size" = "35 113" ]; then echo "$size"; break; fi; sleep .02; done',
    "resize",
  );
  assert.match(first.output(), /35 113/);
  checks.push("real guest PTY, initial dimensions, TERM, cwd, resize");
  first.clear();
  await command(one, first, "printf terminal-edits > /workspace/retained.txt", "write");
  assert.equal(
    (
      await family.execute(family.sourceId, { argv: ["/bin/cat", "/workspace/retained.txt"] })
    ).stdout.toString(),
    "terminal-edits",
  );
  const tools = await Promise.all(
    Array.from({ length: 4 }, () =>
      family!.execute(family!.sourceId, { argv: ["/bin/echo", "parallel"] }),
    ),
  );
  assert(tools.every((result) => result.stdout.toString() === "parallel\n"));
  checks.push("two shells coexist with four ordinary tool calls and shared files");
  first.clear();
  await one.write(encode("printf '__INT_%s__\\n' start; sleep 60\n"));
  await until(() => first.output().includes("__INT_start__"), "interrupt start");
  await one.write(new Uint8Array([3]));
  await command(one, first, "printf ctrl-c-returned", "interrupt");
  checks.push("Ctrl-C interrupts foreground guest command without ending shell");
  first.clear();
  await command(one, first, "head -c 1100000 /dev/zero | tr '\\0' x", "large");
  assert(first.output().length > 1100000);
  checks.push("continuous terminal output exceeds one MiB");
  await one.close();
  await command(two, second, "printf second-survived", "peer");
  assert.equal(
    (await family.execute(family.sourceId, { argv: ["/bin/echo", "alive"] })).stdout.toString(),
    "alive\n",
  );
  checks.push("closing one exec client preserves peer terminal and VM");
  await two.write(encode("exit 7\n"));
  assert.equal((await two.completion).exitCode, 7);
  checks.push("normal shell exit forwards exit status");
  const child = await family.branch(family.sourceId, { branchable: false });
  const childFixture = fixture();
  const childTerminal = await family.openTerminal(child, childFixture.options);
  await ready(childTerminal, childFixture);
  await command(childTerminal, childFixture, "printf reviewer > /workspace/retained.txt", "child");
  await childTerminal.close();
  await family.removeMachine(child);
  const retained = await family.retainForColdReopen();
  for (let i = 0; i < 2; i++) {
    family = await reopenSmolvmOciFamily({ statePath: retained.statePath });
    assert.equal(
      (
        await family.execute(family.sourceId, { argv: ["/bin/cat", "/workspace/retained.txt"] })
      ).stdout.toString(),
      i === 0 ? "terminal-edits" : "reopened-edits",
    );
    const edit = fixture();
    const terminal = await family.openTerminal(family.sourceId, edit.options);
    await ready(terminal, edit);
    await command(terminal, edit, "printf reopened-edits > /workspace/retained.txt", `reopen${i}`);
    await terminal.close();
    await family.retainForColdReopen();
  }
  checks.push(
    "exact reviewer branch isolated; original edits survive repeated writable cold retention",
  );
  family = await reopenSmolvmOciFamily({ statePath: retained.statePath });
  const final = fixture();
  const terminal = await family.openTerminal(family.sourceId, final.options);
  await ready(terminal, final);
  const vmPids = await pids(family.statePath);
  await family.close();
  await terminal.completion;
  for (const pid of [final.pid(), ...vmPids]) {
    let exists = true;
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      exists = !/[)] [ZX] /.test(stat);
    } catch {
      exists = false;
    }
    assert(!exists, `fixture pid ${pid} survived close`);
  }
  safeToRemove = true;
  checks.push("family close stops terminal clients and VM");
  console.log(JSON.stringify({ checks }));
} finally {
  try {
    await family?.close();
    if (safeToRemove) await rm(state, { recursive: true, force: true });
  } catch (error) {
    console.error("Fixture cleanup unconfirmed; state retained", state, error);
  }
}
