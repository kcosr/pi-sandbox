# Administrator-provided shared skills for Pi 1.5.0

Status: implemented against merged Pi 1.5.0 (PR #49, baseline
`53e5c7ca269d97fc7f6e1b92d7c73a9b532fcd04`). This records the reviewed design and
acceptance rationale; maintained subject documents under `docs/` define the
current product contract.

## Decision

Add main-policy `[skills].directories`. The managed application supplies these
directories to Pi's ordinary skill discovery for every user, independently of
their user-state directory and settings. Users retain normal Pi filtering and
`--no-skills`, can add their own sources, and can replace an individual shared
skill by supplying a personal skill with the same name.

Add an optional distribution `skills_source` build input for shipping a complete
skill tree with the application. Administrator-managed external directories and
bundled directories use the same runtime setting. Do not add user/group skill
overrides, new skill CLI flags, a skill management menu, or new package discovery.

## Target and reassessment

The upgrade's source lock selects:

| Field                  | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| Pi version / tag       | `1.5.0` / `v1.5.0`                                                 |
| Upstream commit        | `f9a26365568127461c47a07a37dcb42c140a3ac5`                         |
| Source archive SHA-256 | `577ace662a466326d1a4b41f813579aeb5957679e796c577bae65820faea5d9a` |
| Main policy baseline   | Schema 14                                                          |
| Distribution baseline  | Version 3                                                          |
| Broker / rule baseline | Protocol 10 / rule version 10                                      |

The pre-implementation source comparison with pinned Pi 1.3.0 established:

- Neither version has a system skill root or an embedding option for additional
  filterable default discovery roots. Managed startup and distribution packaging
  did not supply any.
- Directory recursion, stopping beneath a discovered `SKILL.md`, name collisions,
  user filtering, `--no-skills`, and explicit `--skill` behavior are unchanged.
  The upstream skills documentation is byte-identical.
- Pi 1.5.0 uses `getResourcePathKey()` for canonical resource identity, combining
  realpath with platform path-comparison rules. Reuse this helper for resource
  deduplication rather than restoring the earlier standalone realpath handling.
- The upgrade preserves Pi 1.5.0's corrected project-trust selection: an explicit
  remembered distrust value must not be replaced by a default trusted state.
  Shared discovery must not enable project settings or alter this decision.
- Package resolution and source metadata have gained install-failure diagnostics
  and package changelog support. Shared directories are top-level resources, not
  package sources; they must not enter installation or package-update machinery.

The user-facing proposal therefore remains the same. Two ordering details need
explicit implementation: shared resources must rank below personal package
resources, and explicit user `--skill` paths must precede shared resources.

Relevant upstream sources at the exact target commit:

- [Directory discovery, filters, precedence and resource identity](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/coding-agent/src/core/package-manager.ts)
- [Resource-loader composition and reload](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/coding-agent/src/core/resource-loader.ts)
- [Skill parsing and name-collision resolution](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/coding-agent/src/core/skills.ts)
- [Resource source metadata](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/coding-agent/src/core/source-info.ts)
- [Runtime creation and project trust](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/coding-agent/src/main.ts)
- [CLI options](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/coding-agent/src/cli/args.ts)

The existing `additionalSkillPaths` option is unsuitable as the new discovery
input: it implements explicit paths, survives `--no-skills`, and bypasses the
ordinary settings filters. An offline probe against the installed Pi 1.5.0
package confirmed that a path supplied there still loads with `skills = ["!**"]`
and with either value of `noSkills`. The extension `resources_discover` hook also
appends resources after filtering. Neither is the implementation seam to use.

## Administrator configuration

```toml
[skills]
directories = ["/etc/pi-sandbox/skills"]
```

`skills` is optional; omission means no additional shared roots. When present it
has exactly one required field, `directories`, an ordered array of normalized
absolute directory paths. An empty array is valid. Reject unknown fields,
non-string entries, empty paths, NULs, relative paths, `/`, non-normalized paths,
and duplicate literal entries. No glob, home, environment, account, or machine
macro expansion is added to this administrative path field.

Keep the authored spelling for discovery, diagnostics, and user path filters.
Use realpath-derived resource keys to deduplicate aliases; do not rewrite a
configured `/etc/...` spelling to `/private/etc/...` in user-facing paths.

