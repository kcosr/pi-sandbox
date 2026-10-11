import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("This required probe needs Darwin arm64 and the Apple compiler");
}
const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^(--vmm-pid|--runtime|--boot-config)=(.+)$/u.exec(arg);
    if (!match) throw new Error(`Invalid probe argument: ${arg}`);
    return [match[1], match[2]];
  }),
);
const source = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(mkdtempSync("/private/tmp/pi-query-"));
const query = join(root, "query");
const target = join(root, "target");
const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };
const tests = [];
const children = [];
const decode = (hex) => Buffer.from(hex, "hex");
function observe(pid) {
  return JSON.parse(
    execFileSync(query, [String(pid)], {
      env: environment,
      timeout: 3000,
      maxBuffer: 3 * 1024 * 1024,
      encoding: "utf8",
    }),
  );
}
async function createTarget(args = []) {
  const child = spawn(target, args, {
    env: { ...environment, QUERY_ENV_CANARY: "must-never-appear-in-query-output" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  children.push({ child, exited });
  const [ready] = await once(child.stdout, "data", {
    signal: globalThis.AbortSignal.timeout(5000),
  });
  assert.equal(ready.toString(), "READY\n");
  return { child, exited };
}
try {
  for (const [input, output] of [
    ["darwin-process-query.c", query],
    ["darwin-query-target.c", target],
  ]) {
    execFileSync(
      "/usr/bin/clang",
      ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", join(source, input), "-o", output],
      { env: environment, timeout: 30000 },
    );
  }
  const args = ["one two", "", 'quote"\\slash', "line\nfeed", "unicode-π"];
  const first = await createTarget(args);
  const initial = observe(first.child.pid);
  assert.equal(initial.state, "present");
  assert.equal(initial.version, 1);
  assert.equal(initial.pid, first.child.pid);
  assert.equal(initial.processGroup, first.child.pid);
  assert.equal(initial.uid, process.geteuid());
  assert.deepEqual(
    initial.argvHex.map(decode),
    [target, ...args].map((s) => Buffer.from(s)),
  );
  assert.equal(decode(initial.executableHex).toString(), target);
  assert.match(initial.startSeconds, /^[1-9][0-9]*$/u);
  assert.match(initial.startMicroseconds, /^(?:0|[1-9][0-9]{0,5})$/u);
  assert(!JSON.stringify(initial).includes(Buffer.from("QUERY_ENV_CANARY").toString("hex")));
  tests.push(
    "deny-attach target: exact generation, executable and byte-preserving argv; no environment",
  );
  for (let i = 0; i < 10; i++) assert.deepEqual(observe(first.child.pid), initial);
  tests.push("repeated same-generation reads stable");
  first.child.kill("SIGSTOP");
  assert.deepEqual(observe(first.child.pid), initial);
  first.child.kill("SIGCONT");
  tests.push("stopped process remains the same live generation");
  const second = await createTarget();
  const later = observe(second.child.pid);
  assert.notEqual(
    `${initial.startSeconds}:${initial.startMicroseconds}`,
    `${later.startSeconds}:${later.startMicroseconds}`,
  );
  tests.push(
    initial.startSeconds === later.startSeconds
      ? "distinct subsecond generations inside one second"
      : "distinct exact generations across a second boundary",
  );
  first.child.kill("SIGTERM");
  await first.exited;
  assert.deepEqual(observe(first.child.pid), { version: 1, state: "absent" });
  assert.deepEqual(observe(2000000000), { version: 1, state: "absent" });
  tests.push("dead and nonexistent PIDs report absent");
  for (const invalid of ["0", "-1", "01", "1.5", "999999999999999999", "1 extra"]) {
    assert.throws(() => execFileSync(query, [invalid], { env: environment, timeout: 3000 }));
  }
  tests.push("strict bounded PID input");
  if (Object.keys(options).length) {
    assert.equal(Object.keys(options).length, 3);
    const runtime = realpathSync(options["--runtime"]);
    const observed = observe(options["--vmm-pid"]);
    assert.equal(observed.state, "present");
    assert.equal(decode(observed.executableHex).toString(), runtime);
    assert.deepEqual(
      observed.argvHex.map(decode),
      [runtime, "_boot-vm", options["--boot-config"]].map((s) => Buffer.from(s)),
    );
    assert.deepEqual(observe(options["--vmm-pid"]), observed);
    tests.push("actual stock smolvm VMM generation, executable and full boot argv");
  }
  console.log(
    JSON.stringify(
      {
        runtime: process.versions.bun
          ? `Bun ${process.versions.bun}`
          : `Node ${process.versions.node}`,
        tests,
      },
      null,
      2,
    ),
  );
} finally {
  for (const { child, exited } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGCONT");
      child.kill("SIGTERM");
    }
    await exited;
  }
  rmSync(root, { recursive: true });
}
