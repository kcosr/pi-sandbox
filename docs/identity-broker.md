# Per-user environment and overrides

On Linux, Pi Sandbox can optionally resolve administrator-managed settings for
the account that launches it and its primary and supplementary groups. A root
systemd socket service identifies the caller with Linux `SO_PEERCRED`, resolves
membership through the host account system, and combines matching rules from
`<config_dir>/users.d/*.toml` and `<config_dir>/groups.d/*.toml`. It returns one
environment and override patch. The Bun application is the client; the broker
is not a launcher or wrapper.

Global policy and global scoped environment belong in
`<config_dir>/config.toml`. Both rule directories are optional. If no rules
match, the main configuration is inherited unchanged.

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

Create only the rule directories and files you need. For example:

```sh
sudo install -d -o root -g root -m 0755 /etc/pi-sandbox/groups.d
sudo install -o root -g root -m 0600 admin.toml /etc/pi-sandbox/groups.d/admin.toml
sudo systemctl daemon-reload
sudo systemctl enable --now pi-sandbox-identity-broker.socket
```

The directory must be owned by root and must not be writable by group or
others. Each drop-in must be a root-owned regular file with mode `0600` and
must not be a symlink. `/etc`, `/etc/pi-sandbox`, and the fixed
`/run/pi-sandbox-identity` socket directory must remain root-controlled.

The release installs the broker executable and systemd units but never creates,
replaces, backs up, or removes `users.d`, `groups.d`, or their contents, and it does not enable
the socket. Deployment tooling owns those live drop-ins and service state.

To disable user/group resolution, use the complete alternative table:

```toml
[identity]
mode = "disabled"
```

Inherited `PI_SANDBOX_*` values and other runtime-injection variables are
removed before managed startup. Configured environment names beginning with
`PI_SANDBOX_` are invalid. Disabled mode still applies the global scoped
environment from the main configuration; it merely skips user/group lookup.

## Main configuration environment

The main configuration owns the global environment inherited by every user:

```toml
[environment.pi]
ORGANIZATION_MODEL_TOKEN = "shared-model-value"
PI_CODING_AGENT_DIR = "~/.pi/agent"

[environment.sandbox]
ORGANIZATION_ENVIRONMENT = "production"

[environment.extensions.service-api]
SERVICE_API_TOKEN = "shared-service-value"
```

The three scopes are intentionally separate:

- `pi` is applied to the trusted host-side Pi process for model configuration,
  provider requests, and other Pi runtime use. It does not enter Bubblewrap or
  a managed extension's host command. An MCP server receives only the values
  explicitly mapped by its `headers_from_env` or `env_from_env` configuration.
- `sandbox` is added to the otherwise fixed, cleared Bubblewrap environment or
  overlaid on the inherited environment of direct built-in commands. The model
  can read these values, so this scope must not contain secrets.
- `extensions.<id>` is available only to that selected compiled extension's
  host commands. The extension must declare each admitted name in its compiled
  host-environment policy.

Environment entries never select an extension, add or enable a tool, change a
policy, or grant an invocation.

