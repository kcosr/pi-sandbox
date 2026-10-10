import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import type { SmolvmOciFamilyOptions, SmolvmOciRetainedFamily } from "./types.js";

export interface ColdRecord extends SmolvmOciRetainedFamily {
  readonly options: SmolvmOciFamilyOptions;
  readonly runtimeIdentity: string;
  readonly mountIdentities: readonly { dev: number; ino: number }[];
}
const READY = "cold-ready.json";
const CLAIMED = "cold-claimed.json";
const fail = () => new Error("smolvm_oci_cold_state_invalid");
export async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes as Buffer);
  return hash.digest("hex");
}

export async function mountIdentities(options: SmolvmOciFamilyOptions) {
  return Promise.all(
    (options.mounts ?? []).map(async (m) => {
      const st = await lstat(m.hostPath);
      if (!st.isDirectory()) throw fail();
      return { dev: st.dev, ino: st.ino };
    }),
  );
}
export async function readColdRecord(statePath: string): Promise<ColdRecord> {
  const handle = await open(
    path.join(statePath, READY),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = await handle.stat();
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid?.() ||
      st.mode & 0o077 ||
      st.size > 65536
    )
      throw fail();
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 65536) throw fail();
    const parsed: unknown = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail();
    const value = parsed as Record<string, unknown>;
    if (
      !value ||
      Object.keys(value).sort().join(",") !==
        "cwd,imageSha256,mode,mountIdentities,options,runtimeIdentity,statePath,version" ||
      value.version !== 1 ||
      value.mode !== "cold" ||
      value.statePath !== statePath ||
      typeof value.runtimeIdentity !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.runtimeIdentity) ||
      !Array.isArray(value.mountIdentities) ||
      value.mountIdentities.some(
        (m: unknown) =>
          !m ||
          typeof m !== "object" ||
          Object.keys(m).sort().join(",") !== "dev,ino" ||
          !Number.isSafeInteger((m as { dev: number }).dev) ||
          !Number.isSafeInteger((m as { ino: number }).ino),
      )
    )
      throw fail();
    return value as unknown as ColdRecord;
  } finally {
    await handle.close();
  }
}
export async function claimColdRecord(statePath: string): Promise<void> {
  // A hard link is atomic and refuses replacement. Two concurrent openers cannot
  // both claim the same record. Crash/failure after claim leaves forensic state.
  await link(path.join(statePath, READY), path.join(statePath, CLAIMED));
  await unlink(path.join(statePath, READY));
}
export async function publishColdRecord(record: ColdRecord): Promise<void> {
  const data = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(data) > 65536) throw fail();
  // This method runs only after acknowledged teardown; an old claim can now be
  // retired before publishing the next cold-open generation.
  await unlink(path.join(record.statePath, CLAIMED)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const temporary = path.join(record.statePath, "cold-ready.partial");
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let published = false;
  try {
    await link(temporary, path.join(record.statePath, READY));
    published = true;
    await unlink(temporary);
    const directory = await open(record.statePath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (published) await unlink(path.join(record.statePath, READY));
    throw error;
  }
}
