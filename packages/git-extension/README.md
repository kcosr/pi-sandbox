# Pi Git extension

A standard Pi extension providing `git_clone({ repository })`. It works alone
or alongside `@kcosr/pi-sandbox-extension`; neither package requires the other.
It targets Pi 1.1.0 and Node.js 24+ on Linux or macOS, with `/usr/bin/git` and,
when SSH is allowed, `/usr/bin/ssh` available.

## Standalone use

Install the package in Pi or load its `dist/index.js` with `pi -e`. Supply an
explicit private configuration file outside shared project content:

```json
{
  "version": 1,
  "allowed_hosts": ["github.com"],
  "allowed_schemes": ["https", "ssh"]
}
```

```sh
chmod 600 /absolute/path/git.json
pi -e /absolute/path/pi-git-extension/dist/index.js \
  --git-config /absolute/path/git.json
```

The configuration must be an owned regular file no larger than 64 KiB, with no
group/other permissions and no final symlink. Its path must be absolute and
normalized. The version and both policy fields are required; unknown fields,
empty lists, duplicate entries and invalid values are rejected. Hosts are exact
lowercase canonical IDNA names (no wildcard, port or trailing dot). Supported
schemes are `http`, `https` and `ssh`.

Pi's tool selection and exclusions remain authoritative. The extension registers
`git_clone` during loading and never activates it behind the user's selection.
Initialization captures the canonical launch directory and sanitized environment;
configuration or prerequisite failure prevents execution. New/resumed sessions,
reload and quit close the old host runner, including outstanding operations.
Replacement extension instances initialize a fresh runner.

## Clone behavior and boundary

For a launch directory `/home/user/work` and repository
`https://github.com/example/widget.git`, Git clones into
`/home/user/work/widget`. It derives an immediate child from the repository name
and strips `.git`; the caller cannot choose another destination or Git options.
Any existing destination, including an empty directory or a symlink, is rejected.
Local repositories, remote helpers, unsupported protocols, URL passwords,
queries and fragments are rejected.

Clone executes **on the host**, outside sandbox filesystem and networking
restrictions. Managed Bubblewrap and smolvm mount the launch directory at the
same path, so sandbox tools can use the checkout there. A read-only sandbox
mount does not prevent the host clone. For an externally attached guest,
visibility depends on the owner's mounts; Git does not copy into guest-only
paths or discover VM attachments.

Git uses fixed absolute executables, fixed arguments and a bounded host runner
with a default 120-second timeout and combined 1 MiB output limit. It removes
inherited `GIT_*` and `SSH_ASKPASS` settings, disables global/system Git config,
forces `/usr/bin/ssh`, and disables interactive credential prompts. It preserves
other host environment values, such as HOME and proxy settings. It does not
provide Pi Sandbox's approval prompts or audit system; the managed application
adds those separately. All Pi extensions remain trusted host JavaScript.

`git_clone` is declared sequential. This does not prevent a surviving background
process from racing destination validation and redirecting cloning into another
empty writable host directory. In pinned Pi, nested Code Mode sequential tools
also need not exclude nested Bash/file calls. That race is accepted: there is no
clone-specific guardian, background termination or publication step.

## Programmatic use

The `./factory` export provides `createGitExtension({ getRuntime })`. The callback
must return a runtime containing the captured canonical host `cwd`, validated
`config`, and a narrow `host.execute` port, or throw while unavailable. The
factory borrows these resources; it never closes them or reads configuration.
The caller must supply bounded execution, cancellation and its own lifecycle.

The `./core` export provides `parseGitCloneConfig`, `executeGitClone`, shared
metadata, environment restrictions and package-owned structural types. The
`./config` export provides the standalone versioned JSON parser and private-file
reader. No public import requires the sandbox package, a permissions package,
managed Pi patches or the repository's private SDK.

Pi Sandbox uses an application-owned managed adapter around this same core. Its
TOML configuration, approval/audit wrapper and scoped host executor are separate
from the standalone entry and `--git-config`. The package build privately bundles
the canonical host runner from repository source; installed users do not need a
sibling checkout.
