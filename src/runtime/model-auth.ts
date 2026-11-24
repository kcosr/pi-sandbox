import type { Credential, Provider } from "@earendil-works/pi-ai";

const MAXIMUM_CREDENTIAL_STRING_BYTES = 256 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, empty = false): value is string {
  return (
    typeof value === "string" &&
    (empty || value.length > 0) &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= MAXIMUM_CREDENTIAL_STRING_BYTES
  );
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((name) => allowed.includes(name));
}

/** Validate raw native records without interpreting any key/token as configuration. */
export function validatePersonalCredential(
  provider: Provider,
  value: unknown,
  environment: Readonly<Record<string, string>>,
  radius: boolean,
): Credential {
  const invalid = () => new Error(`Invalid personal credential for provider ${provider.id}`);
  if (!record(value)) throw invalid();
  if (value.type === "oauth") {
    if (!provider.auth.oauth) throw invalid();
    const extra = radius
      ? ["scope"]
      : provider.id === "openai"
        ? ["clientId", "scopes"]
        : provider.id === "openai-codex"
          ? ["accountId"]
          : provider.id === "github-copilot"
            ? ["enterpriseUrl", "availableModelIds"]
            : [];
    if (
      !exactKeys(value, ["type", "access", "refresh", "expires", ...extra]) ||
      !text(value.access) ||
      !text(value.refresh, provider.id === "openrouter") ||
      typeof value.expires !== "number" ||
      !Number.isFinite(value.expires)
    ) {
      throw invalid();
    }
    for (const name of extra) {
      const field = value[name];
      if (field === undefined) continue;
      if (name === "scopes" || name === "availableModelIds") {
        const maximum = name === "scopes" ? 128 : 4096;
        if (!Array.isArray(field) || field.length > maximum || !field.every((entry) => text(entry)))
          throw invalid();
      } else if (!text(field)) throw invalid();
    }
    if (
      !radius &&
      provider.id === "openai" &&
      (!text(value.clientId) || !Array.isArray(value.scopes))
    )
      throw invalid();
    if (!radius && provider.id === "openai-codex" && !text(value.accountId)) throw invalid();
    return structuredClone(value) as unknown as Credential;
  }
  if (value.type !== "api_key" || !provider.auth.apiKey) throw invalid();
  if (!exactKeys(value, ["type", "key", "env"])) throw invalid();
  if (value.key !== undefined && !text(value.key)) throw invalid();
  const fields = value.env === undefined ? {} : value.env;
  if (!record(fields) || !Object.values(fields).every((entry) => text(entry))) throw invalid();
  const sourceFields =
    provider.id === "amazon-bedrock"
      ? ["AWS_PROFILE"]
      : provider.id === "google-vertex"
        ? ["GOOGLE_APPLICATION_CREDENTIALS"]
        : [];
  const routingFields =
    provider.id === "google-vertex"
      ? ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"]
      : provider.id === "cloudflare-workers-ai"
        ? ["CLOUDFLARE_ACCOUNT_ID"]
        : provider.id === "cloudflare-ai-gateway"
          ? ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]
          : [];
  if (!exactKeys(fields, [...sourceFields, ...routingFields])) throw invalid();
  for (const name of routingFields) {
    if (fields[name] === undefined) continue;
    const expected =
      name === "GOOGLE_CLOUD_PROJECT"
        ? (environment.GOOGLE_CLOUD_PROJECT ?? environment.GCLOUD_PROJECT)
        : environment[name];
    if (!expected) throw new Error(`Provider ${provider.id} requires administrative ${name}`);
    if (fields[name] !== expected)
      throw new Error(`Personal credential cannot change administrative ${name}`);
  }
  if (provider.id === "amazon-bedrock") {
    if (value.key === undefined && !text(fields.AWS_PROFILE))
      throw new Error("Amazon Bedrock requires an explicit stored bearer token or AWS profile");
    if (value.key !== undefined && Object.keys(fields).length > 0) throw invalid();
  } else if (provider.id === "google-vertex") {
    if (value.key === undefined) {
      if (!text(fields.GOOGLE_CLOUD_PROJECT) || !text(fields.GOOGLE_CLOUD_LOCATION))
        throw invalid();
    } else if (Object.keys(fields).length > 0) throw invalid();
  } else if (value.key === undefined) throw invalid();
  return structuredClone(value) as unknown as Credential;
}
