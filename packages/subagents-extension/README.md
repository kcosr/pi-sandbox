# Pi Subagents extension

Five native tools delegate bounded tasks to separate Pi SDK conversations in the
same application process. The ordinary Pi entrypoint supports RPC and interactive
parents without Pi Sandbox patches or private dependencies. An explicit host
factory lets a managed application own execution, authorization and auditing.

Build this package with `npm run build:extensions` at the repository root. Install
the packed `@kcosr/pi-subagents-extension` artifact with Pi's package installer or
load its `dist/index.js` with `pi -e /path/to/dist/index.js`. Pi 1.5.0 is required;
the artifact has no sibling-checkout or managed-application dependency. Node.js
24 or newer and Bun are supported runtimes.

The tools are `spawn_agent`, `steer_agent`, `cancel_agent`, `resume_agent` and
`inspect_agent`. Results arrive automatically; inspection is not a polling loop.
Children share files and process resources but keep independent conversations.
They receive repository context, but not the parent's conversation, personal
prompt files, skills or prompt templates. Pass the relevant task context explicitly.
Cancellation is cooperative and preserves transcripts. A child that has not
settled retains its concurrency slot and cannot be resumed. If cleanup cannot be
confirmed after shutdown, the same conversation cannot be reopened until the
application restarts. Work that settles later releases its session ownership
automatically.

Cancelling with `/subagents` or the RPC cancel action records the user's intent.
After the task actually settles, its existing automatic callback tells the parent
that the user cancelled it and instructs the parent not to restart or replace it
automatically. The command can return `stopping` while work is still settling.
Repeated cancellation does not send another callback or restore callbacks disabled
by a parent abort or shutdown. Cancelling through the model's `cancel_agent` tool
instead suppresses the callback because the tool itself returns the result.

Stopping the parent turn (for example with Escape or RPC abort) disables automatic
result delivery for **all existing children**, including children still running.
Those children continue until they finish or are cancelled. A one-time notification
points to `/subagents` or `inspect_agent` for viewing their progress and results.
Explicitly resuming a settled child starts a new task with automatic delivery.

If an idle parent cannot start a result turn, delivery retries at increasing delays
(2, 4, 8, 16 and 30 seconds), then pauses after six attempts and notifies once.
Results remain available to inspect. A successfully completed parent turn resumes
delivery at its safe settlement boundary; failed parent turns do not reset retries.

Standalone configuration is read from trusted `.pi/subagents.json`, or an
explicit `PI_SUBAGENTS_CONFIG` path. A supplied path is required: missing, unreadable
or invalid explicit configuration fails initialization instead of using defaults.
Configuration supports `enabled`,
`waitForChildren`, `forwardActivity`, `maxConcurrent`, `maxTotal`, `startupTimeoutMs`, `cancelTimeoutMs`, `taskTimeoutMs`,
`stateDirectory`, and `tools`. Defaults allow four concurrent tasks and 32 total
new spawns per parent session. Accepted spawn attempts count before startup;
cancellation, completion and failed startup do not refund the total.

Standard children default to read/bash/edit/write. Extended children reproduce
the parent's selected file-backed tools and MCP configuration, excluding
delegation. Unsupported runtime-only tool definitions fail explicitly. Model
requests use the parent's in-memory provider/authentication registry; credential
snapshots are not written to child task state. Extended MCP connections use the
parent's live provider credentials and ordinary Pi MCP OAuth store; sign-in stays
with the parent. Project MCP files cannot select provider credentials.

Example `.pi/subagents.json`:

```json
{
  "enabled": true,
  "maxConcurrent": 4,
  "maxTotal": 32
}
```

`maxConcurrent` accepts 1–32 and `maxTotal` accepts 1–1024. Unknown configuration
fields are rejected. The optional startup and cancellation waits default to
30000 and 5000 milliseconds; `taskTimeoutMs` defaults to 0 (no task deadline).
Positive timers must not exceed 2147483647 milliseconds. Timing out a cancellation
wait does not free a still-running child. State defaults to `subagents/` below the
Pi agent directory, with private directory/file modes. It contains ordinary child
conversation transcripts and bounded progress records. The progress manifest is
limited to 64 MiB independently of the spawn quota; inability to persist state
fails the operation explicitly. Saved spawn counts and parent journal entries
preserve the quota across reload/resume. Child state uses
format version 2 with spawn-only counts; earlier development version 1 child state
is rejected rather than migrated. Parent quota recovery reads `pi-subagents:spawn`
journal entries and ignores the earlier `pi-subagents:attempt` entries. Resuming a
parent with version-1 child state fails initialization; managed Pi then disables
the session's tools. Start a new parent conversation instead. This
standalone entry does not automatically expire child transcripts; the embedding application
may own retention. A crash interrupts running tasks; continuing requires an
explicit resume. Resuming an existing child never consumes the spawn quota, even
when that quota is full; it still requires a free concurrency slot.

