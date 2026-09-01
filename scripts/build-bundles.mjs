#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import {
  createCompiledExtensionsModule,
  createExtensionBuildInventory,
  loadExtensionManifests,
  sha256File,
} from "./build/extension-composition.mjs";
import { createCompiledLayoutModule, loadDistribution } from "./build/distribution.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDistribution = join(repositoryRoot, "config/default/distribution.toml");

function usage(stream = process.stdout) {
  stream.write(`Usage: node scripts/build-bundles.mjs [options]

Options:
  --distribution FILE  Select extensions and installation layout
                       (default: config/default/distribution.toml)
  -h, --help           Show this help

Only extensions selected by the distribution manifest are compiled.
`);
}

function parseArguments(argv) {
  let distribution = defaultDistribution;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument !== "--distribution") throw new Error(`unknown option: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    distribution = resolve(value);
    index += 1;
  }
  return { distribution };
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(`build-bundles: ${error instanceof Error ? error.message : String(error)}`);
  usage(process.stderr);
  process.exitCode = 2;
}

if (options?.help) {
  usage();
  process.exit(0);
}

if (options === undefined) process.exit(2);

const distribution = await loadDistribution(options.distribution);
const extensions = await loadExtensionManifests(distribution.extensionManifests);
const compiledExtensionsModule = createCompiledExtensionsModule(extensions);
const compiledLayoutModule = createCompiledLayoutModule(distribution.layout);
const privateBundle = join(repositoryRoot, "dist/private/private-cli.js");

const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22.19",
  sourcemap: true,
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __piSandboxCreateRequire } from "node:module"; const require = __piSandboxCreateRequire(import.meta.url);',
  },
};

await build({
  ...common,
  absWorkingDir: repositoryRoot,
  entryPoints: [join(repositoryRoot, "src/private-cli.ts")],
  outfile: privateBundle,
  external: [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/*",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-coding-agent/*",
    "@earendil-works/pi-tui",
    "@earendil-works/pi-tui/*",
  ],
  plugins: [
    {
      name: "pi-sandbox-managed-extensions",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^pi-sandbox:compiled-extensions$/ }, () => ({
          path: "compiled-extensions",
          namespace: "pi-sandbox-managed-extensions",
        }));
        buildApi.onLoad(
          { filter: /^compiled-extensions$/, namespace: "pi-sandbox-managed-extensions" },
          () => ({ contents: compiledExtensionsModule, loader: "js" }),
        );
        buildApi.onResolve({ filter: /^#pi-sandbox-compiled-layout$/ }, () => ({
          path: "compiled-layout",
          namespace: "pi-sandbox-managed-extensions",
        }));
        buildApi.onLoad(
          { filter: /^compiled-layout$/, namespace: "pi-sandbox-managed-extensions" },
          () => ({ contents: compiledLayoutModule, loader: "js" }),
        );
        buildApi.onResolve({ filter: /^pi-sandbox:extension-entry:\d+$/ }, (args) => {
          const index = Number.parseInt(args.path.slice(args.path.lastIndexOf(":") + 1), 10);
          const extension = extensions[index];
          if (extension === undefined)
            throw new Error(`unknown compiled extension index: ${index}`);
          return { path: extension.entrypointPath };
        });
        buildApi.onResolve({ filter: /^pi-sandbox\/managed-extension-api$/ }, () => ({
          path: join(repositoryRoot, "src/managed-extensions/sdk.ts"),
        }));
      },
    },
  ],
});

const inventory = createExtensionBuildInventory(extensions, await sha256File(privateBundle));
await writeFile(
  join(repositoryRoot, "dist/private/extension-build-inventory.json"),
  `${JSON.stringify(inventory, null, 2)}\n`,
  { mode: 0o644 },
);
