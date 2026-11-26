# Managed configuration and audit service

## Configuration profiles

Distribution schema 4 fixes one configuration source per platform at build time.
`source = "service"` obtains policy, account overrides, scoped environment and the
model catalog from one endpoint. `source = "local"` loads the selected TOML and
catalog as the invoking user, with no account-rule or remote-override lookup.
Both normalize to the same validated in-memory snapshot and execution pipeline.
A service failure never switches to local files. User state, CLI, environment and
returned policy cannot replace a compiled endpoint or change source kind.

The default public distribution is local, has `allow_config_override = false`,
and disables audit. Custom local builds may enable the leading `--config FILE`
option for personal/development use. Local builds may also compile a fixed
`audit_endpoint`; this supplies auditing only and cannot supply policy. Enabling
local audit without that endpoint fails validation. Disabled local audit performs
no transport identity lookup or network call.

```toml
version = 4
extension_manifests = ["/absolute/build-input/git/pi-sandbox-extension.json"]

[platforms.linux]
libexec_dir = "/usr/libexec/pi-sandbox"
launcher_path = "/usr/bin/pi-sandbox"

[platforms.linux.bubblewrap]
mode = "system"
path = "/usr/bin/bwrap"

[platforms.linux.configuration]
source = "service"

[platforms.linux.configuration.endpoint]
transport = "unix"
socket_path = "/run/pi-sandbox/service.sock"
```

For HTTPS, use the same endpoint shape in a service `endpoint` or local
`audit_endpoint`:

```toml
transport = "https"
url = "https://policy.example.net/v1/service"
basic_username = "managed-clients-v1"
basic_password_file = "/absolute/build-input/bootstrap-password"
send_machine_id = false
# tls_ca_file = "/absolute/build-input/service-ca.pem"
```

`url` is the complete public HTTPS endpoint, including an optional port and path.
The client sends every operation directly to that path; it does not append
`/v1/service`. For example, separate builds can select
`https://policy.example.net/pi-sandbox-macos` and
`https://policy.example.net/pi-sandbox-linux`. A reverse proxy can route each
public path to a different daemon listener and rewrite it to `/v1/service`.
Direct daemon connections use `/v1/service`. Query strings, fragments and URL
credentials are rejected. The same rules apply to local builds' `audit_endpoint`.
The builder uses standard URL parsing and serialization: an omitted path becomes
`/`, dot segments are resolved (for example, `/old/../service` becomes `/service`),
and spaces are percent-encoded. Repeated slashes are preserved. Release metadata
records the resulting URL, and service-source diagnostics display that full URL.

Linux supports Unix and HTTPS endpoints; macOS supports HTTPS. The optional
machine assertion is macOS-only. Password and optional CA files are build inputs,
compiled into the executable, not runtime file references. Passwords must have
at least 32 bytes after one terminal newline removal; generate them from at least
256 bits of randomness. No usable service credential ships with the public
example. Build metadata excludes credential contents, source paths and standalone
credential digests.

TLS requires at least 1.2 with hostname validation and the runtime's bundled
public CA roots by default. A compiled custom CA bundle replaces those roots.
Runtime host CA, proxy and insecure-TLS environment variables cannot change this
trust or routing. Redirects and plain HTTP are rejected. Changing the endpoint,
password or trust set requires rebuilding clients; ordinary certificate renewal
under the selected CA does not.

## Daemon and listeners

One concurrent Linux Rust `pi-sandbox-service` process binds its own listeners. The
packaged `pi-sandbox-service.service` unit runs it as root. Any Unix listener requires
root, including a mixed Unix/HTTPS manifest; an HTTPS-only manifest may also run
under an unprivileged service account. The daemon never
spawns a systemd instance or application process per user. macOS installs no
privileged daemon. The service does not execute tools or proxy model requests.
Client and service packages are separate; see [installation](installation.md).

The unit supplies an absolute manifest path, normally
`/etc/pi-sandbox-service/main/service.toml`. A strict version-1 manifest defines
one to sixteen listeners:

```toml
manifest_version = 1

[[listeners]]
id = "local_linux"
transport = "unix"
platform = "linux"
socket_path = "/run/pi-sandbox/service.sock"
audit_facility = "local0"
policy_file = "/etc/pi-sandbox-service/main/linux.toml"
rule_directory = "/etc/pi-sandbox-service/main/local-rules"

[[listeners]]
id = "remote_macos"
transport = "https"
platform = "darwin"
listen_address = "0.0.0.0:9443"
audit_facility = "local0"
policy_file = "/etc/pi-sandbox-service/main/macos.toml"
rule_directory = "/etc/pi-sandbox-service/main/remote-rules"
certificate_file = "/etc/pi-sandbox-service/main/tls/certificate.pem"
private_key_file = "/etc/pi-sandbox-service/main/tls/key.pem"

[[listeners.credentials]]
name = "managed-clients-v1"
password_file = "/etc/pi-sandbox-service/main/credentials/v1"
```

