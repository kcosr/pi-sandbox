import { execFileSync } from "node:child_process";

import { isNormalizedAbsoluteFilePath } from "../domain/index.js";

const MAXIMUM_LOOKUP_BYTES = 65_536;
const ACCOUNT_HOME_ERROR =
  "Unable to resolve the invoking account's home directory from the operating system";

function invalid(): never {
  throw new Error(ACCOUNT_HOME_ERROR);
}

function accountId(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) invalid();
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id > 0xffff_ffff) invalid();
  return id;
}

function validAccountName(value: string | undefined): boolean {
  return (
    value !== undefined &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !/^\d+$/.test(value) &&
    !/[\s:\p{Cc}]/u.test(value)
  );
}

function passwdHome(output: string, uid: number): string {
  const lines = output.replace(/\n$/, "").split("\n");
  if (lines.length !== 1) invalid();
  const fields = lines[0]!.split(":");
  if (fields.length !== 7 || !validAccountName(fields[0]) || accountId(fields[2]) !== uid) {
    invalid();
  }
  accountId(fields[3]);
  return fields[5]!;
}

function directoryServiceHome(output: string, uid: number): string {
  const fields = new Map<string, string>();
  const allowed = new Set(["name", "password", "uid", "gid", "dir", "shell", "gecos"]);
  for (const line of output.replace(/\n+$/, "").split("\n")) {
    const match = /^([a-z]+): (.*)$/.exec(line);
    if (match === null || !allowed.has(match[1]!) || fields.has(match[1]!)) invalid();
    fields.set(match[1]!, match[2]!);
  }
  if (!validAccountName(fields.get("name")) || accountId(fields.get("uid")) !== uid) invalid();
  accountId(fields.get("gid"));
  return fields.get("dir") ?? invalid();
}

/** Query the OS account database; Bun's userInfo().homedir can depend on startup HOME. */
export function readAccountHomeDirectory(): string {
  try {
    const uid = process.geteuid?.();
    if (uid === undefined || !Number.isInteger(uid) || uid < 0 || uid > 0xffff_ffff) invalid();
    const platform = process.platform;
    if (platform !== "linux" && platform !== "darwin") invalid();
    const executable = platform === "linux" ? "/usr/bin/getent" : "/usr/bin/dscacheutil";
    const args =
      platform === "linux"
        ? ["--", "passwd", String(uid)]
        : ["-q", "user", "-a", "uid", String(uid)];
    const result = execFileSync(executable, args, {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: MAXIMUM_LOOKUP_BYTES,
    });
    if (result.length > MAXIMUM_LOOKUP_BYTES) invalid();
    const output = new TextDecoder("utf-8", { fatal: true }).decode(result);
    if ([...output].some((character) => character !== "\n" && /\p{Cc}/u.test(character))) {
      invalid();
    }
    const home = platform === "linux" ? passwdHome(output, uid) : directoryServiceHome(output, uid);
    if (home !== "/" && !isNormalizedAbsoluteFilePath(home)) invalid();
    return home;
  } catch {
    // Never expose command output (which includes account metadata) through errors or causes.
    throw new Error(ACCOUNT_HOME_ERROR);
  }
}
