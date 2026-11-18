---
title: "Recover an encrypted profile"
---

If Kurlo reports **Decryption failed**, restore `requests.json` and the `request-store.key` created with it. The recovery file is owner-readable only and normally has `0600` permissions on Unix-like systems.

Kurlo may also find the key in:

- macOS Keychain.
- Windows DPAPI for the same OS user.
- Linux libsecret.

The credential-store copy is an additional recovery path, not a substitute for keeping the matching recovery file with a disk backup.

:::caution
If no matching key copy exists, AES-256-GCM encrypted profile data cannot be recovered. A key from another Kurlo installation will not work.
:::

## Recommended routine

1. Use Git-backed workspaces for shared, reviewable API definitions.
2. Create an all-data export before upgrades, migrations, or destructive imports.
3. Keep periodic closed-app backups of the Kurlo data directory.
4. Verify that external workspace repositories are covered by their own backup or remote.
5. Test restore files in a disposable OS profile when the data is business-critical.

See [Privacy & security](/privacy/) for encryption details and [Git-backed workspaces](/docs/guides/git-workspaces/) for repository storage.