Operational startup checks that configured roots are directories the invoking
user can read and traverse. Any missing, non-directory, or inaccessible root
fails the entire startup before interface startup with an actionable
administrative configuration error, including when `--no-skills` is selected.
That flag controls skill selection, not validity of the main policy. Perform this
check in effective runtime startup, not the shared structural config parser or
installation validator. The separate candidate-payload check described below
validates packaged directory presence, not external-root runtime accessibility.

This treats an explicitly selected root as an administrator assertion that the
resource exists, like `execution.command_path_prepend`. It deliberately differs
from `filesystem.hidden_paths`, whose contract explicitly permits missing masks.
That existing mask behavior is unchanged. A root on a network mount couples
startup to that mount's availability; installation guidance should recommend
stable local system directories unless that dependency is intentional.

Individual malformed skills retain Pi's ordinary diagnostics and skip behavior.
After startup, filesystem changes and reload discovery remain Pi's best-effort
behavior; there is no watcher or snapshot of skill bodies.

Installation validation checks the field's structure without requiring external
skill directories to exist on the builder or reading their contents as the
installer account. Bundled payload integrity is validated separately. Restart Pi
after changing the administrative directory list. `/reload` refreshes contents
and user preferences for the roots captured at startup.

Shared skills joins the release that first publishes schema 14, so it is an
optional field of schema 14. No version advance or dual parser is needed. A prior
binary cannot read the new field: upgrade the application before deploying it.
Distribution version 3 is unchanged.
No broker protocol, rule, audit wire/record, or standalone-extension configuration
changes are required. In particular,
`applyIdentityOverrides()` explicitly constructs a fresh configuration and must
carry `skills: base.skills` through every merge. Broker-authored or wire skill
overrides remain rejected.

## Discovery and user control

Shared roots use Pi's existing `collectAutoSkillEntries(root, "pi")` traversal:

```text
/etc/pi-sandbox/skills/
  development/
    code-review/SKILL.md
    testing/SKILL.md
  operations/
    troubleshooting/SKILL.md
    troubleshooting/scripts/check.sh
```

Grouping directories have no `SKILL.md`. Finding that file turns its containing
directory into one skill and stops recursive discovery beneath it. Supporting
files remain references and scripts. Preserve upstream ignore-file handling,
hidden-directory and `node_modules` exclusions, symlink handling, and supported
standalone Markdown behavior. Folder grouping does not create skill namespaces.

Apply the user's global `settings.skills` filter expressions to shared candidates
using the existing matcher and the agent directory as the relative-pattern base.
Absolute paths and directory basenames therefore work without special syntax.
Shared source metadata may identify the actual root separately from this filter
base. Plain user paths continue to add sources; they do not replace the shared
root list. An empty user `skills` array leaves shared discovery enabled.

For example, disabling only a bundled copy in the user's settings:

```json
{
  "skills": ["-/etc/pi-sandbox/skills/development/code-review/SKILL.md"]
}
```

`!code-review` matches a containing directory name, not the YAML `name:` field,
and can exclude more than one copy. Keep Pi's existing `!glob`, `+exact-path`,
and `-exact-path` semantics. Do not introduce semantic-name exclusions.

Project filters retain their existing project-source scope and trust rules.
They are not applied to the new shared discovery layer. A trusted project's
explicit reference to the same file still participates in native precedence and
deduplication, including its disabled state; shared discovery must not revive it.
Users can disable shared candidates through their global settings, or use
`--no-skills` for the invocation.

There is no individual-exclusion CLI in Pi 1.5.0 and none is added. Preserve the
existing commands exactly:

```sh
pi-sandbox --no-skills
pi-sandbox --no-skills --skill /path/to/one-skill
```

The first omits all ordinary and shared discovered/configured skills. The second
still loads the explicitly requested skill. Preserve `disable-model-invocation`
and `enableSkillCommands` behavior; neither is a replacement filtering system.

## Composition, precedence and integration seam

Add a generic optional `defaultSkillPaths: readonly string[]` embedding input
through Pi's `MainOptions`, `DefaultResourceLoaderOptions`, and package-manager
options. It is not a CLI option or a user-settings property. An omitted input
preserves ordinary Pi behavior. Pi Sandbox parses main policy and supplies it
from `src/runtime/main.ts`; no administrative schema belongs in the Pi patch.

