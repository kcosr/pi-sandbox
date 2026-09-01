import { lstat } from "node:fs/promises";
import path from "node:path";
import { domainToASCII } from "node:url";

import {
  defineManagedExtension,
  defineManagedHostEnvironment,
  defineManagedTool,
  freezeExtensionConfig,
  type FrozenJsonObject,
  type JsonObject,
  type ManagedToolExecutionContext,
} from "../sdk.js";

const GIT_EXECUTABLE = "/usr/bin/git";
const SSH_EXECUTABLE = "/usr/bin/ssh";
const ALLOWED_SCHEMES = Object.freeze(["http", "https", "ssh"] as const);
const CONFIG_KEYS = Object.freeze(["allowed_hosts", "allowed_schemes"] as const);

type GitScheme = (typeof ALLOWED_SCHEMES)[number];

interface GitCloneArguments extends JsonObject {
  readonly repository: string;
}

interface GitCloneConfig extends JsonObject {
  readonly allowed_hosts: readonly string[];
  readonly allowed_schemes: readonly GitScheme[];
}

interface ParsedRepository {
  readonly host: string;
  readonly scheme: GitScheme;
  readonly destinationName: string;
}

export const gitCloneExtension = defineManagedExtension({
  kind: "managed",
  apiVersion: 3,
  id: "git",
  version: "1.1.0",
  hostEnvironment: defineManagedHostEnvironment({
    variables: [],
    removeInherited: ["SSH_ASKPASS"],
    removeInheritedPrefixes: ["GIT_"],
    fixed: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_SSH: SSH_EXECUTABLE,
      GIT_SSH_VARIANT: "ssh",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS_REQUIRE: "never",
    },
  }),
  parseConfig: parseGitCloneConfig,
  requiredHostExecutables: (config: FrozenJsonObject) => {
    const parsed = readConfig(config);
    return Object.freeze([
      GIT_EXECUTABLE,
      ...(parsed.allowed_schemes.includes("ssh") ? [SSH_EXECUTABLE] : []),
    ]);
  },
  tools: Object.freeze([
    defineManagedTool<GitCloneArguments>({
      name: "git_clone",
      label: "Git clone",
      description:
        "Clone an administrator-approved HTTP or SSH Git repository into a derived directory under the launch directory. The destination and Git options cannot be selected.",
      promptSnippet: "Clone a repository from an approved Git host",
      promptGuidelines: Object.freeze([
        "Pass only the repository locator; the destination is derived from its repository name.",
      ]),
      diagnosticScope: "git.clone",
      executionMode: "sequential",
      parameters: Object.freeze({
        type: "object",
        properties: Object.freeze({
          repository: Object.freeze({
            type: "string",
            minLength: 1,
            maxLength: 8192,
            description: "HTTP(S), ssh://, or SCP-style SSH repository locator",
          }),
        }),
        required: Object.freeze(["repository"]),
        additionalProperties: false,
      }),
      formatCall(arguments_) {
        return typeof arguments_.repository === "string" ? arguments_.repository : undefined;
      },
      async execute(arguments_, context) {
        return executeGitClone(arguments_, context);
      },
    }),
  ]),
});

export default gitCloneExtension;

export function parseGitCloneConfig(raw: unknown, configPath: string): FrozenJsonObject {
  if (!isPlainObject(raw)) throw new Error(`${configPath} must be a table`);
  const keys = Object.keys(raw).sort();
  if (keys.length !== CONFIG_KEYS.length || keys.some((key, index) => key !== CONFIG_KEYS[index])) {
    const unknown = keys.find((key) => !(CONFIG_KEYS as readonly string[]).includes(key));
    if (unknown !== undefined)
      throw new Error(`${configPath}.${unknown} is not a recognized field`);
    const missing = CONFIG_KEYS.find((key) => !Object.hasOwn(raw, key));
    throw new Error(`${configPath}.${missing ?? "configuration"} is required`);
  }

  const allowedHosts = parseAllowedHosts(raw.allowed_hosts, `${configPath}.allowed_hosts`);
  const allowedSchemes = parseAllowedSchemes(raw.allowed_schemes, `${configPath}.allowed_schemes`);
  return freezeExtensionConfig({
    allowed_hosts: allowedHosts,
    allowed_schemes: allowedSchemes,
  });
}

