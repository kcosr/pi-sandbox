# User-directed saving of sandbox files

Status: implemented in `feature/user-sandbox-save` after subagent and Keel Oracle
design review. Current behavior is maintained in the subject documents under `docs/`.
The normative export contract below includes the subsequently accepted writable-CWD
extension; the original Oracle consultation remains historical.

## Intent and accepted direction

Let a user preserve selected files created in the existing private tool HOME or
temporary storage. Keep Linux HOME and temporary storage on their current tmpfs
mounts and keep the existing process lifetime across logical Pi sessions. Saving
is available with either writable or read-only CWD on a confined backend. With
read-only CWD, Bash, write and edit can use their existing `allow` policy while
filesystem enforcement protects host files from sandbox commands.

Saving is a user action through `/sandbox save` or the interactive exit prompt. It is not a model tool or a
Code Mode capability. It does not add persistent writable HOME, another work
directory, general host-copy execution, or automatic preservation. Normal
interactive exit checks for regular files, including hidden descendants, and asks
whether to save before the TUI stops only if files exist or the bounded check cannot
complete. Empty directories alone do not prompt. Yes opens the picker;
No or Ctrl+C on the confirmation exits without saving, while Escape, cancelling
the picker, or a failed save keeps the session open. Signals
bypass or cancel the prompt and continue cleanup.

The user may choose an existing destination directory. Existing regular files
can be replaced only after the user explicitly approves the listed conflicts.
Unique output directories are the suggested default, not a requirement.

## Current implementation facts

- `packages/sandbox-extension/src/runtime/bubblewrap-policy.ts` creates private
  `/run` and `/tmp`, sets HOME to `/run/pi-sandbox/home`, then restores the launch
  CWD at its identical path with the configured read/write or read-only access.
- `src/runtime/managed-executor.ts` caches a process-owned executor. Logical
  conversation changes preserve its storage. Final close destroys the Linux
  namespace and its private files.
- `src/extension/index.ts` already registers `/sandbox` and owns the selected
  executor. Its `session_shutdown` hook invokes process cleanup only on quit.
- The Pi extension API supports custom interactive UI components. RPC can also
  dispatch extension commands; a slash command alone is not proof of local
  interactive user intent or of custom-UI support.
- `SandboxExecutor` currently has command execution, probing and close, but no
  filesystem-export capability. Ordinary managed host extensions have no
  private-filesystem reader.
- The worker transport already frames bounded requests and responses. Ordinary
  command execution accumulates output, so large exports need an explicitly
  bounded streaming or pull-chunk protocol.
- Seatbelt HOME/temp directories are real host scratch. Descendants may survive
  close with their original grants. Direct execution has no private HOME.

## User interaction

Use a directory-at-a-time browser with a root chooser for Home and Temporary
files. Start in Home. Display a breadcrumb and a persistent selection summary.

- Space selects a file or an entire directory.
- Right opens a directory; Left returns to its parent, stopping at the root.
- Enter reviews the selection and destination; Escape cancels.
- Hidden entries (dot-prefixed basenames) are hidden by default. A toggle changes
  visibility only. Selected directories include all descendants, including
  hidden entries. State this beside selection totals.
- Select all acts on visible entries in the current directory. Existing hidden
  selections remain selected and are reflected in a hidden-selection count.
- A selected ancestor covers its descendants. The UI shows descendants as
  covered; avoiding ambiguous subtree exclusions keeps the selection contract
  simple. Deselecting the ancestor permits selecting individual children.
- The review shows every selected root, including hidden selections, plus the
  bounded expanded file count, byte total, destination mapping and any problems.
  Do not silently omit unsupported or unreadable selected entries.
- Filenames are untrusted display data: escape terminal controls and other
  misleading display characters without changing the underlying filesystem name.

Preserve paths relative to each source root. A Home-only save maps
`~/project/report.txt` to `<destination>/project/report.txt`; navigation never
changes this mapping. A Temporary-only save uses the corresponding temp-relative
path. A mixed-root save uses explicit `home/` and `tmp/` prefixes. Preview exact
output paths so the mapping is visible before approval.

Prefill a new timestamp-and-random-ID directory under a conventional saved-output
folder in the launch CWD. The field is editable by the user. Relative destination
input resolves against the captured host launch CWD; `~` in this field means the
invoking OS account's home, not tool HOME. Show the resulting absolute host path.

