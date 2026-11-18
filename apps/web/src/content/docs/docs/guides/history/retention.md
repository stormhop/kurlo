---
title: "Retention and privacy"
---

## Retention

By default Kurlo keeps:

- **14 days** of history, or
- **1 000 entries** total, whichever comes first.

When you exceed either cap, the oldest entries are pruned the next time the request store is saved. Pruning happens silently in the background; you don't need to clear history manually unless you want to.

These caps aren't exposed in Settings yet — they're constants in the source. If you find yourself wanting longer retention, file a request on GitHub.

## Finding an entry

The filter at the top of the History panel matches URLs and request names, and the status buttons narrow the list to `2xx`, `3xx`, `4xx` or `5xx`. The command palette (`Cmd/Ctrl K`) searches saved requests, not history.

## Privacy & data location

History entries are stored in encrypted `requests.json` with the rest of the local profile. They never leave your machine unless you explicitly include them in an all-data export. If you delete the data directory (see [Privacy](/privacy/)), history goes with it.

When you *Export all data* from Settings, history is included in the JSON export. *Import all data* replaces the entire profile, including history.

## Common questions

**Does history persist across restarts?**
Yes. The entries live in the encrypted `requests.json`. Response bodies are stored separately in `history/`, one file per entry, and encrypted with the same key.

**What about large responses?**
A stored response is capped at 2 MB. Past that only the head is kept, and reopening it says so. The status code, headers, duration, and test results are kept in full.

**What about binary responses?**
History records the status, headers, and size of binary responses. The binary body is excluded.

**Are stored responses cleaned up?**
Yes. A response file is deleted when its entry falls out of the 14-day window, when you delete the entry, and when you clear history.

**Can I disable history?**
Recording is automatic. Use **Delete** on a history entry to remove it, or [clear the profile's history](/docs/guides/history/manage/#bulk-operations).
