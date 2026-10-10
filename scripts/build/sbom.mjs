import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "@iarna/toml";

const property = (name, value) => ({ name: `pi-sandbox:${name}`, value: String(value) });
const digest = (value) => createHash("sha256").update(value).digest("hex");

// Resolve actual bundle inputs rather than treating every installed development
// dependency as shipped code. Scoped/nested packages use their nearest manifest.
export async function bundledPackages(metafile, cwd) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (input.includes(":") && !input.startsWith("/")) continue;
    let directory = dirname(resolve(cwd, input));
    for (;;) {
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (manifest?.name && manifest.version) {
        packages.set(`${manifest.name}@${manifest.version}`, manifest);
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...packages.values()];
}

export async function createSbom({
  repositoryRoot,
  sourceRoot,
  codingAgentRoot,
  bunMetafile,
  packageJson,
  lock,
  patches,
  extensions,
  platform,
  bunVersion,
  sourceCommit,
  sourceDirty,
  bubblewrap,
  smolvm,
  payload,
}) {
  const components = new Map();
  const add = (component) => components.set(component["bom-ref"], component);
  const npmPackages = [
    ...(await bundledPackages(JSON.parse(await readFile(bunMetafile, "utf8")), codingAgentRoot)),
    ...(await bundledPackages(
      JSON.parse(await readFile(join(repositoryRoot, "dist/private/bundle-metafile.json"), "utf8")),
      repositoryRoot,
    )),
  ];
  for (const pkg of npmPackages) {
    const purl = `pkg:npm/${pkg.name.replace("@", "%40")}@${pkg.version}`;
    add({
      type: "library",
      "bom-ref": purl,
      name: pkg.name,
      version: pkg.version,
      purl,
      scope: "required",
      properties: [property("evidence", "bundle-input")],
      ...(typeof pkg.license === "string"
        ? { licenses: [{ license: { name: pkg.license } }] }
        : {}),
    });
  }
  add({
    type: "framework",
    "bom-ref": "runtime:bun",
    name: "bun",
    version: bunVersion,
    properties: [property("role", "compiled-runtime")],
  });
  add({
    type: "application",
    "bom-ref": "source:pi",
    name: "pi",
    version: lock.version,
    hashes: [{ alg: "SHA-256", content: lock.sourceArchiveSha256 }],
    externalReferences: [{ type: "distribution", url: lock.sourceArchive }],
    properties: [property("commit", lock.commit), property("patches", JSON.stringify(patches))],
  });
  for (const extension of extensions) {
    add({
      type: "library",
      "bom-ref": `extension:${extension.id}`,
      name: extension.id,
      version: extension.version,
      hashes: [{ alg: "SHA-256", content: extension.entrypointSha256 }],
      properties: [
        property("role", "selected-compiled-extension"),
        property("manifest-sha256", extension.manifestSha256),
      ],
    });
  }
  if (platform.startsWith("linux")) {
    for (const crate of ["broker", "audit-collector"]) {
      const cargoLock = parseToml(
        await readFile(join(repositoryRoot, crate, "Cargo.lock"), "utf8"),
      );
      const binary = crate === "broker" ? "identity-broker" : crate;
      add({
        type: "application",
        "bom-ref": `binary:${binary}`,
        name: `pi-sandbox-${binary}`,
        version: packageJson.version,
        hashes: [
          {
            alg: "SHA-256",
            content: digest(await readFile(join(payload, `pi-sandbox-${binary}`))),
          },
        ],
        properties: [property("cargo-inventory", crate)],
      });
      for (const pkg of cargoLock.package) {
        const ref = `cargo:${crate}:${pkg.name}@${pkg.version}`;
        add({
          type: "library",
          "bom-ref": ref,
          name: pkg.name,
          version: pkg.version,
          ...(pkg.source?.startsWith("registry+")
            ? { purl: `pkg:cargo/${pkg.name}@${pkg.version}` }
            : {}),
          ...(pkg.checksum ? { hashes: [{ alg: "SHA-256", content: pkg.checksum }] } : {}),
          properties: [
            property("artifact", `binary:${binary}`),
            property("evidence", "Cargo.lock"),
            property(
              "scope-note",
              "Build and runtime dependency inventory; includes procedural macros and build-only crates.",
            ),
          ],
        });
      }
    }
  }
  if (bubblewrap?.mode === "bundled")
    add({
      type: "application",
      "bom-ref": "binary:bubblewrap",
      name: "bubblewrap",
      version: bubblewrap.version,
      hashes: [{ alg: "SHA-256", content: bubblewrap.sha256 }],
    });
  // Copied executable assets are outside the bundler graph. Inventory their
  // actual bytes and embedded package metadata without inventing versions.
  async function inventoryAssets(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (prefix || ["node_modules", "native", "export-html"].includes(entry.name))
          await inventoryAssets(path, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (relativePath.endsWith("/package.json") && relativePath.startsWith("node_modules/")) {
        const pkg = JSON.parse(await readFile(path, "utf8"));
        if (pkg.name && pkg.version) {
          const purl = `pkg:npm/${pkg.name.replace("@", "%40")}@${pkg.version}`;
          add({
            type: "library",
            "bom-ref": `asset:${relativePath}`,
            name: pkg.name,
            version: pkg.version,
            purl,
            properties: [property("evidence", "packaged-package-manifest")],
          });
        }
      }
      if (
        !/\.(wasm|node|so|dylib)$/.test(entry.name) &&
        !relativePath.startsWith("native/") &&
        !relativePath.startsWith("export-html/vendor/")
      )
        continue;
      const contents = await readFile(path);
      if (relativePath === "photon_rs_bg.wasm") {
        const pkg = JSON.parse(
          await readFile(
            join(sourceRoot, "node_modules/@silvia-odwyer/photon-node/package.json"),
            "utf8",
          ),
        );
        add({
          type: "library",
          "bom-ref": "asset:photon",
          name: pkg.name,
          version: pkg.version,
          purl: `pkg:npm/${pkg.name.replace("@", "%40")}@${pkg.version}`,
          hashes: [{ alg: "SHA-256", content: digest(contents) }],
          properties: [property("evidence", "packaged-wasm-and-source-package-manifest")],
        });
      }
      const vendorVersion =
        relativePath === "export-html/vendor/highlight.min.js"
          ? contents.toString("utf8", 0, 300).match(/Highlight\.js v([0-9.]+)/)
          : relativePath === "export-html/vendor/marked.min.js"
            ? contents.toString("utf8", 0, 300).match(/marked v([0-9.]+)/)
            : undefined;
      if (vendorVersion) {
        const name = entry.name === "highlight.min.js" ? "highlight.js" : "marked";
        add({
          type: "library",
          "bom-ref": `vendor:${name}`,
          name,
          version: vendorVersion[1],
          purl: `pkg:npm/${name}@${vendorVersion[1]}`,
          hashes: [{ alg: "SHA-256", content: digest(contents) }],
          properties: [property("evidence", "packaged-vendor-version-header")],
        });
      }
      add({
        type: "file",
        "bom-ref": `asset:${relativePath}`,
        name: relativePath,
        hashes: [{ alg: "SHA-256", content: digest(contents) }],
        properties: [property("evidence", "packaged-asset")],
      });
    }
  }
  await inventoryAssets(payload);
  const executableHash = digest(await readFile(join(payload, "pi-sandbox")));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": "pi-sandbox",
        name: "pi-sandbox",
        version: packageJson.version,
        hashes: [{ alg: "SHA-256", content: executableHash }],
        properties: [
          property("platform", platform),
          property("source-commit", sourceCommit),
          property("source-dirty", sourceDirty),
          ...(smolvm === undefined || smolvm === null
            ? []
            : [
                property("external-smolvm-version", smolvm.version),
                property("external-smolvm-path", smolvm.path),
                property("external-smolvm-source-commit", smolvm.sourceCommit),
                property("external-smolvm-release-archive-sha256", smolvm.releaseArchiveSha256),
              ]),
          property(
            "coverage",
            "Actual JavaScript bundle inputs, selected extensions, Bun runtime, native Cargo lock inventories and bundled Bubblewrap. System libraries and Bun internal third-party components are not enumerated.",
          ),
        ],
      },
      properties: [
        property(
          "upstream-lock-sha256",
          digest(await readFile(join(sourceRoot, "package-lock.json"))),
        ),
      ],
    },
    components: [...components.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"])),
  };
}
