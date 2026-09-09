# Per-user environment and overrides

On Linux, Pi Sandbox can optionally resolve administrator-managed settings for
the Unix user that launches it. A root systemd socket service identifies the
caller with Linux `SO_PEERCRED` and, when present, reads only
`<config_dir>/users.d/<uid>.toml`. It returns that UID's environment and
override patch. The Bun `pi-sandbox` application is the client; the broker is
not a launcher or wrapper.

Global policy and global scoped environment belong in
`<config_dir>/config.toml`. There is no `users.toml`, `users.json`, or
`defaults.toml`. The `users.d` directory and every per-UID file are optional. A
missing directory or missing matching file means that the main configuration
is inherited unchanged.

The broker is not built or packaged on macOS. macOS direct-mode configuration
must use `identity.mode = "disabled"` and therefore uses only the main
configuration.

## Enabling the broker

Configure broker mode in the distribution's `config_dir/config.toml`:

```toml
[identity]
mode = "broker"
```

Broker mode always uses the root-managed socket compiled from the distribution
manifest; runtime configuration cannot redirect it.

Create the optional drop-in directory and a per-UID file only when that UID
needs a patch:

```sh
sudo install -d -o root -g root -m 0755 /etc/pi-sandbox/users.d
sudo install -o root -g root -m 0600 1000.toml /etc/pi-sandbox/users.d/1000.toml
sudo systemctl daemon-reload
sudo systemctl enable --now pi-sandbox-identity-broker.socket
```

The directory must be owned by root and must not be writable by group or
others. Each drop-in must be a root-owned regular file with mode `0600` and
must not be a symlink. `/etc`, `/etc/pi-sandbox`, and the fixed
`/run/pi-sandbox-identity` socket directory must remain root-controlled.

The release installs the broker executable and systemd units but never creates,
replaces, backs up, or removes `users.d` or its contents, and it does not enable
the socket. Deployment tooling owns those live drop-ins and service state.

To disable per-UID resolution, use the complete alternative table:

```toml
[identity]
mode = "disabled"
```

Inherited `PI_SANDBOX_*` values and other runtime-injection variables are
removed before managed startup. Configured environment names beginning with
`PI_SANDBOX_` are invalid. Disabled mode still applies the global scoped
environment from the main configuration; it merely skips per-UID lookup.

## Main configuration environment

The main configuration owns the global environment inherited by every user:

```toml
[environment.pi]
ORGANIZATION_MODEL_TOKEN = "shared-model-value"

[environment.sandbox]
ORGANIZATION_ENVIRONMENT = "production"

[environment.extensions.service-api]
SERVICE_API_TOKEN = "shared-service-value"
```

The three scopes are intentionally separate:

- `pi` is applied to the trusted host-side Pi process for model configuration,
  provider requests, and other Pi runtime use. It does not enter Bubblewrap or
  a managed extension's host command.
- `sandbox` is added to the otherwise fixed, cleared Bubblewrap environment or
  overlaid on the inherited environment of direct built-in commands. The model
  can read these values, so this scope must not contain secrets.
- `extensions.<id>` is available only to that selected compiled extension's
  host commands. The extension must declare each admitted name in its compiled
  host-environment policy.

Environment entries never select an extension, add or enable a tool, change a
policy, or grant an invocation.

## Per-UID drop-in format

Each optional `/etc/pi-sandbox/users.d/<uid>.toml` is strict TOML.
Its filename and `uid` must both match the kernel-reported
calling UID:

```toml
version = 6
uid = 1000
username = "user"
comment = "Example account"

[environment.pi]
ORGANIZATION_MODEL_TOKEN = "user-model-value"

[environment.extensions.service-api]
SERVICE_API_TOKEN = "user-service-value"

[overrides.execution]
backend = "bubblewrap"

[overrides.filesystem]
cwd_writable = false

[overrides.network]
mode = "host"

[overrides.tools.git_clone]
mode = "disabled"
session_grant = "never"

[overrides.tools.service_api]
mode = "deny"
session_grant = "never"
```

