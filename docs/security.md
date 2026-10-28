# Security model

## Intended protection

Pi Sandbox limits the effects of accidental or model-initiated filesystem and
shell operations. Repository content and model output are untrusted. The local
Unix user, installed Pi runtime, installed Pi Sandbox code, and system
administrator are trusted.

This is defense in depth for user-invoked interactive agents, not containment
for unattended autonomous agents. Approval policy assumes an attentive user.
The managed executable does not prevent the account owner from downloading or
running other coding tools, bypassing Pi Sandbox, or operating user-owned
services such as an SSH server where existing host controls permit it.

The default Linux Bubblewrap ceiling is:

- ordinary host filesystem readable except configured `filesystem.hidden_paths`;
- only the captured launch CWD persistently writable by default; setting
  `filesystem.cwd_writable = false` also makes that host directory read-only;
- private temporary/runtime storage writable, except when host `/tmp` itself is
  deliberately selected as the writable launch CWD;
- no network access by default; administrators may allow private loopback with
  `local` or unrestricted host networking with `host`;
- no ambient host credentials or service sockets in the sandbox environment.

Managed host tools are explicit exceptions to this sandbox ceiling and carry
the host authority described below. Direct execution is a separate explicit
operating mode, not a containment boundary: every approved built-in tool and
user `!` shell runs with the invoking user's ordinary host authority.

RPC mode uses the same execution boundary and policy as interactive mode. The
trusted caller chooses the launch directory and RPC endpoint access. Session
replacement cannot change the process workspace: a selected session must name
the exact canonical launch CWD, and its current real path must still match.
Validation precedes target-project discovery and outgoing-session teardown.
Aliases are rejected because ancestor instruction discovery depends on path
spelling. Session approval grants do not survive replacement or reload.
Workspace pathname replacement during a process lifetime is outside the trusted
launcher contract; admission checks do not make host-side resource reads atomic.

## macOS Seatbelt

Seatbelt is the macOS packaged policy backend using the trusted system
`/usr/bin/sandbox-exec`. It constrains tool
children, not Pi or managed host tools. Ordinary host paths stay readable, while
ordinary file writes are limited to the allowed CWD and executor-owned real host
scratch directories. `cwd_writable = false` removes CWD write authority.
Apple marks `sandbox-exec` deprecated. Treat continued availability and policy
behavior as macOS qualification requirements; an unavailable launcher or failed
enforcement probe aborts startup rather than selecting direct execution.
`filesystem.denied_paths` denies reads and writes to canonical existing directories,
including selected CWD descendants. Denials are not empty mounts and may expose
names in parent listings. A denied ancestor admits only the CWD subtree, with
explicit interior denials applied afterward. Denying CWD itself is rejected.
Root `/`, system trees `/System`, `/usr`, `/bin`, `/sbin`, `/dev`, and known
noncanonical aliases `/tmp`, `/var`, `/etc` are invalid denial targets. Broad
account/data roots such as `/Users`, `/Volumes`, and `/Library` may be denied,
but are not valid whole-workspace grants.

There are no PID, filesystem, IPC or network namespaces, private `/tmp`, VM,
or parent-death containment. Scratch is real host storage with best-effort removal.
`none` denies network operations under Seatbelt policy; `host` admits host networking
subject to other policy restrictions. Private-loopback `local` is unsupported.
The policy uses a cleared environment plus fixed values and the admitted sandbox
scope; those values remain model-visible. Broad filesystem reads can still expose
credentials outside denied directories. Path aliases and existing filesystem
relationships must not be treated as inode-level confidentiality guarantees.

Commands may overlap and have bounded argv, stdin and output. Optional caller or
administrator timeouts start at successful command launch. Cleanup
signals the command process group on failure, cancellation or close only while
the direct child remains active. Normal foreground completion can leave background
descendants alive, including members of the same group. Cleanup is explicitly
best effort: descendants that detach or change process group can escape those
attempts and may survive after Pi exits or dies. They retain the original filesystem
and network grants. Closing the executor, changing a session or changing later
policy does not revoke those grants. Scratch deletion is not a substitute for
process revocation. No watcher, guardian, observer or new host service attempts
to provide stronger lifecycle guarantees.

macOS broker identity and audit collection remain disabled. Host `git_clone`
retains ordinary execution and its accepted destination race; Seatbelt introduces
no staging publisher or clone-specific process cleanup. Qualify runtime behavior
on each supported macOS architecture and version; arm64 execution does not prove
x86-64 qualification.

## Outside the boundary

Pi runs on the host. Its provider API requests, authentication material, UI,
session files, and Pi Sandbox extension process are not contained by the tool
sandbox. The pinned, minimally patched Pi source, compiled Pi Sandbox extension,
and all managed extension modules selected at build time are trusted. A defect
or malicious action in that host-side code is outside this threat model.