At every runtime creation, including session recreation, forward the immutable
root list into the resource loader/package manager. `/reload` retains this list
while rereading settings and traversing the roots. Shared roots load independently
of whether project trust was granted; they confer no project trust.

Package-manager integration:

1. Discover shared skill files through the existing collector and compute their
   enabled state using the existing global user filter matcher.
2. Add them as `source: "default"`, `scope: "user"`, `origin: "top-level"`, with
   the root in `baseDir`. Here `scope` identifies the preference scope; the
   `default` source and file path identify their administrator-supplied origin.
   Do not add a new source-scope union or claim that these are installed packages.
3. Give top-level `default` resources an explicit precedence rank below every existing
   resource source. Merely appending them with user metadata is insufficient:
   Pi sorts resources, and the ordinary fallback rank would put them ahead of
   personal package resources. Preserve every existing relative rank.
4. Preserve first-registration handling of identical paths and canonical
   deduplication using `getResourcePathKey()`, before enabled-state filtering.
   An earlier disabled occurrence must not be resurrected by shared discovery.

Resource-loader integration:

1. Partition resolved enabled skill resources into ordinary and top-level `default`
   candidates without losing path metadata or their existing within-group order.
2. Build the ordinary skill path list exactly as Pi does today, including its
   current handling and precedence of explicit CLI paths.
3. If `noSkills` is false, append shared paths after that ordinary list and the
   explicit `additionalSkillPaths`, using Pi's canonical path merge helper.
   If true, omit shared candidates and preserve only native explicit paths.
4. Run the existing skill parser and name-collision handling on that combined
   list. No body-merging or replacement registry is needed.

This preserves the existing project/user/package/explicit ordering relative to
one another while giving all of them precedence over shared defaults. A personal
same-name skill, including one supplied through `--skill`, wins. Shared roots
retain administrator array order. Name collisions retain ordinary diagnostics;
do not promise a new tie-break order for duplicate names within one scanned root.
Overlapping or nested roots are allowed and deduplicated with native resource
identity. Only duplicate literal array entries are configuration errors. Treat
the top-level origin together with the `default` source marker as the shared
identity; do not reclassify a package whose source string happens to be `default`.

The second loader step matters: native Pi resolves ordinary skills before its
explicit `additionalSkillPaths`. Putting shared candidates directly into that
ordinary list would make a shared skill win over a personal explicit path.

Preserve provenance metadata and paths in existing resource displays. The native
autocomplete tag remains `[u]`, so that short tag does not distinguish shared from
personal skills; source/path details retain the distinction. No new UI is required. The
managed application still rejects the `pi config` package-management command;
this proposal does not depend on its resource selector.

Later `extendResources` / `resources_discover` contributions retain their native
append behavior and may lose same-name collisions to already-loaded shared
skills. No managed composition currently contributes skills through these hooks.
The personal-source precedence promise covers normal settings, discovery,
packages, and explicit `--skill`, not a redesign of extension resource events.

## Distribution and installation

An administrator may deploy an external tree independently of the application
and name it in `[skills].directories`. The Pi installer does not own or remove
that tree. Skill-content updates then require no application build.

For distributions that ship skills, add one optional top-level `skills_source`
field to the version-3 distribution manifest, alongside `version` and
`extension_manifests`, not inside a platform table:

```toml
skills_source = "./company-skills"
```

Resolve it relative to the manifest, as a build input. It must be an existing
directory containing a prepared skill hierarchy, including its supporting files
and licenses. Copy the tree to `payload/pi-sandbox/skills`, installed under
`<libexec_dir>/skills`. Do not fetch packages, evaluate manifests as code, or
execute skill scripts during collection. Reject symlinks and special files in
the packaged tree, consistent with the existing release payload contract.
Require printable ASCII path components without spaces or backslashes; reject
all control and non-ASCII characters. The current checksum and inventory formats cannot round-trip these
names safely. Fail collection clearly; never silently rename or omit files.
These packaging restrictions do not extend to external discovery roots.

Distribution version 3 remains appropriate for this optional build input because
the manifest and its builder are selected together from the same source tree.
An older builder rejects the unknown field. There is no old-builder fallback or
second accepted contract.

The supplied packaged administrator config explicitly names the installation
path, for example on the default Linux layout:

```toml
[skills]
directories = ["/usr/libexec/pi-sandbox/skills"]
```

Use the selected platform's actual `libexec_dir`; do not assume Linux paths on
macOS or add a second implicit bundled-discovery path. The builder must verify
that a selected `skills_source` has the expected installed path in the supplied
default config, and fail clearly on a mismatch rather than silently rewriting
authored configuration. Conversely, defaults naming a root in the package-owned
`<libexec_dir>/skills` tree require a selected source and that root's presence in
the candidate tree. An unselected source packages no skill tree.

Before the installer replaces the application payload, the compiled installation
validator must check the configuration actually being retained or installed
against the candidate payload. Supply the candidate payload location explicitly
to this validation path; do not parse TOML in shell or inspect the old installed
tree as a substitute. A configured root equal to or beneath the layout-selected
`<libexec_dir>/skills` must map to a directory in the candidate tree. Check both
bundle removal and removal of a configured subdirectory. Reject before
replacement if that invariant fails; the administrator must adjust the setting
or explicitly select replacement configuration. Apply the corresponding check
in the release builder against packaged defaults. The validator's candidate
input is an installation-only interface, not a runtime discovery override.

External roots remain structurally validated during installation. An installation
whose config names an external root may succeed before that root is deployed;
operational startup fails until it is readable and traversable by the invoking
user. Document that ordering. The package-owned candidate check must not start
opening arbitrary external skill trees as the installer account.

Ordinary upgrades preserve existing administrator configuration. An administrator
must add the setting once to an existing installation, or explicitly choose the
existing replace-config operation. There is no per-user setup. Package updates
replace the bundled tree with the application, removing obsolete bundled files;
rollback restores the prior payload. Uninstall removes bundled skills with the
application and leaves external administrator-managed trees alone.

Normalize directories to `0755`, ordinary files to `0644`, and files with any
source executable bit to `0755`. Preserve those intended modes through copy,
archive inspection, installation, and rollback. The existing installers flatten
all files to `0644` and restore only known binaries; that must be amended for
skill scripts. Add a checksum-covered `payload/pi-sandbox/skills-modes.txt` with
one sorted entry per bundled regular file, for example:

```text
0644 skills/development/code-review/SKILL.md
0755 skills/development/code-review/scripts/check.sh
```

Only `0644` and `0755` are valid. Paths are normalized payload-relative paths
starting with `skills/`. Reject absolute paths, dot/traversal components,
backslashes, non-ASCII or whitespace/control characters, unknown modes, duplicates, entries
without matching regular files, and files missing from the inventory. The
sidecar is outside the skill tree. An empty selected tree has an empty sidecar
and a present skill directory; an unselected bundle has neither.
Reject the two mixed states: a skill tree without its sidecar, or a sidecar
without its skill tree.

Validate complete checksum coverage first, then consume the mode inventory with
the existing `awk` and POSIX shell facilities, using quoted paths for staging
`chmod`. No jq, Python, or new host runtime dependency is required. Cross-check
the inventory against the release file inventory and actual normalized modes
during build and extracted-archive inspection, and validate completeness again
before installation. Do not mark every skill file executable or trust arbitrary
archive permission bits. Retain current payload path validation and complete
checksum coverage. Keep this amendment scoped to skill payloads rather than
redesigning native-binary installation.

Bundled content remains ordinary administrator-maintained files. Record included
paths, hashes, sizes, modes, and source provenance in release metadata. Preserve
supporting assets and licenses, and integrate the inventory with the existing
release/SBOM process. Validation and smoke fixtures must be separate from shipped
administrator configuration.

## Execution boundary

Skill discovery and explicit `/skill:name` expansion occur in the host Pi
application, as they do today. Automatic model use reads the advertised skill
path through ordinary managed tools. References and helper scripts use existing
tool policies and execution backends; discovery grants no permission and adds
no filesystem mounts, hidden/denied-path exceptions, or host execution tools.

Administrators should place shared skills at ordinary system paths readable by
the intended users and visible under the chosen execution policy. A directory
hidden from sandbox tools can still be read by the existing host resource loader;
the feature does not turn skill selection into a confidentiality boundary or
promise that host discovery obeys sandbox mounts. Deployment owns filesystem
ownership and permissions. Skills are guidance, not mandatory policy enforcement.