async function executeGitClone(
  arguments_: Readonly<GitCloneArguments>,
  context: ManagedToolExecutionContext,
) {
  if (typeof arguments_.repository !== "string") throw new Error("repository must be a string");
  const config = readConfig(context.config);
  const parsed = parseRepository(arguments_.repository);
  if (!config.allowed_schemes.includes(parsed.scheme)) {
    throw new Error(`git clone scheme is not allowed: ${parsed.scheme}`);
  }
  if (!config.allowed_hosts.includes(parsed.host)) {
    throw new Error(`git clone host is not allowed: ${parsed.host}`);
  }

  const destination = path.resolve(context.cwd, parsed.destinationName);
  if (path.dirname(destination) !== context.cwd) {
    throw new Error("derived Git clone destination is outside the launch directory");
  }
  await requireAbsent(destination);

  const protocolPolicy = config.allowed_schemes.flatMap((scheme) => [
    "-c",
    `protocol.${scheme}.allow=always`,
  ]);
  const result = await context.host.execute(
    {
      argv: [
        GIT_EXECUTABLE,
        "-c",
        "protocol.allow=never",
        ...protocolPolicy,
        "clone",
        "--",
        arguments_.repository,
        destination,
      ],
    },
    { signal: context.signal },
  );
  const stdout = decode(result.stdout).trim();
  const stderr = decode(result.stderr).trim();
  if (result.exitCode !== 0) {
    const diagnostic = stderr || stdout || `terminated by ${result.signal ?? "unknown signal"}`;
    throw new Error(`git clone failed: ${diagnostic}`);
  }

  const detail = stderr || stdout;
  return {
    content: [
      {
        type: "text" as const,
        text: `Cloned repository into ${parsed.destinationName}.${detail ? `\n\n${detail}` : ""}`,
      },
    ],
    details: undefined,
  };
}

function parseRepository(repository: string): ParsedRepository {
  if (
    repository.length === 0 ||
    Buffer.byteLength(repository) > 8192 ||
    repository.includes("\\") ||
    hasControlCharacter(repository)
  ) {
    throw new Error("repository locator is invalid");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/u.test(repository)) {
    throw new Error("Git remote-helper repository locators are not supported");
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(repository)) {
    return parseUrlRepository(repository);
  }
  return parseScpRepository(repository);
}

function parseUrlRepository(repository: string): ParsedRepository {
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    throw new Error("repository URL is invalid");
  }
  const scheme = url.protocol.slice(0, -1);
  if (!(ALLOWED_SCHEMES as readonly string[]).includes(scheme)) {
    throw new Error(`Git repository scheme is not supported: ${scheme || "missing"}`);
  }
  if (url.password.length > 0) throw new Error("repository URL must not contain a password");
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("repository URL must not contain a query or fragment");
  }
  const host = canonicalizeParsedHost(url.hostname);
  return {
    scheme: scheme as GitScheme,
    host,
    destinationName: deriveDestinationName(url.pathname, true),
  };
}

function parseScpRepository(repository: string): ParsedRepository {
  if (/^(?:file|git|http|https|ssh):/iu.test(repository)) {
    throw new Error("repository locator must use a supported URL or SCP-style SSH form");
  }
  const separator = scpPathSeparator(repository);
  if (separator <= 0) {
    throw new Error("local Git repository paths are not supported");
  }
  const authority = repository.slice(0, separator);
  const remotePath = repository.slice(separator + 1);
  if (
    authority.includes("/") ||
    authority.includes("\\") ||
    remotePath.includes("?") ||
    remotePath.includes("#")
  ) {
    throw new Error("SCP-style repository locator is invalid");
  }
  const at = authority.lastIndexOf("@");
  const username = at < 0 ? undefined : authority.slice(0, at);
  const rawHost = authority.slice(at + 1);
  if (username !== undefined && (username.length === 0 || username.startsWith("-"))) {
    throw new Error("SCP-style repository username is invalid");
  }
  return {
    scheme: "ssh",
    host: canonicalizeParsedHost(rawHost),
    destinationName: deriveDestinationName(remotePath, false),
  };
}

