import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundledPackages, createSbom } from "../build/sbom.mjs";

test("bundle inventory identifies nearest scoped dependency and omits unbundled packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sbom-"));
  try {
    await mkdir(join(root, "node_modules/@scope/used/lib"), { recursive: true });
    await mkdir(join(root, "node_modules/unused"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    await writeFile(
      join(root, "node_modules/@scope/used/package.json"),
      JSON.stringify({ name: "@scope/used", version: "2.3.4" }),
    );
    await writeFile(
      join(root, "node_modules/unused/package.json"),
      JSON.stringify({ name: "unused", version: "9.0.0" }),
    );
    const packages = await bundledPackages(
      {
        inputs: {
          "node_modules/@scope/used/lib/index.js": {},
          "node_modules/@scope/used/lib/other.js": {},
          "virtual:compiled": {},
        },
      },
      root,
    );
    assert.deepEqual(
      packages.map(({ name, version }) => ({ name, version })),
      [{ name: "@scope/used", version: "2.3.4" }],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release inventory ties source and executable identity to selected shipped components", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sbom-release-"));
  try {
    await mkdir(join(root, "dist/private"), { recursive: true });
    for (const file of ["bun.json", "dist/private/bundle-metafile.json"])
      await writeFile(join(root, file), JSON.stringify({ inputs: {} }));
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(root, "pi-sandbox"), "compiled executable");
    const args = {
      repositoryRoot: root,
      sourceRoot: root,
      codingAgentRoot: root,
      bunMetafile: join(root, "bun.json"),
      packageJson: { version: "1.2.3" },
      lock: {
        version: "4.5.6",
        commit: "pinned",
        sourceArchive: "https://example.org/pi.tar.gz",
        sourceArchiveSha256: "a".repeat(64),
      },
      patches: [{ file: "0001.patch", sha256: "b".repeat(64) }],
      extensions: [
        {
          id: "chosen",
          version: "1.0.0",
          entrypointSha256: "c".repeat(64),
          manifestSha256: "d".repeat(64),
        },
      ],
      platform: "darwin-arm64",
      bunVersion: "1.3.0",
      sourceCommit: "local-head",
      sourceDirty: true,
      bubblewrap: null,
      payload: root,
    };
    const sbom = await createSbom(args);
    assert.equal(sbom.bomFormat, "CycloneDX");
    assert.equal(sbom.metadata.component.version, "1.2.3");
    assert.equal(sbom.metadata.component.hashes[0].content.length, 64);
    assert.ok(
      sbom.metadata.component.properties.some(
        (p) => p.name.endsWith("source-dirty") && p.value === "true",
      ),
    );
    assert.deepEqual(sbom.components.map((c) => c.name).sort(), ["bun", "chosen", "pi"]);
    const withSkills = await createSbom({
      ...args,
      skillsBundle: {
        source: { kind: "prepared-directory", sha256: "1".repeat(64) },
        files: [
          { path: "skills/review/SKILL.md", size: 123, sha256: "2".repeat(64), mode: "0644" },
          {
            path: "skills/review/scripts/check.sh",
            size: 45,
            sha256: "3".repeat(64),
            mode: "0755",
          },
        ],
      },
    });
    const skill = withSkills.components.find(
      (component) => component["bom-ref"] === "skill-file:skills/review/scripts/check.sh",
    );
    assert.equal(skill.type, "file");
    assert.deepEqual(skill.hashes, [{ alg: "SHA-256", content: "3".repeat(64) }]);
    assert.ok(
      skill.properties.some((item) => item.name === "pi-sandbox:mode" && item.value === "0755"),
    );
    assert.ok(
      skill.properties.some(
        (item) => item.name === "pi-sandbox:source-sha256" && item.value === "1".repeat(64),
      ),
    );
    await mkdir(join(root, "export-html/vendor"), { recursive: true });
    await writeFile(join(root, "export-html/vendor/marked.min.js"), "/* marked v18.0.5 */");
    await mkdir(join(root, "node_modules/@silvia-odwyer/photon-node"), { recursive: true });
    await writeFile(
      join(root, "node_modules/@silvia-odwyer/photon-node/package.json"),
      JSON.stringify({ name: "@silvia-odwyer/photon-node", version: "0.3.4" }),
    );
    await writeFile(join(root, "photon_rs_bg.wasm"), "wasm fixture");
    const linux = await createSbom({
      ...args,
      platform: "linux-x64",
      bubblewrap: { mode: "bundled", version: "0.11.0", sha256: "f".repeat(64) },
    });
    assert.ok(
      !linux.components.some((c) => c.name.includes("broker") || c.name.includes("collector")),
    );
    assert.equal(linux.components.find((c) => c.name === "marked").version, "18.0.5");
    assert.equal(linux.components.find((c) => c["bom-ref"] === "asset:photon").version, "0.3.4");
    assert.equal(
      linux.components.find((c) => c.name === "photon_rs_bg.wasm").hashes[0].content.length,
      64,
    );
    assert.equal(linux.components.find((c) => c.name === "bubblewrap").version, "0.11.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
