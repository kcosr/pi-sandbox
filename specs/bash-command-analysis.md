# Bash command analysis and known read-only commands

Status: implemented on `feature/bash-known-read-only` (analyzer, managed
integration, identity broker and audit collector) and natively qualified on
macOS 26.7.1 arm64 with `/bin/bash` 3.2.57 at `1750997` (Section 11).

Prepared 2026-10-13 against Pi Sandbox `dc45abc` and pinned Pi 1.1.0. This
document is the contract for the Bash command analyzer and the first command
class built on it, `known_read_only`. The maintained subject documents
([configuration](../docs/configuration.md), [security](../docs/security.md),
[identity broker](../docs/identity-broker.md) and [testing](../docs/testing.md))
describe the implemented behavior for administrators and operators.

## 1. Decisions and scope

1. Add a deterministic, offline analyzer for model `bash` tool commands. It
   recognizes a deliberately small, literal subset of Bash and either produces a
   structured description of every command the shell will run, or reports
   precisely why the input is not understood. It never executes, expands, or
   resolves shell text through a shell.
2. Classification feeds the existing approval engine. It never changes how a
   command is executed: the frozen approval request is still the exact command
   run by the selected executor as `[bash, "-c", command]`. The OS boundary
   (Bubblewrap, Seatbelt, or none in direct mode) remains the security boundary.
3. The first command class is `known_read_only`: commands that pi-sandbox's
   reviewed registry proves only read data visible to the executor and write only
   to captured output or `/dev/null`. The class is named "known" because the
   registry is intentionally not exhaustive; an unlisted command that only reads
   is still unclassified.
4. Administrators assign a policy to the class independently of the tool's main
   policy. A class policy may only be more permissive than the main policy,
   because a model can always move a command out of a class (for example by
   adding `$x`), so a stricter class policy would protect nothing.
5. Supported backends: Bubblewrap, Seatbelt and direct. Direct mode is accepted
   with its documented residual risk (Section 6.3).
6. Out of scope for this change, but designed for (Section 10): administrator
   command sets, "allow similar for session" grants, explanatory approval
   summaries for unclassified commands, and advisory escalation rules.

## 2. Terminology

- **Main policy:** `[tools.bash] mode/session_grant`, applied to every command
  that no class covers.
- **Command class:** a named, product-defined category computed by the
  analyzer. The only class is `known_read_only`.
- **Class policy:** `[tools.bash.known_read_only] mode/session_grant`.
- **Registry:** the compiled-in, versioned list of known read-only command
  profiles (Section 8). Its version is `KNOWN_READ_ONLY_VERSION`, a positive
  integer incremented whenever recognizer acceptance or any profile changes.
- **Stage:** one simple command inside a pipeline.

## 3. Configuration contract

```toml
[tools.bash]
mode = "deny"            # allow | ask | deny | disabled; every unclassified command
session_grant = "never"
audit = true

[tools.bash.known_read_only]   # optional
mode = "ask"                   # allow | ask | deny
session_grant = "never"        # never | offer ("offer" only with "ask")
```

Validation of the base configuration (`config_version` stays 13; the table is an
additive optional field, following the `bearer_token_from_env` precedent):

1. `known_read_only` is accepted only under `[tools.bash]`. Any other tool
   table containing it is rejected as an unrecognized field.
2. The class table has exactly `mode` and `session_grant`. `audit` remains a
   tool-level setting. `disabled` is not a valid class mode: availability is
   tool-level only.
3. `session_grant = "offer"` requires `mode = "ask"`, as for every policy.
4. The class policy must be strictly more permissive than the main policy
   (Section 4.1 ordering). Otherwise it has no effect and is rejected.
5. The class table is rejected when the main mode is `disabled`.
6. When the class mode is `allow`, the effective policies of `read`, `grep`,
   `find` and `ls` must all be `allow`. This is the condition that makes
   skipping the prompt justified (Section 6.1).

