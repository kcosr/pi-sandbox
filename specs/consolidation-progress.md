# Pi Sandbox consolidation milestones

Implementation starts from merged PR #15, commit
`16f20912a1ce45d54aea19b80b83fd549f523252`, including Pi 1.1.0, local networking
and configurable process lifetime. The earlier design and implementation map
are research records; this file records delivery. Evaluator implementation is
explicitly deferred until the Pi Sandbox milestones have been reviewed.

1. **Reusable extension extraction:** branch `feat/reusable-sandbox-extension`,
   based on main. Move implementation once, keep managed controls, add a stock-Pi
   entry and self-contained artifact. Implemented. Subagent implementation,
   integrated verification and iterative Keel `claude-default` review are complete;
   the review returned no actionable findings.
2. **Linux smolvm:** a subsequent branch and separate draft PR stacked on the
   extraction checkpoint. Add owned host-project execution and reusable OCI
   controller/attachment support, replacing custom guardian supervision with
   in-process lifecycle handling. Native acceptance and another iterative Keel
   review are required. Not started.

No macOS/Seatbelt or OpenCode work is included. The host Git clone race remains
an accepted documented limitation; no clone-specific staging, cleanup, guardian
or publication helper is introduced.

## Extraction verification checkpoint

Full Linux release verification passed: 656 unit, 43 integration, 43 end-to-end
and 335 patched-Pi integration tests, plus broker/audit/systemd checks, package
inspection and staged installers. The real packaged CLI/RPC checks cover managed
MCP, Code Mode, local networking and persistent processes. The standalone tarball
passed stock-Pi startup/session-switch checks with Node and Bun workers.
A nonfatal Bun 1.3.14 compiler directory-mismatch diagnostic was emitted; the
resulting executable passed the compiled-application and packaged checks.
Keel `claude-default` code review completed clean. The reviewer independently
ran the TypeScript check and 118 package unit tests, and verified managed
authorization/audit/MCP/Code Mode preservation, package boundaries, worker
assets and standalone ownership across session changes, reload and shutdown.

## smolvm release selection

The user explicitly requires the latest smolvm release for the next milestone.
On 2026-10-10 the live GitHub release API identifies **v1.25.4**, published
2026-10-09, as latest. Reconfirm before pinning. The older 1.23.1 source and
artifact observations in the planning documents are historical; they do not
qualify the new integration. Review current lifecycle, branching, image and
network contracts and verify current release assets before native testing.
