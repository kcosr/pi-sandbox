import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const processQuerySource = join(
  root,
  "packages/sandbox-extension/native/darwin-process-query.c",
);
/** Build-time only. Ordinary Node Pi never invokes a compiler or Python. */
export async function buildSmolvmProcessQuery(directory) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Process query build requires Darwin arm64 and the Apple SDK");
  await mkdir(directory, { recursive: true });
  const binary = join(directory, "process-query");
  execFileSync(
    "/usr/bin/clang",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-arch",
      "arm64",
      "-mmacosx-version-min=26.0",
      processQuerySource,
      "-o",
      binary,
    ],
    {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      timeout: 30000,
      stdio: "inherit",
    },
  );
  await chmod(binary, 0o755);
  const hash = async (file) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  const provenance = {
    platform: "darwin",
    architecture: "arm64",
    protocolVersion: 1,
    binary: "process-query",
    sha256: await hash(binary),
    sourceSha256: await hash(processQuerySource),
  };
  await copyFile(processQuerySource, join(directory, "process-query.c"));
  await writeFile(join(directory, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  return provenance;
}
