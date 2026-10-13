import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { URL } from "node:url";

export const TOOL_COMMANDS = Object.freeze([
  "bash",
  "sh",
  "cat",
  "chmod",
  "mkdir",
  "mv",
  "rm",
  "grep",
  "file",
  "find",
  "awk",
  "head",
  "sha256sum",
  "sort",
  "tail",
  "test",
  "wc",
]);
const COMMANDS = new Set([...TOOL_COMMANDS, "fd", "rg"]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const DIGEST = /^[0-9a-f]{64}$/u;
const VERSION = /^\d+\.\d+(?:\.\d+)?$/u;

function record(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new Error(`${label}.${key} is not recognized`);
  return value;
}

function portablePath(value) {
  return (
    typeof value === "string" &&
    /^(bin|lib|licenses)\/[A-Za-z0-9_.+/-]+$/u.test(value) &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value))
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

/** Read a pinned, complete artifact. No downloads, PATH lookup, or library repair occurs here. */
export async function loadToolBundle(value, manifestDirectory, platform, libexecDir) {
  const selected = record(value, ["directory", "inventory_sha256", "commands"], "tool_bundle");
  if (
    typeof selected.directory !== "string" ||
    !selected.directory ||
    selected.directory.includes("\0")
  )
    throw new Error("tool_bundle.directory must be a non-empty path");
  requireDigest(selected.inventory_sha256, "tool_bundle.inventory_sha256");
  if (
    !Array.isArray(selected.commands) ||
    !selected.commands.length ||
    selected.commands.some((name) => !COMMANDS.has(name)) ||
    new Set(selected.commands).size !== selected.commands.length
  )
    throw new Error("tool_bundle.commands must contain unique supported command names");
  const directory = resolve(manifestDirectory, selected.directory);
  if (directory.includes(":"))
    throw new Error("tool_bundle.directory cannot contain the PATH delimiter");
  if (!(await lstat(directory)).isDirectory() || (await realpath(directory)) !== directory)
    throw new Error(
      "tool_bundle.directory must be a canonical directory without symlink components",
    );
  const inventoryPath = join(directory, "inventory.json");
  const inventoryStat = await lstat(inventoryPath);
  if (!inventoryStat.isFile() || inventoryStat.size > 1024 * 1024)
    throw new Error("tool bundle inventory must be a regular file of at most 1 MiB");
  const bytes = await readFile(inventoryPath);
  if (sha256(bytes) !== selected.inventory_sha256)
    throw new Error("tool bundle inventory SHA-256 mismatch");
  const inventory = record(
    JSON.parse(bytes),
    ["version", "platform", "architecture", "minimumOS", "files", "sources"],
    "tool bundle inventory",
  );
  if (
    inventory.version !== 1 ||
    inventory.platform !== platform ||
    platform !== "darwin" ||
    !["arm64", "x64"].includes(inventory.architecture) ||
    !VERSION.test(inventory.minimumOS)
  )
    throw new Error(
      "tool bundle requires inventory version 1 and a Darwin target architecture/minimumOS",
    );
  if (
    !Array.isArray(inventory.files) ||
    !inventory.files.length ||
    inventory.files.length > 512 ||
    !Array.isArray(inventory.sources) ||
    !inventory.sources.length
  )
    throw new Error("tool bundle requires bounded files and source inventories");
  const sources = new Map();
  for (const item of inventory.sources) {
    const source = record(
      item,
      [
        "name",
        "version",
        "license",
        "sourceUrl",
        "sourceSha256",
        "binaryUrl",
        "binarySha256",
        "licenseFiles",
      ],
      "tool bundle source",
    );
    if (
      typeof source.name !== "string" ||
      !/^[A-Za-z0-9_.+-]+$/u.test(source.name) ||
      sources.has(source.name) ||
      typeof source.version !== "string" ||
      !source.version ||
      typeof source.license !== "string" ||
      !source.license
    )
      throw new Error("tool bundle source identity is invalid or duplicated");
    for (const key of ["sourceUrl", "binaryUrl"])
      if (typeof source[key] !== "string" || new URL(source[key]).protocol !== "https:")
        throw new Error(`tool bundle source ${key} must be an HTTPS URL`);
    requireDigest(source.sourceSha256, "tool bundle source sourceSha256");
    requireDigest(source.binarySha256, "tool bundle source binarySha256");
    if (
      !Array.isArray(source.licenseFiles) ||
      !source.licenseFiles.length ||
      source.licenseFiles.some((path) => !portablePath(path) || !path.startsWith("licenses/"))
    )
      throw new Error("tool bundle source must identify packaged license files");
    sources.set(source.name, source);
  }
  const files = new Map();
  let totalSize = 0;
  for (const item of inventory.files) {
    const file = record(
      item,
      ["path", "sha256", "mode", "size", "source", "originalSha256"],
      "tool bundle file",
    );
    if (
      !portablePath(file.path) ||
      files.has(file.path) ||
      !sources.has(file.source) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new Error("tool bundle file path, size, or source is invalid or duplicated");
    requireDigest(file.sha256, "tool bundle file sha256");
    const native = !file.path.startsWith("licenses/");
    if (native) {
      if (
        file.path.startsWith("bin/")
          ? !COMMANDS.has(file.path.slice(4))
          : !/^lib\/[A-Za-z0-9_.+-]+\.dylib$/u.test(file.path)
      )
        throw new Error("tool bundle native file has an unsupported path");
      requireDigest(file.originalSha256, "tool bundle file originalSha256");
    } else if (file.originalSha256 !== undefined)
      throw new Error("license files cannot declare originalSha256");
    if (file.mode !== (native ? "0755" : "0644"))
      throw new Error("tool bundle file mode must be 0755 for native code or 0644 for licenses");
    totalSize += file.size;
    if (totalSize > 512 * 1024 * 1024) throw new Error("tool bundle exceeds 512 MiB");
    files.set(file.path, file);
  }
  for (const source of sources.values())
    for (const path of source.licenseFiles)
      if (files.get(path)?.source !== source.name)
        throw new Error(
          "tool bundle source license file is missing or attributed to another source",
        );
  const binaries = [...files.keys()]
    .filter((path) => path.startsWith("bin/"))
    .map((path) => path.slice(4))
    .sort();
  if (JSON.stringify(binaries) !== JSON.stringify([...selected.commands].sort()))
    throw new Error("tool_bundle.commands must exactly select the inventory bin entries");
  const found = new Set();
  async function inspect(relative = "") {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (path === "inventory.json") continue;
      if (entry.isDirectory()) {
        if (![...files.keys()].some((name) => name.startsWith(`${path}/`)))
          throw new Error(`unlisted tool bundle directory: ${path}`);
        await inspect(path);
      } else {
        const file = files.get(path);
        if (!entry.isFile() || !file)
          throw new Error(`unlisted or unsupported tool bundle file: ${path}`);
        const stat = await lstat(join(directory, path));
        if (
          (stat.mode & 0o7777) !== Number.parseInt(file.mode, 8) ||
          stat.size !== file.size ||
          sha256(await readFile(join(directory, path))) !== file.sha256
        )
          throw new Error(`tool bundle file hash, size, or mode mismatch: ${path}`);
        found.add(path);
      }
    }
  }
  await inspect();
  if (found.size !== files.size) throw new Error("tool bundle inventory contains missing files");
  const root = `${libexecDir}/tools`;
  const commands = Object.fromEntries(
    binaries
      .filter((name) => TOOL_COMMANDS.includes(name))
      .map((name) => [name, `${root}/bin/${name}`]),
  );
  const hostTools = Object.fromEntries(
    binaries
      .filter((name) => name === "fd" || name === "rg")
      .map((name) => [name, `${root}/bin/${name}`]),
  );
  return Object.freeze({
    directory,
    inventorySha256: selected.inventory_sha256,
    inventory,
    commands: Object.freeze([...binaries]),
    layout: Object.freeze({
      toolBundle: Object.freeze({ root, commands: Object.freeze(commands) }),
      hostTools: Object.freeze(hostTools),
    }),
    release: Object.freeze({
      inventorySha256: selected.inventory_sha256,
      platform,
      architecture: inventory.architecture,
      minimumOS: inventory.minimumOS,
      commands: binaries,
    }),
  });
}

function versionParts(value) {
  return value.split(".").map(Number);
}
function exceedsVersion(actual, maximum) {
  const left = versionParts(actual),
    right = versionParts(maximum);
  for (let i = 0; i < 3; i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0);
  }
  return false;
}