The managed executable is the supported product entry point, not access control
against the account owner. A logged-in user can inspect its processes and
installed files or run unrelated software. Executable naming is not a defense.
The interactive application refuses effective UID `0`, preventing an accidental
root invocation from giving model tools or user shell commands root authority.
This check has no configuration override. Installer-only configuration
validation commands remain available to root and do not start Pi or an
execution backend.
The build-selected system Bubblewrap executable or packaged bundled Bubblewrap
binary is trusted installation code. A bundled binary is digest-checked at
build and by the release inventory, installed non-setuid beneath the root-owned
libexec directory, and never selected by runtime configuration.

Optional native tool bundles are also trusted installation code selected only
at build time. The builder verifies a pinned complete inventory and the native
loader dependency closure; source/original hashes record artifact provenance.
The installed bundle and libraries must remain protected from untrusted writes.
Bubblewrap and Seatbelt reject overlap between the bundle and writable CWD, and
reject filesystem exclusions covering selected tools or the bundle. A standalone
package should therefore be installed outside its writable project workspace.
Direct execution provides no filesystem protection for the package. Runtime
configuration, environment and Pi's host-tool cache cannot replace a selected
bundled executable, and a missing selected executable does not trigger fallback.

## MCP and code-mode authority

Administrator-enabled HTTP MCP clients and stdio MCP servers run outside the
selected sandbox boundary. Stdio servers are trusted installed host code with the
invoking account's authority, including startup and background activity before
any tool approval. HTTP tools exercise the server's authority. Sandbox network
and filesystem exclusion settings do not constrain either transport. Enabling a server
authorizes connection and tool discovery even if every tool policy is disabled.
On Linux, root-managed user/group rules may change a globally defined server's
enabled flag and tool approval policies. Matching explicit true wins over false
for admission. Each file's first matching tool rule or explicit default
contributes a complete approval pair; the least restrictive pair replaces the
global invocation policy. An explicit default can therefore broaden global
restrictions for unmatched and newly discovered tools. A restrictive rule cannot
revoke another matching rule's grant; users and groups have equal precedence.
Policy-only overrides do not imply admission. Audit always follows the global
first-match/default policy; connections, credential mappings, exposure and
timeouts remain globally defined.
The application rejects unknown matching server IDs and invalid effective
code-mode exposure. An effectively disabled server performs no server-specific
identity, executable, credential-reference, or transport work. Independently
configured Pi environment values remain present.

Code mode isolates model-authored JavaScript in the embedded QuickJS runtime,
with bounded computation and selected bridges. It exposes no general host API;
its nested tools still use ordinary permissions and executors. This is language
isolation, not operating-system containment. A runtime or bridge defect remains
a host-side risk. Concurrent nested approvals are serialized, and a later denial
or cancellation does not undo effects already completed.

MCP connections and permissions come only from administrative policy. User MCP
preferences can disable or change presentation for admitted servers, never add
connections or alter permissions. Saved true cannot enable an administratively
disabled server; saved false may keep an admitted server disabled. Administrative
policy and membership changes require a process restart. Menu changes revoke affected approvals/grants.
Code-mode availability is an administrator ceiling, not forced activation. Catalog
metadata never grants authority. Original server/tool identities bind permission
and grants; refreshed definitions invalidate stale approvals. HTTP redirects are
rejected, credentials are explicitly projected, and tool requests are never
transparently replayed. MCP server-side cancellation is best effort. Stdio
shutdown reaps owned process groups; trusted servers that deliberately daemonize
remain outside the containment guarantee.

Account macros in configured paths and environment values use the invoking
effective OS identity, not ambient environment variables. MCP URLs remain
literal. Account identifiers do not authenticate a user to a remote service.
The optional macOS `{{machine_id}}` macro reads the host's `IOPlatformUUID`
through a fixed, bounded host command with a cleared environment, only when
configured. It does not trust an ambient identifier or executable path. The
UUID is shared across accounts and can permit correlation across services;
administrators choose its recipients through scoped environment configuration.
It is not secret, an unforgeable identity, or device attestation. A copied UUID
can be replayed. Using it as a provider bearer value preserves the provider's
existing credential precedence and requires server support; it creates no new
authentication guarantee. Unsupported or failed lookup rejects effective
policy; an MCP-stdio-only lookup failure disables only the affected server.

## Fail-closed guarantees

The supported executable does not load user or project extensions, permit Pi
package-management commands, enable Pi's built-in extension factories, or
expose Pi's built-in filesystem or Bash implementations. The separately
maintained Pi Sandbox extension and build-selected extension modules
are compiled into the executable; Pi receives only the one forced Pi Sandbox
extension through its inline API. Each enabled operation uses its replacement
tool backed by its declared boundary. The seven replacements and user shell use
the configured Bubblewrap, Seatbelt or direct executor. Explicit managed host tools use only
their compiled direct-argument implementation; sandbox failure never changes a
tool into a host operation. Direct execution is admitted only from the
effective selected configuration and is never selected
after a Bubblewrap or Seatbelt failure.

