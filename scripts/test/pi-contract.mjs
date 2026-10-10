#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { compilePiContract } from "../build/pi-contract.mjs";

const sourceRoot = process.argv[2];
if (sourceRoot === undefined || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/test/pi-contract.mjs BUILT_PI_SOURCE_DIRECTORY");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const originalRoot = resolve(sourceRoot);
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-sandbox-contract-test-"));
const fixtureRoot = join(temporaryRoot, "pi");
const agentRoot = join(fixtureRoot, "packages/coding-agent");

function interfaceMember(source, interfaceName, memberName) {
  const parsed = ts.createSourceFile("fixture.d.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = parsed.statements.filter(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === interfaceName,
  );
  assert.equal(declarations.length, 1, `expected one ${interfaceName} declaration`);
  const members = declarations[0].members.filter(
    (node) => node.name !== undefined && node.name.getText(parsed) === memberName,
  );
  assert.equal(members.length, 1, `expected one ${interfaceName}.${memberName} declaration`);
  return members[0];
}

function removeMember(interfaceName, memberName) {
  return (source) => {
    const member = interfaceMember(source, interfaceName, memberName);
    return source.slice(0, member.getFullStart()) + source.slice(member.end);
  };
}

function changeManagementCallback(source) {
  const member = interfaceMember(source, "McpManagementOptions", "updateConfig");
  assert.ok(member.type !== undefined && ts.isFunctionTypeNode(member.type));
  const parameter = member.type.parameters[0];
  assert.ok(parameter?.type !== undefined, "expected updateConfig's server parameter");
  return (
    source.slice(0, parameter.type.getStart()) +
    "{ name: number }" +
    source.slice(parameter.type.end)
  );
}

async function expectContractFailure(label) {
  const result = await compilePiContract(fixtureRoot);
  assert.notEqual(result.code, 0, `${label}: unexpectedly accepted incompatible declarations`);
  assert.match(
    result.output,
    /pi-contract\.ts\(\d+,\d+\): error TS/,
    `${label}: expected an assertion-file diagnostic, received:\n${result.output}`,
  );
  assert.doesNotMatch(
    result.output,
    /error TS(?:1\d{3}|2307):/,
    `${label}: failed because the fixture was invalid or a module was missing:\n${result.output}`,
  );
  console.log(`Pi contract rejects ${label}`);
}

try {
  await mkdir(agentRoot, { recursive: true });
  await copyFile(
    join(originalRoot, "packages/coding-agent/package.json"),
    join(agentRoot, "package.json"),
  );
  await cp(join(originalRoot, "packages/coding-agent/dist"), join(agentRoot, "dist"), {
    recursive: true,
  });
  for (const entry of await readdir(join(originalRoot, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "coding-agent") {
      await symlink(
        join(originalRoot, "packages", entry.name),
        join(fixtureRoot, "packages", entry.name),
        "dir",
      );
    }
  }
  await symlink(join(originalRoot, "node_modules"), join(fixtureRoot, "node_modules"), "dir");

  const baseline = await compilePiContract(fixtureRoot);
  assert.equal(baseline.code, 0, `patched declarations failed the baseline:\n${baseline.output}`);
  console.log("Pi contract accepts the actual patched declarations");

  const cases = [
    ["missing display version", "main.d.ts", removeMember("MainOptions", "displayVersion")],
    ["missing main hook", "main.d.ts", removeMember("MainOptions", "beforeRun")],
    ["missing mandatory startup hook", "main.d.ts", removeMember("MainOptions", "beforeInterface")],
    [
      "missing model catalog switch",
      "core/model-runtime.d.ts",
      removeMember("CreateModelRuntimeOptions", "includeBuiltinCatalog"),
    ],
    [
      "missing MCP option",
      "extensions/mcp/index.d.ts",
      removeMember("McpExtensionOptions", "toolsOnly"),
    ],
    [
      "missing nested MCP management hook",
      "extensions/mcp/index.d.ts",
      removeMember("McpManagementOptions", "updateConfig"),
    ],
    ["changed MCP callback parameter", "extensions/mcp/index.d.ts", changeManagementCallback],
    [
      "missing nested code-mode limit",
      "extensions/codemode/tool.d.ts",
      removeMember("CodemodeExecutionLimits", "maxOutputBytes"),
    ],
  ];
  for (const [label, relativePath, mutate] of cases) {
    const path = join(agentRoot, "dist", relativePath);
    const original = await readFile(path, "utf8");
    try {
      await writeFile(path, mutate(original));
      await expectContractFailure(label);
    } finally {
      await writeFile(path, original);
    }
  }

  await rm(join(agentRoot, "dist"), { recursive: true });
  await cp(
    join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist"),
    join(agentRoot, "dist"),
    { recursive: true },
  );
  await expectContractFailure("unpatched published Pi declarations");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