Before any payload is written to the host, inventory the selection, validate its
mapping, inspect the destination, and show the final Save action. If regular-file
conflicts exist, offer Replace listed files, Choose another directory, or Cancel.
Existing real directories are merged; unrelated entries are preserved. A file
versus directory mismatch, destination symlink, source symlink, special file, or
unrepresentable/name-colliding mapping is an explicit error to resolve.

Only interactive TUI invocation is admitted: require `ctx.mode === "tui"`,
not merely `hasUI`, which is also true for RPC. RPC,
print and headless invocation must return a clear unsupported message before
inventory or destination mutation. Do not send command text to the model.
Use `ctx.waitForIdle()` with a visible waiting message before opening the picker.
This waits for ordinary foreground activity, not arbitrary background processes.
The precise authority claim is that the command is absent from the model tool
catalog and requires the interactive user workflow; it is not proof of a human
originating every possible input to trusted host/UI code.

## Ownership and authorization

The command and save coordinator live in a dedicated module of the existing
forced managed extension. No new general extension loading or model tool is
introduced. The coordinator holds a narrow filesystem-export capability from
the process-owned backend; that capability never enters model-tool contexts.

Reusable listing/export primitives belong in `packages/sandbox-extension` behind
a separate backend-neutral `SandboxExportSource` capability. Keep that handle
out of `SandboxExecutor`, tool factory contexts, model tools and Code Mode. The
managed composition obtains it alongside executor creation; precise factory
wiring must be qualified with both consumers without compatibility aliases.
The managed application owns user intent, host
destination selection, confirmation, publication, and UI. Ordinary Pi consumers
must still load and run without the managed application or new private
dependencies; shared API changes require both consumers' qualification.

Administrative control remains main-authored `[exports].enabled`, including
workspace-mode overlays. It creates no `tools.save` policy, account-rule override
or automatic approval grant. Packaged Bubblewrap and Seatbelt host and sandbox
modes enable it; direct keeps it disabled. A suggested destination is convenience,
not an allowlist. The user may save wherever their host account has permission,
except destinations overlapping private sandbox scratch storage. Writable CWD
destinations are permitted. This extension adds no schema version or flag.

The admitted workflow requires a confined backend, independently of CWD writability.
Direct mode has no private source roots and does not support this command.
Do not silently switch backends, change CWD writability, or alter other tool
policies to enable saving. The user explicitly accepts the host publication races
described below for writable-CWD destinations.

## Export across the boundary

The host cannot read Bubblewrap HOME by its ordinary pathname. Read selected data
inside the existing boundary and transfer it to the application. Do not use a
general host shell, arbitrary archive extraction, or `/proc/<pid>/root` traversal
as the export API.

The backend advertises startup-registered private root IDs and identities, not
caller-supplied absolute root paths. List, manifest, open/read and cancel address
paths relative to those roots. Capture Linux root handles at startup, before the
agent can rename or replace directories under writable `/run`.

Every source read executes with the same filesystem authority as sandboxed
commands. Linux extends its existing worker and framed transport. On macOS,
launch a short-lived internal export-reader role in the existing packaged
application/runtime under the exact effective Seatbelt policy, then close it
when the save ends. Share export operations and protocol logic with Linux. The
reader role accepts no general command execution and never inherits Linux's
`/proc` process sweep. Cleanup closes its own streams/handles and child only;
it never kills unrelated commands. It is an ordinary confined operation, not a
watcher, guardian, separately installed helper binary or service. Node/Bun
ordinary-Pi embeddings need the same packaged internal reader entry.
The reader reuses the verbatim startup-built Seatbelt profile and exits on stdin
EOF; this is not a new macOS parent-death or descendant-revocation guarantee.

Never read unchecked Mac scratch paths using full parent authority: a surviving
writer could redirect a path into a directory denied by Seatbelt. Native tests
must prove the internal reader can launch under the effective profile and cannot
read through such a race into denied content.

The `/tmp` root is not entirely private when it contains the restored host CWD.
Exclude the CWD mount and its descendants from the temporary source inventory,
including when read-only. Pin the private tmpfs root's device/identity and reject
filesystem crossings as well as the known CWD overlay. A bind mount does not
generally have a unique `st_dev`; the device check is useful here because the
private tmpfs is newly created and distinct from the host CWD filesystem. Do not
substitute a general device-equals-mount claim for explicit overlay handling.
CWD exactly `/tmp` is rejected when read-only. With writable CWD exactly `/tmp`,
the worker registers only Home: no Temporary root is offered, and listing the
`tmp` root rejects with `export_invalid_root` without enumerating host `/tmp`.

