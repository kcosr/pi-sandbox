# Pi sandbox extension

The same filesystem and shell implementation used by Pi Sandbox, packaged for
ordinary Pi. Pi stays on the host. The configured backend runs tools through
Bubblewrap's filesystem, network and process namespaces on Linux or Seatbelt's
filesystem and network policy on macOS. Explicit direct mode executes tools as
the host user and provides no sandbox isolation.

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

Install the resulting tarball alongside ordinary Pi **1.3.0**. Its public Pi
peer dependencies must resolve to that version. No private repository, adjacent
source checkout or second bundled Pi SDK is required.

Create a private JSON file outside the project, owned by your account and mode 0600. For Linux Bubblewrap, use absolute paths for your installed Bubblewrap and
Node 24 or Bun 1.3.14+ executables. Seatbelt and direct configurations follow below:

```json
{
  "version": 6,
  "mode": "owned",
  "backend": {
    "kind": "bubblewrap",
    "executable": "/usr/bin/bwrap",
    "runtime": "/usr/bin/node",
    "network": "none",
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

Standalone configuration version 6 contains execution settings only. Old versions
and removed `processLifetime` fields are rejected; there is no compatibility parser.
Approvals remain part of managed Pi Sandbox's TOML policy.

The optional common `maximumTimeoutMs` field caps every command, independent of
backend. It accepts positive finite milliseconds through 2147483647. Without a
cap or caller timeout there is no timer. An omitted caller timeout uses the cap;
a shorter value wins; a value above it is rejected. Timers start at successful
launch, excluding approvals, file coordination and transport waiting, and remain
active through output draining. Each command in a file operation is timed separately.
Host Git, MCP and Code Mode keep their own timing contracts.

Bubblewrap requires Linux user namespaces and the documented GNU prerequisites.
`network: "local"` enables sandbox-loopback TCP/UDP; `host` shares host networking.
All backends retain Pi's scheduling without a serial queue or fixed command-count
limits. Same-file mutations remain coordinated. Background descendants may survive
completion. Cancellation and failure affect only their request; active group
cleanup is best effort. Bubblewrap's final shutdown terminates its namespace;
fatal worker or transport failure can abort that executor. No watcher or monitoring
daemon is added.

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
best-effort command-group cleanup.

For opt-in macOS Seatbelt, replace `backend` with:

```json
{
  "kind": "seatbelt",
  "network": "none",
  "cwdWritable": true,
  "deniedPaths": [],
  "environment": {}
}
```

Seatbelt uses fixed `/usr/bin/sandbox-exec` and the same macOS GNU prerequisites
as direct mode. `network` accepts only `none` or `host`. `deniedPaths` accepts up
to 63 unique absolute paths to existing canonical directories; missing targets,
files, symlink components and contradictory grants fail startup. Unlike managed
TOML, standalone JSON paths are literal and do not expand account macros or `~`.
A denied ancestor admits only CWD, then explicit interior denials apply; denying
CWD itself is rejected. Denials cause access errors, not empty mounts. Ordinary host paths are read-only
except writable CWD and executor-owned real host scratch. HOME and TMPDIR use
that scratch; literal `/tmp` is not private. It accepts no launcher override,
worker runtime, `hiddenPaths`, or `processLifetime` field.

Commands may overlap, with bounded input/output and optional command timeouts. Normal
foreground completion can leave background descendants alive, including those
still in its process group. Cancellation, timeout, output failure and close
attempt process-group cleanup only while the direct child remains active.
Detached descendants can escape those attempts. Surviving descendants retain
their original filesystem/network grants after completion, session changes,
close or owner death. Scratch removal is best effort and does not revoke grants.
No private namespace, lifecycle supervisor or parent-death cleanup is promised.
Qualify the package on each intended macOS architecture under Node and Bun.

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
its configured Bubblewrap, Seatbelt or direct executor at session initialization. The embedding
application owns any executor it supplies to the factory and must close it explicitly.

Built artifacts include declarations, the worker, license and provenance. Run
`npm run test:extension` from the repository to build, inspect and exercise the
tarball with stock Pi under Node/Bun, using Bubblewrap on Linux, Seatbelt on macOS, and direct execution.
The package includes ordinary tool UI rendering, command output streaming and
cancellation. It does not provide interactive terminal sessions or a VM controller.
File-tool cards keep absolute paths intact. Explicit `~` and `~/...` arguments
are labelled `tool home`, referring to the executor's home rather than the Pi
process's home. They do not link to a host file or resolve against a different
executor when displaying session history. Call rendering preserves read ranges,
search options, and write previews without reading target files on the host.
Existing links on explicit absolute paths remain host-file links; an external
executor or private mount may expose different contents at that path.
The default package is JavaScript-only; no compiler, Python or native runtime
helper is required to use it. A build may select a pinned native macOS tool
bundle with `node scripts/build-extensions.mjs --distribution FILE`. That
artifact includes executables, dependent dylibs, licenses and an inventory under
`dist/native-tools`, with package-relative immutable selection recorded in provenance.
It requires the inventory's OS, architecture and minimum OS version. Missing
selected tools fail closed; runtime JSON and environment variables cannot change
the selection. Unselected commands keep the ordinary system prerequisites.
Stock Pi's interactive `fd`/`rg` helpers retain their own cache/PATH behavior;
the managed application's exact host-tool selection is not injected into stock Pi.

Install bundled packages outside the writable workspace: confined executors
reject bundle/workspace overlap and exclusions hiding selected prerequisites.
Embedding applications can pass trusted `toolBundle: { root, commands }` to an
executor constructor. `root` and selected command paths must be canonical and
existing; command paths remain beneath that root. Applications that rebundle
the default entry must preserve its adjacent tools layout. See the repository's
installation documentation for the strict build artifact schema.