User/group selection is deferred. It would require broker schema, merge, wire,
and qualification work, and would initially be Linux-only. If audience-specific
discovery later becomes necessary, a separate design can select centrally
defined skill collections; it must not treat discoverability as access control.

## Implementation and acceptance

Implementation targets the finalized Pi 1.5.0 upgrade in PR #49. Its integration
seams were reconfirmed against that merge. The implementation touchpoints are main config/domain parsing, identity merge, runtime options,
the minimal Pi patch series and API contract checks, distribution/release
packaging, both installers, and the maintained configuration, installation,
architecture, security, testing, and Pi integration documents. Shared executor APIs remain
unchanged. The feature is recorded in the Unreleased changelog.

Required offline coverage:

- Config omission/empty roots; strict validation; multiple ordered and nested
  roots; alias handling; any inaccessible root fails startup, even with
  `--no-skills`; external roots stay structural-only at installation; unchanged
  standalone settings; rejection of broker skill
  fields and preservation through no-match and matching broker merges.
- Automatic discovery with no user configuration; recursive grouping and leaf
  boundaries; supporting assets; ignore files; malformed skills; independent
  `PI_CODING_AGENT_DIR`; remembered project distrust without project activation.
- Exact bundled-file exclusion leaves a personal same-name skill available;
  directory-name and subtree exclusions; positive user paths and empty settings;
  existing `!`, `+`, `-` precedence; no semantic-name filtering or new CLI flags.
- Same-name user auto, user settings, trusted project, personal package, and
  explicit `--skill` sources all precede shared skills. Existing relative
  precedence remains unchanged. An earlier disabled same-file occurrence,
  including a symlink alias, cannot be revived by shared discovery.
- `--no-skills` omits shared skills; `--no-skills --skill FILE` still works;
  `/reload` picks up edits, deletions, and changed user filters; recreated
  sessions retain roots. Ordinary Pi with no embedding input is unchanged.
- Patched declaration checks and a negative control removing the new seam;
  native upstream skill/package-manager/resource-loader regressions; ensure the
  full release verifier actually invokes the new shared-skill suites.
- Installation candidate input cannot alter runtime discovery or substitute for
  invoking-user startup root validation.
- Bundle selection/config mismatch in both directions; non-ASCII/whitespace/control/
  backslash filename rejection; full asset and license inventory; normalized
  executable modes; malformed/incomplete mode-inventory and mixed tree/sidecar
  state rejection; archive
  inspection; Linux/macOS staged installation; retained config referencing a
  removed bundle or removed subdirectory fails before replacement; preservation
  of existing config, removal of obsolete files, rollback/uninstall, and
  external-directory preservation.
- Compiled managed smoke with an isolated user state proves automatic discovery,
  filtering, personal precedence, and opt-out. Managed read and Bash probes prove
  that references/scripts work through the existing boundary and gain no grants.
  Use scripted fixtures, never live model providers.

Keep `build:release` limited to build/package/integrity work. Put behavioral
qualification in `verify:release` at the existing source and packaged checkpoints.
Qualify Linux and each supported macOS architecture according to repository
policy before claiming release support. The Oracle record below covers the
design review; implementation qualification and code review are separate steps.

## Review record

Keel Oracle first review confirmed the discovery, precedence, filter, canonical
deduplication, CLI, trust, and identity-merge mechanics. Its required revisions
were schema-publication contingency, inverse builder/config validation, explicit
root-failure rationale and scope, and top-level placement of the distribution
field. This draft incorporates those revisions and the parallel packaging
review's mode inventory, filename constraints, and candidate-payload checks.

The design retains bundled delivery and executable helper modes because the
requested distribution use case includes complete skill trees. Runtime and
packaging changes may be separate implementation commits, but both remain in
scope. Optional new provenance UI, overlap warnings, name-filtering controls,
and rejection of nested roots are not added.

Keel Oracle (`claude-fable-5`, saved workflow version 4) completed two review
turns on 2026-11-05. The second verdict was implementation-ready with no
remaining blockers, conditional on finalizing the Pi 1.5.0 upgrade and
reconfirming the integration seams. Its three non-blocking clarifications are
included: distinguish runtime accessibility from candidate-payload validation,
test that the installation candidate cannot override runtime discovery, and
explicitly reject mixed tree/sidecar states. This records design review, not
runtime implementation or release qualification.