In managed builds (`allow_config_override = false`), the distribution's
compiled `config_dir/config.toml` is the fixed global policy and
scoped-environment source. A build with `allow_config_override = true` instead
allows the caller to explicitly select that source with a leading `--config FILE`.
This build mode delegates policy choice to the caller and is unsuitable for
forcing staff to use administrator-selected permissions. The option cannot
change the compiled extension catalog, root runtime check, or Bubblewrap binary.
Service sockets and service-owned configuration remain build-selected. In broker mode, optional root-only rules in
`config_dir/users.d/*.toml` and `config_dir/groups.d/*.toml` may provide matching account/group scoped-environment
and administrator-selected model/execution/network/filesystem/tool patch, plus
MCP server enablement and tool approval policies. If no rules
match, the main configuration remains unchanged. Pi's
internal model catalog is disabled. `PI_CODING_AGENT_DIR` may
redirect user state but cannot redirect these administrative inputs. Missing,
unreadable, or invalid effective inputs abort operational startup. An exact
`--version` is metadata-only and does not read those inputs. The broker requires the
drop-in directory to be root-owned and not group/other writable, and all
files to be root-owned regular files with mode `0600`; ownership and
permissions for the main TOML and model files remain deployment responsibilities.
Every rule is structurally validated, including unmatched files. The broker does
not read the main server inventory; the application checks server existence only
for the combined matching patch.

The base TOML remains the default tool policy. Matching user/group rules combine
explicit permissions using least restrictive wins before replacing defaults.
A restrictive rule cannot revoke a grant from another matching rule; user rules
have no special precedence. Conflicting backend, model, or scoped environment
values fail startup. Environment values do not select extensions,
enable tools, grant approvals, or otherwise change policy.

The following conditions deny the operation or abort startup rather than use a
host fallback:

- the configured executor is unavailable or its probe fails;
- the interactive application is launched with effective UID `0`;
- administrative configuration or the selected model catalog is missing or
  invalid;
- the broker is unavailable, any user/group drop-in is structurally invalid, or
  a matching override refers to an unavailable tool or unknown MCP server;
- an unsafe managed-executable argument is supplied;
- the selected command process cannot start or report a coherent result;
- a required model-tool approval cannot be obtained;
- a configured Bash class policy has no working command analyzer;
- a request is malformed, oversized, cancelled, or stale;
- a mutation's outcome cannot be proven; or
- process-tree cleanup cannot be proven.

The same fail-closed behavior applies to host-tool argument validation,
prerequisites, startup, cancellation, timeout, and output bounds. A selected
extension whose required absolute executable is absent aborts startup.

## Managed host-tool authority

Managed host tools intentionally execute as the invoking Unix user outside
the selected sandbox. They retain the host filesystem view, network namespace, user
configuration, most ambient environment, proxies, and reachable services. Each
compiled extension declares the managed variable names it accepts, inherited
names or prefixes it removes, and fixed values it applies. Broker values can
populate only declared names under that extension's scope. Pi-scoped values and
another extension's declared variables are excluded. The central executor
prevents shell syntax, redirection, and model-selected executables by using a
fixed absolute executable and direct argument vector, but it does not sandbox
what that executable or its admitted user configuration can do.

For `git_clone`, the exact host/scheme allowlist and derived destination prevent
the model from directly selecting Git options or an arbitrary write target.
The compiled Git environment disables global and system Git configuration, URL
rewrites, credential prompting, and Git-selected SSH commands. The locator
allowlist still does not constrain SSH aliases and jumps, DNS resolution,
proxies, redirects, or behavior of the contacted repository. It is a locator
admission rule, not a network-destination or egress guarantee.

The clone-only tool retains its derived destination and rejects any existing
destination, including symlinks, at validation. A surviving sandbox background
process can race that check and Git startup by creating a symlink that redirects
the host clone into another empty directory writable by the host user. This is
an accepted residual risk. Ordinary sequential tool scheduling does not stop
background writers from earlier calls. No clone-specific background termination,
staging, publication helper, or guardian is used. This decision does not establish
arbitrary existing-file overwrite capability; future fetch/pull tools require
their own assessment.

`git_clone` retains Pi's sequential-tool declaration. An ordinary Pi batch that
includes it runs sequentially. Pi 1.3.0's nested Code Mode runner serializes it
against other sequential nested tools, but can overlap it with nested Bash or
file tools. That existing scheduling behavior is unchanged; the declaration is
not a global lock against all project writers.

Standard `pi-tool` extensions receive the same invocation policy but are
trusted host code. Their factory is limited to `registerTool` and `exec` during
startup, but imported code and tool implementations are not sandboxed. Use the
managed extension API when the central bounded host-command contract is a
required guarantee.

## Filesystem details

The host root is mounted read-only at `/`, preserving absolute paths. The
captured launch CWD is explicitly mounted over its identical path, read/write
when `filesystem.cwd_writable = true` and read-only when it is `false`. This
bind is created after private mounts, preserving CWD visibility beneath `/tmp`.
Read-only access does not hide host contents. CWD exactly `/tmp` is rejected in
read-only mode so the CWD bind cannot mask writable private temporary storage.
Reserved CWD path overlap checks remain in effect.

The sandbox receives its own process and device views and private writable temp
and runtime locations. Host pseudo-filesystems and privileged sockets are not
bind-mounted as host resources.

