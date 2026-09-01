import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const MANIFEST_KEYS = new Set([
  "manifestVersion",
  "kind",
  "apiVersion",
  "id",
  "version",
  "entrypoint",
  "tools",
  "provenance",
]);
const PROVENANCE_KEYS = new Set(["repository", "revision"]);

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function requireRegularFile(path, description) {
  const stats = await lstat(path).catch(() => undefined);
  if (stats?.isFile() !== true) throw new Error(`${description} must be a regular file: ${path}`);
}

function requireObject(value, description) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, description) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${description} has unknown field: ${key}`);
  }
}

function isSemver(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    );
  if (match === null) return false;
  const prerelease = match[4];
  return (
    prerelease === undefined ||
    prerelease
      .split(".")
      .every(
        (identifier) =>
          !/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0"),
      )
  );
}

function parseProvenance(value, manifestPath) {
  if (value === undefined) return undefined;
  const provenance = requireObject(value, `extension provenance in ${manifestPath}`);
  rejectUnknownKeys(provenance, PROVENANCE_KEYS, `extension provenance in ${manifestPath}`);
  if (
    typeof provenance.repository !== "string" ||
    provenance.repository.trim().length === 0 ||
    typeof provenance.revision !== "string" ||
    provenance.revision.trim().length === 0
  ) {
    throw new Error(
      `extension provenance in ${manifestPath} requires non-empty repository and revision strings`,
    );
  }
  return Object.freeze({ repository: provenance.repository, revision: provenance.revision });
}

export async function loadExtensionManifests(paths) {
  const extensions = [];
  for (const suppliedPath of paths) {
    const manifestPath = resolve(suppliedPath);
    await requireRegularFile(manifestPath, "extension manifest");
    let parsed;
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (cause) {
      throw new Error(`extension manifest is not valid JSON: ${manifestPath}`, { cause });
    }
    const manifest = requireObject(parsed, `extension manifest ${manifestPath}`);
    rejectUnknownKeys(manifest, MANIFEST_KEYS, `extension manifest ${manifestPath}`);
    if (manifest.manifestVersion !== 1) {
      throw new Error(`extension manifest ${manifestPath} requires manifestVersion 1`);
    }
    if (manifest.kind !== "managed" && manifest.kind !== "pi-tool") {
      throw new Error(`extension manifest ${manifestPath} has an invalid kind`);
    }
    if (manifest.apiVersion !== 3) {
      throw new Error(`extension manifest ${manifestPath} requires apiVersion 3`);
    }
    if (
      !Array.isArray(manifest.tools) ||
      manifest.tools.length === 0 ||
      manifest.tools.some(
        (name) => typeof name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(name),
      ) ||
      new Set(manifest.tools).size !== manifest.tools.length
    ) {
      throw new Error(`extension manifest ${manifestPath} has invalid tools`);
    }
    if (
      typeof manifest.id !== "string" ||
      manifest.id.length > 64 ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(manifest.id)
    ) {
      throw new Error(`extension manifest ${manifestPath} has an invalid id`);
    }
    if (typeof manifest.version !== "string" || !isSemver(manifest.version)) {
      throw new Error(`extension manifest ${manifestPath} has an invalid semantic version`);
    }
    if (
      typeof manifest.entrypoint !== "string" ||
      manifest.entrypoint.length === 0 ||
      isAbsolute(manifest.entrypoint)
    ) {
      throw new Error(`extension manifest ${manifestPath} requires a relative entrypoint`);
    }
    const entrypointPath = resolve(dirname(manifestPath), manifest.entrypoint);
    await requireRegularFile(entrypointPath, `entrypoint for extension ${manifest.id}`);
    extensions.push({
      metadata: Object.freeze({
        manifestVersion: 1,
        kind: manifest.kind,
        apiVersion: 3,
        id: manifest.id,
        version: manifest.version,
        tools: Object.freeze([...manifest.tools]),
        ...(manifest.provenance === undefined
          ? {}
          : { provenance: parseProvenance(manifest.provenance, manifestPath) }),
      }),
      manifestPath,
      entrypointPath,
      manifestSha256: await sha256File(manifestPath),
      entrypointSha256: await sha256File(entrypointPath),
    });
  }
  extensions.sort((left, right) => left.metadata.id.localeCompare(right.metadata.id));
  for (let index = 1; index < extensions.length; index += 1) {
    if (extensions[index - 1].metadata.id === extensions[index].metadata.id) {
      throw new Error(`duplicate extension id: ${extensions[index].metadata.id}`);
    }
  }
  return Object.freeze(extensions);
}

export function createCompiledExtensionsModule(extensions) {
  const imports = extensions.map(
    (_extension, index) =>
      `import compiledExtension${index} from ${JSON.stringify(`pi-sandbox:extension-entry:${index}`)};`,
  );
  const records = extensions.map((extension, index) => {
    const manifest = {
      kind: extension.metadata.kind,
      apiVersion: extension.metadata.apiVersion,
      id: extension.metadata.id,
      version: extension.metadata.version,
      toolNames: extension.metadata.tools,
      digests: {
        manifestSha256: extension.manifestSha256,
        moduleSha256: extension.entrypointSha256,
      },
    };
    if (extension.metadata.kind === "managed") {
      return `  Object.freeze({ manifest: Object.freeze(${JSON.stringify(manifest)}), extension: compiledExtension${index} }),`;
    }
    return `  Object.freeze({
    manifest: Object.freeze(${JSON.stringify(manifest)}),
    extension: Object.freeze({
      kind: "pi-tool",
      apiVersion: 3,
      id: ${JSON.stringify(extension.metadata.id)},
      version: ${JSON.stringify(extension.metadata.version)},
      hostEnvironment: Object.freeze({ variables: Object.freeze([]) }),
      parseConfig(raw, path) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(path + " must be a table");
        const keys = Object.keys(raw);
        if (keys.length > 0) throw new Error(path + " has unknown field: " + keys[0]);
        return Object.freeze({});
      },
      requiredHostExecutables() { return Object.freeze([]); },
      toolNames: Object.freeze(${JSON.stringify(extension.metadata.tools)}),
      factory: compiledExtension${index},
    }),
  }),`;
  });
  return `${imports.join("\n")}${imports.length === 0 ? "" : "\n"}
export const compiledExtensions = Object.freeze([
${records.join("\n")}
]);
`;
}

export function createExtensionBuildInventory(extensions, bundleSha256) {
  return {
    inventoryVersion: 1,
    extensions: extensions.map((extension) => ({
      ...extension.metadata,
      manifestSha256: extension.manifestSha256,
      entrypointSha256: extension.entrypointSha256,
    })),
    privateBundleSha256: bundleSha256,
  };
}