`version` and `uid` are required. `username` and `comment` are optional
annotations and are neither trusted nor returned to Pi. `environment` and
`overrides` are optional patches. A per-UID environment value replaces the
same variable in the same main-configuration scope; all unmentioned global
values remain in effect.

Variable names use the ordinary portable environment-name form and values are
strings without NUL bytes. Names, values, maps, and the complete response are
bounded. Runtime-injection names, dynamic-loader variables, and all
`PI_SANDBOX_*` names are reserved; the sandbox scope also cannot replace fixed
values such as `HOME`, `PATH`, or `TMPDIR`. Duplicate keys, malformed tool or
extension names, unknown fields, exposed file permissions, symlinks, filename
or UID mismatches, and invalid values reject the matching drop-in.

`overrides.models_file`, `overrides.execution`, `overrides.network`, and
`overrides.filesystem` are
optional. `overrides.execution.backend` is exactly `bubblewrap` or `direct` and
replaces the complete base execution table. `overrides.network.mode` is exactly
`none` or `host` and replaces the complete base network table.
`overrides.filesystem` must contain exactly the boolean `cwd_writable`, which
replaces the base CWD write-access setting. Omission inherits the parent.
`overrides.tools` may contain any bounded subset of syntactically valid model
tool names. Each included tool replaces its invocation permissions, so both
`mode` and `session_grant` are required. The parent tool's `audit` boolean is
preserved; logging settings are not accepted in UID drop-ins. Every override name must belong to the
exact active base tool policy, including tools from selected compiled
extensions. Omitted values inherit `/etc/pi-sandbox/config.toml`. The effective
backend/network/filesystem combination is then validated; `direct` requires
`network.mode = "host"` and `filesystem.cwd_writable = true`.
Per-UID files cannot select extensions, change extension configuration, change
the broker socket or configuration version, change mount locations or host
visibility, or change
the fixed user-shell behavior.

The effective order is:

1. Parse the complete main TOML configuration, including its global scoped
   environment and complete tool policy.
2. Resolve the calling UID through the broker. A missing
   `users.d` directory or matching file yields an empty patch.
3. Overlay the returned per-UID environment by scope, extension identifier,
   and variable name; apply any atomic model, execution, network, filesystem, and complete
   tool-policy overrides; and validate the effective configuration.
4. Apply the effective `pi` scope while loading and validating the selected
   model catalog.
5. Validate selected-extension environment declarations and executables, then
   start isolated per-extension host executors, the selected built-in executor,
   and Pi with the effective policy and scoped environment.

The broker protocol uses newline-delimited JSON version 5 and carries only
the per-UID patch. The matching drop-in is reopened for every connection, so an
administrator can atomically replace it without restarting the socket. An
unavailable broker, invalid matching drop-in or response, or missing or invalid
selected model file stops startup. Absence of the directory or matching file
does not.

## Using Pi-scoped variables in models.json

Each effective `environment.pi` value is available to the host-side Pi process
under its configured name. A selected model catalog can use Pi's ordinary
environment substitution:

```json
{
  "apiKey": "$ORGANIZATION_MODEL_TOKEN"
}
```

or place it in a provider header:

```json
{
  "headers": {
    "X-Managed-Identity": "$ORGANIZATION_MODEL_TOKEN"
  }
}
```

Pi-scoped values are restored to their prior host values when startup fails or
Pi exits. They are excluded from managed host-command environments even though
Pi uses them in its own process. Pi's stored provider credentials can take
precedence over a configured `apiKey`; a configured custom header is the
reliable choice when the identity must accompany every request.

## Security boundary

Separate root-only drop-ins prevent one ordinary user from reading another
user's configured patch. The broker obtains UID from the kernel rather than
from request data and reads only the matching filename. It does not make a
user's own environment values secret from that user: the user can connect to
the world-accessible Unix socket and request their own patch, Pi-scoped values
exist in their host-side Pi process, sandbox-scoped values are deliberately
agent-visible, and extension-scoped values are supplied to a program running as
that user. This feature is centralized administrative distribution and
cross-user data minimization, not authentication against a hostile local user.
An authorized local user can also consume broker connections or repeatedly
activate the bounded service, so host-level denial of service is outside this
feature's guarantees.
