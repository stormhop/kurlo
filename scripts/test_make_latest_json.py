import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("make-latest-json.py")
SPEC = importlib.util.spec_from_file_location("manifest", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ManifestTests(unittest.TestCase):
    def generate(self, root, *args):
        return subprocess.run([sys.executable, str(SCRIPT), "--release-dir", str(root), "--tag", "v9.8.7", "--repo", "example/releases", *args], capture_output=True, text=True)

    def test_partial_default_build_fails_without_overwriting_manifest(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "kurlo-darwin-universal").write_bytes(b"binary")
            manifest = root / "latest.json"
            manifest.write_text("previous")
            result = self.generate(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(manifest.read_text(), "previous")

    def test_complete_build_has_every_platform(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for asset in MODULE.DEFAULT_ASSETS.values():
                (root / asset.format(version="9.8.7")).write_bytes(b"binary")
            result = self.generate(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((root / "latest.json").read_text())
            self.assertEqual(set(manifest["platforms"]), set(MODULE.DEFAULT_ASSETS))

    def test_explicit_platform_requires_its_signature_when_requested(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "kurlo-darwin-universal").write_bytes(b"binary")
            result = self.generate(root, "--platforms", "darwin-universal", "--require-signature")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "latest.json").exists())


if __name__ == "__main__":
    unittest.main()
