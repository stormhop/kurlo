---
title: "Data and storage"
---

## My collections / environments are gone

First, don't panic and don't reinstall — your data is on disk, not in the app bundle. Check whether:

- You're in a different workspace than you remember. Switch via the workspace dropdown in the title bar.
- You signed into a different OS user / Profile and Kurlo is reading another directory.

Find your data manually:

| Platform | Location |
|----------|----------|
| macOS    | `~/Library/Application Support/Kurlo/` |
| Windows  | `%AppData%\Kurlo\` |
| Linux    | `~/.config/Kurlo/` |

The `requests.json` file is an AES-256-GCM encrypted JSON envelope containing local profile state and secrets. If it's present but Kurlo can't read it, see "Decryption failed" below.

## "Decryption failed" or empty on startup

Kurlo couldn't decrypt `requests.json` with any available key copy. Kurlo normally keeps `request-store.key` in the app-data directory as a `0600` recovery copy and also stores the key in Keychain, DPAPI, or libsecret when available.

Common causes:

- `requests.json` was restored without the matching `request-store.key`.
- Files were copied from another OS user without preserving access to the key.
- The encrypted profile and recovery key came from different installations.

Restore `requests.json` and its matching `request-store.key` together. If no matching key exists, the encrypted data cannot be recovered; export/import backups are the safer migration path between machines. See [Backup & recovery](/docs/guides/backup-recovery/) for the full restore procedure.

## "Warning: changes could not be saved"

Disk full, or Kurlo's data directory is no longer writable (permissions changed, drive unmounted). Free up space or fix permissions and the next save will succeed.