Broad read access is the default. `filesystem.hidden_paths` masks selected
canonical existing host directories with private read-only filesystems and
regular files with private empty read-only file data. The
launch CWD is restored through a hidden ancestor; explicit hidden files and directories
inside CWD are then masked again. Redundant nested masks are reduced on either
side of the CWD restore. No hidden entry may equal CWD, `/`, or `/tmp`, or overlap
the private process, device, system, or runtime paths. Directory masks are remounted
read-only non-recursively after the CWD skeleton is built, so CWD retains its
configured permissions and tools cannot change directory mask contents or
permissions. File masks use empty `--ro-bind-data` inputs and prevent content
changes or replacement through a writable containing CWD. Their private inode
permissions may still be changed on kernels using sealed file data; that cannot
make the contents writable and does not alter host permissions. Names remain
visible, and neither mask type modifies the original host object. Missing targets
are silently skipped at worker startup. Permission errors, non-directory
ancestors, special files, and symlink components fail startup, including dangling
links and symlink ancestors of missing targets. Skipped paths created later on
the host may be visible until restart unless another mask already hides them.

Home-relative hidden paths (`~` or `~/...`) are expanded using the invoking
effective user's OS account home, independently of ambient or configured
`HOME`. All reserved-path, canonical-path, and target-type checks apply to
the result. The same prefix convention expands configured scoped environment
values after the broker merge without granting access to hidden paths or
bypassing variable admission and size limits. It does not evaluate shell
expressions or expand arbitrary configuration strings.

This is pathname isolation for sandboxed tools, not an inode confidentiality
boundary. A symlink to a hidden pathname resolves through the hidden view, but
pre-existing hard links and separate host bind-mount aliases outside the hidden
tree can expose the same data. The trusted host must keep configured paths and
ancestors stable while a worker is being created; hiding a pathname does not
track host-side directory renames. Hidden entries with symlink components are
rejected at startup rather than silently resolving to another policy target.

Host Pi instruction/resource loading and managed host tools remain outside these
mounts. In particular, ancestor `AGENTS.md` files, sessions, logs, and model
configuration may still be read by trusted host code. Hide shared transcripts
and logs separately if they are stored outside the runs parent, and select
trusted host context inputs separately. The mask does not prevent a permitted
host extension or reachable network service from returning hidden data.

Direct mode has no filesystem ceiling. Typed read/search tools use their
approved path arguments, typed write/edit tools may mutate any approved path
the current user can mutate, and approved Bash has the user's full filesystem
authority. Disabling the model-visible `bash` tool is useful when an operator
wants only typed model operations, but it does not turn direct mode into a
sandbox. User `!` remains available because it is invoked by the human rather
than advertised to the model.

The read-only CWD setting is enforced by Bubblewrap and Seatbelt. It applies to
model Bash and human shell commands as well as typed tools; an approval cannot
bypass it. Direct mode rejects the setting, and managed host tools retain their
explicit host authority. Writable private runtime/temp storage remains available
in Bubblewrap; Seatbelt uses writable real host scratch directories.

## Audit correlation

The application and collector use strict audit wire version 3; the collector emits
record schema version 4 and requires configuration version 13. They must be
installed from the same release. MCP records carry the configured server ID,
original tool name, and `http` or `stdio` transport. Nested audited calls carry
`parent_invocation_id` from trusted execution context, never from script arguments.
An unaudited nested tool does not produce decision records for its parent.

With a Bash class policy, Bash decision records carry the paired
`command_class` and `known_read_only_version` fields. Both the application and
the collector require them together, only on Bash `tool_execution_intent` and
`tool_denied` events, with a version from 1 through 4294967295. They describe
the classification used for policy, not the command's actual effects. Custom-rule
decisions use `configured_command` with a nonempty, bounded list of matching
`command_set_ids`, never the `known_read_only` label. Other classes cannot carry
those IDs. The registry version continues to describe only the built-in profiles.

When global auditing is enabled, code mode records outer lifecycle metadata
without script source; nested built-in and MCP tools follow their own audit
settings. MCP arguments, results, headers, environment values, and server error
payloads are excluded. This correlation describes application requests and
outcomes, not the server's internal actions or rollback of remote effects.

## Session retention

The administrator controls conversation cleanup through the required main
`[sessions]` policy; user/group rules cannot replace it. Cleanup runs as the
invoking user on the host, outside the tool namespace, and may delete expired
Pi session JSONL files from the selected session store. It does not affect
audit-log persistence or retention.

The sweep does not follow session-tree symlinks or traverse arbitrary nested
directories. It validates only a bounded header of expired regular candidates
and rechecks file identity and modification time before unlinking. Startup
protects its selected session and refreshes its last-use timestamp; logical
session activation also refreshes that timestamp. There is no cross-process
active-session lock, and a concurrent resume can still race with final deletion.

This is best-effort housekeeping. The trusted account owner controls session
files, modification times, and scheduling state; malformed files and cleanup
failures are skipped. It does not guarantee deletion by a deadline or override
host filesystem permissions. Zero retention disables the maintenance entirely.

## Network details

The required effective mode is `none`, `local`, or `host`. In the default `none` mode,
tool execution uses a new network namespace with no configured egress and the
seccomp filter denies `socket`. This prevents connections to Internet, LAN,
host loopback, metadata services, and pathname or abstract Unix-domain sockets.

