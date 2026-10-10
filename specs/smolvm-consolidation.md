# Linux smolvm consolidation

This milestone adds smolvm to the public reusable extension and managed Pi
Sandbox. The evaluator application is unchanged. macOS, Seatbelt and OpenCode
are outside this change. Current configuration and security contracts remain in
`docs/`; the package README documents the ordinary Pi/controller API.

## Upstream release and selected capabilities

The latest release was checked on 2026-10-10: **1.25.4**, source
`3a2d56c295c7e58a036bd8cac2d7b078b7a6c8b0`. The official Linux x86-64 archive is
pinned at SHA-256
`5a470d2db922290f17918bb8cee35820a389690b7c741570d8944f500bc04bc9`.
The compiled inventory covers the wrapper, native executable, libraries,
compressed templates and guest-rootfs files and symlinks. A configured path must
identify this complete distribution. No on-demand download or alternative
runtime selection occurs in a tool call.

We use named create/start/exec/stop/delete and explicit `--freeze-source` for OCI
siblings. The new release's sparse-template copying and frozen/branchable-clone
fixes are useful automatically. An explicit branchability argument permits cheap
leaf reviewers and preserves a path to branchable implementers. Ordinary leaves
avoid materializing another branchable RAM base.

The newer continuing-source chain compactor is not needed for immutable evaluated
candidates. Shared cache disks, prepared-environment reuse, warm incremental
checkpoints and batch pools are separate evaluator decisions. Cache slots are
not exposed through the inspected CLI; adding an API daemon for them is outside
scope. Guest networking remains separate from host image acquisition: only local
digest-pinned images are admitted.

Sources: [release 1.25.4](https://github.com/smol-machines/smolvm/releases/tag/v1.25.4),
[branch fixes and sparse copies](https://github.com/smol-machines/smolvm/releases/tag/v1.25.2),
[frozen-source implementation](https://github.com/smol-machines/smolvm/blob/3a2d56c295c7e58a036bd8cac2d7b078b7a6c8b0/src/agent/fork.rs),
[incremental checkpoints](https://github.com/smol-machines/smolvm/blob/3a2d56c295c7e58a036bd8cac2d7b078b7a6c8b0/docs/incremental-checkpoints.md).

## Source reuse

The MIT-licensed agent-sandbox prototype at
`f414fef2c502cb4c910c772174d6388c09c4a05c` supplied the following algorithms:

- `src/smolvm/oci/{family,transport,types,index,retention,disk-capacity}.ts` and
  corresponding tests: scoped attachment, frozen-family and cold-record logic.
- `src/admission.ts`: bounded serialized admission.
- `src/seatbelt/request.ts`: neutral request/environment/limit validation only.
- `src/smolvm/{options,executor,disk-capacity}.ts`: packed-image admission logic.

These sources were adapted into this public repository. No private dependency
or repository history is required. Supervisor sources, custom C/Python guardians,
old process-handle protocol, host-mutation leases and Seatbelt were not imported.

## Lifecycle

The owning application runs bounded smolvm CLI calls directly. Named VMMs are
upstream daemonized processes. Normal cleanup verifies the recorded generation,
stops leaves before frozen parents, confirms process death, and then deletes
records/state. Failed cleanup preserves evidence and recovery information.
Upstream VMMs disable dumpability; executable identity cannot require reading
`/proc/PID/exe`. The Linux check uses stable start ticks and the fixed boot argv
bound to private state. No check-and-kill fallback claims atomic PID targeting.

Readonly extracted CoW bases are made removable only after dependent VMs stop.
Cleanup does not follow directory symlinks. Owner SIGKILL/crash may leave VMs
running; this is the accepted manual-recovery contract, not a guaranteed
crash-cleanup system. Standalone Pi owns its VM. Borrowed Pi attachments leave
ownership with the orchestrator.

## Native storage probe

A Linux 1.25.4 probe used two 1 GiB source disks and a nonzero 32 MiB file. Each
initial ordinary reviewer had two qcow2 overlays, each with 200,704 allocated
bytes and 1 GiB virtual capacity. Both named their respective source disk as
backing file. Writing another nonzero 32 MiB in one reviewer grew allocation by
approximately 33 MiB including guest filesystem metadata. Its sibling remained
unchanged. Source execution was refused while frozen. All three machines stopped
and were deleted, with recorded PIDs absent afterward.

This distinguishes physical allocation, host apparent file size and guest disk
capacity. It is a measured fixture result, not a fixed per-reviewer cost or a
claim about RAM consumption. The probe qualifies upstream behavior; product
acceptance separately exercises the new adapters and ordinary Pi package.

## Deferred administrator customization

The initial managed backend deliberately accepts only a plain offline tools
image and the single launch-project mount. Administrator policy selects the
image digest, project write access, CPU, memory, disk sizes and private state
location. A restricted build does not accept a user-selected configuration, and
project Smolfiles are not executed or treated as runtime policy. Image metadata
cannot add networking, host mounts, commands, environment, secrets or other
unsupported runtime settings.

Broader OS-image selection for the standalone backend, additional explicit host
mounts and network policies are deferred, low-priority work. If added, they must
remain administrator-controlled in the managed product: separate guest image
contents from runtime authority, define each supported option explicitly, reject
unsupported combinations, and qualify enforcement. Upstream support for an OCI
image in a Smolfile does not itself qualify that image or its settings for this
backend. The existing separate controller's OCI support is not a promise that
standalone managed Pi accepts OCI-backed packs.
