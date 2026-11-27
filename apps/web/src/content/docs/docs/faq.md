---
title: FAQ
description: Find answers about data storage, backups, installation, auto-updates, and Postman compatibility.
---

## Is Kurlo free?

Yes — free and open source under the [MIT license](https://github.com/stormhop/kurlo/blob/main/LICENSE), on macOS, Windows, and Linux. The full desktop application source is at [stormhop/kurlo](https://github.com/stormhop/kurlo), which is also where releases are published. You can read it, [build it yourself](https://github.com/stormhop/kurlo#building-from-source), or [contribute](https://github.com/stormhop/kurlo/blob/main/CONTRIBUTING.md).

## Is my data sent anywhere?

Kurlo is local-first: requests, collections, history, environments, and secrets live on disk. There is no account system, Kurlo cloud sync, analytics, or telemetry.

Network traffic still occurs for actions that inherently need it: requests and realtime connections you start, OAuth authorization/token calls, GraphQL introspection, Git fetch/pull/push/clone operations, and release update checks.

## Where is my data stored?

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Kurlo/` |
| Windows | `%APPDATA%\Kurlo\` |
| Linux | `~/.config/Kurlo/` |

The local profile is an AES-256-GCM encrypted JSON envelope stored as `requests.json`, not SQLite. Kurlo also writes `request-store.key` as a `0600` recovery copy of the encryption key. Where available, the same key is additionally stored in macOS Keychain, Windows DPAPI, or Linux libsecret.

Folder/Git workspace YAML is intentionally readable so it can be reviewed and committed. Sensitive values are replaced by `{{kurloSecret:...}}` placeholders and retained in the encrypted local profile.

## How do I export and back up my data?

Use **Settings → General → Data → Export all data** for a portable Kurlo backup. It includes profile data, history, cookies, and selected preferences. The plaintext file can contain secrets. Collection exports are for interoperability and do not include runtime history or cookies.

For an exact disk-level backup, quit Kurlo and copy the data directory with both `requests.json` and its matching `request-store.key`. Back up external workspace repositories separately.

See [Backup & recovery](/docs/guides/backup-recovery/) for contents, exclusions, migration, and destructive restore behavior.

## macOS says "the app can't be opened"

If macOS reports the app is damaged after download, the file likely got the quarantine attribute from a non-standard download path. Run:

```sh
xattr -d com.apple.quarantine /Applications/Kurlo.app
```

If that doesn't help, redownload from the [official releases page](https://github.com/stormhop/kurlo/releases/latest) and compare its SHA-256 checksum.

## Windows SmartScreen warns about the installer

The NSIS installer is not currently Authenticode-signed, so SmartScreen may flag it. Confirm that it came from the official releases page, verify its checksum, then use **More info → Run anyway** only if you trust the download.

## Auto-updates aren't working

- Check manually from **Settings → About**.
- If you want background installation, choose **Install automatically** in **Settings → About → Update mode**.
- Make sure `https://github.com/stormhop/kurlo/releases/latest/download/latest.json` is reachable — corporate proxies sometimes block GitHub release downloads.
- If you're on an unreleased dev build, auto-update is disabled by design.

## Postman compatibility — what doesn't carry over?

See [Import & export](/docs/guides/import-export/). Short version: common `pm.*` scripts import into Kurlo's sandboxed script fields — including `pm.sendRequest`, `pm.collectionVariables`, and `CryptoJS` request signing. What still needs a rewrite: scripts that `require` a Node.js module or external package, anything using `async`/`await` or `setTimeout`, Visualizers, and cloud-only Postman features. Monitors have no direct equivalent — use the [CLI runner](/docs/guides/cli-runner/) on a schedule. Mock servers do have one, and it is local: Kurlo serves a collection's [saved examples](/docs/guides/examples/) over HTTP on your own machine. See [Mock server](/docs/guides/mock-server/).

## How do I report a bug?

[Open an issue](https://github.com/stormhop/kurlo/issues) with:

- Version (Settings → About).
- Platform and OS version.
- Steps to reproduce.
- Anonymized request if relevant (strip auth + sensitive bodies).
