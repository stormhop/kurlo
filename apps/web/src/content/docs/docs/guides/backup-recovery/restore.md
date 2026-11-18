---
title: "Restore an all-data export"
---

1. Export the current profile first if it is still usable.
2. Open **Settings -> General -> Data -> Import all data**.
3. Select a Kurlo backup JSON file.
4. Confirm the replacement.
5. Re-enter the global proxy password and reconnect any external workspace paths if needed.

Import replaces the local workspaces, collections, requests, environments, history, and cookies in the current profile. It is not a merge operation.

For cross-machine migration, the all-data export is usually safer than copying encrypted files because it does not depend on an OS credential-store entry.