function scpPathSeparator(repository: string): number {
  const bracket = repository.indexOf("[");
  if (bracket >= 0) {
    const close = repository.indexOf("]", bracket + 1);
    if (close < 0) return -1;
    return repository.indexOf(":", close + 1);
  }
  return repository.indexOf(":");
}

function deriveDestinationName(repositoryPath: string, decode: boolean): string {
  const withoutTrailingSlash = repositoryPath.replace(/\/+$/u, "");
  const finalSlash = withoutTrailingSlash.lastIndexOf("/");
  let name = withoutTrailingSlash.slice(finalSlash + 1);
  if (decode) {
    try {
      name = decodeURIComponent(name);
    } catch {
      throw new Error("repository basename has invalid URL encoding");
    }
  }
  if (name.endsWith(".git")) name = name.slice(0, -4);
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    hasControlCharacter(name) ||
    Buffer.byteLength(name) > 255
  ) {
    throw new Error("repository basename cannot produce a safe destination directory");
  }
  return name;
}

function parseAllowedHosts(value: unknown, configPath: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${configPath} must be a nonempty array of host strings`);
  }
  const hosts = value as string[];
  const canonical = hosts.map((host, index) => {
    const normalized = canonicalizeConfiguredHost(host);
    if (host !== normalized) {
      throw new Error(`${configPath}[${index}] must be a lowercase canonical IDNA hostname`);
    }
    return normalized;
  });
  if (new Set(canonical).size !== canonical.length) {
    throw new Error(`${configPath} must not contain duplicates`);
  }
  return Object.freeze(canonical);
}

function parseAllowedSchemes(value: unknown, configPath: string): readonly GitScheme[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${configPath} must be a nonempty array of scheme strings`);
  }
  const schemes = value as string[];
  for (const [index, scheme] of schemes.entries()) {
    if (!(ALLOWED_SCHEMES as readonly string[]).includes(scheme)) {
      throw new Error(`${configPath}[${index}] must be one of: ${ALLOWED_SCHEMES.join(", ")}`);
    }
  }
  if (new Set(schemes).size !== schemes.length) {
    throw new Error(`${configPath} must not contain duplicates`);
  }
  return Object.freeze([...schemes] as GitScheme[]);
}

function canonicalizeConfiguredHost(host: string): string {
  if (host.length === 0 || hasControlCharacter(host)) throw new Error("hostname is invalid");
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}/`);
  } catch {
    throw new Error("hostname is invalid");
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("hostname is invalid");
  }
  return canonicalizeParsedHost(parsed.hostname);
}

function canonicalizeParsedHost(host: string): string {
  const withoutTrailingDot = host.endsWith(".") ? host.slice(0, -1) : host;
  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  if (ascii.length === 0 || hasControlCharacter(ascii))
    throw new Error("repository hostname is invalid");
  return ascii;
}

function readConfig(config: FrozenJsonObject): GitCloneConfig {
  const hosts = config.allowed_hosts;
  const schemes = config.allowed_schemes;
  if (!Array.isArray(hosts) || !Array.isArray(schemes)) {
    throw new Error("Git clone extension configuration is invalid");
  }
  return config as unknown as GitCloneConfig;
}

async function requireAbsent(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Git clone destination already exists: ${path.basename(destination)}`);
}

function decode(value: Uint8Array): string {
  return Buffer.from(value).toString("utf8");
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