Allow regular files and directories. Reject observed symlink components, links
themselves and special files; use no-follow final opens and inspect/read the same
open handle. Reject filenames that cannot round-trip through the protocol's
UTF-8 representation instead of mangling them. Linux walks through owned
directory FDs using its fixed `/proc/self/fd/<fd>/<component>`
paths; arbitrary proc paths are never caller input.

The anchored Linux walk prevents ancestor-path replacement from redirecting the
next open and rejects symlink components. Ordinary pathname checks on macOS do
not provide the same strict traversal property against every intermediate race.
On both platforms, the hard authority guarantee is that the source reader never
has more filesystem access than the agent; the parent separately restricts
requested publication to validated, user-authorized manifest paths, subject to
the accepted destination races below. Observed-link
checks and root identities enforce intended selection and detect changes; they
are not an inode-provenance or atomic-snapshot guarantee. An agent can already
copy any sandbox-readable content into HOME. A selected file's contents therefore
remain agent-controlled data, even when its displayed name and size were reviewed.

Create a bounded manifest before user confirmation and transfer only manifest
entries. Do not add newly created descendants during copying. Source file
identity/size/timestamp changes detected before or during copying fail that entry
and are reported. This is a live file copy, not an atomic snapshot of a running
filesystem. Hashes identify received/copied bytes, not global consistency or
the mutable destination's lasting contents. Wait for ordinary foreground activity to idle, without killing or
claiming exclusion against background writers.

Use strict pull with exactly one outstanding request; request the next chunk
only after writing the previous one to host staging. Do not accumulate file
contents in command-result
buffers or starve cancellation/control messages. Bound scan entries, depth,
filename bytes, open handles, transfer bytes and in-flight memory separately.
Proposed fixed bounds: 100,000 entries, depth 64, 256 KiB raw data chunks,
one active export and 4 GiB aggregate, with no redundant per-file cap. Manifest
pages also obey byte and entry limits below the 1 MiB response-frame ceiling;
bound decoded inventory memory explicitly, not just the number of entries.
Limit approved replacements to 1,000 per save; larger conflict sets require
smaller selections or a new destination, without truncating the review list.
These are product choices requiring validation; crossing a limit is explicit, never a
silently truncated successful export. Existing ordinary command limits and
scheduling are unchanged.

## Host publication and replacement

The parent treats every path and byte from the worker as untrusted. Accept only
manifest-authorized relative paths, preserve them as data, and reject traversal,
absolute names, duplicates and filesystem-equivalent collisions. Never let the
worker choose the destination root or provide code to execute on the host.

The user-selected destination may be inside writable CWD but must remain outside
private sandbox scratch storage, including Seatbelt's actual host scratch root.
The shared source still reports all writable host grants; the managed controller
exempts only its canonical launch-CWD grant from destination exclusions. Reject
observed symlink traversal and incompatible final entries. These pathname checks
are best-effort detection under concurrent modification, not an atomic traversal
boundary. MCP and other managed host operations retain their separate authority;
export does not make the entire application a universal no-host-write boundary.

Write each file to an exclusively created temporary sibling with restrictive
permissions, finalize and fsync its data, then publish it. New targets use a
genuinely atomic no-replace operation: link the fresh staging inode to the target
name, then unlink the staging name. This does not hardlink a sandbox source; it
publishes a new host inode. If the destination filesystem cannot support this
operation, fail explicitly and ask for another destination. Do not silently
fall back to overwrite-capable rename or partially written visible files.
Distinguish a new `EEXIST` conflict, which requires review again, from unsupported
publication errors such as `EPERM`, `EXDEV` or `ENOTSUP`.
Approved existing regular files may be atomically
replaced, with a fresh comparison to the conflict inventory immediately before
publication. Never write through the original file: replacing a directory entry
avoids modifying another pathname hardlinked to that original inode. Preserve
only deliberate safe metadata; do not replay owners, ACLs, privileged mode bits,
extended attributes or device definitions supplied by the source.

