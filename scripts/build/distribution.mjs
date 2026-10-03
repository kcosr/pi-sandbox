import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

import { parse as parseToml } from "@iarna/toml";

const ROOT_KEYS = new Set(["version", "allow_config_override", "extension_manifests", "platforms"]);
const PLATFORM_KEYS = new Set([
  "config_dir",
  "libexec_dir",
  "launcher_path",
  "service_dir",
  "identity_socket_path",
  "audit_socket_path",
  "bubblewrap",
]);
const SYSTEM_BUBBLEWRAP_KEYS = new Set(["mode", "path"]);
const BUNDLED_BUBBLEWRAP_KEYS = new Set(["mode", "binary", "version", "sha256", "license_file"]);

function object(value, description) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a table`);
  }
  return value;
}

function rejectUnknown(value, allowed, description) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${description}.${key} is not recognized`);
  }
}

function absolutePath(value, description) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    value === "/"
  ) {
    throw new Error(`${description} must be a normalized absolute path below /`);
  }
  return value;
}

function inputPath(value, description, manifestDirectory) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${description} must be a non-empty path`);
  }
  return resolve(manifestDirectory, value);
}

function semanticVersion(value, description) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      value,
    )
  ) {
    throw new Error(`${description} must be a semantic version`);
  }
  return value;
}

function parseBubblewrap(value, manifestDirectory, libexecDir) {
  const bubblewrap = object(value, "distribution platforms.linux.bubblewrap");
  if (bubblewrap.mode === "system") {
    rejectUnknown(bubblewrap, SYSTEM_BUBBLEWRAP_KEYS, "distribution platforms.linux.bubblewrap");
    const path = absolutePath(bubblewrap.path, "distribution platforms.linux.bubblewrap.path");
    return Object.freeze({
      mode: "system",
      path,
      release: Object.freeze({ mode: "system", path }),
    });
  }
  if (bubblewrap.mode === "bundled") {
    rejectUnknown(bubblewrap, BUNDLED_BUBBLEWRAP_KEYS, "distribution platforms.linux.bubblewrap");
    const binary = inputPath(
      bubblewrap.binary,
      "distribution platforms.linux.bubblewrap.binary",
      manifestDirectory,
    );
    const licenseFile = inputPath(
      bubblewrap.license_file,
      "distribution platforms.linux.bubblewrap.license_file",
      manifestDirectory,
    );
    const version = semanticVersion(
      bubblewrap.version,
      "distribution platforms.linux.bubblewrap.version",
    );
    if (typeof bubblewrap.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(bubblewrap.sha256)) {
      throw new Error(
        "distribution platforms.linux.bubblewrap.sha256 must be a lowercase SHA-256 digest",
      );
    }
    const path = `${libexecDir}/bwrap`;
    return Object.freeze({
      mode: "bundled",
      path,
      binary,
      licenseFile,
      version,
      sha256: bubblewrap.sha256,
      release: Object.freeze({
        mode: "bundled",
        path,
        version,
        sha256: bubblewrap.sha256,
      }),
    });
  }
  throw new Error("distribution platforms.linux.bubblewrap.mode must be system or bundled");
}

export async function loadDistribution(path, platform = process.platform) {
  const distributionPath = resolve(path);
  let parsed;
  try {
    parsed = parseToml(await readFile(distributionPath, "utf8"));
  } catch (cause) {
    throw new Error(`distribution manifest is not valid TOML: ${distributionPath}`, { cause });
  }
  const root = object(parsed, `distribution manifest ${distributionPath}`);
  rejectUnknown(root, ROOT_KEYS, `distribution manifest ${distributionPath}`);
  if (root.version !== 3) throw new Error("distribution manifest version must be 3");
  if (typeof root.allow_config_override !== "boolean") {
    throw new Error("distribution allow_config_override must be a boolean");
  }
  if (
    !Array.isArray(root.extension_manifests) ||
    root.extension_manifests.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error("distribution extension_manifests must be an array of paths");
  }
  const manifestDirectory = dirname(distributionPath);
  const extensionManifests = root.extension_manifests.map((entry) =>
    resolve(manifestDirectory, entry),
  );
  if (new Set(extensionManifests).size !== extensionManifests.length) {
    throw new Error("distribution extension_manifests must not contain duplicates");
  }

  const platforms = object(root.platforms, "distribution platforms");
  rejectUnknown(platforms, new Set(["linux", "darwin"]), "distribution platforms");
  const selected = object(platforms[platform], `distribution platforms.${platform}`);
  rejectUnknown(selected, PLATFORM_KEYS, `distribution platforms.${platform}`);
  const configDir = absolutePath(
    selected.config_dir,
    `distribution platforms.${platform}.config_dir`,
  );
  const libexecDir = absolutePath(
    selected.libexec_dir,
    `distribution platforms.${platform}.libexec_dir`,
  );
  const launcherPath = absolutePath(
    selected.launcher_path,
    `distribution platforms.${platform}.launcher_path`,
  );
  const identitySocketPath = absolutePath(
    selected.identity_socket_path,
    `distribution platforms.${platform}.identity_socket_path`,
  );
  const auditSocketPath = absolutePath(
    selected.audit_socket_path,
    `distribution platforms.${platform}.audit_socket_path`,
  );
  if (auditSocketPath === identitySocketPath) {
    throw new Error("distribution audit_socket_path must differ from identity_socket_path");
  }
  const serviceDir =
    platform === "linux"
      ? absolutePath(selected.service_dir, "distribution platforms.linux.service_dir")
      : undefined;
  if (
    platform === "darwin" &&
    (selected.service_dir !== undefined || selected.bubblewrap !== undefined)
  ) {
    throw new Error("distribution platforms.darwin does not support service_dir or bubblewrap");
  }
  if (launcherPath === libexecDir || launcherPath.startsWith(`${libexecDir}/`)) {
    throw new Error("distribution launcher_path must be outside libexec_dir");
  }
  const bubblewrap =
    platform === "linux"
      ? parseBubblewrap(selected.bubblewrap, manifestDirectory, libexecDir)
      : undefined;

  return Object.freeze({
    path: distributionPath,
    extensionManifests: Object.freeze(extensionManifests),
    ...(bubblewrap === undefined ? {} : { bubblewrap }),
    layout: Object.freeze({
      allowConfigOverride: root.allow_config_override,
      configDir,
      configPath: `${configDir}/config.toml`,
      defaultModelsPath: `${configDir}/models.json`,
      libexecDir,
      launcherPath,
      identitySocketPath,
      auditSocketPath,
      ...(bubblewrap === undefined
        ? {}
        : { bubblewrap: Object.freeze({ mode: bubblewrap.mode, path: bubblewrap.path }) }),
      ...(serviceDir === undefined ? {} : { serviceDir }),
    }),
  });
}

export function createCompiledLayoutModule(layout) {
  return `export const compiledLayout = Object.freeze(${JSON.stringify(layout)});\n`;
}
