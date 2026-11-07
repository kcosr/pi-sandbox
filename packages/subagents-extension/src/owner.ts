import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Kernel boot and process start identity, independent of a reused numeric PID. */
export interface ProcessIdentity {
  readonly platform: NodeJS.Platform;
  readonly boot: string;
  readonly start: string;
}

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
      const bootTime = command("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
      const match = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/u.exec(bootTime);
      const boot = match ? `${match[1]}:${match[2]}` : undefined;
      const start = command("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
      const state = command("/bin/ps", ["-p", String(pid), "-o", "stat="]);
      if (state.startsWith("Z")) return { state: "dead" };
      if (boot && start)
        return { state: "live", identity: { platform: process.platform, boot, start } };
    }
    if (process.platform === "win32" && process.env.SystemRoot) {
      const powershell = join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const text = command(powershell, [
        "-NoLogo",
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid}; $o=Get-CimInstance Win32_OperatingSystem; @{boot=$o.LastBootUpTime.ToUniversalTime().Ticks.ToString();start=$p.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Compress`,
      ]);
      const data = JSON.parse(text) as { boot?: unknown; start?: unknown };
      if (typeof data.boot === "string" && typeof data.start === "string")
        return {
          state: "live",
          identity: { platform: process.platform, boot: data.boot, start: data.start },
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

export function processIdentity(pid: number): ProcessIdentity {
  const probe = probeProcess(pid);
  if (probe.state !== "live") throw new Error("Cannot establish subagent owner process identity");
  return probe.identity;
}

export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).length === 3 &&
    typeof input.platform === "string" &&
    ["linux", "darwin", "win32"].includes(input.platform) &&
    typeof input.boot === "string" &&
    input.boot.length > 0 &&
    input.boot.length <= 256 &&
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
    probe.identity.boot !== identity.boot ||
    probe.identity.start !== identity.start
  );
}
