import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Linux boot-relative ticks or an absolute process start, independent of a reused PID. */
export type ProcessIdentity =
  | Readonly<{ platform: "linux"; boot: string; start: string }>
  | Readonly<{ platform: "darwin" | "win32"; start: string }>;

type ProcessProbe =
  | { readonly state: "live"; readonly identity: ProcessIdentity }
  | { readonly state: "dead" }
  | { readonly state: "unknown" };

function command(program: string, args: readonly string[]): string {
  return execFileSync(program, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    maxBuffer: 4096,
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      LC_ALL: "C",
      LANG: "C",
      TZ: "UTC",
    },
  }).trim();
}

/** Unknown/permission-denied probes never authorize displacing an owner. */
export function probeProcess(pid: number): ProcessProbe {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { state: "dead" };
    // EPERM can still allow reading a process identity; by itself it proves nothing.
  }
  try {
    if (process.platform === "linux") {
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return { state: "dead" };
      const start = fields[19];
      if (!/^[a-f0-9-]{36}$/u.test(boot) || !start || !/^\d+$/u.test(start))
        return { state: "unknown" };
      return { state: "live", identity: { platform: process.platform, boot, start } };
    }
    if (process.platform === "darwin") {
      const start = command("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
      const state = command("/bin/ps", ["-p", String(pid), "-o", "stat="]);
      if (state.startsWith("Z")) return { state: "dead" };
      if (start) return { state: "live", identity: { platform: process.platform, start } };
    }
    if (process.platform === "win32" && process.env.SystemRoot) {
      const powershell = join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const start = command(powershell, [
        "-NoLogo",
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid}; $p.StartTime.ToUniversalTime().Ticks.ToString()`,
      ]);
      if (/^\d+$/u.test(start))
        return {
          state: "live",
          identity: { platform: process.platform, start },
        };
    }
  } catch {
    // The process may have disappeared during the identity read. Recheck only death.
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { state: "dead" };
    }
  }
  return { state: "unknown" };
}

let currentProcessIdentity: ProcessIdentity | undefined;

export function processIdentity(pid: number): ProcessIdentity {
  if (pid === process.pid && currentProcessIdentity) return currentProcessIdentity;
  const probe = probeProcess(pid);
  if (probe.state !== "live") throw new Error("Cannot establish subagent owner process identity");
  const identity = Object.freeze(probe.identity);
  if (pid === process.pid) currentProcessIdentity = identity;
  return identity;
}

export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    (input.platform === "linux"
      ? Object.keys(input).length === 3 &&
        typeof input.boot === "string" &&
        input.boot.length > 0 &&
        input.boot.length <= 256
      : Object.keys(input).length === 2 &&
        (input.platform === "darwin" || input.platform === "win32")) &&
    typeof input.start === "string" &&
    input.start.length > 0 &&
    input.start.length <= 256
  );
}

export function previousOwnerIsDead(pid: number, identity: ProcessIdentity): boolean {
  const probe = probeProcess(pid);
  if (probe.state === "dead") return true;
  if (probe.state === "unknown") return false;
  return (
    probe.identity.platform !== identity.platform ||
    // Linux starts are boot-relative ticks. Other platforms report absolute
    // process start times; their boot timestamps can change after a clock step.
    (identity.platform === "linux" &&
      probe.identity.platform === "linux" &&
      probe.identity.boot !== identity.boot) ||
    probe.identity.start !== identity.start
  );
}