/** Verify actual native loader metadata; never execute an artifact to inspect it. */
export function validateNativeToolBundle(
  bundle,
  platform = process.platform,
  architecture = process.arch,
) {
  if (!bundle) return;
  if (
    platform !== "darwin" ||
    process.platform !== platform ||
    bundle.inventory.architecture !== architecture ||
    process.arch !== architecture
  )
    throw new Error("tool bundles require a native build matching the inventory target");
  const capture = (command, args) =>
    execFileSync(command, args, { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  const targetArch = architecture === "x64" ? "x86_64" : "arm64";
  const names = new Set(bundle.inventory.files.map((file) => file.path));
  const hostVersion = capture("/usr/bin/sw_vers", ["-productVersion"]).trim();
  if (exceedsVersion(bundle.inventory.minimumOS, hostVersion))
    throw new Error("tool bundle minimumOS exceeds the build host macOS version");
  for (const file of bundle.inventory.files.filter((item) => !item.path.startsWith("licenses/"))) {
    const path = join(bundle.directory, file.path);
    if (capture("/usr/bin/lipo", ["-archs", path]).trim() !== targetArch)
      throw new Error(`tool bundle architecture mismatch: ${file.path}`);
    const header = capture("/usr/bin/otool", ["-hv", path]);
    if (!(file.path.startsWith("bin/") ? /\bEXECUTE\b/u : /\bDYLIB\b/u).test(header))
      throw new Error(`tool bundle native file type mismatch: ${file.path}`);
    const headers = capture("/usr/bin/otool", ["-l", path]);
    for (const block of headers.split(/Load command \d+\n/u)) {
      if (
        /\bcmd LC_LOAD_DYLINKER\b/u.test(block) &&
        block.match(/\bname (.+) \(offset \d+\)/u)?.[1] !== "/usr/lib/dyld"
      )
        throw new Error(`tool bundle must use the system dynamic loader: ${file.path}`);
    }
    const minimums = headers.split(/Load command \d+\n/u).flatMap((block) => {
      if (/\bcmd LC_BUILD_VERSION\b/u.test(block)) {
        if (!/\bplatform (?:1|MACOS)\n/u.test(block))
          throw new Error(`tool bundle is not a macOS binary: ${file.path}`);
        return [block.match(/\bminos (\d+\.\d+(?:\.\d+)?)\n/u)?.[1]].filter(Boolean);
      }
      return /\bcmd LC_VERSION_MIN_MACOSX\b/u.test(block)
        ? [block.match(/\bversion (\d+\.\d+(?:\.\d+)?)\n/u)?.[1]].filter(Boolean)
        : [];
    });
    if (
      !minimums.length ||
      minimums.some((version) => exceedsVersion(version, bundle.inventory.minimumOS))
    )
      throw new Error(`tool bundle minimumOS mismatch: ${file.path}`);
    if (/\bcmd (?:LC_RPATH|LC_DYLD_ENVIRONMENT)\b/u.test(headers))
      throw new Error(`tool bundle cannot use LC_RPATH or LC_DYLD_ENVIRONMENT: ${file.path}`);
    const dependencies = capture("/usr/bin/otool", ["-L", path])
      .split("\n")
      .slice(1)
      .map((line) => line.trim().replace(/ \(compatibility version.*$/u, ""))
      .filter(Boolean);
    // A dylib's first -L entry is its identity, not an import. It must also be relocatable.
    for (const dependency of dependencies) {
      if (
        (dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/Library/")) &&
        posix.normalize(dependency) === dependency
      )
        continue;
      if (!dependency.startsWith("@loader_path/"))
        throw new Error(
          `tool bundle has an external loader dependency: ${file.path}: ${dependency}`,
        );
      const target = posix.normalize(
        posix.join(posix.dirname(file.path), dependency.slice("@loader_path/".length)),
      );
      if (!target.startsWith("lib/") || !names.has(target))
        throw new Error(`tool bundle dependency is not inventoried: ${file.path}: ${dependency}`);
    }
    capture("/usr/bin/codesign", ["--verify", "--strict", path]);
  }
}

export async function copyToolBundle(bundle, destination) {
  if (!bundle) return;
  // Re-read before copying so a changed build input cannot silently bypass the pin.
  await loadToolBundle(
    {
      directory: bundle.directory,
      inventory_sha256: bundle.inventorySha256,
      commands: bundle.commands,
    },
    "/",
    bundle.inventory.platform,
    "/unused",
  );
  // Builders create the parent, but the tool subtree must be new and complete.
  await mkdir(destination, { mode: 0o755 });
  for (const file of bundle.inventory.files) {
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await copyFile(join(bundle.directory, file.path), target);
    await chmod(target, Number.parseInt(file.mode, 8));
    if (sha256(await readFile(target)) !== file.sha256)
      throw new Error(`copied tool bundle hash mismatch: ${file.path}`);
  }
  await copyFile(join(bundle.directory, "inventory.json"), join(destination, "inventory.json"));
  await chmod(join(destination, "inventory.json"), 0o644);
  if (sha256(await readFile(join(destination, "inventory.json"))) !== bundle.inventorySha256)
    throw new Error("copied tool bundle inventory SHA-256 mismatch");
}
