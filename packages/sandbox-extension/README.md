# Pi sandbox extension

The same filesystem and shell implementation used by Pi Sandbox, packaged for
ordinary Pi. Pi stays on the host. Bubblewrap runs tools inside its filesystem,
network and process boundary. Explicit direct mode executes tools as the host
user and provides no sandbox isolation.

This package does not impose the managed application's administrator controls.
Other extensions and host MCP servers are outside this execution boundary.
Pi Sandbox embeds these modules with mandatory policy, managed configuration,
admitted MCP connections and audit logging.

Applications can compose the public seven-tool factory with an application-owned
`SandboxExecutor`. This interface supplies command execution, CWD, home, command
paths, readiness and cleanup. It has no backend name or container-specific logic.
The embedding application owns the execution environment and its lifecycle.

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

## Programmatic composition

- `./factory`: seven tool definitions and user-shell routing over a supplied
  executor, with required authorization of the exact normalized request.
- `./runtime`: bounded executor contracts and explicit backend constructors.
- `./config`: strict standalone JSON validation and bounded private-file reading.
- `./identity`: artifact version, source commit and source digest.

- `./invocation`: built-in names, neutral immutable requests and pure JSON snapshot helpers.

The factory requires an explicit authorization callback. It normalizes and freezes
arguments before calling it, passes the actual tool-call signal, and executes the
same snapshot only after success. The standalone entry deliberately supplies a
no-op callback. Managed Pi Sandbox supplies its internal policy/audit callback;
an embedding application can supply its own authorization with an immutable tool ceiling.
No permissions package is installed or discovered.

Importing these modules does not create a sandbox. The default extension initializes
its configured Bubblewrap or direct executor at session initialization. The embedding
application owns any executor it supplies to the factory and must close it explicitly.

Built artifacts include declarations, the worker, license and provenance. Run
`npm run test:extension` from the repository to build, inspect and exercise the
tarball with stock Pi under Node/Bun, using Bubblewrap on Linux and direct execution.
The package includes ordinary tool UI rendering, command output streaming and
cancellation. It does not provide interactive terminal sessions or a VM controller.
The package is JavaScript-only; no compiler, Python or native runtime helper is
required to use it.
