# Models and authentication

## Administrative model catalog

The build-selected configuration source supplies the complete catalog. A service
build obtains the parsed catalog in its authenticated bootstrap response. A local
build reads the required absolute `models_file` in its selected TOML policy, as
the invoking user. Both paths validate the same strict Pi catalog object and
pass one immutable in-memory snapshot to Pi. Refresh, session replacement and
managed children reuse that snapshot; they do not reread a file or fetch policy.
A new application process obtains new administrative inputs.

Pi's internal model catalog, user `models.json`, persistent model caches and
OpenRouter's downloaded catalog cannot add providers or models. Neither
`PI_CODING_AGENT_DIR` nor Pi settings redirect the administrative source. Only a
local distribution compiled with `allow_config_override = true` accepts a leading
`--config FILE`; that capability delegates policy choice to its caller.

The public local distribution includes one unauthenticated localhost model as a
schema example. Administrators replace it with their deployment's catalog.
User-owned additions or merges into an administrator catalog are not supported.

## Provider example

```toml
[model_auth]
personal_providers = []

[environment.pi]
MODEL_TOKEN = { file = "/etc/pi-sandbox/secrets/model-token" }
MODEL_USER = "{{username}}"
```

```json
{
  "providers": {
    "managed-openai-compatible": {
      "baseUrl": "https://models.example.net/v1",
      "api": "openai-completions",
      "apiKey": "$MODEL_TOKEN",
      "headers": { "X-Agent-Access-User": "$MODEL_USER" },
      "models": [
        {
          "id": "example-model",
          "name": "Example Model",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Provider and model fields follow the pinned Pi release's `models.json` schema.
The optional `$schema` editor hint is accepted without fetching a schema. Unknown
APIs, malformed catalogs and forbidden authentication expressions fail startup.
For OpenAI-compatible completions, the client sends the resolved key as a bearer
value; explicitly configured provider/model headers are retained.

When configured providers share a model ID, use `--model provider/model` to
resolve ambiguity. Pi also retains explicit custom model-ID behavior within a
configured provider. The configured catalog controls discovery, not the provider
service's model-ID authorization; that service must enforce its own access limits.

## Administrative credentials

Both configuration profiles use the same authentication rules. Model config
values may be literal strings or `$VARIABLE` references to the captured,
expanded `environment.pi` map. Ambient shell variables never repair a missing
key or header, and later `process.env` changes do not alter the snapshot.
Command expressions beginning with `!` are rejected in provider keys, provider
headers, model headers and `modelOverrides` headers, including unused entries.
Resolved bytes are opaque and are never interpolated or executed again.

A missing administrative key makes that credential source unavailable. A missing
provider header makes that provider unavailable; a missing model header hides
only that model. Another usable configured provider or sibling model remains
available. Diagnostics identify the provider/model and missing variable name,
without exposing values.

By default, authentication uses only the administrative snapshot. The launcher
rejects `--api-key`; SDK/runtime key and authentication-environment overrides are
also rejected. Native SDK defaults cannot introduce shell keys, arbitrary profiles,
ADC discovery or metadata credentials. Configured unauthenticated/proxy modes
remain supported. Pi-scoped values stay out of sandbox commands and managed
extension commands except through their explicit credential projection rules.

The service-access Basic credential is separate from model-provider credentials.
It is compiled into service builds (or a local build's optional audit endpoint)
and cannot come from returned policy. See [managed service](managed-service.md).

Pi's ordinary model-transport proxy settings remain available. They relay requests
to the configured provider origin; they do not select a catalog or supply a
missing managed credential. Configuration and audit service connections use their
own fixed endpoint and trust settings and ignore these proxy settings.

## Personal credentials

Personal authentication requires explicit main-policy admission for each
configured provider:

```toml
[model_auth]
personal_providers = ["anthropic", "amazon-bedrock"]
```

The default list is empty. The list cannot be supplied by account rules and must
name providers in every catalog selectable by those rules. `/login`, `/logout`
and native `auth` commands honor that admission. Native provider methods remain
available where their configured endpoint and routing are compatible. Authored
`oauth: "radius"` also requires admission rather than being silently ignored.

An admitted stored personal credential wins over the administrative credential.
Absence falls back to the configured administrative source; invalid credentials
or refresh/authentication failures do not. Personal records cannot add providers,
models, arbitrary environment variables or routing overrides. Native methods that
repeat a region/project/location must agree with administrative settings; missing
required administrative routing makes the provider unavailable. Authentication
headers cannot conflict with configured headers, and OAuth-derived endpoints
must match the effective configured endpoint for every model of the provider.

The managed store reads bounded regular UTF-8 `auth.json` data under Pi's user
state directory. Keys and OAuth tokens are literal data, including strings that
look like `$VARIABLE` or `!command`. Unadmitted provider records are not resolved;
writes preserve unrelated records and use locking with atomic replacement.
Read-only `auth check --no-refresh` does not mutate or refresh credentials.
`auth print-api-key --model ...` also discovers administrative providers without
requiring a personal store entry. Explicit credential-printing commands reveal
the selected credential to their caller by design.

## Cloud provider sources

Bedrock supports explicit administrative bearer/access-key credentials and its
configured proxy mode. Personal opt-in retains an explicitly selected native AWS
profile, including supported role, SSO and web-identity profiles. Profile files
are read with bounds from the OS account home, and selected source-profile chains
are checked before loading. `credential_process`, environment credential sources,
cycles and the unconstrained default-chain login choice are rejected. Model
region and endpoint remain administrative; SDK endpoint environment overrides
cannot redirect requests.

Vertex supports explicit administrative keys or self-contained service-account
JSON in `GOOGLE_APPLICATION_CREDENTIALS_JSON`. Malformed configured JSON fails
startup even if a personal credential is available. Personal opt-in retains an
explicitly selected credentials file or native ADC-file choice, including native
non-executable supported credential types and external-account authorized-user ADC.
Selected AWS federation uses the file's explicit metadata source without repairing
its identity or region from ambient AWS values. Executable credential sources are
rejected. Explicit administrative project/location and endpoint remain fixed;
there is no ambient ADC or metadata fallback.

OAuth login and refresh use the same captured environment for supported host and
callback settings. Native OAuth state/token refresh behavior is retained without
import-time shell-variable overrides. Cloud and OAuth network operations occur
only for explicitly selected admitted credential methods, not catalog validation.

## Account and machine values

Use `{{username}}`/`{{uid}}` in authored Pi environment strings for the invoking
OS account. On macOS, optional `{{machine_id}}` expands the host hardware UUID.
The catalog itself is not macro-expanded. File-derived values remain literal.
A required unavailable machine ID fails resolution; unused macros do no lookup.
These identifiers are copyable values, not credentials or device attestation.
An endpoint must separately authenticate and authorize any asserted identity.

## Troubleshooting

Use `/sandbox` to identify the configuration source and selected workspace mode.
For a local source, inspect its reported TOML and catalog paths; for a service
source, inspect the listener's administrative files on the service host. A new
process is required after administrative edits. Confirm required key and header
names are in `environment.pi`, rather than exporting a shell variable. For
personal login, confirm the provider is configured and explicitly admitted.
Malformed catalogs fail startup; unavailable credentials leave only the affected
providers/models unavailable. No error triggers a local or built-in fallback.

## Session export

External session sharing is disabled. `/share` is not advertised and returns a
disabled message. Native `/export` remains available for HTML or JSONL output;
the separate user-only `/sandbox save` feature follows its own policy and audit
contract.
