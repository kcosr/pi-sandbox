import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadDistribution } from "./build/distribution.mjs";
import { copyToolBundle, validateNativeToolBundle } from "./build/tool-bundle.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--distribution" || !args[1]))
  throw new Error("usage: node scripts/build-extensions.mjs [--distribution FILE]");
const distribution = args.length ? await loadDistribution(resolve(args[1])) : undefined;
validateNativeToolBundle(distribution?.toolBundle);
for (const name of ["sandbox-extension", "git-extension"]) {
  const pkg = join(root, "packages", name);
  const metadata = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
  const pin = JSON.parse(await readFile(join(root, "pi-source.lock.json"), "utf8"));
  if (metadata.peerDependencies["@earendil-works/pi-coding-agent"] !== pin.version)
    throw new Error("Extension Pi peer must match source pin");
  await rm(join(pkg, "dist"), { recursive: true, force: true });
  const sourceFiles = new Set(await sources(join(pkg, "src")));
  if (name === "git-extension") {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [...sourceFiles],
      outbase: join(pkg, "src"),
      outdir: join(pkg, "dist"),
      bundle: true,
      splitting: true,
      chunkNames: "_chunks/[name]-[hash]",
      platform: "node",
      format: "esm",
      target: "node24",
      packages: "external",
      metafile: true,
    });
    for (const input of Object.keys(result.metafile.inputs)) sourceFiles.add(resolve(root, input));
    const staging = await mkdtemp(join(tmpdir(), "pi-git-types-"));
    try {
      execFileSync(
        process.execPath,
        [
          join(root, "node_modules/typescript/bin/tsc"),
          "-p",
          join(pkg, "tsconfig.build.json"),
          "--rootDir",
          root,
          "--outDir",
          staging,
          "--emitDeclarationOnly",
          "--declarationMap",
          "false",
        ],
        { stdio: "inherit" },
      );
      await cp(join(staging, "packages/git-extension/src"), join(pkg, "dist"), { recursive: true });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } else {
    execFileSync(
      process.execPath,
      [join(root, "node_modules/typescript/bin/tsc"), "-p", join(pkg, "tsconfig.build.json")],
      { stdio: "inherit" },
    );
    if (distribution?.toolBundle) {
      const bundle = distribution.toolBundle;
      await copyToolBundle(bundle, join(pkg, "dist/native-tools"));
      await writeFile(
        join(pkg, "dist/build-tools.js"),
        `import { realpathSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\nimport { join } from "node:path";\nconst root = realpathSync(fileURLToPath(new URL("./native-tools", import.meta.url)));\nexport const builtToolBundle = Object.freeze({root, commands:Object.freeze(Object.fromEntries(${JSON.stringify(Object.keys(bundle.layout.toolBundle.commands))}.map(name => [name, join(root,"bin",name)])))});\n`,
      );
    }
  }
  await cp(join(root, "LICENSE"), join(pkg, "LICENSE"));
  const digest = createHash("sha256");
  sourceFiles.add(join(pkg, "package.json"));
  sourceFiles.add(join(pkg, "tsconfig.build.json"));
  sourceFiles.add(fileURLToPath(import.meta.url));
  sourceFiles.add(join(root, "scripts/build/distribution.mjs"));
  sourceFiles.add(join(root, "scripts/build/tool-bundle.mjs"));
  const inputs = [...sourceFiles].sort();
  for (const file of inputs)
    digest
      .update(relative(root, file))
      .update("\0")
      .update(await readFile(file))
      .update("\0");
  await writeFile(
    join(pkg, "provenance.json"),
    `${JSON.stringify({ name: metadata.name, version: metadata.version, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), piVersion: pin.version, sourceSha256: digest.digest("hex"), sourceInputs: inputs.map((file) => relative(root, file)), ...(name === "sandbox-extension" && distribution?.toolBundle ? { toolBundle: distribution.toolBundle.release } : {}) }, null, 2)}\n`,
  );
  await mkdir(join(root, "release"), { recursive: true });
  console.log(`Built ${metadata.name}@${metadata.version}`);
}

async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sources(file)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(file);
  }
  return files;
}
