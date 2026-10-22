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

The broker is not built or packaged on macOS. macOS configuration
must use `identity.mode = "disabled"` and therefore uses only the main
configuration.

Seatbelt does not add macOS broker support. Linux broker overrides accept only
Bubblewrap or direct execution. Main-policy directory denials cannot be removed
by a filesystem override; changing CWD write access preserves both exclusion arrays.

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

Configured string values equal to `~` or starting with `~/` expand to the invoking
effective user's OS account home at application startup. This applies to all
three scopes, including values overlaid from matching user/group rules. The
broker returns unexpanded values; conflict checks compare the configured
strings before expansion. The application expands the merged environment once,
independently of `$HOME`, the broker's root account, and the launch directory,
then rechecks its bounds. `{{username}}` and `{{uid}}` expand in these configured
values using the same effective OS account; `$USER`, `$LOGNAME`, and `SUDO_USER`
are ignored. Expansion is single-pass; `{{{{` and `}}}}` escape literal braces.
On macOS `{{machine_id}}` resolves the host hardware UUID independently of the
account lookup, once only if a merged value requests it. The broker does not
read hardware identity; it still returns symbolic values. Referencing this
macro on unsupported platforms fails effective policy resolution. It is a
copyable machine identifier, not a credential or account-authentication claim.
Unknown macro syntax is an error. Other values remain literal. See
[home-directory and account expansion](configuration.md#home-directory-and-account-expansion).

## File-backed Pi values

User and group rules can reference a separate file for a Pi-scoped variable:

```toml
version = 11
group = "developers"

[environment.pi]
SERVICE_TOKEN = { file = "/etc/pi-sandbox/secrets/service-token" }
```

The broker selects and merges matching rules, then reads their effective file
references under its existing credentials and returns the values over the Unix
socket. Unmatched references are validated structurally but never opened.
An ordinary string still supports account expansion; file contents do not.
See [file syntax and contents](configuration.md#file-backed-pi-environment-values)
for path, UTF-8, newline and size rules.

Conflicts compare declarations before any file reads: different file paths,
or a string and a file reference, conflict even if their eventual contents would
match. Repeated identical paths share one read within a broker request. Resolved
values must still satisfy all environment and response bounds. A new connection
reads fresh contents; no live reload or cross-request cache is added.

Deployment must keep broker-referenced paths, their ancestors and symlink
targets under administrative control. Otherwise an untrusted user could redirect
a privileged read. The reader follows ordinary symlinks and adds no secret-file
owner, mode, or ancestry checks. Existing root-owned `0600` rule-file checks and
service confinement remain in force. The service's `ProtectHome` and `PrivateTmp`
settings still apply; a directory such as `/etc/pi-sandbox/secrets` avoids those
private or inaccessible locations.

Main-config references are instead read by the invoking application user. A
root-only file there fails naturally. Put shared root-only values in matching
broker rules. Authorized users can obtain their own resolved values from the
socket; storing a secret in a separate file does not hide it from its recipients.

Protocol 11 distinguishes ordinary expandable strings from file-derived
`{ "literal": "resolved value" }` values in the response's `environment.pi`.
The latter is a wire-only shape: TOML accepts `{ file = "…" }`, not `literal`,
and the application never accepts a file reference from the socket. Upgrade the
application and broker together. Use rule version 11 and main schema 14.

## User and group rules

Put ordinary permissions in the main configuration. Add rules for accounts or
groups that need exceptions; no priority or filename ordering is required.
For example, with Bash disabled and read requiring approval in the main policy:

`/etc/pi-sandbox/groups.d/admin.toml`:

```toml
version = 11
group = "admin"

[overrides.tools.bash]
enabled = true
read_write = { mode = "ask", session_grant = "offer" }
```

`/etc/pi-sandbox/groups.d/log-readers.toml`:

```toml
version = 11
group = "log-readers"

[overrides.tools.read]
enabled = true
read_write = { mode = "allow", session_grant = "never" }
```

Someone in both groups receives both exceptions in read-write mode: enabled Bash
with approval and read without approval. Their read-only branches inherit main. Other tool policies remain at their defaults. A user rule
can grant the same kind of exception:

`/etc/pi-sandbox/users.d/alice.toml`:

```toml
version = 11
user = "alice"

[overrides.tools.write]
enabled = true
read_write = { mode = "ask", session_grant = "never" }
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
`overrides.network.mode` accepts `none`, `local`, or `host`; and
`overrides.filesystem` accepts independently optional `cwd_default` and
`cwd_allowed`. An empty table is rejected. For the seven sandbox tools, each
`overrides.tools.<name>` entry accepts optional `enabled`, `read_only`, and
`read_write` fields and must contribute at least one. Each contributed branch
requires the complete `mode` / `session_grant` pair; Bash branches may include
`known_read_only`. A branch replaces its main counterpart, including an absent
class policy; an unmentioned branch inherits main. Enablement is independent:
a policy contribution never implicitly enables a disabled tool.
Host extension tool entries keep the flat complete `mode` / `session_grant`
shape. Tool names must belong to the active compiled inventory. Neither
sandbox branches on host tools nor flat sandbox policies are accepted.
MCP server overrides may change `enabled`, `default_policy`, and ordered
`tool_rules` for servers defined in the main policy. Connection definitions,
credential mappings, exposure, timeouts, audit, and the code-mode switch remain
main-policy-only. MCP approval policies contain only `mode` and `session_grant`.
Per-user MCP credential values can use `environment.pi`, explicitly referenced
by an administrator's server mappings; these values do not select servers or
grant tool calls.

### MCP server enablement

To admit a server for selected accounts or groups, keep its complete definition
in the main `[mcp.servers]` table with `enabled = false`, then add a rule such as
`groups.d/developers.toml`:

```toml
version = 11
group = "developers"

[overrides.mcp.servers.docs]
enabled = true
```

The `docs` server must already exist in the main policy. An override cannot add
a server or supply connection, credential, exposure, timeout, or audit fields.
Each server entry must provide at least one of `enabled`, `default_policy`, or
a nonempty `tool_rules` array; omitted fields inherit as described below. When present,
`overrides.mcp` requires a nonempty `servers` map with at most 32 entries; the
combined matching map has the same limit. IDs follow the main configuration's
`[a-z][a-z0-9_]{0,31}` grammar. Empty, malformed, duplicate, and unknown fields
are errors.

The main `enabled` value is a default. A matching `true` can enable a server
whose default is false, and a matching `false` can disable a server whose
default is true. When multiple matching rules specify the same server, `true`
wins over `false`; a user rule has no priority over a group rule. Thus a false
override cannot revoke a true from another matching rule. If no matching rule
specifies `enabled`, its main-policy default is inherited. A policy-only override
does not enable a server.

The application rejects unknown server IDs in the combined matching patch.
The broker checks the structure of every rule, including unmatched rules, but
does not read the main server inventory. A structurally valid unknown ID in an
unmatched rule is checked against that inventory only if the rule later matches.
Enabling a server with `exposure = "codemode"` also requires the main
`codemode.enabled = true`; the application checks this again after merging.

An effectively disabled server does not trigger its executable check, credential
reference resolution, account or machine lookup, or transport startup. This
does not remove independently configured `environment.pi` values from Pi's
environment. Saved user preferences can keep an admitted server disabled, but
a saved `enabled = true` cannot enable an administratively disabled server.
Restart Pi after changing administrative rules or group membership. This
feature uses the Linux broker; macOS continues to use only the main policy.

### MCP tool approval policies

Use the same server-local default and ordered rule structure as the main policy,
with complete `mode`/`session_grant` pairs and no `audit` field:

```toml
version = 11
group = "developers"

[overrides.mcp.servers.docs]
enabled = true

[overrides.mcp.servers.docs.default_policy]
mode = "ask"
session_grant = "offer"

[[overrides.mcp.servers.docs.tool_rules]]
match = "search_*"
mode = "allow"
session_grant = "never"
```

Omit `default_policy` to override only the named patterns, or omit `tool_rules`
to apply a default to all tools. `enabled` is independent and optional. A policy
requires both fields; `offer` is valid only with `ask`. Bash command classes,
connection fields, and user-authored `policy_layers` are rejected.

For each original tool name, resolve every matching file separately: use its
first matching rule, otherwise its explicit default, otherwise no contribution.
Join the resulting complete pairs with the same least-restrictive order used
for ordinary tools. If any file contributes, that pair replaces the global
invocation policy; if none contributes, inherit the global first-match/default
policy. User and group files have equal precedence. File names and order do not
change the result, but order within each file's `tool_rules` matters.

An override default is an explicit policy for every tool not matched in that
file, including newly discovered tools. It can broaden a restrictive global
rule. For example, a file with default `allow` and `secret_* = deny`, combined
with another file with default `ask`, yields `ask` for `secret_*` and `allow`
elsewhere. The first file's default does not compete with its own matching rule.
A restrictive user rule cannot revoke a permissive matching group rule.

Audit always comes from the main policy's first matching rule or default for
the original tool name. Overrides cannot suppress or enable audit. Direct and
Code Mode calls use the same effective approval policy; session grants remain
scoped to the original server/tool and catalog revision. Diagnostics identify
an identity override and its global audit rule without disclosing selectors,
filenames, or other accounts' rules. Changing policy requires a new Pi process.

Patterns use the main policy's case-sensitive literal/`*` grammar, are at most
128 UTF-8 bytes, and cannot contain whitespace, control characters, `?`,
brackets, braces, or backslashes. Patterns must be unique within one file's
server entry. Each file permits at most 256 rules per server and 1,024 total MCP
rules, within 256 KiB of serialized MCP configuration. Identical complete policy
layers from matching files are deduplicated; rule order inside a layer is never
changed. The aggregate permits at most 256 layers and 256 rules per server,
1,024 rules total, 32 servers, and 256 KiB of MCP data. The complete response is
limited to 512 KiB including its newline and is checked before any bytes are
written. Oversized rules or aggregates fail resolution; they are not truncated.

The wire representation is deliberately different from authored TOML:
`policy_layers` retains each matching file's ordered rules and optional default,
without its identity or filename. Only the broker emits that representation.

The current contract is main schema 14, rule version 11, and broker protocol 11.
Older shapes and versions are rejected. Deploy the matching application, broker,
and audit collector together; the installer preserves rule files, so deployment
must update their versions and obsolete sandbox/filesystem shapes explicitly.
See [upgrade instructions](installation.md#installing-and-upgrading).

### Combining matching rules

All matching user and group rules participate equally. Combine their explicit
settings first, then overlay the result on the main configuration. Defaults do
not compete in this comparison, and user rules do not apply last.

| Setting                         | Combination                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tool invocation policy          | Most permissive complete pair wins independently within each sandbox branch (`deny/never` < `ask/never` < `ask/offer` < `allow/never`); host policies additionally permit `disabled/never` |
| Bash known read-only class      | Join of present class policies, kept only if strictly more permissive than the combined same-branch Bash policy                                                                            |
| Network mode                    | Most permissive wins: `none` < `local` < `host`                                                                                                                                            |
| CWD allowed modes               | Union of explicitly contributed nonempty sets; main only when no contribution                                                                                                              |
| Default CWD mode                | Explicit values must agree; main only when no contribution                                                                                                                                 |
| Sandbox tool enabled            | `true` wins over `false`, independently of branch approval                                                                                                                                 |
| MCP tool invocation policy      | Resolve first match/default per file, then join complete pairs; global audit remains unchanged                                                                                             |
| MCP server enabled              | `true` wins over `false` for each explicitly overridden server                                                                                                                             |
| Execution backend or model file | Different explicit values are a configuration error                                                                                                                                        |
| Scoped environment variable     | Different values for the same scope, extension, and variable are a configuration error                                                                                                     |
| Omitted setting                 | Inherits from the main configuration if no matching rule specifies it                                                                                                                      |

Rules can replace a default restriction, but cannot revoke permission granted
by another matching rule. For a common staff/admin setup, keep staff access in
the default policy and use an admin rule for extra permissions.

Execution overrides contain only `backend`; an empty execution table is rejected.
The command timeout maximum belongs to base policy and cannot be overridden by
user/group files or broker responses. Removed lifetime fields are rejected.

Parent tool `audit` flags and the global `[audit]` settings remain unchanged.
Rules cannot select extensions, change extension configuration, redirect the
broker socket, change mount locations or host visibility, or change the fixed
human-shell behavior. Environment values cannot enable tools or grant approval.

The combined effective configuration is validated again. The default must belong
to the final allowed set, including when one field inherits main. Conflicts fail
startup instead of silently selecting another mode. Direct execution requires
`network.mode = "host"`, `cwd_default = "read_write"`,
`cwd_allowed = ["read_write"]`, and empty filesystem exclusion arrays. Hidden
and denied paths belong exclusively to the main configuration; user/group rules
cannot replace or erase them.
Unknown fields, invalid policy combinations, malformed environment names,
reserved runtime-injection variables, exposed permissions, and symlinks are
rejected. All `.toml` files are structurally validated, including unmatched
rules; the application checks matching tool and MCP server names against the
active main policy. The two directories together allow at most 256 rule files
and 4 MiB of TOML, with at most
1 MiB per file. Combined environment values and responses also retain their
size limits.

### Known read-only Bash class

A rule may refine either complete Bash branch:

```toml
version = 11
group = "developers"

[overrides.tools.bash]
enabled = true
read_write = { mode = "deny", session_grant = "never", known_read_only = { mode = "allow", session_grant = "never" } }
```

Each file validates the class against its own branch: exactly `mode` and
`session_grant`, `offer` only with `ask`, and strictly more permissive than that
branch. Invalid unmatched files also fail validation. Among matching files,
join the branch pairs and class policies independently, then drop a class that
is no longer more permissive than the combined branch. Normalization never
adds permission beyond the contributing policies.

Protocol 11 preserves every contributed branch; the broker does not select the
launch mode:

```json
{
  "overrides": {
    "tools": {
      "bash": {
        "enabled": true,
        "read_write": {
          "mode": "deny",
          "session_grant": "never",
          "known_read_only": { "mode": "allow", "session_grant": "never" }
        }
      }
    }
  }
}
```

A combined contributed branch replaces the corresponding main branch wholesale. Repeat
its class policy in the rule if it should be retained. An omitted branch
inherits main. The client validates both final branches: class `allow` requires
`read`, `grep`, `find`, and `ls` enabled and `allow` in that same branch, even
when Bash or the branch is dormant. An override that violates those requirements
fails startup; it does not silently drop an inherited class or enable a tool.

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
protocol is newline-delimited JSON version 11 with operation `resolve-identity`;
requests contain no claimed identity. It returns only the combined matching
patch, not unrelated rule contents or annotations. Administrators can atomically
replace files without restarting the socket.

The Bun client independently validates the response, overlays the patch on the
main configuration, expands configured home-relative values, and validates both
effective tool-policy branches. It then selects the default or explicitly
requested workspace mode within the final allowed set. The broker receives no
requested mode and cannot resolve a different identity from CLI input. The same
selected mode determines filesystem access, invocation policies, diagnostics,
and session-start audit metadata for that process. The client applies the `pi`
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