Rule 6 is validated against the effective policy after identity-broker
overlays as well as the base configuration. Rules 4 and 5 are validated on the
base configuration and on every broker rule file; after broker merging the
result is normalized instead (Section 4.3). The exact issue and startup messages
are published in [configuration](../docs/configuration.md#class-policy-validation).

## 4. Decision procedure

### 4.1 Ordering and join

Modes are ordered `deny < ask < allow` (`disabled` is never joined). Session
grant policies are ordered `never < offer`. The **join** of two policies takes
the greater mode and the greater session grant policy, then normalizes
`session_grant` to `never` unless the joined mode is `ask`.

A policy P is strictly more permissive than Q when `P.mode > Q.mode`, or when
both modes are `ask`, `P.session_grant = offer` and `Q.session_grant = never`.

### 4.2 Evaluating a model `bash` call

1. If the effective bash policy has no class policy, behavior is unchanged: no
   analysis runs and the main policy decides.
2. Otherwise the managed `authorize` path analyzes `arguments.command` of the
   same immutable argument snapshot that is approved and executed, with the
   analyzer for the current execution context (Section 6), before preparing the
   approval request. The result (`known_read_only` or `unclassified`) is bound
   into the frozen `ApprovalRequest` as `commandClass` and covered by its
   fingerprint (request fingerprint version 2, which includes `commandClass`,
   or `null` when absent, and is re-verified at evaluation). An analyzer
   exception, a result whose `version` differs from the analyzer's, or a
   malformed result makes the request `unclassified` with the issue
   `command analysis failed`. A class policy without an analyzer refuses session
   start, and analyzer construction failure aborts startup.
3. The engine evaluates `known_read_only` requests against
   `join(main, class)` and `unclassified` requests against the main policy.
   Because every accepted class policy is strictly more permissive than its
   main policy, the join equals the class policy for every accepted
   combination.
4. Code-mode nested bash calls use the same `authorize` path and are covered.
   User `!` shell commands remain fixed-allow and are never analyzed.
   The standalone `@kcosr/pi-sandbox-extension` package has no approvals and is
   unchanged.

### 4.3 Identity broker

Broker rule files may carry the same optional `known_read_only` table under
`tools.bash` with the same per-file validation (Rules 1–5). Matching rules are
combined least-restrictive-wins:

- The main bash policy keeps the existing rank-based selection.
- Class policies combine with the join; an absent class policy is the identity
  element.
- The combined record is then normalized: a class policy that is not strictly
  more permissive than the combined main policy is dropped, and a class policy
  under a `disabled` main policy is dropped. Normalization never rejects.

As today, a returned tool policy replaces the base tool policy wholesale. The
returned bash patch therefore carries its own optional `known_read_only` (absent
means the user has no class policy). The response uses protocol version 8 and
serializes the class as
`{"mode":"ask","session_grant":"never","known_read_only":{"mode":"allow","session_grant":"never"}}`,
omitting `known_read_only` when absent. The client accepts it only for `bash`
and rejects an unnormalized class policy as an invalid response. Rule 6 is then
validated on the final effective policy and startup fails closed with an
actionable message when it is violated.

### 4.4 Session grants

Session grants remain memory-only and are cleared with every session lifecycle
event that clears them today. Grants are scoped:

- A grant made while evaluating an `unclassified` request has **tool scope** and
  covers every later bash request, as today.
- A grant made while evaluating a `known_read_only` request has **class scope**
  and covers only later `known_read_only` requests.
- A `known_read_only` request is covered by a tool-scope or a class-scope
  grant; an `unclassified` request only by a tool-scope grant.

The prompt labels the session choice with its scope ("Allow for session" versus
"Allow known read-only commands for session"). Grant revisions include the class
policy so policy changes invalidate grants as today.

### 4.5 Prompts, denials and audit

- Approval display for a `known_read_only` request uses the label
  `bash (known read-only)`. Unclassified display is unchanged.
- When an unclassified request is denied with reason `policy_denied` and a
  class policy exists, the error returned to the model names the first analyzer
  issue:
  `Pi Sandbox denied bash: policy_denied; not a known read-only command: <issue.message>`.
  The issue, including any truncation ellipsis, is limited to 512 UTF-8 bytes
  with control and format characters replaced. This lets the model adjust instead of retrying blindly. Other denial
  reasons keep their ordinary messages.
- Bash audit decision events (`tool_execution_intent`, `tool_denied`) carry
  `command_class` (`known_read_only` | `unclassified`) and
  `known_read_only_version` whenever the effective bash policy has a class
  policy. Both fields are absent otherwise, appear together, and are valid only
  for tool `bash`. The version is an integer from 1 through 4294967295 (the
  collector's unsigned 32-bit field), and the analyzer is rejected at startup
  when its version is outside that range. `approval_source` keeps its existing
  values. The client and the collector validate the new fields strictly.
- `/sandbox policy` adds a `bash (known read-only)` row. `/sandbox policy bash`
  diagnostics show the class policy and its class-scoped grant, the registry
  version and the known command names grouped as shell builtins and
  executables.

## 5. Analyzer result

```ts
type BashAnalysis =
  | { commandClass: "known_read_only"; version: number; commands: readonly string[] }
  | { commandClass: "unclassified"; version: number; issue: BashAnalysisIssue };
```

`commands` lists the command names of every stage in source order.
`issue.code` is a stable machine code; `issue.message` is a printable-ASCII,
plain English explanation of at most about 160 characters, suitable for the
model and the approval UI, that quotes input only as short escaped excerpts;
`issue.offset` is the UTF-16 offset of the offending input when one exists.
When several issues apply, the reported issue is the first of: an unsafe
command-wide environment variable (Section 6.2 Rules 1 and 2), the locale rule
(Rule 3), then the first problem in source order, whether a stage's context
check or the syntax, option or operand error at which recognition stopped. The structured
parse (statements, stages, decoded words and normalized redirections) is
exposed by the syntax module for future features and tests; it is not
persisted.

## 6. What `known_read_only` means

### 6.1 Definition

A command is `known_read_only` when every stage is accepted by its registry
profile, every redirection is in the accepted set (Section 7.4), and the
execution context checks pass (Section 6.2). Such a command:

- runs only reviewed shell builtins or reviewed executables resolved outside the
  launch directory;
- reads only data visible to the executor (any path the backend exposes);
- writes only to captured stdout/stderr, pipes between stages, `/dev/null`, and
  private temporary files a reviewed program manages itself (for example `sort`
  spill files under `TMPDIR`);
- opens no network connection, starts no background job, and changes no shell
  or environment state beyond `cd` within the same `bash -c` process. The one
  documented exception is Apple `cat`'s Unix-domain socket fallback
  (Section 6.3).

This is **capability equivalence**: with `read`, `grep`, `find` and `ls` already
`allow`, a known read-only command can observe nothing those tools cannot
observe inside the same boundary. It is not a claim that the command is
"harmless": reading is disclosure to the model, and resource use is bounded only
by the existing timeout and output limits.

### 6.2 Execution context checks

The analyzer is constructed once per runtime with the execution context the
executor actually uses: backend, canonical launch directory, and the exact
environment passed to `bash -c` children (fixed sandbox values plus
administrator `environment.sandbox` values plus tool-bundle `PATH` for
Bubblewrap/Seatbelt; the sanitized ambient environment plus administrator values
plus tool-bundle `PATH` for direct). The environment comes from pure helpers that
the executors themselves use. The Seatbelt context omits the scratch `HOME`,
`TMPDIR`, `TMP`, `TEMP` and `XDG_*` values that the executor creates at its own
startup; none of them participates in the checks below. A command is
unclassified when:

1. `BASH_ENV`, `SHELLOPTS`, `BASHOPTS` or `EXECIGNORE` is set to a non-empty
   value. Bash imports these at startup: `BASH_ENV` startup code could redefine
   commands, `SHELLOPTS=xtrace` with an inherited `PS4` containing `$(...)` runs
   code before any analyzed command, `BASHOPTS` can enable `expand_aliases` or
   `extglob`, and `EXECIGNORE` changes executable lookup. This rule applies to
   the whole command.
2. Any `LD_*` or `DYLD_*` variable, or `GCONV_PATH`, is set to a non-empty
   value. Dynamic-loader and C-library hooks such as `LD_PRELOAD`, `LD_AUDIT`,
   `LD_DEBUG_OUTPUT`, `LD_PROFILE_OUTPUT` or `DYLD_INSERT_LIBRARIES`, and
   `iconv` module loading through `GCONV_PATH`, can make any program load code
   or write files. This rule also applies to the whole command.
3. The input contains non-ASCII text and the effective locale (the first
   non-empty of `LC_ALL`, `LC_CTYPE` and `LANG`) is neither `C`, `POSIX` nor a
   UTF-8 locale. Other multibyte encodings could decode bytes into shell
   syntax differently from the recognizer.
4. The environment exports a Bash function whose name is a command used by the
   input, including builtins. Exported functions are recognized as
   `BASH_FUNC_name` or `__BASH_FUNC<name>` variables with a `%%` or `()` suffix
   (for example `BASH_FUNC_ls%%` or `__BASH_FUNC<ls>()`), and as legacy
   variables whose value starts with `()`.
5. An executable stage is used while a `command_not_found_handle` function is
   exported.
6. For each executable stage, `PATH` lookup in the context environment:
   - has no `PATH` or an empty one (Bash would use a compiled-in default search
     path that can include the current directory);
   - encounters an empty or relative `PATH` entry, or an entry inside the launch
     directory by its normalized path or after resolving symbolic links, before
     the command is found;
   - finds no regular executable file; or
   - resolves (after `realpath`) to a file inside the launch directory.
7. A profile's declared environment dependency is unsafe: `RIPGREP_CONFIG_PATH`
   set while `rg` is used without `--no-config`, or `GREP_OPTIONS` set while
   `grep` is used (Apple grep and older GNU grep honor it).

Shell builtins in the registry are not looked up in `PATH`; Rule 4 still
applies. `PATH` resolution for one command name is shared by every stage of a
single analysis and repeated for each later analysis; nothing is cached across
commands.

These rules target variables that change which program runs, how Bash starts,
or whether every program loads foreign code or writes files. Other
environment-driven behavior of administrator or user values, such as locale
data, `TMPDIR` or tool-specific settings, applies equally to the typed `read`,
`grep`, `find` and `ls` tools, which run in the same backend environment, and
therefore preserves capability equivalence.

### 6.3 Per-backend guarantees and residual risk

- **Bubblewrap / Seatbelt:** the OS boundary still contains a misclassified
  command (read-only host, no network by default). The analyzer reduces prompts
  within that boundary.
- **Direct:** there is no OS boundary, so a misclassification runs with the
  user's full authority. The ambient environment is the user's own; the checks
  in Section 6.2 reject project-supplied executables and startup hooks, but a
  model that has already been allowed to write outside the project (for example
  to a user-writable `PATH` directory) can affect later resolution. This
  residual risk is accepted and documented. Private spill files that `sort`
  creates and removes are allowed by Section 6.1; in direct mode they live in
  the user's real `TMPDIR` (or `/tmp` when it is unset).
- **Apple `cat` Unix-domain sockets:** Apple's `cat` manual page and source
  implement a fallback that connects to a socket path given as an operand and
  reads what the peer sends. On the tested Mac (macOS 26.7.1), Apple `cat`
  failed before connecting (`ai_family not supported`), so no positive control
  was possible; an independent control showed that Seatbelt network `none`
  denies Unix-domain connects (`EPERM`) while `host` permits them. The typed
  `read` tool runs the same `/bin/cat`, so capability equivalence holds. The
  exposure under Seatbelt `host` or direct mode, limited to reading what a local
  service sends on connect, is a documented residual risk, not a claim that no
  local IPC occurs.

## 7. Recognizer grammar

The recognizer accepts only inputs whose meaning is identical in GNU Bash 3.2
and later, as invoked by `bash -c` with no startup file. Anything outside this
grammar is unclassified; there is no error recovery.

### 7.1 Input

- At most 16 KiB UTF-8.
- No C0 control character other than tab and newline, no DEL or C1 control
  character, and no lone UTF-16 surrogate, even inside quotes.
- Non-ASCII characters only inside single or double quotes, subject to the
  locale rule in Section 6.2.

### 7.2 Words

A word is a concatenation of one or more of:

- **Unquoted text** from `[A-Za-z0-9_./,:@%+=-]`.
- **Single-quoted text:** `'…'`, any characters except `'`.
- **Double-quoted text:** `"…"`, any characters except `"`, `\`, `$`, `` ` ``
  and `!`.

Decoded word values drop the quotes. Every other character outside quotes is
rejected, including `$ \` \ ! # ~ * ? [ ] { } ( ) ^` and other punctuation.
Consequently there are no expansions, globs, escapes, comments, line
continuations, subshells, arithmetic, process substitution or brace expansion.

### 7.3 Structure

- **Separators:** spaces and tabs separate words.
- **Statements** are separated by `;` or newline. Leading, trailing and repeated
  newlines are allowed; a trailing `;` is allowed; an empty statement between
  `;` separators, and `;;`, are rejected.
- **Lists:** pipelines joined by `&&` or `||`. A newline directly after `&&`,
  `||` or `|` is whitespace, as in Bash.
- **Pipelines:** one or more simple commands joined by `|`.
- **Rejected operators:** `&` (background), `|&`, `!`, `(`, `)`, and any
  operator not listed above.
- **Simple commands:** one or more words plus zero or more redirections, in any
  order. The first word is the command name; its decoded value must exactly
  match a registry profile name. An unquoted reserved word (`if`, `time`,
  `coproc`, `function` and the rest of Bash's list) or an assignment-shaped
  first word (`NAME=value`, `NAME+=value`) is a syntax error, so assignment
  prefixes are never accepted. A command name containing `/` is rejected.
- All branches of `&&`, `||` and `;` are analyzed; control flow is not
  evaluated.

### 7.4 Redirections

An unquoted digit-only word immediately followed by `<` or `>`, with no blank
between them, is the file-descriptor number, as in Bash; otherwise the default
descriptor applies. Only descriptors 0, 1 and 2 are accepted. Accepted forms:

| Form                                                                                      | Meaning                             |
| ----------------------------------------------------------------------------------------- | ----------------------------------- |
| `>/dev/null`, `>>/dev/null`, `1>/dev/null`, `2>/dev/null`, `1>>/dev/null`, `2>>/dev/null` | discard the stream                  |
| `&>/dev/null`                                                                             | discard stdout and stderr           |
| `2>&1`, `1>&2`, `>&1`, `>&2`, `2>&2`, `1>&1`                                              | duplicate between stdout and stderr |
| `<word`, `0<word`                                                                         | read a file                         |

The target word follows the operator after optional blanks. Discard targets must
decode exactly to `/dev/null`. Duplication targets must be an unquoted `1` or
`2`. Input targets may not name `/dev/tcp` or `/dev/udp`, including spellings
with repeated slashes such as `//dev//tcp/host/80`. Everything else is rejected,
including descriptors other than 0, 1 and 2, output or duplication of descriptor
0, input on descriptors 1 and 2, `>&word` with any other target, `<&`, `>&-`,
`<>`, `>|`, `&>>` (a syntax difference in Bash 3.2), here-documents and
here-strings. A statement consisting only of redirections is rejected.

## 8. Registry

### 8.1 Profile contract

Each profile declares its name, kind (`shell_builtin` or `executable`), an
option grammar, operand rules, optional environment dependencies, and a one-line
documentation summary. Profiles use positive option lists: any option not
explicitly accepted makes the stage unclassified.

Option parsing follows GNU `getopt_long` conventions, which is the most
permissive interpretation across the implementations considered: GNU
coreutils, findutils, grep and sed; uutils coreutils (whose clap-based parser
infers long-option abbreviations, which exact matching rejects); and the BSD
and macOS userland. Busybox applets are not covered. Options whose meaning is
doubtful on any considered implementation are omitted.

- `--` ends options for every `getopt_long` profile; `find` has its own
  expression grammar.
- `--name` and `--name=value` must match an accepted long option exactly; GNU
  abbreviations are rejected. A long option that takes no value rejects `=`.
  A required value comes from `=value` or the next word.
- `-abc` is a cluster of short options. A short option that takes a value
  consumes the rest of the word, or the next word when the rest is empty.
- `-` alone is an operand (standard input).
- Options are recognized anywhere before `--` (GNU argument permutation), so an
  option after an operand is still checked.
- Operand limits count every word from the first operand onward, as
  implementations that stop option parsing at the first operand (BSD
  `getopt`, `POSIXLY_CORRECT`) would. For example `uniq a -c` is rejected
  because BSD `uniq` would write a file named `-c`. This applies to `cd`, `pwd`,
  `sed` and `uniq`.
- Profile-specific forms (for example `head -20`) are explicit.

Option values and operands are data or paths to read; paths are not confined,
by design (Section 6.1). A few accepted options take values differently across
implementations, which changes only which words are data: BSD `stat -f` and
`-t` take a format argument where the registry parses GNU flags, so the
following word becomes a format instead of a file, and BSD `grep --context` and
`diff --context` or `--unified` take only an optional attached value, so a
following number becomes a pattern or file operand. Every reading is read-only.

### 8.2 Initial registry (version 1)

Shell builtins: `cd`, `echo`, `false`, `pwd`, `true`.

Executables: `basename`, `cat`, `cut`, `diff`, `dirname`, `du`, `find`, `grep`,
`head`, `ls`, `nl`, `readlink`, `realpath`, `rg`, `sed`, `sort`, `stat`, `tail`,
`tr`, `uniq`, `wc`.

Notable exclusions inside accepted commands:

| Command | Not accepted                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd`    | more than one operand, `-e`, `-@`                                                                                                                                               |
| `find`  | `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`, unknown primaries                                                                   |
| `rg`    | `--pre`, `--pre-glob`, `-z`/`--search-zip`, `--hostname-bin`; any use while `RIPGREP_CONFIG_PATH` is set unless `--no-config`                                                   |
| `grep`  | any use while `GREP_OPTIONS` is set                                                                                                                                             |
| `sed`   | everything except `-n`/`--quiet`/`--silent` with one script of the form `Np`, `N,Mp`, `$p` or `N,$p` (decimal `N`, `M`), and at most one file; one of those options is required |
| `sort`  | `-o`/`--output`, `-T`/`--temporary-directory`, `--compress-program`                                                                                                             |
| `tail`  | `-f`, `-F`, `--follow`, `--retry`, `--pid`, `-s`/`--sleep-interval`                                                                                                             |
| `uniq`  | a second operand (it names an output file), counting every word after the first operand                                                                                         |
| `cat`   | BSD `-l` (locks output)                                                                                                                                                         |

Commands deliberately not in version 1 include `git` (repository configuration
can run helpers), interpreters and shells, wrappers (`env`, `xargs`, `timeout`,
`nice`, `command`, `builtin`), network-capable tools (including DNS lookups),
pagers, editors and `printf` (its `-v` assigns variables).

The administrator documentation publishes the exact accepted options per
command as a table generated by `renderKnownReadOnlyTable()`; it is the complete
accepted set. A unit test fails if the table in `docs/configuration.md` and the
registry disagree and names the regeneration command.

## 9. Module layout

- `src/permissions/bash/contracts.ts` — shared types and the analyzer factory
  signature.
- `src/permissions/bash/syntax.ts` — the recognizer (Section 7).
- `src/permissions/bash/options.ts` — option grammar engine (Section 8.1).
- `src/permissions/bash/registry.ts` — profiles, version and documentation
  rendering (Section 8.2).
- `src/permissions/bash/analyzer.ts` — combines syntax, registry and context
  checks (Section 6.2).
- `src/permissions/command-classes.ts` — generic class-policy algebra (join,
  strict ordering, validation and the read-tool precondition).
- `src/runtime/bash-analysis.ts` — per-backend execution context and analyzer
  construction from the effective configuration.
- Managed integration lives in `src/extension`, `src/permissions/policy-engine.ts`,
  `src/permissions/approval.ts`, `src/config`, `src/identity`, `src/audit` and
  `src/runtime`; the broker and audit collector change in Rust. The reusable
  `packages/sandbox-extension` public interface does not change: its runtime
  modules export pure environment helpers for the managed context, but neither
  the package entry points nor `SandboxExecutor` change.

## 10. Extension points

- **More classes:** add a name to `COMMAND_CLASSES`, a TOML table under
  `[tools.bash]`, and analyzer rules. The join, the monotonic rule and scoped
  grants already generalize. A stage covered by several classes takes the most
  permissive; a command takes the most restrictive of its stages.
- **Administrator command sets:** a separate `command_sets` namespace for
  identity-based matches defined by administrators, sharing the decision rules
  but not the `known_read_only` guarantee or its read-tool precondition.
- **Allow similar for session:** grants keyed on the structured parse (program,
  leading options, subcommand words) offered only for fully recognized
  commands; interpreters and wrappers get exact-command grants only.
- **Explanatory prompts and audit detail:** render per-stage argv and effects
  from the structured parse; a tolerant parser may be used for display only,
  never for classification.
- **Advisory escalation:** prompts for risky shapes under `mode = "allow"` must
  be documented as non-security speed bumps, separate from classes.

## 11. Verification

- Unit tests for the recognizer, option engine, every profile (accepted and
  rejected forms) and the context checks with an injected filesystem probe.
- A known-bypass corpus that must stay unclassified, including brace and glob
  words (`rg --pre{=,=sh}`, `find . -de\lete`), line continuation, ANSI-C
  quoting, `${x@P}`, arithmetic substitution, assignment prefixes
  (`PAGER=curl …`), GNU abbreviations (`sort --compress=sh`), `uniq a b`,
  `sed …e`, `/dev/tcp` input, `&>>`, background `&` and multi-line pipelines.
- A differential integration test
  (`tests/integration/bash-known-read-only-differential.test.ts`) that runs every
  accepted corpus entry under the real `/bin/bash` with POSIX `sh` stub
  executables on an isolated `PATH`. Stubs record argv, descriptor file types
  and the markers they read, and write unique markers to standard output and
  standard error; inputs carry markers too. Where each marker arrives is
  compared with the parse, which checks stage wiring, capture routing, discards
  and duplication without device or inode numbers, so the test runs unchanged
  on Linux and macOS. It also runs a seeded generated corpus and checks every
  accepted input.
- Policy-engine, configuration, broker, identity-overlay, audit and diagnostics
  tests for Sections 3–4, including scoped session grants, nested code-mode
  calls and fail-closed handling of malformed analyzer results.
- A real-Bubblewrap end-to-end test with the real analyzer: a known read-only
  pipeline runs without a prompt under main `deny`, an unclassified command is
  denied with feedback, and a class-scoped grant does not cover an
  unclassified command.
- A documentation test that fails when the generated table in
  `docs/configuration.md` differs from `renderKnownReadOnlyTable()`.
- Native macOS qualification is a Mac-owner item. A first run on macOS 26.7.1
  with `/bin/bash` 3.2.57 probed every registry option spelling against the
  utilities resolved by both the packaged Seatbelt system `PATH` and the
  selected tool-bundle prefix and found no accepted option that writes files,
  runs programs or locks, and recorded the Apple `cat` behavior in Section 6.3. Its
  differential run failed in the earlier identity-based harness because
  `/dev/fd` reports a synthetic device and distinct inodes for the two ends of a
  pipe. The portable marker harness then passed natively at `1750997`: all
  analyzer and differential tests, including every accepted input of the seeded
  generated corpus, and the Seatbelt integration tests. Stubs write each marker
  in its own subshell because Bash 3.2 `printf` otherwise keeps a failed
  broken-pipe write buffered and later flushes it to standard error.
