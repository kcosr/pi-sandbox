import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = join(root, "packages/sandbox-extension");
const metadata = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
const pin = JSON.parse(await readFile(join(root, "pi-source.lock.json"), "utf8"));
if (metadata.peerDependencies["@earendil-works/pi-coding-agent"] !== pin.version)
  throw new Error("Extension Pi peer must match source pin");
await rm(join(pkg, "dist"), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "-p", join(pkg, "tsconfig.build.json")],
  { stdio: "inherit" },
);
await cp(join(root, "LICENSE"), join(pkg, "LICENSE"));
const digest = createHash("sha256");
async function hashDirectory(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await hashDirectory(file);
    else if (!entry.name.endsWith(".test.ts"))
      digest
        .update(relative(pkg, file))
        .update("\0")
        .update(await readFile(file))
        .update("\0");
  }
}
await hashDirectory(join(pkg, "src"));
await writeFile(
  join(pkg, "provenance.json"),
  `${JSON.stringify({ name: metadata.name, version: metadata.version, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), piVersion: pin.version, sourceSha256: digest.digest("hex") }, null, 2)}\n`,
);
await mkdir(join(root, "release"), { recursive: true });
console.log(`Built ${metadata.name}@${metadata.version}`);
