# Prepared-machine runtime build

The prepared-family controller requires the reviewed
[smolvm integration branch](https://github.com/kcosr/smolvm/tree/integration-prepared-vm-tree)
at `91fc328186bc7b8c38b313139b44ca7ffc4a2b52`. The host contains the continuing-source
restart and macOS named-machine layer-lifetime fixes. Its libraries, wrapper and
guest filesystem are unchanged from the official 1.26.1 distribution. The guest
agent was not rebuilt. Archive import/export fixes are not included.

This is a development integration, not an upstream smolvm release. `smolvm
--version` still reports 1.26.1; that output alone does not identify the build.
The extension verifies the complete pinned file inventory before execution.

| Platform     | Qualified archive SHA-256                                          |
| ------------ | ------------------------------------------------------------------ |
| Linux x86-64 | `c7896652d08e24010e576c48a108d8f8cf1bcc7dce1968185e589b749218f1b1` |
| macOS arm64  | `a9d070ce98979690a75db67f3d05dbaaf85e92af8f046943031cd0cc1099d7ab` |

The qualification archives are provisioned separately; they have not been
published as a GitHub release. Do not substitute an official archive at the same
version, or copy just the native binary without its complete distribution.
The archive contains `BUILD-PROVENANCE.json`, `checksums.txt`, the wrapper,
native binary, libraries and stock guest rootfs. Provision it outside the project
and select its canonical `smolvm` wrapper path.

For maintainer builds, check out the exact fork source, then run
`cargo build --release --locked --bin smolvm`. The qualified Linux build used
Rust 1.96.0; macOS used Rust 1.95.0 and Apple clang 21. Replace `smolvm-bin` in a
fresh verified official 1.26.1 distribution, keeping all other runtime inputs.
On macOS sign the replacement with the existing smolvm Hypervisor entitlements.
Regenerate checksums, record source/toolchain provenance without local paths,
inspect the archive and qualify the resulting complete inventory on the target
platform. Deterministic repacking does not guarantee independently reproducible
compiler or linker output. A different build needs reviewed inventory pins and
qualification; runtime configuration cannot disable verification.

Native qualification covers continuing preparation copies, independent candidate
families, frozen reviewers, retained descendants with stopped ancestors, and
named stop/delete cleanup. It does not supply stopped-machine CoW cloning,
bitwise immutable state across boot, or automatic cleanup after owner SIGKILL.
