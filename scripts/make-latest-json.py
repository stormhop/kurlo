#!/usr/bin/env python3
"""Generate latest.json for the Kurlo auto-updater.

Reads binary artifacts from a release directory, computes SHA256, and writes
the manifest used by the in-app updater. When minisign signature files
(<asset>.minisig) are present alongside the binaries, a `signature` field is
emitted per platform.

Usage:
    make-latest-json.py \
        --release-dir release \
        --tag v0.1.5 \
        --repo stormhop/kurlo \
        --notes-file release-notes.md \
        [--platforms darwin-universal,darwin-universal-app,windows-amd64,windows-arm64,linux-amd64,linux-amd64-appimage]

If --platforms is omitted, every entry from the default platform table is
required. Any missing asset is an error.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_ASSETS = {
    "darwin-universal": "kurlo-darwin-universal",
    "darwin-universal-app": "kurlo-darwin-universal.app.zip",
    "windows-amd64": "kurlo-windows-amd64.exe",
    "windows-arm64": "kurlo-windows-arm64.exe",
    "linux-amd64": "kurlo-linux-amd64",
    "linux-amd64-appimage": "kurlo-{version}-linux-amd64.AppImage",
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-dir", required=True, type=Path)
    parser.add_argument("--tag", required=True, help="release tag, e.g. v0.1.5")
    parser.add_argument("--repo", required=True, help="owner/repo that hosts the releases")
    parser.add_argument("--notes-file", type=Path, default=None)
    parser.add_argument(
        "--platforms",
        default=None,
        help="comma-separated platform keys (e.g. 'darwin-universal'). "
        "Defaults to all platforms; every asset is required.",
    )
    parser.add_argument(
        "--require-signature",
        action="store_true",
        help="fail if any included platform is missing its <asset>.minisig file",
    )
    args = parser.parse_args()

    release_dir: Path = args.release_dir
    if not release_dir.is_dir():
        print(f"error: release dir not found: {release_dir}", file=sys.stderr)
        return 1

    tag = args.tag if args.tag.startswith("v") else f"v{args.tag}"
    version = tag[1:]

    notes = "Bug fixes and improvements"
    if args.notes_file and args.notes_file.is_file():
        loaded = args.notes_file.read_text(encoding="utf-8").strip()
        if loaded:
            notes = loaded

    if args.platforms:
        requested = [p.strip() for p in args.platforms.split(",") if p.strip()]
        for platform in requested:
            if platform not in DEFAULT_ASSETS:
                print(f"error: unknown platform key: {platform}", file=sys.stderr)
                return 1
        assets = {p: DEFAULT_ASSETS[p] for p in requested}
    else:
        assets = DEFAULT_ASSETS
    assets = {p: name.format(version=version) for p, name in assets.items()}

    manifest: dict = {
        "version": version,
        "notes": notes,
        "published_at": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "platforms": {},
    }

    for platform, asset in assets.items():
        asset_path = release_dir / asset
        if not asset_path.exists():
            print(f"error: missing asset for platform {platform}: {asset_path}", file=sys.stderr)
            return 1
        entry = {
            "url": f"https://github.com/{args.repo}/releases/download/{tag}/{asset}",
            "sha256": sha256_file(asset_path),
        }
        sig_path = release_dir / f"{asset}.minisig"
        if sig_path.exists():
            entry["signature"] = f"https://github.com/{args.repo}/releases/download/{tag}/{asset}.minisig"
        elif args.require_signature:
            print(f"error: missing signature for platform {platform}: {sig_path}", file=sys.stderr)
            return 1
        manifest["platforms"][platform] = entry

    if not manifest["platforms"]:
        print("error: no platforms produced — refusing to emit an empty manifest", file=sys.stderr)
        return 1

    out_path = release_dir / "latest.json"
    out_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_path} with platforms: {', '.join(manifest['platforms'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
