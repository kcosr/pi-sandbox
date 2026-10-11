#!/usr/bin/env python3
"""Offline preparation check for a 1.26.1 sidecar; requires Python 3.14.

Read the complete CRC and asset inventory without extracting guest paths.
Optionally export the single flattened OCI layer to a new operator-selected file.
This is a build/test utility, not a runtime importer or image builder.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import struct
import tarfile
import tempfile
import zlib
from compression.zstd import ZstdFile


class Section(io.RawIOBase):
    def __init__(self, source, length):
        self.source, self.remaining = source, length

    def readable(self):
        return True

    def readinto(self, buffer):
        data = self.source.read(min(len(buffer), self.remaining))
        buffer[:len(data)] = data
        self.remaining -= len(data)
        return len(data)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect(file, layer_output=None):
    with file.open("rb") as source:
        st = os.fstat(source.fileno())
        require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_size >= 64,
                "expected one ordinary sidecar file")
        source.seek(-64, 2)
        magic, version, stub, start, length, offset, size, crc, reserved = struct.unpack(
            "<8sIQQQQQI8s", source.read(64))
        require(magic == b"SMOLPACK" and version == 1 and stub == start == 0 and
                0 < length == offset and 2 <= size <= 1048576 and
                offset + size + 64 == st.st_size and reserved == bytes(8), "invalid footer")
        source.seek(offset)
        manifest = json.loads(source.read(size))
        require(manifest["smolvm_version"] == "1.26.1", "wrong runtime version")
        require((manifest["platform"], manifest["host_platform"]) in
                [("linux/arm64", "darwin/arm64"), ("linux/amd64", "linux/amd64")],
                "unsupported platform pair")
        require(manifest["network"] is False and manifest["gpu"] is False and
                manifest["cuda"] is False, "pack requests extra authority")
        require(manifest.get("checkpoint") is None and
                ("secret_refs" not in manifest or manifest["secret_refs"] == {}),
                "checkpoint/secrets are not preparation inputs")
        assets = manifest["assets"]
        require(assets.get("workspace_seed") is None, "unexpected workspace seed")
        expected = {}
        declared_digests = {}
        # Libraries belong to the signed launcher, not this sidecar. Runtime
        # verification independently pins the full official library inventory.
        records = [assets["agent_rootfs"], *assets["layers"], assets["storage_template"]]
        if "overlay_template" in assets:
            records.append(assets["overlay_template"])
        for record in records:
            require(type(record) is dict and set(record) in
                    ({"path", "size"}, {"path", "size", "digest"}),
                    "invalid asset declaration")
            name = record["path"]
            require(type(name) is str and not name.startswith("/") and
                    all(p not in ("", ".", "..") for p in name.split("/")) and
                    name not in expected and type(record["size"]) is int and
                    0 < record["size"] <= 32 * 1024 ** 3, "invalid asset name/size")
            expected[name] = record["size"]
            if "digest" in record:
                require(type(record["digest"]) is str and
                        re.fullmatch(r"sha256:[0-9a-f]{64}", record["digest"]),
                        "invalid asset digest")
                declared_digests[name] = record["digest"][7:]
        require(sum(expected.values()) <= 64 * 1024 ** 3, "asset inventory exceeds bound")
        if manifest["mode"] == "vm":
            require(assets["layers"] == [] and layer_output is None, "plain pack has OCI layers")
            require(all(manifest.get(k, []) == [] for k in ("entrypoint", "cmd", "env")) and
                    all(manifest.get(k) is None for k in ("user", "workdir")),
                    "plain pack imports workload authority")
        else:
            require(manifest["mode"] == "container" and len(assets["layers"]) == 1,
                    "expected a single flattened OCI layer")
        for disk in (("storage", "overlay") if manifest["mode"] == "vm" else ()):
            logical = assets[f"{disk}_logical_size"]
            require(type(logical) is int and 0 < logical <= 64 * 1024 ** 3 and
                    assets[f"{disk}_template"]["size"] <= logical, "invalid disk capacity")
        source.seek(0)
        actual_crc, remaining = 0, offset + size
        while remaining:
            data = source.read(min(1048576, remaining))
            require(bool(data), "truncated pack")
            actual_crc = zlib.crc32(data, actual_crc)
            remaining -= len(data)
        require(actual_crc == crc, "CRC mismatch")
        found = {}
        source.seek(0)
        temporary = None
        try:
            if layer_output is not None:
                require(not layer_output.exists() and not layer_output.is_symlink(),
                        "layer output already exists")
                temporary = tempfile.NamedTemporaryFile(dir=layer_output.parent, delete=False)
            with ZstdFile(io.BufferedReader(Section(source, length))) as decoded:
                with tarfile.open(fileobj=decoded, mode="r|") as archive:
                    for member in archive:
                        if member.isdir() and member.name in ("lib", "layers"):
                            continue
                        require(member.isfile() and member.name in expected and
                                member.name not in found and member.size == expected[member.name],
                                "unexpected, duplicate or inconsistent asset")
                        digest = hashlib.sha256()
                        payload = archive.extractfile(member)
                        export = temporary is not None and member.name == assets["layers"][0]["path"]
                        total = 0
                        for chunk in iter(lambda: payload.read(1048576), b""):
                            digest.update(chunk)
                            total += len(chunk)
                            if export:
                                temporary.write(chunk)
                        require(total == member.size, "truncated asset")
                        require(member.name not in declared_digests or
                                digest.hexdigest() == declared_digests[member.name],
                                "asset digest mismatch")
                        found[member.name] = {"size": total, "sha256": digest.hexdigest()}
                # Read through the Zstandard frame checksum after the tar EOF.
                tail = decoded.read(1048577)
                require(len(tail) <= 1048576 and not any(tail),
                        "unexpected decompressed tail")
            require(set(found) == set(expected), "incomplete asset inventory")
            if temporary is not None:
                temporary.close()
                os.link(temporary.name, layer_output)  # no replacement
        finally:
            if temporary is not None:
                temporary.close()
                os.unlink(temporary.name)
        source.seek(0)
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    return {"sha256": digest, "bytes": st.st_size, "crc32Verified": True,
            "manifest": manifest, "inventory": found}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--layer-output", type=Path)
    args = parser.parse_args()
    print(json.dumps(inspect(args.image, args.layer_output), indent=2))
