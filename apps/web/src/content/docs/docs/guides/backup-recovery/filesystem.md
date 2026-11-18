---
title: "Filesystem backup"
---

Quit Kurlo before copying its data directory:

| Platform | Default location |
|----------|------------------|
| macOS | `~/Library/Application Support/Kurlo/` |
| Windows | `%APPDATA%\Kurlo\` |
| Linux | `~/.config/Kurlo/` or `$XDG_CONFIG_HOME/Kurlo/` |

Keep at least these files together:

- `requests.json` - encrypted local profile.
- `request-store.key` - matching recovery copy of the encryption key.
- `request-store.key.dpapi` on Windows, when present.
- `request-view.json`, when present - the open tabs and the active request, saved on their own so switching requests does not rewrite `requests.json`. It holds request ids only, and the next full save folds it back into `requests.json`.
- `preferences.json` and the rest of the app-data directory for the most complete local restore.

Back up folder-backed workspaces and cloned Git repositories separately when they live outside the app-data directory.
