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
  "version": 1,
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
"sandbox"` preserves background programs between completed operations. Default
examples use command lifetime, which cleans up descendants after each operation.
Cancellation and errors may clean up all sandbox programs in either mode.

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
command-scoped cleanup. This milestone provides Bubblewrap and direct execution;
VM backends and evaluator attachments are delivered separately.

## Programmatic composition

- `./factory`: seven tool definitions and user-shell routing over a supplied
  executor, with required authorization of the exact normalized request.
- `./runtime`: bounded executor contracts and explicit backend constructors.
- `./policy`: pure authorization engine plus optional Pi approval UI adapter.
- `./config`: strict standalone JSON validation and bounded private-file reading.
- `./identity`: artifact version, source commit and source digest.

Importing these modules does not create a sandbox. The default extension starts
its backend at session initialization. The embedding application owns any
executor it supplies to the factory and must close it explicitly.

Built artifacts include declarations, the worker, license and provenance. Run
`npm run test:extension` from the repository to build, inspect and exercise the
tarball with stock Pi and both Node/Bun workers on Linux.
