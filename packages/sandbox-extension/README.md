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
npm run build:extension
npm pack ./packages/sandbox-extension
```

Install the resulting tarball alongside ordinary Pi **1.1.0**. Its public Pi
peer dependencies must resolve to that version. No private repository, adjacent
source checkout or second bundled Pi SDK is required.

Create a private JSON file outside the project, owned by your account and mode 0600. Use absolute paths for your installed Bubblewrap and Node 24 or Bun 1.3.14+
executables:

```json
{
  "version": 2,
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
  "tools": {
    "read": { "mode": "allow", "sessionGrant": "never" },
    "grep": { "mode": "allow", "sessionGrant": "never" },
    "find": { "mode": "allow", "sessionGrant": "never" },
    "ls": { "mode": "allow", "sessionGrant": "never" },
    "write": { "mode": "ask", "sessionGrant": "offer" },
    "edit": { "mode": "ask", "sessionGrant": "offer" },
    "bash": { "mode": "ask", "sessionGrant": "offer" }
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

Use ordinary Pi provider/model/reasoning arguments as usual. Missing tool policy
entries are disabled. `allow`, `ask`, `deny` and `disabled` control invocation;
Pi's `--tools` controls presentation and cannot expand configuration permissions.
`ask` without an available approval UI denies execution. `userBash` explicitly
allows the user's `!` shell independently of model-tool approval; false blocks it
without falling back to host execution.

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
backend while clearing conversation approval grants. Quit closes it; extension
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

Use the same version-2 configuration, replacing `backend` with:

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

`family.branch(id, { branchable: false })` freezes the source and makes a cheap,
independently writable leaf. Use `branchable: true` only for a child that must
later be branched itself. It incurs additional RAM-backing work. Native Linux
qcow2 overlays share the immutable source disks. Host mounts are not snapshotted.
Remove child leaves before their source. A frozen, child-free original source
can be retained and explicitly cold-reopened on the same host; cold reopening
restores disks, not running processes or RAM.

A trusted orchestrator writes this private configuration for ordinary Pi:

```js
const config = {
  version: 2,
  mode: "attached",
  attachment: family.attachment(machineId),
  tools: selectedToolPolicies,
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

## Programmatic composition

- `./factory`: seven tool definitions and user-shell routing over a supplied
  executor, with required authorization of the exact normalized request.
- `./runtime`: bounded executor contracts and explicit backend constructors.
- `./controller`: OCI family creation, branching, attachment and cold reopening.
- `./policy`: pure authorization engine plus optional Pi approval UI adapter.
- `./config`: strict standalone JSON validation and bounded private-file reading.
- `./identity`: artifact version, source commit and source digest.

Importing these modules does not create a sandbox. The default extension initializes its owned backend or borrowed attachment
at session initialization. The embedding application owns any
executor it supplies to the factory and must close it explicitly.

Built artifacts include declarations, the worker, license and provenance. Run
`npm run test:extension` from the repository to build, inspect and exercise the
tarball with stock Pi and both Node/Bun workers on Linux.
