# Versions and releases

Pi Sandbox uses its own semantic version, independent of the pinned Pi release
and the reusable extension package:

| Component                  | Version source                              | Current version |
| -------------------------- | ------------------------------------------- | --------------- |
| Pi Sandbox product         | Root `package.json` and `package-lock.json` | `0.6.0`         |
| Upstream Pi                | `pi-source.lock.json`                       | `1.1.0`         |
| Reusable sandbox extension | `packages/sandbox-extension/package.json`   | `0.2.0`         |

Product tags use `v<product-version>`, for example `v0.6.0`. During the `0.x`
series, new features and breaking changes increment the minor version; fixes
increment the patch version. Document configuration changes and required
administrator action in `CHANGELOG.md`. An upstream upgrade does not make the
product adopt Pi's version number. Bump the reusable extension separately when
its published contents change.

## Application display

The managed application's `--version` output and TUI header combine the two
application versions:

| Build                                            | Example display                     |
| ------------------------------------------------ | ----------------------------------- |
| Clean checkout at the matching product tag       | `1.1.0+ps.0.6.0`                    |
| Untagged Git checkout                            | `1.1.0+ps.0.6.0.dev.gabcdef0`       |
| Modified Git checkout                            | `1.1.0+ps.0.6.0.dev.gabcdef0.dirty` |
| Source execution or a build without Git metadata | `1.1.0+ps.0.6.0.dev.source`         |

Only a clean checkout at `v0.6.0` produces the release display for product
version `0.6.0`. Build identity is embedded at build time; launching the
application does not query Git. The combined value is a display identifier,
not the product's release number. Use the product version and tag for release
ordering; SemVer build metadata does not affect precedence.

Pi's internal version remains `1.1.0`, including its update and changelog
comparisons. Ordinary Pi using the reusable extension keeps its own version
display.

## Release procedure

Group release entries under `Breaking changes`, `Added`, `Changed`, and `Fixed`,
omitting empty sections. Put required administrator actions first under
`Breaking changes`, including the current configuration schema. Keep an
`Unreleased` section above dated releases and retain PR links.

1. Update the root package version and corresponding lockfile entries. Move
   the completed `CHANGELOG.md` entries from `Unreleased` into a dated section
   for that version, retaining PR links and noting configuration changes.
   Leave an `Unreleased` section for subsequent work.
2. Complete the applicable checks in [testing](testing.md), review the change,
   and merge the release changes. Create the matching product tag on the final
   merged commit, then push that tag.
3. Publish a GitHub release for that tag using the changelog section as its
   notes. Releases are source-only: upload no application or extension
   binaries. GitHub's automatically generated source archives remain available.
4. If deployment artifacts are needed separately, build them from a clean
   checkout of that final tag using [installation and operation](installation.md).
   Inspect their version, source identity, platform, layout and checksums before
   handing them off. Do not reuse an archive built before the final release
   commit or tag.

`npm run build:application` can build downloaded sources without Git metadata;
those builds carry the `dev.source` display. The full `npm run build:release`
builder requires a Git checkout to record source provenance. Use a clean
checkout of the final tag for deployment archives and the release display.
