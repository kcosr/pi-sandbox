import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Check the actual adapter types against freshly built, patched Pi declarations. */
export async function compilePiContract(sourceRoot) {
  const paths = {};
  for (const name of ["coding-agent", "ai", "mcp", "tui"]) {
    const declaration = resolve(sourceRoot, "packages", name, "dist/index.d.ts");
    // A missing target must not silently fall back to the published npm package.
    await access(declaration);
    paths[`@earendil-works/pi-${name}`] = [declaration];
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-sandbox-contract-"));
  try {
    const project = join(temporaryDirectory, "tsconfig.json");
    await writeFile(
      project,
      JSON.stringify({
        extends: join(repositoryRoot, "scripts/checks/tsconfig.json"),
        compilerOptions: {
          paths,
          typeRoots: [join(repositoryRoot, "node_modules/@types")],
        },
      }),
    );
    return await new Promise((resolveResult, reject) => {
      execFile(
        process.execPath,
        [
          join(repositoryRoot, "node_modules/typescript/bin/tsc"),
          "--project",
          project,
          "--pretty",
          "false",
        ],
        {
          cwd: repositoryRoot,
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error !== null && typeof error.code !== "number") reject(error);
          else resolveResult({ code: error?.code ?? 0, output: stdout + stderr });
        },
      );
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
