import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export interface ExtensionDescriptor {
  readonly id: string;
  readonly label: string;
  readonly toolNames: readonly string[];
  readonly adminEnabled: boolean;
  readonly cliEnabled?: boolean;
}

export interface ExtensionPreferenceState extends ExtensionDescriptor {
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly source: "administrator" | "command-line" | "user" | "default";
}

export interface ExtensionPreferences {
  enabled(this: void, id: string): boolean;
  permitsTool(this: void, name: string): boolean;
  snapshot(this: void): readonly ExtensionPreferenceState[];
  setEnabled(this: void, id: string, enabled: boolean): Promise<void>;
}

interface Document {
  readonly version: 1;
  readonly extensions: Record<string, { readonly enabled: boolean }>;
}
const MAX_BYTES = 64 * 1024;
const MAX_EXTENSIONS = 256;
const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/u;
const updates = new Map<string, Promise<void>>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parse(value: unknown): Document {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== "version" && key !== "extensions") ||
    value.version !== 1 ||
    !record(value.extensions) ||
    Object.keys(value.extensions).length > MAX_EXTENSIONS
  )
    throw new Error("Invalid user extension preferences");
  const extensions: Document["extensions"] = {};
  for (const [id, preference] of Object.entries(value.extensions)) {
    if (
      !ID.test(id) ||
      !record(preference) ||
      Object.keys(preference).length !== 1 ||
      typeof preference.enabled !== "boolean"
    )
      throw new Error("Invalid user extension preferences");
    extensions[id] = Object.freeze({ enabled: preference.enabled });
  }
  return { version: 1, extensions };
}

async function read(path: string): Promise<Document> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, extensions: {} };
    throw new Error("Cannot read user extension preferences");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error();
    return parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))),
    );
  } catch {
    throw new Error("Invalid user extension preferences");
  } finally {
    await file.close();
  }
}

function serialized(path: string, update: () => Promise<void>): Promise<void> {
  const previous = updates.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(update);
  updates.set(path, next);
  void next
    .finally(() => {
      if (updates.get(path) === next) updates.delete(path);
    })
    .catch(() => undefined);
  return next;
}

/** Preferences select only the application-supplied inventory; they never load code. */
export async function loadExtensionPreferences(options: {
  readonly agentDir: string;
  readonly descriptors: readonly ExtensionDescriptor[];
  readonly onChange?: (id: string, enabled: boolean) => void;
}): Promise<ExtensionPreferences> {
  if (options.descriptors.length > MAX_EXTENSIONS) throw new Error("Too many optional extensions");
  const inventory = new Map<string, ExtensionDescriptor>();
  const toolOwners = new Map<string, string>();
  for (const descriptor of options.descriptors) {
    if (
      !ID.test(descriptor.id) ||
      inventory.has(descriptor.id) ||
      !descriptor.label.trim() ||
      Buffer.byteLength(descriptor.label) > 128 ||
      /[\p{Cc}\p{Cf}]/u.test(descriptor.label) ||
      typeof descriptor.adminEnabled !== "boolean" ||
      (descriptor.cliEnabled !== undefined && typeof descriptor.cliEnabled !== "boolean")
    )
      throw new Error("Invalid optional extension inventory");
    const toolNames = Object.freeze([...descriptor.toolNames]);
    for (const name of toolNames) {
      if (!TOOL.test(name) || toolOwners.has(name))
        throw new Error("Invalid optional extension tool inventory");
      toolOwners.set(name, descriptor.id);
    }
    inventory.set(descriptor.id, Object.freeze({ ...descriptor, toolNames }));
  }
  const directory = resolve(options.agentDir);
  const path = join(directory, "extensions.json");
  let document = await read(path);
  const state = (descriptor: ExtensionDescriptor): ExtensionPreferenceState => {
    const saved = Object.hasOwn(document.extensions, descriptor.id)
      ? document.extensions[descriptor.id]
      : undefined;
    return Object.freeze({
      ...descriptor,
      enabled: descriptor.adminEnabled && (descriptor.cliEnabled ?? saved?.enabled ?? true),
      editable: descriptor.adminEnabled && descriptor.cliEnabled === undefined,
      source: !descriptor.adminEnabled
        ? "administrator"
        : descriptor.cliEnabled !== undefined
          ? "command-line"
          : saved !== undefined
            ? "user"
            : "default",
    });
  };
  const enabled = (id: string): boolean => {
    const descriptor = inventory.get(id);
    return descriptor !== undefined && state(descriptor).enabled;
  };
  return {
    enabled,
    permitsTool(name) {
      const owner = toolOwners.get(name);
      return owner === undefined || enabled(owner);
    },
    snapshot: () => Object.freeze([...inventory.values()].map(state)),
    setEnabled(id, value) {
      const descriptor = inventory.get(id);
      if (descriptor === undefined) return Promise.reject(new Error("Unknown optional extension"));
      if (typeof value !== "boolean")
        return Promise.reject(new Error("Extension preference must be boolean"));
      const prior = state(descriptor);
      if (!prior.editable)
        return Promise.reject(
          new Error(
            prior.source === "administrator"
              ? `${descriptor.label} is unavailable under policy or tool selection`
              : `${descriptor.label} is controlled by the command line`,
          ),
        );
      return serialized(path, async () => {
        const latest = await read(path);
        const oldEnabled = enabled(id);
        const next = parse({
          version: 1,
          extensions: { ...latest.extensions, [id]: { enabled: value } },
        });
        const text = `${JSON.stringify(next, null, 2)}\n`;
        if (Buffer.byteLength(text) > MAX_BYTES)
          throw new Error("Extension preferences exceed size limit");
        await mkdir(directory, { recursive: true });
        const temporary = join(directory, `.extensions-${randomUUID()}.tmp`);
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(text);
          } finally {
            await file.close();
          }
          await rename(temporary, path);
          // Preserve this session's other choices; external writes are merged on
          // disk without silently changing its live tool exposure.
          document = {
            version: 1,
            extensions: { ...document.extensions, [id]: { enabled: value } },
          };
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
        if (oldEnabled !== enabled(id)) options.onChange?.(id, enabled(id));
      });
    },
  };
}
