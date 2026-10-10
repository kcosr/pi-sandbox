import { lstat } from "node:fs/promises";
import path from "node:path";
import { domainToASCII } from "node:url";

export const GIT_EXECUTABLE = "/usr/bin/git";
export const SSH_EXECUTABLE = "/usr/bin/ssh";
const ALLOWED_SCHEMES = Object.freeze(["http", "https", "ssh"] as const);
const CONFIG_KEYS = Object.freeze(["allowed_hosts", "allowed_schemes"] as const);
export type GitScheme = (typeof ALLOWED_SCHEMES)[number];

export interface GitCloneArguments {
  readonly [key: string]: string;
  readonly repository: string;
}
export interface GitCloneConfig {
  readonly [key: string]: readonly string[];
  readonly allowed_hosts: readonly string[];
  readonly allowed_schemes: readonly GitScheme[];
}
export interface GitExecutionPort {
  execute(
    request: { readonly argv: readonly [string, ...string[]] },
    options?: { readonly signal?: AbortSignal },
  ): Promise<{
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
  }>;
}
export interface GitCloneRuntime {
  /** Canonical host launch directory; not an arbitrary attached guest path. */
  readonly cwd: string;
  readonly config: GitCloneConfig;
  /** Borrowed executor with bounded output, timeout and cancellation support. */
  readonly host: GitExecutionPort;
}
export interface GitCloneContext extends GitCloneRuntime {
  readonly signal?: AbortSignal;
}
interface ParsedRepository {
  readonly host: string;
  readonly scheme: GitScheme;
  readonly destinationName: string;
}

export const GIT_HOST_ENVIRONMENT = Object.freeze({
  variables: Object.freeze([] as string[]),
  removeInherited: Object.freeze(["SSH_ASKPASS"]),
  removeInheritedPrefixes: Object.freeze(["GIT_"]),
  fixed: Object.freeze({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_SSH: SSH_EXECUTABLE,
    GIT_SSH_VARIANT: "ssh",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS_REQUIRE: "never",
  }),
});

export function gitHostEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...Object.fromEntries(
      Object.entries(source).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !entry[0].startsWith("PI_SANDBOX_") &&
          !GIT_HOST_ENVIRONMENT.removeInherited.includes(entry[0]) &&
          !GIT_HOST_ENVIRONMENT.removeInheritedPrefixes.some((prefix) =>
            entry[0].startsWith(prefix),
          ),
      ),
    ),
    ...GIT_HOST_ENVIRONMENT.fixed,
  });
}

export function requiredGitExecutables(config: GitCloneConfig): readonly string[] {
  return Object.freeze([
    GIT_EXECUTABLE,
    ...(config.allowed_schemes.includes("ssh") ? [SSH_EXECUTABLE] : []),
  ]);
}

export const GIT_CLONE_TOOL = Object.freeze({
  name: "git_clone",
  label: "Git clone",
  description:
    "Clone an approved HTTP or SSH Git repository into a derived directory under the launch directory. The destination and Git options cannot be selected.",
  promptSnippet: "Clone a repository from an approved Git host",
  promptGuidelines: Object.freeze([
    "Pass only the repository locator; the destination is derived from its repository name.",
  ]),
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
} as const);

/** A bounded, single-line summary that does not render control sequences. */
export function gitCloneCallSummary(arguments_: unknown): string | undefined {
  if (!isPlainObject(arguments_)) return undefined;
  const repository = arguments_.repository;
  if (
    typeof repository !== "string" ||
    !repository.trim() ||
    hasControlCharacter(repository) ||
    Buffer.byteLength(repository) > 1024
  )
    return undefined;
  return repository;
}

export function parseGitCloneArguments(raw: unknown): Readonly<GitCloneArguments> {
  if (
    !isPlainObject(raw) ||
    Object.keys(raw).length !== 1 ||
    !Object.hasOwn(raw, "repository") ||
    typeof raw.repository !== "string"
  )
    throw new Error("Git clone accepts only a repository string");
  return Object.freeze({ repository: raw.repository });
}

export function parseGitCloneConfig(
  raw: unknown,
  configPath = "Git configuration",
): GitCloneConfig {
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
  return Object.freeze({
    allowed_hosts: allowedHosts,
    allowed_schemes: allowedSchemes,
  });
}

export async function executeGitClone(
  arguments_: Readonly<GitCloneArguments>,
  context: GitCloneContext,
) {
  const { repository } = parseGitCloneArguments(arguments_);
  if (!context.host || typeof context.host.execute !== "function")
    throw new Error("Git requires an explicit host execution port");
  if (!path.isAbsolute(context.cwd) || path.normalize(context.cwd) !== context.cwd)
    throw new Error("Git requires a canonical absolute launch directory");
  const config = parseGitCloneConfig(context.config);
  context.signal?.throwIfAborted();
  const parsed = parseRepository(repository);
  if (!config.allowed_schemes.includes(parsed.scheme)) {
    throw new Error(`git clone scheme is not allowed: ${parsed.scheme}`);
  }
  if (!config.allowed_hosts.includes(parsed.host)) {
    throw new Error(`git clone host is not allowed: ${parsed.host}`);
  }

  const destination = gitCloneTarget(repository, context.cwd);
  await requireAbsent(destination);

  context.signal?.throwIfAborted();
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
        repository,
        destination,
      ],
    },
    context.signal === undefined ? {} : { signal: context.signal },
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

export function gitCloneTarget(repository: string, cwd: string): string {
  const parsed = parseRepository(repository);
  const destination = path.resolve(cwd, parsed.destinationName);
  if (path.dirname(destination) !== cwd)
    throw new Error("derived Git clone destination is outside the launch directory");
  return destination;
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
