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
- no network access from sandbox tools or shell commands unless an
  administrator explicitly selects unrestricted host networking;
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

## Fail-closed guarantees

The supported executable does not load user or project extensions, permit Pi
package-management commands, enable Pi's built-in extension factories, or
expose Pi's built-in filesystem or Bash implementations. The separately
maintained Pi Sandbox extension and build-selected extension modules
are compiled into the executable; Pi receives only the one forced Pi Sandbox
extension through its inline API. Each enabled operation uses its replacement
tool backed by its declared boundary. The seven replacements and user shell use
the configured Bubblewrap or direct executor. Explicit managed host tools use only
their compiled direct-argument implementation; sandbox failure never changes a
tool into a host operation. Direct execution is admitted only from the
effective selected configuration and is never selected
after a Bubblewrap failure.

In managed builds (`allow_config_override = false`), the distribution's
compiled `config_dir/config.toml` is the fixed global policy and
scoped-environment source. A build with `allow_config_override = true` instead
allows the caller to explicitly select that source with a leading `--config FILE`.
This build mode delegates policy choice to the caller and is unsuitable for
forcing staff to use administrator-selected permissions. The option cannot
change the compiled extension catalog, root runtime check, or Bubblewrap binary.
Service sockets and service-owned configuration remain build-selected. In broker mode, optional root-only rules in
`config_dir/users.d/*.toml` and `config_dir/groups.d/*.toml` may provide matching account/group scoped-environment
and administrator-selected model/execution/network/filesystem/tool patch. If no rules
match, the main configuration remains unchanged. Pi's
internal model catalog is disabled. `PI_CODING_AGENT_DIR` may
redirect user state but cannot redirect these administrative inputs. Missing,
unreadable, or invalid effective inputs abort operational startup. An exact
`--version` is metadata-only and does not read those inputs. The broker requires the
drop-in directory to be root-owned and not group/other writable, and matching
files to be root-owned regular files with mode `0600`; ownership and
permissions for the main TOML and model files remain deployment responsibilities.

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
- the broker is unavailable or the matching user/group drop-in is invalid;
- an unsafe managed-executable argument is supplied;
- the selected command process cannot start or report a coherent result;
- a required model-tool approval cannot be obtained;
- a request is malformed, oversized, cancelled, or stale;
- a mutation's outcome cannot be proven; or
- process-tree cleanup cannot be proven.

The same fail-closed behavior applies to host-tool argument validation,
prerequisites, startup, cancellation, timeout, and output bounds. A selected
extension whose required absolute executable is absent aborts startup.

## Managed host-tool authority

Managed host tools intentionally execute as the invoking Unix user outside
Bubblewrap. They retain the host filesystem view, network namespace, user
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

The read-only CWD setting is a Bubblewrap filesystem restriction. It applies to
model Bash and human shell commands as well as typed tools; an approval cannot
bypass it. Direct mode rejects the setting, and managed host tools retain their
explicit host authority. Writable private runtime/temp storage remains available.

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

The required effective mode is `none` or `host`. In the default `none` mode,
tool execution uses a new network namespace with no configured egress and the
seccomp filter denies `socket`. This prevents connections to Internet, LAN,
host loopback, metadata services, and pathname or abstract Unix-domain sockets.

In `host` mode, Bubblewrap shares the complete host network namespace and
seccomp permits `socket`. Sandboxed commands can therefore reach host loopback,
LAN, Internet, metadata endpoints, and visible or abstract Unix-domain services
subject only to ordinary host controls. This is not filtered egress. Bubblewrap
does not enforce IP, port, hostname, or destination rules. Only the fixed base
configuration or a root-managed user/group broker drop-in can select this mode.

In both modes the classic seccomp BPF program denies the three `io_uring`
control syscalls. Anonymous `socketpair()` remains available because Bun uses it
to spawn command children. On x86-64 the filter rejects the x32 syscall ABI; the
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
processes one command at a time and removes all command descendants between
requests.

The filesystem may still contain credentials because broad host read access is
intentional. Environment cleaning protects against accidental ambient authority;
it is not a confidentiality promise.

Direct command children instead inherit the ordinary host environment, with
internal `PI_SANDBOX_*` variables removed and effective `environment.sandbox`
values overlaid. They also inherit the user's real `HOME`. This is intentional
host compatibility, not secret isolation; typed model tools and especially an
approved Bash command may observe ambient user credentials.

## Residual risks

- Bubblewrap shares the host kernel; it is not a virtual-machine boundary.
- Direct mode provides policy gating and bounded process lifecycle, but no OS
  containment.
- Commands can damage or delete the project when `cwd_writable = true`.
- An approved Bash command has all authority exposed by the sandbox mounts and
  effective network mode.
- Read-only visibility may expose sensitive contents to a model through an
  allowed read or shell operation.
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