`local` keeps the private network namespace and allows only IPv4/IPv6 TCP/UDP
socket creation. Loopback is the only interface; there are no external routes,
host connections, or port forwarding. Named Unix sockets and other socket
families/types are denied. Host-side Pi, MCP and managed host tools remain
outside this network boundary.

In `host` mode, Bubblewrap shares the complete host network namespace and
seccomp permits `socket`. Sandboxed commands can therefore reach host loopback,
LAN, Internet, metadata endpoints, and visible or abstract Unix-domain services
subject only to ordinary host controls. This is not filtered egress. Bubblewrap
does not enforce IP, port, hostname, or destination rules. Only the fixed base
configuration or a root-managed user/group broker drop-in can select this mode.

In every mode the classic seccomp BPF program denies the three `io_uring`
control syscalls. In `none` and `local`, anonymous `socketpair()` is restricted to
connected Unix stream pairs, which Bun uses to spawn command children. Datagram
pairs are denied because they can reconnect to host pathname sockets even in a
private network namespace. On x86-64 the filter rejects the x32 syscall ABI; the
filter otherwise supports x86-64 and arm64 only. It is supplied over an inherited
pipe, not a host temporary file, and startup fails closed on an unsupported CPU
architecture.

These namespace and seccomp statements apply only to Bubblewrap. Direct mode
requires `network.mode = "host"` and has the user's ordinary network authority;
there is no socket or destination filtering.

## Hard links

Seccomp denies `link` and `linkat`, so sandboxed tools cannot create new hard
links. Pi Sandbox does not traverse the launch CWD looking for pre-existing hard
links. With `cwd_writable = true`, a pre-existing writable hard link beneath the CWD can mutate
the same inode through a pathname outside the writable mount. This is an
accepted residual risk: this boundary protects against accidental writes beyond
the directory the user believes they selected, not deliberate filesystem
relationships created by that user. The user could also select the external
file's directory as the writable CWD directly.

Provider calls made by the trusted host-side Pi process are unaffected.

## Environment and IPC

Pi-scoped `{ file = "/absolute/path" }` references separate credentials from
configuration; they do not add an access-control boundary. Main references are
read with the invoking user's permissions. Broker references are read with the
broker's privileges only after rule matching and merging. Deployment protects
the files, containing directories and symlink targets, especially against
untrusted redirection of a broker read. Existing broker rule-file protection is
unchanged. Matching users can retrieve their own resolved patch through the
broker socket, so granted values are not secrets from those users.

Readers bound input, require regular UTF-8 files, reject NUL and empty values,
and keep file contents out of account/machine expansion and error diagnostics.
File-derived values enter only the Pi scope; MCP receives them only through
explicit mappings. Source-file visibility is independent of environment scope:
a user-readable secret may still be readable by tools unless deployment masks
or denies its location. Installation validation and packaging do not read or
copy referenced secret files.

The Bubblewrap worker starts from a cleared environment and gives command
children fixed values required for execution plus the effective configured
`sandbox` scope. Sandbox-scoped values are deliberately model-visible and must
not contain secrets. They cannot replace fixed sandbox values. Command children
do not otherwise inherit provider tokens, cloud credentials, SSH/GPG agent
sockets, Git askpass helpers, desktop/session buses, or container-engine
sockets.

The host sends sandbox-operation requests through anonymous pipes inherited when it starts the
worker. Length-prefixed protocol frames prevent output and partial reads from
changing message boundaries. No socket or filesystem IPC endpoint accepts
requests inside the tool sandbox. Separately, optional user resolution occurs
before sandbox startup through a root systemd Unix socket. That broker derives
the caller's UID from `SO_PEERCRED`, returns only the matching user/group patch,
and never enters the Bubblewrap boundary. The worker
runs independent commands without a fixed active/outstanding count limit.
Background descendants may persist between calls and logical sessions with their
existing authority, without a new approval for every action. Per-request failures
and cancellation do not sweep peers. Active process-group cleanup is best effort
and may miss detached descendants. Once the direct child exits no later group
signal is sent; application exit state is not an atomic PID/PGID identity guarantee.
Linux final executor shutdown terminates the namespace; fatal worker/transport
failure can abort all requests. No total resource bound is promised for arbitrarily
many concurrent calls. Ordinary scheduling is not exclusion against background writers.

The filesystem may still contain credentials because broad host read access is
intentional. Environment cleaning protects against accidental ambient authority;
it is not a confidentiality promise.

Direct command children instead inherit the ordinary host environment, with
internal `PI_SANDBOX_*` variables removed and effective `environment.sandbox`
values overlaid. They also inherit the user's real `HOME`. This is intentional
host compatibility, not secret isolation; typed model tools and especially an
approved Bash command may observe ambient user credentials.

## Known read-only Bash commands