Each listener owns its platform, policy and syslog facility (`local0`–`local7`).
An omitted rule directory means no rules; a declared missing directory fails.
Restart the daemon for manifest, listener, TLS or ingress-credential changes.
Policy/rule/catalog/secret files are read per configuration request; running
clients retain their captured snapshots. Administrative manifest, policy, catalog,
rule, certificate and credential files must belong to the daemon's effective UID.
Rule directories also belong to that UID. All ancestors must belong to root or
that UID; paths must be non-symlink and not group/world writable. Policies,
catalogs and certificate chains may be `0644`; rules, private keys and Basic
password files must be `0600`. A root daemon still requires root-owned inputs.
Secret references use ordinary permissions and symlink following;
the deployment must prevent untrusted redirection of privileged reads.

### Foreground HTTPS-only operation

An HTTPS-only service can keep its executable and inputs under the service
account's home and run directly, without systemd or installation under `/opt` or
`/run`. Provision a manifest containing only HTTPS listeners, using absolute
physical paths and the ownership/modes above. A symlinked or group/world-writable
ancestor is rejected, including an unsafe home directory. Use an unprivileged
port such as `19443` and keep server keys separate from client-distributed credentials.

Run validation and startup as the same account:

```sh
umask 077
ulimit -n 4096
./pi-sandbox-service --validate --manifest "$HOME/pi-service/service.toml"
exec ./pi-sandbox-service --manifest "$HOME/pi-service/service.toml"
```

`umask` protects newly created files; it does not repair existing modes. The soft
file-descriptor limit must be at least `max_connections + 1024` (4096 suffices for
the default limits), within the account's hard limit. The service account must be
able to submit audit records to the host's existing `/dev/log`; missing or denied
syslog access still fails audited operations. Offline validation does not contact
syslog or read private-key/password/secret contents; startup checks TLS and Basic
credentials. Non-root Unix or mixed manifests are rejected in both validation and
startup, before any listener activates. No privilege switch or ownership repair
is performed.

## Identity and trust

Unix connections capture Linux `SO_PEERCRED` UID/PID before dispatch. Bounded
host account lookup supplies the canonical username and primary/supplementary
groups. Requests cannot replace that identity with a body assertion.

Clients authenticate the configured service through the protected root-owned Unix
socket path or the compiled HTTPS hostname and TLS trust. The HTTPS daemon's UID
does not select client trust. Client users must not have the server private key or
authority to issue trusted certificates for that hostname. An operator-owned trial
service is intentional; use separate trial and production keys and credentials.

HTTPS checks Basic authentication on every request and accepts a canonical
OS-derived username in the request body. Optional machine ID is metadata, not a
policy selector or additional authentication factor. The Basic account identifies
a provisioned client population. It does not attest the asserted user: anyone who
extracts the bundled credential can claim another admitted username, retrieve its
policy/secrets or submit audit events as that assertion. Root access is not
required to regard a compiled shared credential as extractable.

Unix audit records carry kernel UID/PID and resolved account name. HTTPS records
carry credential name, asserted username and optional asserted machine ID, with
explicit provenance; remote UID/PID are not invented from service-host identity.
No password is an audit field. The official client enforces its fixed source,
but a machine owner can run modified or unrelated software.

## User and group rules

Rules use version 12. Unix listeners accept name/numeric user and group selectors;
HTTPS listeners accept exact case-sensitive username rules only. An HTTPS rule
directory rejects numeric user selectors and nonempty `groups.d`, rather than
silently ignoring them. It never resolves a remote assertion against server NSS.
Machine-specific policy and remote directory groups are not supported.

```toml
version = 12
user = "alice"

[environment.pi]
MODEL_TOKEN = { file = "/etc/pi-sandbox-service/main/secrets/alice-token" }

[overrides.workspace]
allowed = ["host", "sandbox"]
default = "sandbox"

[overrides.tools.write]
mode = "ask"
session_grant = "offer"
```

Use `uid = 1000` or `group = "developers"` / `gid = 100` only for Unix listeners.
Filenames are labels and give no priority. Every rule is structurally validated,
including unmatched rules. Named-tool, MCP-server and workspace-mode inventory
membership is checked only for matching rules against that listener's policy.
No matching rules means an empty override and inherited main defaults.

Combine explicit matching settings first, resolve workspace access/defaults,
select a composed mode, then overlay the remaining policy once:

| Setting                       | Combination                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| Invocation policy             | `disabled/never` < `deny/never` < `ask/never` < `ask/offer` < `allow/never` |
| Workspace allowed             | Union explicit lists, replacing main allowed list                           |
| Workspace default             | Explicit names must agree                                                   |
| Network                       | `none` < `local` < `host`, subject to final platform checks                 |
| CWD writability / MCP enabled | Explicit true wins                                                          |
| Backend / model source        | Different explicit values fail                                              |
| Same scoped environment key   | Different authored declarations fail                                        |
| Omitted value                 | Inherit selected main mode                                                  |

A restrictive matching rule cannot revoke another matching grant. Account rules
cannot define modes, select extensions, change audit choices, add providers to a
catalog, permit personal login, modify skill roots or choose service routing.
A model-source override selects a complete administrative catalog. Partial common
`filesystem`, `exports` and invocation defaults remain valid when every mode
supplies the required values; the application validates all composed modes.

### Workspace mode selection

Matching explicit allowed lists replace the main list after union; omitted and
empty lists are distinct. Explicit defaults must agree and the effective default
must be allowed even when the caller supplies `--workspace-mode`. A mode changes
only CWD writability, exports and complete Bash/write/edit invocation entries.
Selection remains fixed across sessions, executor recreation and managed children.

`--list-workspace-modes` uses `policy_inspect` for service builds or a source-only
local read. It validates mode access and shows only permitted names/descriptions
and the default, without reading catalogs or secret files or starting Pi/MCP/tools.
The inspection response cannot be reused as an operational bootstrap.

### Known read-only Bash class

Rules may supply complete Bash invocation policy and optional `known_read_only`
class policy. Joining keeps a class only when it is more permissive than the
combined Bash policy. Overlaying the result replaces `mode`, `session_grant` and
`known_read_only` together; omission can clear the common class. Common audit and
administrator command-set definitions are preserved. Rules cannot define command
sets. Effective policy must still satisfy the typed-read implications documented
in [configuration](configuration.md#known-read-only-bash-commands).

### MCP tool approval policies

Rules may override an existing server's `enabled`, `default_policy` and ordered
`tool_rules`, with complete invocation pairs and no audit fields:

```toml
version = 12
user = "alice"

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

For each original tool, resolve each file's first match or explicit default, then
join the resulting pairs. Inherit main policy only when no layer contributes.
Global first-match/default audit remains unchanged. Whole duplicate layers may
be deduplicated; ordered rules are never flattened. Connection definitions,
credential mappings, exposure, timeouts and code-mode admission remain main-only.
Disabled servers skip connection and credential work; personal preferences may
narrow admission but cannot enable an administratively disabled server.

### File-backed Pi values

The service joins declarations before reading effective `environment.pi` file
references, including main references. Unmatched or overwritten references are
not read. Repeated paths share one read per request. File values are bounded
regular UTF-8 data, strip at most one LF/CRLF and return as wire-only `{literal}`
wrappers, never client file instructions. String values retain account/machine
macro expansion in the client. See [file values](configuration.md#file-backed-pi-environment-values).
Local builds read their effective main references as the invoking user. Offline
validation checks syntax without reading secrets; live bootstrap resolves them.

## Shared protocol and auditing

Both transports use bounded HTTP/1.1 POST, JSON protocol version 1,
and `Connection: close`. Unix clients and both daemon listeners use `/v1/service`;
HTTPS clients post to the compiled endpoint path. Operations are `bootstrap`, `policy_inspect`, `audit_open`,
`audit_check`, `audit_event` and `audit_close`. Requests run concurrently with
bounded connection/worker/session limits; each audit handle serializes its event
sequence. Transport reconnects never refetch a running application's policy.

An acknowledged audited tool intent must precede its effect. Acknowledgment means
submission to local syslog, not durable storage or downstream delivery. Failure
latches the current audit attempt. A later explicit user message or export
checkpoint can check/open a new session; failed events and effects are never
replayed. Completion failure may leave an already-performed effect with an
unknown reported outcome. A successful handle check is not a substitute for the
next tool's own intent acknowledgment.

Registered commands and human `!` shell retain their native behavior during an
audit outage. TUI/RPC/print explicit model inputs check before acceptance; failure
may reject that input before its LLM request. Background compaction, summaries,
queued-message draining and managed children do not add reconnect checkpoints.
Input failure does not permanently poison the client. User-only sandbox export
also captures its audit handle before review and checks that binding before each
publication; stale work cannot publish under a replacement session.

Records use schema 7 and include the configuration origin (service or local),
identity provenance, service epoch, session/sequence and existing tool/export
metadata. The listener policy controls whether auditing is offered, but does not
independently enforce a local client's chosen audit coverage. A local writable
policy can disable its own audit choices. Protection, persistence, retention and
forwarding remain host logging responsibilities. There are no receipts,
replay/deduplication ledger, automatic event retries or service-side tool execution.