## Interactive presentation

The compact native status appears after the first accepted child in a conversation
and stays visible after completion. It shows only active/capacity, such as
`Subagents 2/4`, with active work highlighted and idle counts dimmed. Ordinary Pi uses
its standard extension status area. `/subagents` opens a centered modal list with the
spawn quota and task details; RPC observations retain those details as well. Use
arrows to select a subagent and Enter to view its bounded output rendered with Pi's
native Markdown. Scroll with arrows or Page Up/Down; Home jumps to the beginning,
and End follows the latest output. Escape returns or closes. Press `c` to cancel
the selected task. Closing the modal leaves tasks running; an approval prompt
automatically closes the modal. Previews omit reasoning and transcript paths and
remove terminal controls and clickable hyperlinks.

`/subagents-rpc` is a machine-facing command requiring a JSON request. Missing or
invalid JSON in interactive Pi displays an error directing you to `/subagents`.

## RPC clients

### Waiting for delegated work

Set `"waitForChildren": true` in the standalone JSON configuration to keep a
parent run open through child completion and result incorporation. It defaults
to `false` in both interactive and RPC modes. The option also works through an
explicit SDK host's `config`; managed Pi currently keeps the default behavior.

While the parent would otherwise finish, the extension waits for active children,
including startup, cancellation and host cleanup, using controller notifications.
Eligible results, including child failures and user cancellations, enter the
parent conversation and cause another turn. If that turn starts or resumes more
children, the same process repeats. Only after the parent has incorporated the
results and no work remains may Pi emit final `agent_settled`. RPC clients can use
that normal completion event without subagent-specific polling or resume calls.
Intermediate assistant messages and turn events are not final run completion.
No Pi patches or additional approval UI are required.

Only while blocked waiting for children, the extension checks Pi's queued user
input once per second. Accepted steering and follow-up messages wake the parent
while its children continue running. The check stops when the wait ends or is
aborted; child completion still wakes the parent immediately through controller
notifications. These are local queue checks, not model requests.

Withdrawing queued input (`clear_queue` or the TUI dequeue key) after it wakes the
parent but before Pi consumes it can trigger the final-settlement guard, aborting
the run and cancelling active children.

In this mode, explicit parent abort cancels existing children and suppresses their
callbacks; shutdown likewise requests cleanup. This differs from the default
background behavior described above. A child still cleaning up retains capacity.
Cleanup, storage or delivery failures explicitly abort the parent and emit a
normal Pi `extension_error`; clients must not treat an aborted settlement or an
error as successful completion. After Pi exhausts its normal parent retries, a
parent failure preserves Pi's ordinary provider-error outcome. If any child is
still active, it cancels the delegation tree and suppresses all pending callbacks,
including results from children that already settled. If every child has already
settled, their undelivered results remain eligible for the next prompt. Later
prompts may proceed normally. Normal child failures remain results for the parent
to handle.

If cancellation exceeds `cancelTimeoutMs`, the run reports unfinished cleanup;
the child retains capacity until it actually settles, and a later run can recover.
Actual storage or cleanup faults require restarting the affected session and are
reported again on each attempted run. In waiting mode, this includes errors Pi
reports from child `session_shutdown` handlers: disposing the local session does
not prove that a failed extension cleanup released its resources. The default
background mode keeps Pi's existing handling of those reported hook errors.

The wait adds no deadline or model requests of its own. Existing `taskTimeoutMs`
and cancellation limits still apply, and spawn accounting is unchanged.

### Observations and controls

Run the main Pi in `--mode rpc`. Children still use in-process SDK sessions. First
discover `subagents-rpc` with `get_commands`; do not send an unknown slash command,
because ordinary Pi treats unknown commands as model prompts. Use its returned
`name` (the resolved invocation name) in a normal RPC `prompt` request:

```json
{
  "id": "rpc-1",
  "type": "prompt",
  "message": "/subagents-rpc {\"version\":1,\"requestId\":\"view-1\",\"action\":\"snapshot\"}"
}
```

The prompt response must have `disposition: "handled"`. Separately wait for an
`entry_appended` event whose `entry.customType` is `pi-subagents:response` and whose
`entry.data.requestId` matches. Only that entry's `success` indicates whether the
operation succeeded. Errors carry a bounded `error` string. A snapshot's `data`
contains `enabled`, `active`, `total`, `maxConcurrent`, `maxTotal`, `count`,
`truncated`, and up to 64 recent/active agent summaries. For a preview or explicit
cancellation, supply the exact child and current task identities:

```json
{
  "version": 1,
  "requestId": "view-2",
  "action": "inspect",
  "id": "a-12345678",
  "taskId": "task-uuid"
}
```

`action: "cancel"` has the same fields. Both reject a stale task ID so an old UI
selection cannot cancel a resumed task. Unknown or missing fields are errors;
requests are limited to 4096 bytes. IDs must use the documented response values.

Coarse changes arrive as `pi-subagents:state` custom entries through
`entry_appended`. Replay stored entries with Pi's `get_entries`. Responses and
state entries include `version: 1`, `parentSessionId`, an observer `epoch`, and a
monotonically increasing `sequence` within that epoch. Discard entries for old
parent sessions/epochs. Re-discover and request a snapshot after session replacement
or reconnect; serialize controls with parent session transitions. Assistant token
ticks are not persisted as observation events. Request an on-demand preview to
refresh text. These custom entries are persisted for the client but never injected
into the model conversation. Completion notifications are separate model messages.

## Child activity events

Set `"forwardActivity": true` to receive completed child assistant messages,
tool starts/results and lifecycle changes through `entry_appended` entries with
custom type `pi-subagents:activity`. It defaults to false independently of
`waitForChildren`. Forwarding does not change task execution, completion,
cancellation or result delivery, and the entries never become model messages.
Token deltas, thinking and binary content are omitted.

Import `SubagentActivityEvent` and `SUBAGENT_ACTIVITY_ENTRY` from the `./activity`
export. Every event has `version: 1`, `parentSessionId`, observer `epoch`, strictly
increasing `sequence` within that epoch, `childId`, task-generation `taskId`,
a compact `label`, and a millisecond Unix `timestamp`. The `kind` union is:

- `lifecycle`: `status` and `activity` from the child snapshot.
- `assistant`: completed `text` and a `truncated` flag.
- `tool_start`: `toolCallId`, `toolName`, optional `parentToolCallId`, display-only
  JSON `args` text and `truncated`.
- `tool_end`: the same tool identity, text `result`, `isError` and `truncated`.
- `truncated`: `scope` (`task` or `session`) and `reason` (`byte_limit` or
  `observer_error`).

Correlate by parent session, observer epoch, child and task generation; a resume
retains the child ID but creates a new task ID. Never process these as native
parent assistant/tool events. An omitted terminal event does not prove that the
child completed successfully.

Each serialized activity event is limited to 16 KiB. Forwarding is bounded to
1 MiB per task generation and 8 MiB per parent session, reserving a truncation
marker before a scope is exhausted. Byte totals are recovered from retained
activity entries on session startup, so reopening a parent does not reset them.
Reopening an exhausted parent emits a nonpersisted warning through Pi's normal
UI/RPC notification channel, so a new client sees why activity is unavailable
without appending beyond the lifetime budget. A new parent session starts fresh
forwarding and spawn budgets. Consumers may
apply stricter capture limits in addition to these limits.

Embedders can use `controller.subscribeActivity(listener)` for the same bounded
event shapes without enabling persistence. It does not replay history, and its
returned function unsubscribes the listener. Subscriptions end on controller
shutdown. A throwing listener is removed; one bounded diagnostic is emitted
without failing a task. A persistence error stops forwarding rather than changing
task results. Direct observers receive events independently of the forwarding
byte budget.

State ownership records identify the owning process instance, including its
start and host boot identity, so a stale lock is recoverable after process death
or PID reuse. Unverifiable ownership remains locked; a live owner is not displaced.
The same state directory must not be used simultaneously in independent PID
namespaces. Existing owner records from versions without process identity are
rejected: close sessions before updating, or, after confirming their process has
stopped, remove the stale `owner.json` marker (not the child state/transcripts).

## Embedding

`createSubagentsExtension` from the `./factory` export accepts an explicit `host`,
optional `onController`, and `presentation: false` for applications providing their
own interface. The host's `createSession(request)` returns a prepared, bound
`AgentSession`; the runner owns prompting and lifecycle. Use the `./contracts`
export for typed requests, snapshots, limits and controller operations. All
authorization, tool implementation, model policy and host-specific controls belong
in that host. The ordinary entry has no approval engine.

Extended mode reproduces file-backed extension factories and stock MCP/Code Mode
resources admitted by the parent. An application registering tools only in memory
must provide an explicit host, because Pi's public metadata API cannot reconstruct
arbitrary tool implementations. Shared workspaces require coordinated edits;
cancelling or resuming a child does not roll back changes.

Inspired by `badlogic/pi-subagent`. The reusable implementation was developed in
the independent `kcosr/pi-subagents` project before integration into this repository.
