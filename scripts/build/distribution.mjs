import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { URL } from "node:url";
import { readFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import { X509Certificate } from "node:crypto";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

import { parse as parseToml } from "@iarna/toml";
import { macosPackageLayout } from "./macos-layout.mjs";
import { loadToolBundle } from "./tool-bundle.mjs";

const ROOT_KEYS = new Set(["version", "extension_manifests", "skills_source", "platforms"]);
const PLATFORM_KEYS = new Set([
  "configuration",
  "libexec_dir",
  "launcher_path",
  "bubblewrap",
  "tool_bundle",
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

async function readPrivateInput(path, maximum, description) {
  try {
    absolutePath(path, description);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maximum) throw new Error();
      const bytes = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < bytes.length) {
        const r = await file.read(bytes, length, bytes.length - length, null);
        if (!r.bytesRead) break;
        length += r.bytesRead;
      }
      if (length > maximum) throw new Error();
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, length),
      );
    } finally {
      await file.close();
    }
  } catch {
    throw new Error(`${description} must be a readable bounded regular UTF-8 input`);
  }
}
async function parseEndpoint(value, platform) {
  const endpoint = object(value, "distribution endpoint");
  if (endpoint.transport === "unix") {
    rejectUnknown(endpoint, new Set(["transport", "socket_path"]), "distribution endpoint");
    if (platform !== "linux") throw new Error("Unix service endpoints require Linux");
    return Object.freeze({
      transport: "unix",
      socketPath: absolutePath(endpoint.socket_path, "distribution socket_path"),
    });
  }
  if (endpoint.transport !== "https")
    throw new Error("distribution endpoint transport must be unix or https");
  rejectUnknown(
    endpoint,
    new Set([
      "transport",
      "url",
      "basic_username",
      "basic_password_file",
      "send_machine_id",
      "tls_ca_file",
    ]),
    "distribution endpoint",
  );
  let url;
  try {
    url = new URL(endpoint.url);
  } catch {
    throw new Error("distribution endpoint URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    typeof endpoint.url !== "string" ||
    endpoint.url.includes("?") ||
    endpoint.url.includes("#")
  )
    throw new Error(
      "distribution endpoint must be an HTTPS URL without credentials/query/fragment",
    );
  if (
    typeof endpoint.basic_username !== "string" ||
    !/^[\x20-\x7e]{1,128}$/u.test(endpoint.basic_username) ||
    endpoint.basic_username.includes(":")
  )
    throw new Error("distribution Basic username is invalid");
  if (
    typeof endpoint.send_machine_id !== "boolean" ||
    (platform !== "darwin" && endpoint.send_machine_id)
  )
    throw new Error("distribution send_machine_id must be boolean and requires macOS when enabled");
  const password = (
    await readPrivateInput(endpoint.basic_password_file, 8194, "distribution Basic password input")
  ).replace(/\r?\n$/u, "");
  if (
    Buffer.byteLength(password) < 32 ||
    Buffer.byteLength(password) > 8192 ||
    /[\p{Cc}\uD800-\uDFFF]/u.test(password)
  )
    throw new Error("distribution Basic password must contain 32–8192 bytes without controls");
  let tlsCa;
  if (endpoint.tls_ca_file !== undefined) {
    tlsCa = await readPrivateInput(endpoint.tls_ca_file, 1024 * 1024, "distribution CA input");
    try {
      const blocks = tlsCa.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu);
      if (
        !blocks?.length ||
        tlsCa
          .replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, "")
          .trim() ||
        blocks.some((block) => !new X509Certificate(block).ca)
      )
        throw new Error();
    } catch {
      throw new Error("distribution CA input must be a valid PEM CA bundle");
    }
  }
  return Object.freeze({
    transport: "https",
    url: url.href,
    basicUsername: endpoint.basic_username,
    basicPassword: password,
    sendMachineId: endpoint.send_machine_id,
    ...(tlsCa === undefined ? {} : { tlsCa }),
  });
}
async function parseConfiguration(value, platform) {
  const configuration = object(value, "distribution configuration");
  if (configuration.source === "service") {
    rejectUnknown(configuration, new Set(["source", "endpoint"]), "distribution configuration");
    return Object.freeze({
      source: "service",
      endpoint: await parseEndpoint(configuration.endpoint, platform),
    });
  }
  if (configuration.source !== "local")
    throw new Error("distribution configuration source must be local or service");
  rejectUnknown(
    configuration,
    new Set(["source", "config_dir", "allow_config_override", "audit_endpoint"]),
    "distribution configuration",
  );
  const configDir = absolutePath(configuration.config_dir, "distribution config_dir");
  if (typeof configuration.allow_config_override !== "boolean")
    throw new Error("distribution allow_config_override must be boolean");
  return Object.freeze({
    source: "local",
    configDir,
    configPath: `${configDir}/config.toml`,
    defaultModelsPath: `${configDir}/models.json`,
    allowConfigOverride: configuration.allow_config_override,
    ...(configuration.audit_endpoint === undefined
      ? {}
      : { auditEndpoint: await parseEndpoint(configuration.audit_endpoint, platform) }),
  });
}
/** Explicit metadata representation: never serialize compiled credentials or secret input paths. */
export function releaseLayout(layout) {
  const endpoint = (value) =>
    value.transport === "unix"
      ? { ...value }
      : {
          transport: "https",
          url: value.url,
          basicUsername: value.basicUsername,
          sendMachineId: value.sendMachineId,
          tlsTrust: value.tlsCa === undefined ? "public" : "custom",
        };
  const config = layout.configuration;
  const configuration =
    config.source === "service"
      ? { source: "service", endpoint: endpoint(config.endpoint) }
      : {
          ...config,
          ...(config.auditEndpoint === undefined
            ? {}
            : { auditEndpoint: endpoint(config.auditEndpoint) }),
        };
  return { ...layout, configuration };
}

