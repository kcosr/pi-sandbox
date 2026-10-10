# Pi sandbox extension

The same filesystem and shell implementation used by Pi Sandbox, packaged for
ordinary Pi. Pi stays on the host. Bubblewrap runs tools inside its filesystem,
network and process boundary. Explicit direct mode executes tools as the host
user and provides no sandbox isolation.

This package does not impose the managed application's administrator controls.
Other extensions and host MCP servers are outside this execution boundary.
Pi Sandbox embeds these modules with mandatory policy, managed configuration,
admitted MCP connections and audit logging.

## Build and load

From a Pi Sandbox source checkout with Node 24 and dependencies installed:

```sh
npm run build:extensions
npm pack ./packages/sandbox-extension
```

Install the resulting tarball alongside ordinary Pi **1.1.0**. Its public Pi
peer dependencies must resolve to that version. No private repository, adjacent
source checkout or second bundled Pi SDK is required.

Create a private JSON file outside the project, owned by your account and mode 0600. Use absolute paths for your installed Bubblewrap and Node 24 or Bun 1.3.14+
executables:

```json
{
  "version": 4,
  "mode": "owned",
  "backend": {
    "kind": "bubblewrap",
    "executable": "/usr/bin/bwrap",
    "runtime": "/usr/bin/node",
    "network": "none",
    "processLifetime": "command",
    "cwdWritable": true,
    "hiddenPaths": [],
    "environment": {}
  },
  "userBash": true
}
```

Load the installed package's entry explicitly:

```sh
pi --no-extensions --no-builtin-tools \
  -e /absolute/path/to/installed/package/dist/index.js \
  --sandbox-config /absolute/path/to/sandbox.json
```

Use ordinary Pi provider/model/reasoning arguments as usual. All seven replacement
tools are available subject to Pi's tool selection, without approval prompts.
`userBash` explicitly allows the user's `!` shell; false blocks it without falling
back to host execution. Among competing extension tool names or user-shell
handlers, pinned Pi uses the first applicable extension in runner order; load
sandbox before competing replacements. Other extension JavaScript remains host code.

Standalone configuration version 4 contains execution settings only. To update a
version-2 configuration, remove `tools` and set `version` to `4`. Old versions and
unknown fields are rejected. Approvals are part of managed Pi Sandbox; its TOML
configuration and mandatory policy remain unchanged.