Configured values equal to `~` or starting with `~/` expand to the invoking
effective user's OS account home at application startup. This applies to all
three scopes, including values overlaid from matching user/group rules. The
broker returns unexpanded values; conflict checks compare the configured
strings before expansion. The application expands the merged environment once,
independently of `$HOME`, the broker's root account, and the launch directory,
then rechecks its bounds. `{{username}}` and `{{uid}}` expand in these configured
values using the same effective OS account; `$USER`, `$LOGNAME`, and `SUDO_USER`
are ignored. Expansion is single-pass; `{{{{` and `}}}}` escape literal braces.
Unknown macro syntax is an error. Other values remain literal. See
[home-directory expansion](configuration.md#home-directory-expansion).

## User and group rules

Put ordinary permissions in the main configuration. Add rules for accounts or
groups that need exceptions; no priority or filename ordering is required.
For example, with Bash disabled and read requiring approval in the main policy:

`/etc/pi-sandbox/groups.d/admin.toml`:

```toml
version = 7
group = "admin"

[overrides.tools.bash]
mode = "ask"
session_grant = "offer"
```

`/etc/pi-sandbox/groups.d/log-readers.toml`:

```toml
version = 7
group = "log-readers"

[overrides.tools.read]
mode = "allow"
session_grant = "never"
```

Someone in both groups receives both exceptions: Bash with approval and read
without approval. Other tool policies remain at their defaults. A user rule
can grant the same kind of exception:

`/etc/pi-sandbox/users.d/alice.toml`:

```toml
version = 7
user = "alice"

[overrides.tools.write]
mode = "ask"
session_grant = "never"
```

Every file requires `version` and exactly one selector: `user` or `uid` in
`users.d`, and `group` or `gid` in `groups.d`. Use `uid = 1000` or `gid = 100`
instead of a name when numeric identity is preferred. Filenames are labels,
not selectors. Names and IDs have identical merge behavior. `comment` is an
optional annotation. Names must be nonempty, at most 256 bytes, and contain no
whitespace, control characters, or colons. Numeric-only names are rejected; use
`uid` or `gid` for numeric selectors. Use the canonical spelling returned by the
host account service.

`environment` and `overrides` are optional patches. Environment scopes follow
the main configuration's structure. `overrides.models_file` selects a model
file; `overrides.execution.backend` accepts `bubblewrap` or `direct`;
`overrides.network.mode` accepts `none` or `host`; and
`overrides.filesystem.cwd_writable` is boolean. Each named entry in
`overrides.tools` requires both `mode` and `session_grant`. Tool names must
belong to the exact active base policy, including selected compiled tools.
MCP server definitions, their per-server tool policies, and the code-mode switch
are main-policy-only; neither rule files nor broker responses accept overrides
for them. Per-user MCP credentials can use `environment.pi` values, explicitly
referenced by an administrator's server mappings; these values do not select
servers or grant tool calls.

### Combining matching rules

All matching user and group rules participate equally. Combine their explicit
settings first, then overlay the result on the main configuration. Defaults do
not compete in this comparison, and user rules do not apply last.

| Setting                         | Combination                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tool invocation policy          | Most permissive complete pair wins: `disabled/never` < `deny/never` < `ask/never` < `ask/offer` < `allow/never` |
| Network mode                    | `host` wins over `none`                                                                                         |
| CWD writable                    | `true` wins over `false`                                                                                        |
| Execution backend or model file | Different explicit values are a configuration error                                                             |
| Scoped environment variable     | Different values for the same scope, extension, and variable are a configuration error                          |
| Omitted setting                 | Inherits from the main configuration if no matching rule specifies it                                           |

Rules can replace a default restriction, but cannot revoke permission granted
by another matching rule. For a common staff/admin setup, keep staff access in
the default policy and use an admin rule for extra permissions.

Parent tool `audit` flags and the global `[audit]` settings remain unchanged.
Rules cannot select extensions, change extension configuration, redirect the
broker socket, change mount locations or host visibility, or change the fixed
human-shell behavior. Environment values cannot enable tools or grant approval.

The combined effective configuration is validated again: direct execution
requires `network.mode = "host"`, `filesystem.cwd_writable = true`, and empty
`filesystem.hidden_paths`. Hidden paths belong exclusively to the main configuration;
user/group rules cannot replace or erase them.
Unknown fields, invalid policy combinations, malformed environment names,
reserved runtime-injection variables, exposed permissions, and symlinks are
rejected. All `.toml` files are validated, including unmatched rules. The two
directories together allow at most 256 rule files and 4 MiB of TOML, with at most
1 MiB per file. Combined environment values and responses also retain their
size limits.

### Account lookup and lifecycle

The static broker invokes the fixed host executable `/usr/bin/getent` through
bounded argument vectors. This uses the host's NSS account configuration,
including local accounts and SSSD accessed through local sockets. It does not
implement an LDAP client. Direct network LDAP lookups are unsupported by the
service's isolated network namespace; directory-backed installations must
provide a working local account service.

Membership includes the account's configured primary group and supplementary
groups reported by the host resolver, rather than just the process's current
GID. Running `newgrp` is unnecessary. Membership is a startup snapshot and may
reflect the host account service's cache; restart Pi to resolve policy again.
The complete account/membership lookup has a four-second budget. The client response deadline is ten
seconds and the broker service lifetime is fifteen seconds. Lookup failure or
timeout fails startup rather than silently dropping group rules.

The broker receives the compiled configuration directory as its executable
argument and reads both protected rule directories for each connection. Its
protocol is newline-delimited JSON version 6 with operation `resolve-identity`;
requests contain no claimed identity. It returns only the combined matching
patch, not unrelated rule contents or annotations. Administrators can atomically
replace files without restarting the socket.

The Bun client independently validates the response, overlays the patch on the
main configuration, expands configured home-relative values, and validates
effective policy. It then applies the `pi`
environment while loading models and validates extension environments before
starting executors and Pi. Unavailable brokers, invalid rules or responses,
conflicting matching values, and invalid effective models stop startup. Missing
rule directories or no matches inherit defaults.

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
from request data and returns only the combined patch for that account and its groups. It does not make a
user's own environment values secret from that user: the user can connect to
the world-accessible Unix socket and request their own patch, Pi-scoped values
exist in their host-side Pi process, sandbox-scoped values are deliberately
agent-visible, and extension-scoped values are supplied to a program running as
that user. This feature is centralized administrative distribution and
cross-user data minimization, not authentication against a hostile local user.
An authorized local user can also consume broker connections or repeatedly
activate the bounded service, so host-level denial of service is outside this
feature's guarantees.