The optional `[tools.bash.known_read_only]` class policy is an approval-policy
input, not a boundary. Classification never changes execution: the frozen
approval request is still the exact command the selected executor runs as
`bash -c <command>`, with the backend's ordinary filesystem, network and
environment authority. Bubblewrap or Seatbelt remains the security boundary;
direct mode has none. See
[configuration](configuration.md#known-read-only-bash-commands) for the policy
contract.

### What the class guarantees

A command is `known_read_only` only when every pipeline stage is accepted by its
reviewed registry profile, every redirection is in the accepted set, and the
execution-context checks pass. Such a command:

- runs only reviewed shell builtins or reviewed executables resolved outside the
  launch directory;
- reads only data visible to the executor, at any path the backend exposes;
- writes only captured stdout/stderr, pipes between stages, `/dev/null`, and
  private temporary files a reviewed program manages itself, such as `sort`
  spill files under `TMPDIR`; and
- opens no network connection, starts no background job, and changes no shell or
  environment state beyond `cd` within the same `bash -c` process. The one
  documented exception is Apple `cat`'s Unix-domain socket fallback, described
  under [parser and shell differentials](#parser-and-shell-differentials).

This is capability equivalence, not harmlessness. With `read`, `grep`, `find`
and `ls` already `allow`, a known read-only command can observe nothing those
tools cannot observe inside the same boundary; this is why class `allow`
requires them, both in the base TOML and after broker overrides. Reading is still
disclosure to the model and its provider. Credentials and other data the
backend exposes can be read without a prompt, exactly as with the typed tools.
Use `filesystem.hidden_paths` or `filesystem.denied_paths` to remove such data
from every tool.

"Known" means curated, not exhaustive. Unlisted commands, unlisted options and
unrecognized syntax are unclassified and use the main policy. The class can only
be more permissive than the main policy: the model chooses the command text and
can always move a command out of the class, for example by adding a variable, so
a stricter class policy would be bypassable and is rejected. The main policy is
the floor for every Bash command.

Classification fails closed. An analyzer exception, a result with another
registry version, or a malformed result makes the request unclassified. The
analyzer runs on the same immutable argument snapshot that is approved and
executed, and the class is bound into the request's integrity fingerprint, so a
later change cannot reuse a classification. A configured class policy without a
working analyzer aborts startup; there is no fallback to unclassified evaluation
or to another backend. User `!` commands are never analyzed.

Registry version 2 adds literal double-quote escapes, symbolic `~/...` only as
`cd`'s final directory operand, restricted `sed` regex-range printing, and
integer `sleep`. Double-quote decoding follows Bash's backslash parity without
rescanning decoded dollars or backticks. Every non-`cd` profile receives only
literal words, including `echo`, `true` and `false`; command names and redirects
also require literals. The analyzer never reads or resolves HOME. Bash's tilde
replacement is one unsplit, unglobbed value consumed only by the reviewed `cd`
builtin, which changes its process's directory or fails even when HOME contains
spaces, shell-looking text or a leading dash. Backend access and executable
trust checks remain unchanged after `cd`.

Redirection checks still use the exact decoded target in source order. For
example, `>"\/dev\/null"` retains backslashes and is rejected, while an input
target beginning with a retained backslash is an ordinary relative path, not
Bash's `/dev/tcp` pseudo-path. File output remains unclassified even if a later
redirect discards the stream. The sed profile scans one complete print program;
it does not admit extra scripts, execution or file writes.

### Execution-context checks

The analyzer is created once at startup with the context the executor uses: the
backend, the canonical launch directory and the environment passed to `bash -c`
children. That environment comes from the executors' own construction:

- Bubblewrap: fixed sandbox values, the effective `environment.sandbox` values
  and the tool-bundle `PATH`;
- Seatbelt: fixed values, the effective `environment.sandbox` values and the
  tool-bundle `PATH`. The per-startup scratch `HOME`, `TMPDIR`, `TMP`, `TEMP` and
  `XDG_*` directories are created later and are not consulted by any check;
- direct: the ambient environment captured at startup without `PI_SANDBOX_*`
  variables, overlaid with `environment.sandbox` and the tool-bundle `PATH`.

A command is unclassified when:

1. `BASH_ENV`, `SHELLOPTS`, `BASHOPTS` or `EXECIGNORE` is non-empty. Bash
   imports these at startup: `BASH_ENV` startup code could redefine commands,
   `SHELLOPTS=xtrace` with an inherited `PS4` containing `$(...)` runs code
   before any analyzed command, `BASHOPTS` can enable `expand_aliases` or
   `extglob`, and `EXECIGNORE` changes executable lookup. This makes the whole
   command unclassified;
2. any `LD_*` or `DYLD_*` variable, or `GCONV_PATH`, is non-empty. Dynamic-loader
   and C-library hooks such as `LD_PRELOAD`, `LD_AUDIT`, `LD_DEBUG_OUTPUT`,
   `LD_PROFILE_OUTPUT` or `DYLD_INSERT_LIBRARIES`, and `iconv` module loading
   through `GCONV_PATH`, can make any program load code or write files. This
   also makes the whole command unclassified;
3. the command contains non-ASCII text and the effective locale (the first
   non-empty of `LC_ALL`, `LC_CTYPE` and `LANG`) is neither C, POSIX nor UTF-8,
   because other multibyte encodings could decode bytes into shell syntax;
4. the environment exports a Bash function named after a command the input
   uses, including builtins. Exported functions are recognized as
   `BASH_FUNC_name` or `__BASH_FUNC<name>` variables with a `%%` or `()` suffix,
   and as legacy variables whose value starts with `()`;
5. an executable stage is used while a `command_not_found_handle` function is
   exported;
6. for an executable stage, `PATH` is missing or empty, or lookup meets an
   empty or relative entry, or an entry inside the launch directory by its path
   or after resolving symbolic links, before finding the command; finds no
   regular executable file; or resolves through `realpath` to a file inside the
   launch directory. Without `PATH`, Bash would use a compiled-in search path
   that can include the current directory; or
7. a profile's environment dependency is set: `RIPGREP_CONFIG_PATH` while `rg`
   is used without `--no-config`, or `GREP_OPTIONS` while `grep` is used, which
   Apple grep and older GNU grep honor.

Builtins are not looked up in `PATH`. Lookup uses the host process's view of the
filesystem when the command is analyzed, not the sandbox view at execution. One
analysis resolves each command name once for all of its stages; nothing is
cached between commands.

These environment inputs are administrator or launching-user values, not
model-controlled. Configuration rejects administrator `BASH_ENV`, `SHELLOPTS`,
`LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES` and
`DYLD_LIBRARY_PATH` values for every backend, and the managed runtime removes
the last five from its own environment before direct mode captures it.
`environment.sandbox` and the Bubblewrap executor also reject `BASHOPTS`,
`CDPATH`, `GLOBIGNORE` and `IFS`, as Seatbelt does. Seatbelt also rejects every
`LD_*` and `DYLD_*` name, and neither isolated
backend accepts an administrator `PATH` or exported-function name. Under those
backends only administrator `environment.sandbox` values can trigger the
environment checks; the inherited direct-mode environment can trigger any of
them. A user who exports these variables keeps Bash access; affected commands
use the main policy.

The checks target variables that change which program runs, how Bash starts, or
whether every program loads foreign code or writes files. Other
environment-driven behavior of administrator or user values, such as locale
data, `TMPDIR` or tool-specific settings, applies equally to the typed `read`,
`grep`, `find` and `ls` tools, which run in the same backend environment, so it
gives a known read-only command no capability those tools lack.

### Backend guarantees and residual risk

- **Bubblewrap and Seatbelt:** a misclassified command remains contained by the
  boundary: read-only host paths outside the configured CWD access, masked or
  denied paths, and network `none` by default. It has the same authority as any
  approved Bash command, including writes in a writable CWD and private
  temporary storage. Classification only reduces prompts within that boundary.
  Seatbelt's fixed `PATH` includes Homebrew directories that are often owned by
  the user; sandboxed commands cannot write them, but host software can, and
  the analyzer trusts executables it resolves there.
- **Direct:** there is no OS boundary, so a misclassification runs with the
  user's full authority. The context checks reject project-local executables
  and startup hooks, but a model that has already been allowed to write outside
  the project, through approved `write`, `edit` or Bash, can place an executable
  in a user-writable `PATH` directory outside the launch directory, such as
  `~/.local/bin`. A later known read-only command resolving it would then run
  without a prompt under class `allow`. Other processes running as the user can
  also replace an executable between analysis and execution. This residual risk
  is accepted. Prefer class `ask` in direct mode, or keep `PATH` directories that
  precede system tools unwritable by the account.
- **Temporary files:** reviewed programs such as `sort` may create, write and
  remove private spill files when their input exceeds memory; this is allowed
  by the class definition. The files land in private `/tmp` under Bubblewrap
  and executor scratch under Seatbelt. In direct mode `sort` creates and removes
  them in the user's real `TMPDIR` (or `/tmp` when it is unset), where other
  processes of the account can see them while they exist.
- **Resources:** known read-only commands are bounded only by the shell output
  limit, cancellation and the optional administrator command maximum; there is
  no implicit timeout. Large traversals, unbounded device reads and blocking
  reads from FIFOs consume time and host resources until a limit applies.
  Accepted `sleep` durations are finite integers up to 2147483647 seconds and
  can still occupy a command for a long time; classification adds no timeout.

### Parser and shell differentials

Classification is only as accurate as the analyzer's model of how Bash parses
and runs the command. A differential, where the analyzer sees a listed command
with accepted arguments but Bash or the program interprets the text
differently, would let an unreviewed effect run under the class policy. Typical
sources are expansions, globbing, escapes, shell options, GNU option
abbreviations and implementation-specific options.

The recognizer limits this risk by accepting only a strict literal subset whose
meaning is identical in GNU Bash 3.2 and later under `bash -c` with no startup
file. Every expansion-bearing character outside quotes is rejected, control
characters and invalid Unicode are rejected even inside quotes, and there is no
error recovery: any doubt is unclassified. Command names must match exactly;
paths, reserved words and assignment-shaped words are rejected; and only
descriptors 0, 1 and 2 may be redirected. Options use positive lists with full
long-option names and GNU argument permutation, while operand limits count every
word after the first operand. Together these take the most permissive reading
across GNU coreutils, findutils, grep and sed, uutils coreutils and the BSD and
macOS userland; options whose meaning is doubtful on any of them are omitted.
Busybox applets are not covered. A known-bypass corpus must stay unclassified,
and differential tests run accepted inputs and a seeded generated corpus under
real `/bin/bash` with stub executables, comparing the recorded argv, descriptor
types and the destinations of unique stream markers with the parse.

Some accepted options take values differently across implementations; this
changes only which words are read as data. BSD `stat -f` and `-t` take a format
argument where GNU treats them as flags, so the following word becomes a format
instead of a file, and BSD `grep --context` and `diff --context` or `--unified`
accept an optional attached value where GNU `grep --context` requires one, so a
following number becomes a pattern or file operand. Every reading is
read-only.

A recognizer or registry defect, or an implementation option with an
unreviewed effect, can still misclassify a command. Bubblewrap and Seatbelt
contain the result; direct mode does not. The differential test runs unchanged
on Linux and macOS and passed natively under macOS `/bin/bash` 3.2. It runs stub
executables, so it verifies Bash parsing and stream wiring, not utility
behavior. Registry option semantics on the macOS system utilities and the
selected tool bundle were reviewed separately by native probes of every
accepted option spelling (see [testing](testing.md#bash-command-analysis)).
Event records carry the registry version used for each decision.

Apple `cat` has a Unix-domain socket fallback: its manual page and source
connect to a socket path given as an operand and read what the peer sends. On
the tested Mac (macOS 26.7.1), Apple `cat` failed before connecting
(`ai_family not supported`), so no positive control was possible. An
independent control showed that Seatbelt `network = "none"` denies Unix-domain
connects with `EPERM` while `host` permits them. The typed `read` tool runs the
same `/bin/cat`, so capability equivalence holds. The remaining exposure is
Seatbelt with network `host`, or direct mode, where `cat` of a socket path may
connect to a local service and read whatever it sends on connect. This is a
documented residual risk, not a claim that known read-only commands perform no
local IPC.

## Residual risks

- Bubblewrap shares the host kernel; it is not a virtual-machine boundary.
- Direct mode provides policy gating and bounded process lifecycle, but no OS
  containment.
- Commands can damage or delete the project when `cwd_writable = true`.
- An approved Bash command has all authority exposed by the sandbox mounts and
  effective network mode.
- Read-only visibility may expose sensitive contents to a model through an
  allowed read or shell operation, including known read-only Bash commands that
  run without a prompt.
- In direct mode, a misclassified known read-only command, or an executable
  planted in a user-writable `PATH` directory outside the project, runs with the
  user's full authority.
- On macOS under Seatbelt network `host` or in direct mode, a known read-only
  Apple `cat` of a Unix-domain socket path may connect to a local service and
  read what it sends on connect.
- Resource exhaustion requires separate host controls; v1 does not claim a
  complete cgroup or seccomp policy.
- The local user can run unrelated software outside the managed executable.
- A local user can request and inspect their own broker patch; the broker
  protects other users' drop-ins, not the current user from their own
  values.
- An approved managed host tool has the invoking user's host authority within
  the operation exposed by its compiled implementation and inherited program
  configuration.

Use ordinary backups, version control, least-privilege Unix accounts, and host
resource controls where those risks matter.

## Model-tool event records

Optional Linux event collection attributes submissions to the Unix account
identified by kernel socket credentials. The root collector supplies identity
fields; a client cannot select a different UID or account name. Every event
records `principal_uid` and the trusted resolved `principal_user` (null for an
unmapped UID), plus the peer PID. Group membership is not included in events. Pi session identifiers, tool
metadata, and reported outcomes originate in the trusted application. Shared
Unix accounts remain shared principals.

Root ownership protects the collector endpoint. Protection, retention, and
forwarding of accepted records belong to the host syslog infrastructure.
Successful local submission does not prove durable storage. The feature does
not independently verify human consent, execution, or completeness against a
hostile account owner, who can run unrelated software or submit false reports
under their own UID.

Records exclude file contents, edit diffs, and tool output. Target paths, the
launch CWD, and bounded Bash commands are intentional identifying fields and
may contain sensitive information. Bash commands are truncated, not redacted.

### Administrator command sets

Main-policy `[tools.bash.command_sets]` entries are administrator assertions about
literal argument shapes. They are not additions to the product-reviewed read-only
registry, and do not prove that an executable is harmless. Programs can interpret
ordinary operands as scripts, response files or configuration, and may load plugins
or hooks. Review these behaviors and relevant environment dependencies before
allowing a shape; do not approve general interpreters or arbitrary execution flags.

The shared parser, redirection checks and execution-context gates still apply.
Known registry commands retain their documented environment checks even when a
custom argument shape matches. Every stage must match a custom allow rule or an
effectively allowed built-in class for automatic approval; otherwise the entire
call uses the ordinary Bash policy. `disabled` never becomes available through
these rules. Matching grants no new OS authority and performs no partial execution.
The existing executable-resolution race remains; this feature neither pins binary
contents nor treats arbitrary user-writable program configuration as trusted.