export async function loadDistribution(path, platform = process.platform, { macosPackage } = {}) {
  if (macosPackage && platform !== "darwin")
    throw new Error("macOS Installer packages require a macOS build host");
  const distributionPath = resolve(path);
  let parsed;
  try {
    parsed = parseToml(await readFile(distributionPath, "utf8"));
  } catch (cause) {
    throw new Error(`distribution manifest is not valid TOML: ${distributionPath}`, { cause });
  }
  const root = object(parsed, `distribution manifest ${distributionPath}`);
  rejectUnknown(root, ROOT_KEYS, `distribution manifest ${distributionPath}`);
  if (root.version !== 4) throw new Error("distribution manifest version must be 4");
  if (
    !Array.isArray(root.extension_manifests) ||
    root.extension_manifests.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error("distribution extension_manifests must be an array of paths");
  }
  const manifestDirectory = dirname(distributionPath);
  const skillsSource =
    root.skills_source === undefined
      ? undefined
      : inputPath(root.skills_source, "distribution skills_source", manifestDirectory);
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
  const configuration = await parseConfiguration(selected.configuration, platform);
  if (macosPackage && configuration.source !== "service")
    throw new Error("macOS Installer packages require a service-source distribution");
  if (macosPackage && skillsSource !== undefined)
    throw new Error("macOS Installer packages do not support distribution skills_source");
  const archiveLibexecDir = absolutePath(
    selected.libexec_dir,
    `distribution platforms.${platform}.libexec_dir`,
  );
  const archiveLauncherPath = absolutePath(
    selected.launcher_path,
    `distribution platforms.${platform}.launcher_path`,
  );
  if (platform === "darwin" && selected.bubblewrap !== undefined)
    throw new Error("distribution platforms.darwin does not support bubblewrap");
  if (
    archiveLauncherPath === archiveLibexecDir ||
    archiveLauncherPath.startsWith(`${archiveLibexecDir}/`)
  ) {
    throw new Error("distribution launcher_path must be outside libexec_dir");
  }
  const { libexecDir, launcherPath } = macosPackage
    ? macosPackageLayout
    : { libexecDir: archiveLibexecDir, launcherPath: archiveLauncherPath };
  const bubblewrap =
    platform === "linux"
      ? parseBubblewrap(selected.bubblewrap, manifestDirectory, libexecDir)
      : undefined;
  const toolBundle =
    selected.tool_bundle === undefined
      ? undefined
      : await loadToolBundle(selected.tool_bundle, manifestDirectory, platform, libexecDir);

  return Object.freeze({
    path: distributionPath,
    extensionManifests: Object.freeze(extensionManifests),
    ...(skillsSource === undefined ? {} : { skillsSource }),
    ...(bubblewrap === undefined ? {} : { bubblewrap }),
    ...(toolBundle === undefined ? {} : { toolBundle }),
    layout: Object.freeze({
      configuration,
      libexecDir,
      launcherPath,
      ...(bubblewrap === undefined
        ? {}
        : { bubblewrap: Object.freeze({ mode: bubblewrap.mode, path: bubblewrap.path }) }),
      ...(toolBundle?.layout ?? {}),
      nativeInventory: Object.freeze({
        ...(toolBundle ? { toolBundleSha256: toolBundle.inventorySha256 } : {}),
        ...(bubblewrap?.mode === "bundled" ? { bubblewrapSha256: bubblewrap.sha256 } : {}),
      }),
    }),
  });
}

export function createCompiledLayoutModule(
  layout,
  { toolBundleDirectory, executableRelative = false } = {},
) {
  const freeze = `const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };\n`;
  if (!layout.toolBundle)
    return `${freeze}export const compiledLayout = freeze(${JSON.stringify(layout)});\n`;
  const root = executableRelative
    ? 'join(dirname(realpathSync(process.execPath)), "tools")'
    : JSON.stringify(toolBundleDirectory ?? layout.toolBundle.root);
  const commandNames = Object.keys(layout.toolBundle.commands);
  const hostNames = Object.keys(layout.hostTools ?? {});
  return `${freeze}import { dirname, join } from "node:path";\nimport { realpathSync } from "node:fs";\nconst root = ${root};\nconst paths = names => Object.freeze(Object.fromEntries(names.map(name => [name, join(root, "bin", name)])));\nexport const compiledLayout = freeze({...${JSON.stringify(layout)},toolBundle:Object.freeze({root,commands:paths(${JSON.stringify(commandNames)})}),hostTools:paths(${JSON.stringify(hostNames)})});\n`;
}