Replacement permission is explicitly for the listed pathname. Revalidation
detects changed conflicts and requires another decision, but a trusted host
process can still change a target between that check and rename. A replacement
at that exact time can be lost. An ordinary stat-then-rename sequence is not an
atomic compare-and-swap against file identity; do not promise such a guarantee.
For writable-CWD destinations, surviving sandbox commands can race ancestor
paths, staging names or contents, and replacement publication. Modes 0700/0600
do not separate same-UID commands from staging. A path race can redirect host
writes or cleanup outside the reviewed destination; stage substitution can change
the published object, and replacement races can lose concurrent updates. The user
accepts these risks under host-user authority, analogous to the existing host Git
clone destination race. Foreground idle and managed-child quiescence do not provide
complete process ownership. No monitor, confined writer, descendant revocation or
new helper is added. Preserve fresh-inode/no-truncate, atomic no-replace, required
audit and observed path/identity checks. These checks do not promise race freedom
or durable destination integrity. Trusted host writers retain the same concurrency
limit even with read-only CWD.

Publication is per-file, not a transaction across the tree. Errors/cancellation
leave previously committed files in place and report an exact partial result;
do not attempt destructive rollback of approved replacements. Remove only owned
uncommitted staging files on normal cleanup. A process crash can leave those
files behind after an authorized save began; do not claim a directory-wide
atomic save or guaranteed physical durability across power loss.

## Audit

User export is a host-write action, separate from model-tool events and the
deliberately unaudited human `!` shell. When audit is enabled on either platform,
emit typed parent-only export intent/completion records with operation
and Pi-session IDs, source root IDs, destination, bounded counts and a manifest
digest. Never log file contents or place an unbounded conflict list into a frame.
The final selection and exact local per-file outcome remain available in the UI.

Also emit bounded per-replacement intent/outcome records with pathname,
revalidated prior identity and result. The replacement-count cap bounds total
records without truncating the approved list. Submit export intent before any
payload staging and each replacement intent before its publication. Required
audit failure must stop further host publication and report files already
committed. Do not fabricate a model tool call or a tool approval to fit existing
event types. The managed service protocol already carries these records; writable
CWD saving changes neither its protocol nor record schema.

## Lifecycle, limits and verification

The command runs while the UI and executor are alive. Closing the process cancels
an unfinished save; unsaved tmpfs data is lost. Explicit cancellation preserves
private sources. The existing session-shutdown hook remains responsible for
cleanup and is not used to launch a picker after the UI stops.
An audit outage during saving produces the same exact partial-result reporting
as a per-file failure: already published files remain, with no destructive rollback.

Verify with offline fixtures and real backend coverage:

- Selection/navigation, hidden entries, selected ancestors, mixed roots and exact
  destination mapping; no writes before final user confirmation.
- Negative model-tool/Code Mode/RPC/headless access controls.
- Recursive source symlink and rename attacks, private `/tmp` with host-CWD
  overlay, unreadable/special files, manifest changes and invalid names.
- Writable and read-only CWD admission and real private-source reads, direct-mode
  rejection, writable-CWD destination acceptance and private scratch exclusion.
- Observed destination symlink ancestors, hardlinks, new and changed conflicts, actual
  no-replace races, case/normalization collisions and file-directory mismatches.
  Preserve checks without claiming exclusion of hostile background path/staging races.
- Bounded streaming, cancellation, disk-full and partial-copy reporting.
- Real Linux Bubblewrap; native Seatbelt on each supported architecture; shared
  ordinary Pi packages under Node and Bun. Do not claim native Mac qualification
  from Linux tests.
- Existing application composition, approvals, lifecycle and package suites
  remain required when implementation touches those contracts.

## Oracle consultation

The Oracle consultation recommends proceeding with the user-only export
design, keeping temporary HOME and both Home/Temporary source roots. It supports
the picker and mapping, explicit replacement approval, separate export capability,
main-only default-off enablement, confined source reads on both platforms, and
bounded pull transfer. Its changes and the subagent findings are incorporated
above. Its second answer accepted the corrections to Mac reader cleanup,
mount/device distinctions, source/overwrite guarantees and bounded audit records,
and declared the design settled.

Consultation: `run_dda349ed-72d1-4f25-b32c-89481279bbb0`, saved workflow `oracle`,
configured default profile `claude-fable-5`, two answers on 2026-11-05. The local
transcript and feasibility receipts are under
`.tmp/user-sandbox-save-oracle/`. No Pi application runtime, release, or native
macOS qualification was performed.

Before implementation can claim completion, qualify the native Mac reader under
the effective Seatbelt profile, strict worker protocol revision and both package
consumers, destination filesystem collision handling, no-replace publication,
bounded audit schema, limits and cancellation. A Linux host-only descriptor probe
passed under Node 24.18.0 and Bun 1.3.14; it does not qualify the full exporter,
Bubblewrap runtime, or either macOS architecture.
