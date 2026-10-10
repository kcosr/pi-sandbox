import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = resolve(process.argv[2] ?? join(root, "release"));
await mkdir(out, { recursive: true });
execFileSync(process.execPath, [join(root, "scripts/build-extensions.mjs")], {
  stdio: "inherit",
});
for (const name of ["sandbox-extension", "git-extension"]) {
  const result = JSON.parse(
    execFileSync(
      "npm",
      ["pack", join(root, "packages", name), "--pack-destination", out, "--json"],
      { encoding: "utf8" },
    ),
  )[0];
  const file = join(out, result.filename);
  const entries = execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).trim().split("\n");
  for (const required of [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    "package/provenance.json",
    "package/dist/index.js",
    ...(name === "sandbox-extension"
      ? ["package/dist/runtime/worker-entry.js"]
      : ["package/dist/core.js", "package/dist/factory.js", "package/dist/config.js"]),
  ])
    assert(entries.includes(required), `Missing ${required}`);
  assert(
    entries.every(
      (entry) =>
        entry.startsWith("package/") &&
        !entry.includes("../") &&
        !entry.includes("node_modules/") &&
        !entry.endsWith(".test.js"),
    ),
    "Invalid package entry",
  );
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", file, "package/package.json"], { encoding: "utf8" }),
  );
  for (const target of Object.values(manifest.exports))
    assert(entries.includes(`package/${target.replace(/^\.\//u, "")}`), `Missing export ${target}`);
  const provenance = JSON.parse(
    execFileSync("tar", ["-xOf", file, "package/provenance.json"], { encoding: "utf8" }),
  );
  assert.equal(provenance.name, manifest.name);
  assert.equal(provenance.version, manifest.version);
  assert.equal(provenance.piVersion, manifest.peerDependencies["@earendil-works/pi-coding-agent"]);
  const digest = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  await writeFile(`${file}.sha256`, `${digest}  ${result.filename}\n`);
  console.log(`Created and inspected ${file}\nSHA-256 ${digest}`);
}
