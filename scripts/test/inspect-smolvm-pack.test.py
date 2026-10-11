#!/usr/bin/env python3
"""Portable, offline controls for the trusted pack preparation inspector."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tarfile
import tempfile
import unittest
import zlib
from compression.zstd import compress

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "inspector", Path(__file__).with_name("inspect-smolvm-pack.py"))
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)


def manifest(container=False):
    assets = {
        "libraries": [{"path": "lib/runtime.dylib", "size": 123}],
        "agent_rootfs": {"path": "agent-rootfs.tar", "size": 4},
        "layers": [], "storage_template": {"path": "storage.ext4", "size": 4},
        "storage_logical_size": 1073741824,
        "overlay_template": {"path": "overlay.raw", "size": 4},
        "overlay_logical_size": 1073741824,
    }
    if container:
        assets["layers"] = [{"path": "layers/layer.tar", "size": 4,
                             "digest": "sha256:" + hashlib.sha256(b"data").hexdigest()}]
    return {"mode": "container" if container else "vm", "platform": "linux/arm64",
            "host_platform": "darwin/arm64", "smolvm_version": "1.26.1",
            "network": False, "gpu": False, "cuda": False, "assets": assets}


def write_pack(file, value, entries=None):
    if entries is None:
        assets = value["assets"]
        entries = [(record["path"], b"data") for record in
                   [assets["agent_rootfs"], assets["storage_template"],
                    assets["overlay_template"], *assets["layers"]]]
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, data in entries:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    payload = compress(raw.getvalue())
    metadata = json.dumps(value).encode()
    content = payload + metadata
    footer = struct.pack("<8sIQQQQQI8s", b"SMOLPACK", 1, 0, 0, len(payload),
                         len(payload), len(metadata), zlib.crc32(content), bytes(8))
    file.write_bytes(content + footer)


class Inspection(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.file = self.root / "image.smolmachine"

    def tearDown(self):
        self.temporary.cleanup()

    def test_full_plain_inventory_with_external_libraries(self):
        write_pack(self.file, manifest())
        result = inspector.inspect(self.file)
        self.assertTrue(result["crc32Verified"])
        self.assertEqual(len(result["inventory"]), 3)
        self.assertEqual(result["sha256"], hashlib.sha256(self.file.read_bytes()).hexdigest())

    def test_container_export_no_replacement(self):
        write_pack(self.file, manifest(True))
        output = self.root / "layer.tar"
        inspector.inspect(self.file, output)
        self.assertEqual(output.read_bytes(), b"data")
        with self.assertRaisesRegex(ValueError, "already exists"):
            inspector.inspect(self.file, output)
        self.assertEqual(output.read_bytes(), b"data")

    def test_crc_corruption(self):
        write_pack(self.file, manifest())
        data = bytearray(self.file.read_bytes())
        data[10] ^= 1
        self.file.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "CRC mismatch"):
            inspector.inspect(self.file)

    def test_declared_digest_and_failed_export_cleanup(self):
        value = manifest(True)
        value["assets"]["layers"][0]["digest"] = "sha256:" + "0" * 64
        write_pack(self.file, value)
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            inspector.inspect(self.file, self.root / "layer.tar")
        self.assertEqual(list(self.root.iterdir()), [self.file])

    def test_duplicate_missing_and_unexpected_assets(self):
        for entries in [[("agent-rootfs.tar", b"data")],
                        [("agent-rootfs.tar", b"data")] * 2,
                        [("../escape", b"data")]]:
            with self.subTest(entries=entries):
                write_pack(self.file, manifest(), entries)
                with self.assertRaises(ValueError):
                    inspector.inspect(self.file)

    def test_plain_authority_and_workspace_rejection(self):
        for key, content in [("cmd", ["evil"]), ("network", True),
                             ("checkpoint", {}), ("env", ["KEY=value"]),
                             ("secret_refs", {"key": "secret"})]:
            with self.subTest(key=key):
                value = manifest()
                value[key] = content
                write_pack(self.file, value)
                with self.assertRaises(ValueError):
                    inspector.inspect(self.file)
        value = manifest()
        value["assets"]["workspace_seed"] = {}
        write_pack(self.file, value)
        with self.assertRaisesRegex(ValueError, "workspace seed"):
            inspector.inspect(self.file)

    def test_declared_capacity_and_asset_bounds(self):
        for logical in [True, 0, 3, 65 * 1024 ** 3]:
            with self.subTest(logical=logical):
                value = manifest()
                value["assets"]["storage_logical_size"] = logical
                write_pack(self.file, value)
                with self.assertRaisesRegex(ValueError, "capacity"):
                    inspector.inspect(self.file)

    def test_hardlinked_input_rejected(self):
        write_pack(self.file, manifest())
        (self.root / "alias").hardlink_to(self.file)
        with self.assertRaisesRegex(ValueError, "ordinary sidecar"):
            inspector.inspect(self.file)


if __name__ == "__main__":
    unittest.main()
