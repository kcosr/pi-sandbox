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
settled retains its concurrency slot and cannot be resumed.

Standalone configuration is read from trusted `.pi/subagents.json`, or an
explicit `PI_SUBAGENTS_CONFIG` path. Configuration supports `enabled`,
`maxConcurrent`, `maxTotal`, `startupTimeoutMs`, `cancelTimeoutMs`, `taskTimeoutMs`,
`stateDirectory`, and `tools`. Defaults allow four concurrent tasks and 32 total
spawn/resume attempts per parent session. Accepted attempts count before startup;
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
limited to 64 MiB independently of the attempt quota; inability to persist state
fails the operation explicitly. Saved attempt counts and
parent journal entries preserve the quota across reload/resume. This standalone
entry does not automatically expire child transcripts; the embedding application
may own retention. A crash interrupts running tasks; continuing requires an
explicit resume, which consumes another attempt.

## Interactive presentation

The status line shows active/capacity, waiting approvals when provided by a host,
failures, and total attempts. `/agents` opens the live list. Use arrows to select,
Enter to preview recent assistant output and the result, and Escape to return or
close. Press `c` to request cancellation of the selected task. Closing the view
does not stop the task. Previews are bounded and strip terminal control characters;
private reasoning and transcript paths are not included in observations.

## RPC clients

Run the main Pi in `--mode rpc`. Children still use in-process SDK sessions. First
discover `agents-rpc` with `get_commands`; do not send an unknown slash command,
because ordinary Pi treats unknown commands as model prompts. Use its returned
`name` (the resolved invocation name) in a normal RPC `prompt` request:

```json
{
  "id": "rpc-1",
  "type": "prompt",
  "message": "/agents-rpc {\"version\":1,\"requestId\":\"view-1\",\"action\":\"snapshot\"}"
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
