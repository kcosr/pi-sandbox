import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";

export const MAXIMUM_PERSONAL_CREDENTIAL_BYTES = 1024 * 1024;

interface LockedBackend {
  withLockAsync<T>(
    callback: (current: string | undefined) => Promise<{ result: T; next?: string }>,
    options?: AuthOperationOptions,
  ): Promise<T>;
}

type BackendConstructor = new (
  path: string,
  options: { maximumBytes: number; atomicWrites: true },
) => LockedBackend;

function parseDocument(content: string | undefined): Record<string, unknown> {
  if (content === undefined) return {};
  if (Buffer.byteLength(content) > MAXIMUM_PERSONAL_CREDENTIAL_BYTES)
    throw new Error("Personal credential storage exceeds its bounds");
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Personal credential storage is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Personal credential storage must be an object");
  return value as Record<string, unknown>;
}

async function readDocument(path: string): Promise<Record<string, unknown>> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Personal credential storage could not be read");
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAXIMUM_PERSONAL_CREDENTIAL_BYTES)
      throw new Error("Personal credential storage exceeds its bounds");
    const buffer = Buffer.alloc(MAXIMUM_PERSONAL_CREDENTIAL_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAXIMUM_PERSONAL_CREDENTIAL_BYTES)
      throw new Error("Personal credential storage exceeds its bounds");
    return parseDocument(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)),
    );
  } finally {
    await file.close();
  }
}

/** Raw admitted records; this store never calls stock AuthStorage.read or interpolation. */
export class ManagedCredentialStore implements CredentialStore {
  private readonly admitted: ReadonlySet<string>;
  private backend: LockedBackend | undefined;

  constructor(
    private readonly path: string,
    providers: readonly string[],
    private readonly validate: (provider: string, record: unknown) => Credential,
    private readonly readOnly = false,
    private readonly backendFactory?: () => LockedBackend,
  ) {
    this.admitted = new Set(providers);
  }

  private assertWritable(provider: string): void {
    if (!this.admitted.has(provider))
      throw new Error(`Provider ${provider} is administrator-managed`);
    if (this.readOnly) throw new Error("Read-only credential inspection cannot modify storage");
  }

  private locked(): LockedBackend {
    if (this.backend) return this.backend;
    if (this.backendFactory) return (this.backend = this.backendFactory());
    const constructor = (pi as unknown as { FileAuthStorageBackend?: BackendConstructor })
      .FileAuthStorageBackend;
    if (!constructor) throw new Error("Pi does not provide bounded atomic credential storage");
    return (this.backend = new constructor(this.path, {
      maximumBytes: MAXIMUM_PERSONAL_CREDENTIAL_BYTES,
      atomicWrites: true,
    }));
  }

  async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    if (!this.admitted.has(provider)) return undefined;
    const document = await readDocument(this.path);
    options?.signal?.throwIfAborted();
    return Object.hasOwn(document, provider)
      ? this.validate(provider, document[provider])
      : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    if (this.admitted.size === 0) return [];
    const document = await readDocument(this.path);
    options?.signal?.throwIfAborted();
    const result: CredentialInfo[] = [];
    for (const providerId of this.admitted) {
      if (!Object.hasOwn(document, providerId)) continue;
      // Metadata enumeration must not make a corrupt record disable unrelated providers.
      // Direct reads still report the validation error, without administrative fallback.
      try {
        const credential = this.validate(providerId, document[providerId]);
        result.push({ providerId, type: credential.type });
      } catch {
        continue;
      }
    }
    return result;
  }

  async modify(
    provider: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    this.assertWritable(provider);
    return this.locked().withLockAsync(async (content) => {
      const document = parseDocument(content);
      let current: Credential | undefined;
      if (Object.hasOwn(document, provider)) {
        try {
          current = this.validate(provider, document[provider]);
        } catch {
          // A fresh explicit login can repair an invalid record. Refresh callbacks
          // see absence and cannot refresh it; ordinary reads still fail closed.
          current = undefined;
        }
      }
      const next = await fn(current);
      if (next === undefined) return { result: current };
      const validated = this.validate(provider, next);
      return {
        result: validated,
        next: JSON.stringify({ ...document, [provider]: validated }, null, 2),
      };
    }, options);
  }

  async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
    this.assertWritable(provider);
    await this.locked().withLockAsync((content) => {
      const document = parseDocument(content);
      delete document[provider];
      return Promise.resolve({ result: undefined, next: JSON.stringify(document, null, 2) });
    }, options);
  }
}
