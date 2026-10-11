#!/usr/bin/env python3
import argparse
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "apps" / "desktop" / "extension"
SHIPPED = ["background.js", "popup.html", "popup.js"]


def manifest_version(version: str) -> str:
    match = re.match(r"^\d+(\.\d+){0,3}", version.strip().lstrip("v"))
    return match.group(0) if match else "0.0.0"


def package(browser: str, version: str, out: Path) -> Path:
    manifest_name = "manifest.firefox.json" if browser == "firefox" else "manifest.json"
    manifest = json.loads((SOURCE / manifest_name).read_text())
    manifest["version"] = manifest_version(version)
    target = out / f"kurlo-cookie-sync-{version.lstrip('v')}-{browser}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
        for name in SHIPPED:
            archive.write(SOURCE / name, name)
        for icon in sorted((SOURCE / "icons").glob("*.png")):
            archive.write(icon, f"icons/{icon.name}")
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description="Package the Kurlo Cookie Sync extension for a release.")
    parser.add_argument("--version", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for browser in ("chromium", "firefox"):
        print(package(browser, args.version, out))


if __name__ == "__main__":
    main()
