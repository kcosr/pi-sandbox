#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCompiledExtensionsModule,
  createExtensionBuildInventory,
  loadExtensionManifests,
} from "../build/extension-composition.mjs";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-sandbox-extension-build-test-"));

try {
  const alphaEntrypoint = join(temporaryDirectory, "alpha.ts");
  const alphaManifest = join(temporaryDirectory, "alpha.json");
  const zetaEntrypoint = join(temporaryDirectory, "zeta.ts");
  const zetaManifest = join(temporaryDirectory, "zeta.json");
  await writeFile(alphaEntrypoint, "export default { id: 'alpha' };\n");
  await writeFile(zetaEntrypoint, "export default { id: 'zeta' };\n");
  await writeFile(
    alphaManifest,
    `${JSON.stringify({
      manifestVersion: 1,
      kind: "managed",
      apiVersion: 3,
      id: "alpha",
      version: "1.2.3-beta.1+build.4",
      entrypoint: "./alpha.ts",
      tools: ["alpha_tool"],
      provenance: { repository: "ssh://git.example/alpha", revision: "abc123" },
    })}\n`,
  );
  await writeFile(
    zetaManifest,
    `${JSON.stringify({
      manifestVersion: 1,
      kind: "pi-tool",
      apiVersion: 3,
      id: "zeta",
      version: "2.0.0",
      entrypoint: "./zeta.ts",
      tools: ["zeta_tool"],
    })}\n`,
  );

  const extensions = await loadExtensionManifests([zetaManifest, alphaManifest]);
  assert.deepEqual(
    extensions.map((extension) => extension.metadata.id),
    ["alpha", "zeta"],
  );
  assert.equal(extensions[0].metadata.provenance.revision, "abc123");
  assert.match(extensions[0].manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(extensions[0].entrypointSha256, /^[0-9a-f]{64}$/);

  const moduleSource = createCompiledExtensionsModule(extensions);
  assert.match(moduleSource, /pi-sandbox:extension-entry:0/);
  assert.match(moduleSource, /export const compiledExtensions/);
  assert.match(moduleSource, /"moduleSha256":"[0-9a-f]{64}"/);
  assert.ok(moduleSource.indexOf('"id":"alpha"') < moduleSource.indexOf('"id":"zeta"'));

  const inventory = createExtensionBuildInventory(extensions, "a".repeat(64));
  assert.equal(inventory.inventoryVersion, 1);
  assert.equal(inventory.extensions[0].id, "alpha");
  assert.equal(inventory.privateBundleSha256, "a".repeat(64));
  assert.equal(JSON.stringify(inventory).includes(temporaryDirectory), false);

  await assert.rejects(
    loadExtensionManifests([alphaManifest, alphaManifest]),
    /duplicate extension id: alpha/,
  );

  const invalidManifest = join(temporaryDirectory, "invalid.json");
  await writeFile(
    invalidManifest,
    `${JSON.stringify({
      manifestVersion: 1,
      kind: "managed",
      apiVersion: 2,
      id: "valid-id",
      version: "1.0.0",
      entrypoint: "./alpha.ts",
      tools: ["valid_tool"],
    })}\n`,
  );
  await assert.rejects(loadExtensionManifests([invalidManifest]), /requires apiVersion 3/);

  await writeFile(
    invalidManifest,
    `${JSON.stringify({
      manifestVersion: 1,
      kind: "managed",
      apiVersion: 3,
      id: "Invalid_Id",
      version: "1.0.0",
      entrypoint: "./alpha.ts",
      tools: ["valid_tool"],
    })}\n`,
  );
  await assert.rejects(loadExtensionManifests([invalidManifest]), /invalid id/);

  await writeFile(
    invalidManifest,
    `${JSON.stringify({
      manifestVersion: 1,
      kind: "managed",
      apiVersion: 3,
      id: "valid-id",
      version: "1.0.0",
      entrypoint: "./alpha.ts",
      tools: ["valid_tool"],
      extra: true,
    })}\n`,
  );
  await assert.rejects(loadExtensionManifests([invalidManifest]), /unknown field: extra/);

  await writeFile(
    invalidManifest,
    `${JSON.stringify({
      manifestVersion: 1,
      kind: "managed",
      apiVersion: 3,
      id: "valid-id",
      version: "1.0.0-01",
      entrypoint: "./alpha.ts",
      tools: ["valid_tool"],
    })}\n`,
  );
  await assert.rejects(loadExtensionManifests([invalidManifest]), /invalid semantic version/);

  await writeFile(
    invalidManifest,
    `${JSON.stringify({
      manifestVersion: 1,
      kind: "managed",
      apiVersion: 3,
      id: "valid-id",
      version: "1.0.0",
      entrypoint: alphaEntrypoint,
      tools: ["valid_tool"],
    })}\n`,
  );
  await assert.rejects(loadExtensionManifests([invalidManifest]), /relative entrypoint/);

  console.log("external extension build composition tests passed");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
