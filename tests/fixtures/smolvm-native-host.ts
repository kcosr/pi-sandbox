import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  queryDarwinProcess,
  type DarwinProcessQuery,
} from "../../packages/sandbox-extension/src/runtime/smolvm/darwin-query.js";
import type { SmolvmHostTools } from "../../packages/sandbox-extension/src/runtime/smolvm/host-tools.js";

/** Explicit trusted test setup; requires a built Mac package, never runtime compilation. */
export async function nativeSmolvmHostTools(): Promise<SmolvmHostTools> {
  const tools: SmolvmHostTools = process.env.PI_SANDBOX_E2FSPROGS_DIRECTORY
    ? { e2fsprogsDirectory: process.env.PI_SANDBOX_E2FSPROGS_DIRECTORY }
    : {};
  if (process.platform !== "darwin") return tools;
  const directory = path.resolve(
    "packages/sandbox-extension/dist/runtime/smolvm/native/darwin-arm64",
  );
  const provenance = JSON.parse(
    await readFile(path.join(directory, "provenance.json"), "utf8"),
  ) as { sha256: string };
  return {
    ...tools,
    darwinProcessQuery: { path: path.join(directory, "process-query"), sha256: provenance.sha256 },
  };
}
export async function nativeHostProcessAlive(
  pid: number,
  query?: DarwinProcessQuery,
): Promise<boolean> {
  if (process.platform === "darwin") {
    query ??= (await nativeSmolvmHostTools()).darwinProcessQuery;
    if (!query) throw new Error("native_query_missing");
    return (await queryDarwinProcess(query, pid)) !== undefined;
  }
  try {
    const s = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(s.slice(s.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
