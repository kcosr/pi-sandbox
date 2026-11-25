#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "@iarna/toml";
import { readBuildVersion } from "./build/version.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: repositoryRoot, stdio: "inherit", ...options });
async function inventory(root, prefix = "") {
  const result = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  )) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await inventory(root, path)));
    else if (entry.isFile())
      result.push({
        path,
        sha256: digest(await readFile(join(root, path))),
        size: (await lstat(join(root, path))).size,
      });
    else throw new Error(`unsupported service payload entry: ${path}`);
  }
  return result;
}
export async function buildServiceRelease(out) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("service releases require native Linux x64 or arm64");
  const stage = await mkdtemp(join(tmpdir(), "pi-sandbox-service-release-"));
  try {
    const root = join(stage, "pi-sandbox-service");
    const payload = join(root, "payload/pi-sandbox-service");
    await mkdir(payload, { recursive: true });
    run(process.execPath, [
      join(repositoryRoot, "scripts/build-service.mjs"),
      join(payload, "pi-sandbox-service"),
    ]);
    await cp(join(repositoryRoot, "packaging/service"), join(payload, "examples"), {
      recursive: true,
    });
    await copyFile(
      join(repositoryRoot, "packaging/systemd/pi-sandbox-service.service"),
      join(payload, "pi-sandbox-service.service"),
    );
    await mkdir(join(payload, "licenses"));
    await copyFile(join(repositoryRoot, "LICENSE"), join(payload, "licenses/LICENSE"));
    const lock = parseToml(await readFile(join(repositoryRoot, "service/Cargo.lock"), "utf8"));
    const target =
      process.arch === "x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu";
    const compiled = new Set(
      execFileSync(
        "cargo",
        [
          "tree",
          "--locked",
          "--offline",
          "--edges",
          "normal,build",
          "--target",
          target,
          "--prefix",
          "none",
          "--format",
          "{p}",
        ],
        { cwd: join(repositoryRoot, "service"), encoding: "utf8" },
      )
        .split("\n")
        .map((line) => line.replace(/ \(.*$/u, "")),
    );
    const components = [];
    const notices = [
      "# Pi Sandbox Service dependencies",
      "",
      "Pinned Rust build/runtime inventory, including build-only dependencies. TLS uses rustls and ring; no system OpenSSL is required.",
      "",
    ];
    for (const pkg of lock.package) {
      if (!pkg.source || !compiled.has(`${pkg.name} v${pkg.version}`)) continue;
      const vendor = join(repositoryRoot, "service/vendor", pkg.name);
      const metadata = parseToml(await readFile(join(vendor, "Cargo.toml"), "utf8"));
      const files = (await inventory(vendor)).filter((entry) =>
        /(?:^|\/)(?:LICENSE|COPYING|UNLICENSE)(?:[-.].*)?$/iu.test(entry.path),
      );
      if (!files.length)
        throw new Error(`vendored service dependency lacks license files: ${pkg.name}`);
      for (const file of files) {
        const target = join(payload, "licenses", pkg.name, file.path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(vendor, file.path), target);
      }
      notices.push(
        `- ${pkg.name} ${pkg.version}: ${metadata.package.license ?? "see bundled license"}`,
      );
      components.push({
        type: "library",
        "bom-ref": `pkg:cargo/${pkg.name}@${pkg.version}`,
        name: pkg.name,
        version: pkg.version,
        purl: `pkg:cargo/${pkg.name}@${pkg.version}`,
        hashes: [{ alg: "SHA-256", content: pkg.checksum }],
        licenses: [{ license: { name: metadata.package.license ?? "see bundled license" } }],
      });
    }
    await writeFile(join(payload, "licenses/THIRD-PARTY-NOTICES.md"), notices.join("\n") + "\n");
    const version = await readBuildVersion(repositoryRoot);
    await writeFile(
      join(payload, "sbom.cdx.json"),
      JSON.stringify(
        {
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          version: 1,
          metadata: {
            component: {
              type: "application",
              name: "pi-sandbox-service",
              version: version.productVersion,
            },
          },
          components,
        },
        null,
        2,
      ) + "\n",
    );
    const manifest = {
      manifestVersion: 1,
      product: "pi-sandbox-service",
      version: version.productVersion,
      buildVersion: version,
      platform: `linux-${process.arch}`,
      architecture: process.arch,
      files: await inventory(payload),
    };
    await writeFile(
      join(payload, "release-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    for (const script of ["install", "uninstall"]) {
      await writeFile(
        join(root, `${script}.sh`),
        (
          await readFile(join(repositoryRoot, `scripts/install/service-${script}.sh`), "utf8")
        ).replace("expected_arch=x64", `expected_arch=${process.arch}`),
      );
      await chmod(join(root, `${script}.sh`), 0o755);
    }
    await writeFile(
      join(root, "SHA256SUMS"),
      (await inventory(payload))
        .map((file) => `${file.sha256}  payload/pi-sandbox-service/${file.path}\n`)
        .join(""),
    );
    await mkdir(out, { recursive: true });
    const archive = join(
      out,
      `pi-sandbox-service-${version.productVersion}-linux-${process.arch}.tar.gz`,
    );
    run("tar", [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-czf",
      archive,
      "-C",
      stage,
      "pi-sandbox-service",
    ]);
    const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    if (
      listing.some(
        (path) => !path.startsWith("pi-sandbox-service/") || path.split("/").includes(".."),
      )
    )
      throw new Error("invalid service archive paths");
    const check = join(stage, "inspection");
    await mkdir(check);
    run("tar", ["-xzf", archive, "-C", check]);
    if (
      JSON.stringify(await inventory(root)) !==
      JSON.stringify(await inventory(join(check, "pi-sandbox-service")))
    )
      throw new Error("service archive differs from staged inventory");
    run("sha256sum", ["-c", "SHA256SUMS"], {
      cwd: join(check, "pi-sandbox-service"),
      stdio: "pipe",
    });
    const sums = join(out, "SHA256SUMS");
    const prior = await readFile(sums, "utf8").catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return "";
    });
    await writeFile(
      sums,
      prior
        .split("\n")
        .filter((line) => line && !line.endsWith(`  ${basename(archive)}`))
        .map((line) => line + "\n")
        .join("") + `${digest(await readFile(archive))}  ${basename(archive)}\n`,
    );
    process.stdout.write(`Created and inspected ${archive}\n`);
    return archive;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--out"))
    throw new Error("usage: build-service-release.mjs [--out DIRECTORY]");
  await buildServiceRelease(resolve(args[1] ?? join(repositoryRoot, "release")));
}
