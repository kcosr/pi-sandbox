# Models and authentication

## Administrative model catalog

Pi Sandbox does not use Pi's internal model catalog. It loads the complete
catalog from the absolute `models_file` in the selected TOML policy. By default,
that policy is the distribution's compiled `config_dir/config.toml`, normally:

```toml
models_file = "/etc/pi-sandbox/models.json"
```

A build with `allow_config_override = true` permits an explicit leading
`--config FILE` to select a different TOML and therefore a different
`models_file`. The model path remains absolute. Managed builds reject the CLI
option. Environment variables, Pi settings, and automatic project discovery
cannot redirect either path. When broker mode is enabled,
the root-managed drop-in for the calling UID may select another catalog.
`--model` can select only a model from the effective catalog.

Files under the compiled `libexec_dir/defaults/` are installation templates,
not runtime configuration. A normal upgrade preserves the active files under
the compiled `config_dir`; `install.sh --replace-config` explicitly backs them up and
replaces them with the packaged defaults.

See [user and group environment and overrides](identity-broker.md) for optional broker
drop-ins, startup failure behavior, and use of arbitrary root-managed `pi`-scoped
variables in `apiKey` or custom provider headers.

The packaged catalog contains one unauthenticated localhost model as a functional
schema example. Administrators are expected to replace it with the deployment's
actual model definitions.

## Provider example

```json
{
  "providers": {
    "managed-openai-compatible": {
      "baseUrl": "https://models.example.net/v1",
      "api": "openai-completions",
      "apiKey": "$MANAGED_API_KEY",
      "models": [
        {
          "id": "example-model",
          "name": "Example Model",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 8192,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

Provider and model fields follow the pinned Pi release's `models.json` schema.
Pi Sandbox validates the file at startup and fails rather than combining it
with built-in models.

## API keys

`apiKey` supports Pi's standard value resolution:

- Environment variable: `"apiKey": "$MANAGED_API_KEY"`
- Host-side command: `"apiKey": "!cat ~/.config/example/token"`
- Literal value: `"apiKey": "secret"` (not recommended for packaged catalogs)

Environment variables must be present in the `pi-sandbox` host process. They
may come from the invoking environment or the effective configured
`environment.pi` scope. Managed values overlay same-named ambient values while
Pi runs and are restored afterward. Pi-scoped values are used by host-side
provider requests and are excluded from sandboxed tools, shell commands, and
managed extension host commands.

Commands beginning with `!` run host-side as the invoking user. Use a trusted,
bounded command and ensure it prints only the key. This is useful when a key is
stored in a user-readable file or secret manager. There is no separate
`apiKeyFile` field.

For `api: "openai-completions"`, the resolved API key is sent as:

```http
Authorization: Bearer <api-key>
```

The `openai-completions` client supplies this header automatically.
`authHeader: true` explicitly requests the same header for custom provider
composition. Other provider headers may be configured in `headers`.

Pi's user credential store remains under `PI_CODING_AGENT_DIR` and may also
supply credentials through Pi's login flow. The administrator-selected model
catalog remains fixed regardless of the user-state directory.

## Troubleshooting

If Pi reports that no models are available:

1. Confirm which catalog is active:

   ```sh
   grep '^models_file' /etc/pi-sandbox/config.toml
   ```

2. Inspect that active file, not the template under `/usr/libexec`:

   ```sh
   jq '.providers | keys' /etc/pi-sandbox/models.json
   ```

3. For an environment-based key, either export it in the process environment
   used to launch Pi Sandbox or configure that name under the effective
   global `environment.pi` scope in `/etc/pi-sandbox/config.toml`, optionally
   overridden in `/etc/pi-sandbox/users.d/*.toml` and `/etc/pi-sandbox/groups.d/*.toml`.

4. For a command-based key, run the command as the invoking user and verify that
   it exits successfully and prints only the key.

Missing authentication can leave configured models unavailable. Invalid JSON,
schema or composition errors, and an unreadable catalog cause startup to fail
instead of falling back to other models.

## Session export

External session sharing is disabled in the managed distribution. `/share` is
not advertised and returns a disabled message if entered. Local `/export`
remains available for HTML or JSONL output.
