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

- ordinary host filesystem readable;
- only the captured launch CWD persistently writable;
- private temporary/runtime storage writable, except when host `/tmp` itself is
  deliberately selected as the writable launch CWD;
- no network access from sandbox tools or shell commands unless an
  administrator explicitly selects unrestricted host networking;
- no ambient host credentials or service sockets in the sandbox environment.

Managed host tools are explicit exceptions to this sandbox ceiling and carry
the host authority described below. Direct execution is a separate explicit
operating mode, not a containment boundary: every approved built-in tool and
user `!` shell runs with the invoking user's ordinary host authority.

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
effective root-managed administrative configuration and is never selected
after a Bubblewrap failure.

The distribution's compiled `config_dir/config.toml` is the fixed global policy
and scoped-environment source. In broker mode, an optional root-only
`config_dir/users.d/<uid>.toml` may provide that UID's scoped-environment
and administrator-selected model/execution/network/tool patch. A missing
directory or matching file preserves the main configuration unchanged. Pi's
internal model catalog is disabled. `PI_CODING_AGENT_DIR` may
redirect user state but cannot redirect these administrative inputs. Missing,
unreadable, or invalid effective inputs abort startup. The broker requires the
drop-in directory to be root-owned and not group/other writable, and matching
files to be root-owned regular files with mode `0600`; ownership and
permissions for the main TOML and model files remain deployment responsibilities.

The base TOML remains the global tool policy. Per-UID drop-ins can replace
complete policies for selected tools, including denying or disabling
`git_clone` and any other selected extension tool. Environment values do not select extensions,
enable tools, grant approvals, or otherwise change policy.

The following conditions deny the operation or abort startup rather than use a
host fallback:

- the configured executor is unavailable or its probe fails;
- the interactive application is launched with effective UID `0`;
- administrative configuration or the selected model catalog is missing or
  invalid;
- the broker is unavailable or the matching per-UID drop-in is invalid;
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
captured launch CWD is mounted over its identical path read/write. Linux mount
resolution makes the more specific writable subtree take precedence.

The sandbox receives its own process and device views and private writable temp
and runtime locations. Host pseudo-filesystems and privileged sockets are not
bind-mounted as host resources.

Broad read access is intentional. Pi Sandbox does not attempt to keep ordinary
host data secret from the model. Operators must not use it as a confidentiality
boundary.

Direct mode has no filesystem ceiling. Typed read/search tools use their
approved path arguments, typed write/edit tools may mutate any approved path
the current user can mutate, and approved Bash has the user's full filesystem
authority. Disabling the model-visible `bash` tool is useful when an operator
wants only typed model operations, but it does not turn direct mode into a
sandbox. User `!` remains available because it is invoked by the human rather
than advertised to the model.

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
configuration or a root-managed per-UID broker drop-in can select this mode.

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
links. A pre-existing writable hard link beneath the CWD can therefore mutate
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
the caller's UID from `SO_PEERCRED`, returns only the matching per-UID patch,
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
- Writable-CWD commands can damage or delete the project.
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
