# Preparing smolvm images

The smolvm backend consumes a locally provisioned image and its SHA-256. Image
preparation is a trusted operator task, separate from running Pi. Neither the
managed application nor the ordinary Pi extension discovers or executes a
project's `Smolfile`, `Dockerfile`, image build scripts, or registry references.

## Plain tools image for a mounted host project

[examples/smolvm/Smolfile](../examples/smolvm/Smolfile) records the small Alpine
tools recipe qualified with smolvm **1.25.4** on Linux x86-64. The commands below
apply its resource values and installation steps explicitly through the upstream
CLI. No private repository or custom builder is required.

Prepare these prerequisites first:

- A Linux x86-64 host with usable `/dev/kvm` and enough free disk space for the
  builder, packed image, and offline verification copy.
- The complete official [smolvm 1.25.4 distribution](https://github.com/smol-machines/smolvm/releases/tag/v1.25.4),
  verified against its release checksums. Keep its wrapper, executable, libraries,
  and guest rootfs together in an operator-controlled directory.
- Host `resize2fs` from e2fsprogs to shrink the bundled templates to the
  requested 1 GiB disks. The example expects it in `/usr/sbin`; if installed
  elsewhere, add only that trusted directory to the function's explicit `PATH`.
  A resource setting alone is not proof of actual disk capacity.
- An operator-controlled output location outside the project, plus network
  access for installing guest packages. Do not copy credentials into the builder.

Run these steps from one shell, stopping if any command fails. Set the executable
and a new output directory to your actual absolute paths:

```sh
smolvm_bin=/opt/smolvm-1.25.4/smolvm
image_output=/absolute/operator-owned/tools-image
test -x "$smolvm_bin"
test -x /usr/sbin/resize2fs
umask 077
mkdir "$image_output"
image_state=$(mktemp -d /var/tmp/pi-img.XXXXXX)
for subdir in h d c f s r t; do
  mkdir "$image_state/$subdir"
done
printf 'Keep this state path for cleanup: %s\n' "$image_state"

smol() (
  cd "$image_state" || exit
  env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=C.UTF-8 \
    HOME="$image_state/h" XDG_DATA_HOME="$image_state/d" \
    XDG_CACHE_HOME="$image_state/c" XDG_CONFIG_HOME="$image_state/f" \
    XDG_STATE_HOME="$image_state/s" XDG_RUNTIME_DIR="$image_state/r" \
    TMPDIR="$image_state/t" "$smolvm_bin" "$@"
)

smol --version
```

Expect `smolvm 1.25.4`. The private, short state path avoids Unix socket path
limits and separates this builder from your usual smolvm machines. Preserve this
environment when inspecting or cleaning up the builder, including after an
interrupted shell.

Create the bare VM with networking enabled only for trusted preparation. No host
directory is mounted into it:

```sh
smol machine create --name trusted-image-builder --net \
  --cpus 2 --mem 1024 --storage 1 --overlay 1
smol machine start --name trusted-image-builder
smol machine exec --stream --name trusted-image-builder -- /bin/sh -ec \
  'apk add --no-cache bash coreutils findutils grep gawk file ripgrep fd git nodejs python3 util-linux'
smol machine exec --stream --name trusted-image-builder -- /bin/sh -ec \
  'mkdir -p /root/.cache /root/.config /root/.local/state'
smol machine exec --name trusted-image-builder -- /bin/sh -ec \
  'apk info -v > /workspace/image-packages.txt'
smol machine cp trusted-image-builder:/workspace/image-packages.txt \
  "$image_output/image-packages.txt"
smol machine stop --name trusted-image-builder
smol machine update --name trusted-image-builder --no-net
smol pack create --from-vm trusted-image-builder --cpus 2 --mem 1024 \
  --output "$image_output/tools"
```

Packing produces a launcher named `tools` and the image `tools.smolmachine`.
Configure Pi with the latter. Do not add an image entrypoint, command,
environment, user, workdir, secret, workspace seed, or checkpoint: the backend
sets its own execution context and rejects imported authority. The plain image
has no OCI layers. The `--no-net` update occurs **before** packing so the image
does not request external networking.

Verify the packed image itself with no network flag and no host mount. This checks
the 17 fixed command paths, the guest Node launcher, useful development tools,
and the two actual 1 GiB block-device capacities (2,097,152 sectors of 512 bytes):

```sh
smol machine run --from "$image_output/tools.smolmachine" \
  --cpus 1 --mem 512 --storage 1 --overlay 1 -- /bin/sh -ec '
    for tool in /bin/bash /bin/sh /bin/cat /bin/chmod /bin/mkdir /bin/mv \
      /bin/rm /bin/grep /usr/bin/file /usr/bin/find /usr/bin/awk \
      /usr/bin/head /usr/bin/sha256sum /usr/bin/sort /usr/bin/tail \
      /usr/bin/test /usr/bin/wc /usr/bin/node /usr/bin/rg /usr/bin/fd \
      /usr/bin/git /usr/bin/python3; do
      test -x "$tool"
    done
    test "$(cat /sys/block/vda/size)" = 2097152
    test "$(cat /sys/block/vdb/size)" = 2097152
    node --version
    bash --version | head -1
    grep --version | head -1
    find --version | head -1
    awk --version | head -1
    printf "packed tools image verified\n"
  '
sha256sum "$image_output/tools.smolmachine" > "$image_output/tools.smolmachine.sha256"
```

The GNU packages matter: executable presence alone does not establish the GNU
semantics used by the file tools. Review the version output and keep the package
inventory with the artifact. The package repository is not snapshot-pinned, so
this is a repeatable preparation procedure, not a promise of identical image
bytes on later dates. Review each new build and pin **its own** SHA-256 in
`smolvm.image_sha256` for managed Pi or `backend.imageSha256` for the ordinary Pi
extension. Keep the image outside writable project/state directories. Runtime
startup also validates its manifest and configured disk capacities.

Clean up only after the verification command has finished:

```sh
smol machine delete --name trusted-image-builder --force
smol machine ls --json
```

The list should be empty in this isolated state. If anything failed, retain the
state directory, inspect that list, and use `machine stop --name NAME` and
`machine delete --name NAME --force` on its remaining machines. Do not erase
state while a VM might still be running. After confirmed cleanup the disposable
state can be removed; preserve the image, digest, and inventory. No watcher or
host service is involved.

## OCI archive for an orchestrator-owned family

The extension's `./controller` API separately accepts a local, digest-pinned
`docker save` archive. This supports a different guest distribution and a
writable guest workspace for branching. An OCI archive is not interchangeable
with the plain `.smolmachine` image used above.

Build from an operator-reviewed Dockerfile and context, target `linux/amd64`, and
install the fixed GNU paths listed above plus Node at `/usr/bin/node`. Include
`/bin/sleep` with support for `infinity`; the controller supplies the running
workload and does not rely on the image's application command. An example export,
after separately provisioning Docker, is:

```sh
docker build --platform linux/amd64 -t pi-eval-tools:reviewed \
  -f /absolute/trusted-context/Dockerfile /absolute/trusted-context
docker image save --output /absolute/operator-owned/tools.tar pi-eval-tools:reviewed
sha256sum /absolute/operator-owned/tools.tar
```

Pin the base image digest and dependencies in that Dockerfile as appropriate for
your build. Supply the resulting archive path and SHA-256 explicitly to the
controller; image construction and registry access are never automatic tool
operations. The controller selects runtime networking and read-only host inputs
separately from the image. Qualify its required tools and workload before using
it for evaluations.

OCI startup also needs host `resize2fs` from e2fsprogs when the configured disks
are smaller than the bundled 20 GiB storage or 10 GiB overlay templates. Install
it in a system directory searched by the launcher's fixed PATH
(`/usr/bin:/bin:/usr/sbin:/sbin`); a user-local PATH entry is not inherited. This
is distinct from prepared plain packs, which already contain sized templates
and cannot request smaller capacities in our backend.
