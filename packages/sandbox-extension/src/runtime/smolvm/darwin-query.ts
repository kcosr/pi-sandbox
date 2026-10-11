import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hostQuery } from "./host-query.js";

/** Trusted build metadata, never workload input. */
export interface DarwinProcessQuery {
  readonly path: string;
  readonly sha256: string;
}
export interface DarwinProcessSnapshot {
  readonly start: string;
  readonly executable: string;
  readonly argv: readonly string[];
}
const invalid = () => new Error("smolvm_darwin_process_query_invalid");
function hex(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{2})*$/u.test(value)) throw invalid();
  const bytes = Buffer.from(value, "hex");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes) || text.includes("\0")) throw invalid();
  return text;
}
export function parseDarwinProcessSnapshot(
  raw: Buffer,
  pid: number,
): DarwinProcessSnapshot | undefined {
  if (raw.length > 3 * 1048576) throw invalid();
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (v.version !== 1) throw invalid();
  if (v.state === "absent") {
    if (Object.keys(v).sort().join(",") !== "state,version") throw invalid();
    return undefined;
  }
  if (
    Object.keys(v).sort().join(",") !==
      "argvHex,executableHex,pid,processGroup,startMicroseconds,startSeconds,state,uid,version" ||
    v.state !== "present" ||
    v.pid !== pid ||
    v.uid !== process.geteuid?.() ||
    !Number.isSafeInteger(v.processGroup) ||
    (v.processGroup as number) <= 0 ||
    typeof v.startSeconds !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(v.startSeconds) ||
    typeof v.startMicroseconds !== "string" ||
    !/^(?:0|[1-9][0-9]{0,5})$/u.test(v.startMicroseconds) ||
    !Array.isArray(v.argvHex) ||
    !v.argvHex.length ||
    v.argvHex.length > 4096
  )
    throw invalid();
  return {
    start: `darwin:${v.startSeconds}:${v.startMicroseconds}`,
    executable: hex(v.executableHex),
    argv: v.argvHex.map(hex),
  };
}
export async function queryDarwinProcess(
  query: DarwinProcessQuery,
  pid: number,
): Promise<DarwinProcessSnapshot | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) throw invalid();
  // Nonzero exit, partial reads and permission failures never mean absence.
  return parseDarwinProcessSnapshot(await hostQuery([query.path, String(pid)]), pid);
}

/** Only the ordinary packaged extension calls this. Low-level embedders inject metadata. */
export async function packagedDarwinProcessQuery(): Promise<DarwinProcessQuery> {
  const base = new URL("./native/darwin-arm64/", import.meta.url);
  const metadata: unknown = JSON.parse(await readFile(new URL("provenance.json", base), "utf8"));
  if (!metadata || typeof metadata !== "object") throw invalid();
  const m = metadata as Record<string, unknown>;
  if (
    Object.keys(m).sort().join(",") !==
      "architecture,binary,platform,protocolVersion,sha256,sourceSha256" ||
    m.binary !== "process-query" ||
    m.platform !== "darwin" ||
    m.architecture !== "arm64" ||
    m.protocolVersion !== 1 ||
    typeof m.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(m.sha256) ||
    typeof m.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(m.sourceSha256)
  )
    throw invalid();
  return { path: fileURLToPath(new URL("process-query", base)), sha256: m.sha256 };
}
