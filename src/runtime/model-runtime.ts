import { join } from "node:path";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import {
  getAgentDir,
  ModelRuntime,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";
import { validatePersonalCredential } from "./model-auth.js";
import { ManagedCredentialStore } from "./model-auth-store.js";

export interface ManagedModelSnapshot {
  readonly models: Readonly<Record<string, unknown>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly personalProviders: readonly string[];
}

export interface ManagedModelRuntimeOptions extends CreateModelRuntimeOptions {
  readonly modelsConfig: Readonly<Record<string, unknown>>;
  readonly credentials: CredentialStore;
  readonly includeBuiltinCatalog: false;
  readonly authPolicy: {
    readonly environment: Readonly<Record<string, string>>;
    readonly personalProviders: readonly string[];
  };
  readonly readOnlyCredentials?: boolean;
}

export type ManagedModelRuntimeFactory = (
  options?: CreateModelRuntimeOptions & { readonly readOnlyCredentials?: boolean },
) => Promise<ModelRuntime>;

const FACTORY_OPTION_NAMES = new Set([
  "signal",
  "refreshOnCreate",
  "readOnlyCredentials",
  "allowModelNetwork",
]);

function assertFactoryOptions(options: Record<string, unknown>): void {
  for (const name of Object.keys(options)) {
    if (!FACTORY_OPTION_NAMES.has(name))
      throw new Error(`Managed model runtime does not permit the ${name} override`);
  }
  if (options.allowModelNetwork !== undefined && options.allowModelNetwork !== false)
    throw new Error("Managed model runtime does not permit network catalog discovery");
}

function catalogUsesRadius(models: Readonly<Record<string, unknown>>, providerId: string): boolean {
  const providers = models.providers as Record<string, { oauth?: unknown }> | undefined;
  return providers?.[providerId]?.oauth === "radius";
}

/** Static catalog/admission checks: no personal storage, interpolation, hardware or network. */
export async function validateManagedModelConfiguration(
  models: Readonly<Record<string, unknown>>,
  personalProviders: readonly string[],
): Promise<void> {
  const options: ManagedModelRuntimeOptions = {
    modelsConfig: models,
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    includeBuiltinCatalog: false,
    allowModelNetwork: false,
    refreshOnCreate: false,
    authPolicy: { environment: {}, personalProviders },
  };
  const runtime = await ModelRuntime.create(options);
  const error = runtime.getError();
  if (error !== undefined) throw new Error(error);
}

/** Every recreation receives the same object source and captured authentication authority. */
export function createManagedModelRuntimeFactory(
  snapshot: ManagedModelSnapshot,
): ManagedModelRuntimeFactory {
  const models = structuredClone(snapshot.models);
  const environment = Object.freeze({ ...snapshot.environment });
  const personalProviders = Object.freeze([...snapshot.personalProviders]);
  const googleJson = environment.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (googleJson !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(googleJson);
    } catch {
      throw new Error("Administrative Google credentials are not valid JSON");
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("type" in value) ||
      value.type !== "service_account" ||
      !("client_email" in value) ||
      typeof value.client_email !== "string" ||
      !value.client_email ||
      !("private_key" in value) ||
      typeof value.private_key !== "string" ||
      !value.private_key
    ) {
      throw new Error(
        "Administrative Google credentials require self-contained service-account JSON",
      );
    }
  }
  return async (options = {}) => {
    assertFactoryOptions(options as Record<string, unknown>);
    const credentials = new ManagedCredentialStore(
      join(getAgentDir(), "auth.json"),
      personalProviders,
      (id, value) => {
        const provider = runtime?.getProvider(id);
        if (!provider) throw new Error(`Personal authentication provider is unavailable: ${id}`);
        return validatePersonalCredential(
          provider,
          value,
          environment,
          catalogUsesRadius(models, id),
        );
      },
      options.readOnlyCredentials === true,
    );
    const managedOptions: ManagedModelRuntimeOptions = {
      modelsConfig: models,
      credentials,
      modelsStore: new InMemoryModelsStore(),
      includeBuiltinCatalog: false,
      allowModelNetwork: false,
      refreshOnCreate: false,
      authPolicy: { environment, personalProviders },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const runtime = await ModelRuntime.create(managedOptions);
    const error = runtime.getError();
    if (error !== undefined) throw new Error(error);
    if (options.refreshOnCreate !== false) {
      await runtime.refresh({
        allowNetwork: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
    return runtime;
  };
}