Bubblewrap requires Linux user namespaces and the GNU command prerequisites
listed in the repository's installation guide. `network: "local"` enables only
the sandbox's loopback TCP/UDP; `host` shares host networking. `processLifetime:
"sandbox"` preserves background programs between completed operations and runs
up to four commands concurrently, with a maximum of 64 outstanding requests.
Excess submissions fail with `sandbox_queue_full`. Default
examples use command lifetime, which cleans up descendants after each operation.
Cancellation and errors may clean up all sandbox programs in either mode. In
sandbox lifetime this interrupts other active calls; queued work starts only
after cleanup finishes. Cancelling queued work affects only that request.

The extension owns one backend per Pi process. Conversation switching keeps that
backend. Quit closes it; extension
reload closes it before a replacement starts. Changing the configured workspace
or backend requires an explicit reload/restart. Startup failure disables these
tools instead of falling back to host execution. The worker is the existing
Bubblewrap command executor, not a lifecycle monitoring daemon.

For explicit host execution, replace `backend` with:

```json
{ "kind": "direct", "environment": {} }
```

Direct mode keeps the existing platform-specific command prerequisites and
command-scoped cleanup.

## Linux smolvm

smolvm **1.25.4** is supported on Linux x86-64 with `/dev/kvm`. Install the complete
official distribution outside the project. The package verifies its pinned
executable, library and guest-rootfs inventory before launching anything.
Provision a trusted plain Linux tools pack separately with the required GNU
commands and Node. The image must be offline, without an imported workload,
environment, secrets or checkpoint; its SHA-256 is mandatory.
The public [image preparation guide](https://github.com/kcosr/pi-sandbox/blob/main/docs/smolvm-images.md)
provides a small recipe and upstream CLI commands.

Use the same version-4 configuration, replacing `backend` with:

```json
{
  "kind": "smolvm",
  "executable": "/opt/smolvm-1.25.4/smolvm",
  "image": "/opt/pi-images/tools.smolmachine",
  "imageSha256": "<64 lowercase hexadecimal characters>",
  "stateDirectory": "/home/alice/.local/state/pi-vm",
  "resources": { "cpus": 2, "memoryMiB": 1024, "storageGiB": 1, "overlayGiB": 1 },
  "cwdWritable": true,
  "environment": {}
}
```

Create `stateDirectory` as an owned private directory (0700). Its canonical path
must be at most 48 bytes because smolvm uses Unix sockets. Keep runtime, image,
configuration and state outside the project. The host project is mounted at the
same absolute path, writable unless `cwdWritable` is false. Project edits persist;
the disposable guest root does not. Other host directories are not projected into
the guest. Host Pi keeps its providers, MCP connections, logs and credentials.
This backend disables external guest networking. It does not prohibit guest-local
socket operations. Background programs persist between ordinary calls.

Up to four commands execute concurrently, with at most 64 outstanding requests.
Timeouts include queue wait; queued cancellation/timeout affects only that call.
The existing guest agent handles separate execution connections. A transient
wrapper matches Pi's 100 ms post-exit idle drain, resetting on further output;
redirect background output to files to allow prompt completion.

The extension runs smolvm CLI commands in the Pi process's lifecycle and closes
its VM on normal quit/reload. Active cancellation, timeout, output overflow and
transport failures interrupt peer calls and retire the VM, including earlier
background processes. This differs from Bubblewrap's reusable sandbox cleanup;
smolvm does not expose an equivalent whole-workload reset. Normal nonzero command
exits keep the VM available. There is no custom background watcher. If Pi is killed or crashes, a
smolvm VM can remain alive. Private state contains `owner.json`, recording the
runtime path and private HOME/XDG environment. Use those values with
`smolvm machine ls --json`, then `machine stop --name workspace` and
`machine delete --name workspace --force`. An unconfirmed stop preserves state;
do not remove state before the VM is stopped.
Stock Pi can still exit successfully after reporting an extension cleanup error;
inspect that error and the retained state instead of relying only on its exit code.

## Borrowed OCI machines

The `./controller` export lets an orchestrator create an OCI family from a local,
digest-pinned `docker save` archive. The workspace and writable root live on guest
disks, with optional explicit read-only host inputs. `networkMode` is either
`none` or explicit `host`; the latter enables smolvm outbound networking and does
not literally join the host kernel namespace.
Creating OCI disks smaller than the bundled 20 GiB storage or 10 GiB overlay
templates requires host `resize2fs` from e2fsprogs in a system directory
(`/usr/bin`, `/bin`, `/usr/sbin` or `/sbin`). The launcher clears the inherited
PATH. Prepared plain packs already contain sized templates and do not require
this host shrink step.

Owned and OCI guest commands use the same fixed environment defaults, including
`HOME=/root` and `TMPDIR=/tmp`; scoped environment cannot override those names.
OCI commands now receive `TMPDIR` explicitly, where it was previously unset.

`family.branch(id, { branchable: false })` freezes the source and makes a cheap,
independently writable leaf. Use `branchable: true` only for a child that must
later be branched itself. It incurs additional RAM-backing work. Native Linux
qcow2 overlays share the immutable source disks. Host mounts are not snapshotted.
Remove child leaves before their source. A child-free original source
can be retained and explicitly cold-reopened on the same host; cold reopening
restores disks, not running processes or RAM. The source may be frozen or writable;
edits to a reopened original are saved by another clean `retainForColdReopen()`.

A trusted orchestrator writes this private configuration for ordinary Pi:

```js
const config = {
  version: 4,
  mode: "attached",
  attachment: family.attachment(machineId),
  userBash: false,
};
```

The attachment is a host-only capability. Do not place it in the guest or model
context. Pi receives only that machine's tool access. Quitting/reloading Pi closes
the attachment; the orchestrator owns VM shutdown and retained disks. The
controller's socket server runs inside the orchestrator, not a separate daemon.

The four-active/64-outstanding limit is shared across the family and its borrowed
attachments. Branching, removal and retention take exclusive FIFO admission;
they wait for earlier calls and block later calls until complete. An active
execution failure retires the entire family. Cancelling a queued attachment
request leaves other work intact.
Normal controller close stops machines and removes disposable state. Abrupt
owner death may require manual recovery using its recorded private environment.
Evaluator application adoption is a separate milestone.

### Interactive controller terminals

Trusted host applications can call `family.openTerminal(machineId, options)` on
the writable source or an exact writable child. This is a controller capability,
not an agent tool or an attachment RPC. It starts a fixed interactive Bash shell
at the family working directory through the verified smolvm executable.

Supply `terminalType`, `columns`, `rows` and a runtime-specific `launch` callback,
plus an optional abort signal. The launcher receives the fixed argv, private
host environment, state-directory cwd, dimensions, a startup marker and a scoped
signal. It must provide a real host PTY and consume the exact startup marker
before resolving, then return `completion`, `write`, `resize` and `close`.
smolvm flushes early input while entering raw mode, so resolving merely when the
host client spawns can lose the first command. The launcher owns bounded input
and output backpressure; a rejected launch must already have cleaned up any
partially started client. The public library does not depend on Bun, a PTY
package, or a native helper process.
If startup cleanup cannot be confirmed, the launcher must reject with the
exported `SmolvmOciTerminalCleanupError`, which preserves that uncertainty for
later family cleanup instead of treating the rejection as a clean launch failure.

Each of up to 16 sessions per family has its own exec client. Long-lived terminals
do not consume the four ordinary command slots. `write` resolves when input is
accepted, `resize` updates the PTY, and `close` stops and reaps only that exec
client. A normal or failed terminal exit does not automatically retire the VM or
cancel another terminal. The completion result acknowledges host-client exit,
not guest descendant cleanup; deliberately detached guest jobs may remain.

Close a machine's terminals before awaiting its branch or removal. Those
exclusive transitions wait for its terminal leases, while preventing new
terminal admission. Retention waits for every terminal; family shutdown actively
closes all of them. Failed terminal cleanup makes subsequent lifecycle work fail
and retains state for explicit recovery. It never publishes a clean cold receipt
after an unconfirmed cleanup. Applications should stop terminal admission and
close their sessions before automatic collection, reviewer removal or shutdown.

## Programmatic composition

- `./factory`: seven tool definitions and user-shell routing over a supplied
  executor, with required authorization of the exact normalized request.
- `./runtime`: bounded executor contracts and explicit backend constructors.
- `./controller`: OCI family creation, branching, attachment and cold reopening.
- `./config`: strict standalone JSON validation and bounded private-file reading.
- `./identity`: artifact version, source commit and source digest.

- `./invocation`: built-in names, neutral immutable requests and pure JSON snapshot helpers.

The factory requires an explicit authorization callback. It normalizes and freezes
arguments before calling it, passes the actual tool-call signal, and executes the
same snapshot only after success. The standalone entry deliberately supplies a
no-op callback. Managed Pi Sandbox supplies its internal policy/audit callback;
an evaluator can supply its own authorization with an immutable tool ceiling.
No permissions package is installed or discovered.

Importing these modules does not create a sandbox. The default extension initializes its owned backend or borrowed attachment
at session initialization. The embedding application owns any
executor it supplies to the factory and must close it explicitly.

Built artifacts include declarations, the worker, license and provenance. Run
`npm run test:extension` from the repository to build, inspect and exercise the
tarball with stock Pi and both Node/Bun workers on Linux.
