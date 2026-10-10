import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** Install only packed local artifacts and public dependencies into a disposable tree. */
export async function installExtensionArtifacts(
  root,
  temporaryDirectory,
  names = ["sandbox-extension", "git-extension"],
) {
  const modules = join(temporaryDirectory, "node_modules");
  await mkdir(modules);
  // Avoid linking the workspace package aliases: that would silently test the
  // source checkout instead of the independently distributable tarballs.
  for (const name of await readdir(join(root, "node_modules"))) {
    if (name === "@kcosr" || name.startsWith(".")) continue;
    await symlink(join(root, "node_modules", name), join(modules, name), "dir");
  }
  const artifacts = {};
  for (const name of names) {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", join(root, "packages", name), "--pack-destination", temporaryDirectory, "--json"],
        { encoding: "utf8" },
      ),
    )[0];
    const archive = join(temporaryDirectory, packed.filename);
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    for (const required of [
      "package/package.json",
      "package/dist/index.js",
      "package/LICENSE",
      "package/README.md",
      "package/provenance.json",
    ])
      assert(entries.includes(required), `${name}: missing ${required}`);
    assert(
      entries.every(
        (entry) =>
          entry.startsWith("package/") &&
          !entry.includes("../") &&
          !entry.includes("node_modules/") &&
          !entry.endsWith(".test.js"),
      ),
    );
    const directory = join(modules, "@kcosr", `pi-${name}`);
    await mkdir(directory, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", directory]);
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    assert.deepEqual(metadata.dependencies ?? {}, {}, "Extensions must install independently");
    assert.equal(metadata.peerDependencies["@earendil-works/pi-coding-agent"], "1.1.0");
    for (const target of Object.values(metadata.exports)) {
      assert(entries.includes(`package/${target.replace(/^\.\//u, "")}`));
      await import(pathToFileURL(join(directory, target)).href);
    }
    const provenance = JSON.parse(await readFile(join(directory, "provenance.json"), "utf8"));
    if (name === "git-extension")
      assert(
        provenance.sourceInputs.includes(
          "packages/sandbox-extension/src/runtime/host-command/host-command-executor.ts",
        ),
      );
    for (const entry of entries.filter((entry) => /\.(?:js|d\.ts)$/u.test(entry))) {
      const file = join(directory, entry.slice("package/".length));
      const source = await readFile(file, "utf8");
      const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const imports = new Set();
      const visit = (node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          imports.add(node.moduleSpecifier.text);
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        )
          imports.add(node.arguments[0].text);
        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        )
          imports.add(node.argument.literal.text);
        ts.forEachChild(node, visit);
      };
      visit(syntax);
      for (const specifier of imports) {
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          assert(
            target.startsWith(`${directory}${sep}`),
            `Import escapes tarball: ${file}: ${specifier}`,
          );
          // Type-only modules may emit declarations without a JS module.
          await readFile(target).catch((error) => {
            if (!file.endsWith(".d.ts")) throw error;
            return readFile(target.replace(/\.js$/u, ".d.ts"));
          });
        } else {
          assert(!isAbsolute(specifier));
          assert(
            specifier.startsWith("node:") ||
              Object.keys(metadata.peerDependencies).some(
                (peer) => specifier === peer || specifier.startsWith(`${peer}/`),
              ),
            `Undeclared import: ${specifier}`,
          );
        }
      }
    }
    assert.equal(provenance.name, metadata.name);
    assert.equal(provenance.version, metadata.version);
    assert.equal(provenance.piVersion, "1.1.0");
    assert.equal(
      provenance.sourceCommit,
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    );
    artifacts[name] = { directory, archive, filename: packed.filename, metadata };
  }
  return artifacts;
}
