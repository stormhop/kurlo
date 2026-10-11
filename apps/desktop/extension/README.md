# Kurlo Cookie Sync extension

Pushes browser cookies into Kurlo's per-workspace cookie jar, so a request you send
from Kurlo carries the same session your browser has.

Nothing is read until three things line up:

1. **Kurlo is listening.** Cookie jar → **Sync Cookies** → *Turn on*. Kurlo opens a bridge
   on `127.0.0.1` (ports 3199–3203 are the ones this extension scans).
2. **You let this browser in.** Press **Connect**; Kurlo shows the request with a six-digit
   code and this popup shows the same code. Approve it in Kurlo only if the numbers match.
   Kurlo then hands over a token, and the extension reconnects on its own from then on.
3. **The domain is allowlisted twice.** Kurlo only accepts cookies for the domains listed in
   the Sync Cookies tab, and the browser only lets the extension read domains you grant in
   the popup. A domain missing from either list is never read and never sent.

Cookies flow one way: browser → Kurlo.

## Install

The extension ships with Kurlo. In Kurlo, open **Cookies → Sync cookies → Browser extension**
and pick your browser: Kurlo writes the extension, with its own version in the manifest, to a
folder in its data directory and opens it.

- **Chrome, Edge, Brave:** `chrome://extensions` → **Developer mode** → **Load unpacked** →
  pick that folder.
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
  `manifest.json` in that folder. Kurlo writes the Firefox event-page manifest there for you.

Kurlo rewrites the folder on start-up after an update, so the browser picks up the new
version when it restarts or when you press **Reload**. Releases also attach
`kurlo-cookie-sync-<version>-chromium.zip` and `-firefox.zip`
(`scripts/package-browser-extension.py`).

For development, load this folder itself unpacked (Chromium), or copy
`manifest.firefox.json` over `manifest.json` in a scratch copy for Firefox. `embed.go` is
how the app bundles these files; browsers ignore it.

## How it talks to Kurlo

| Step | Call |
|---|---|
| Find the bridge | `GET /discover` on each candidate port |
| Ask to connect | `POST /pair` → `{requestId, code}` |
| Wait for approval | `GET /pair?requestId=…` → `pending` / `approved` + token / `denied` / `expired` |
| Stream | `ws://127.0.0.1:<port>/ws?token=…` |

Over the socket, Kurlo sends `hello` and `domains` (the allowlist), and the extension sends:

```json
{ "type": "change", "removed": false, "cause": "explicit", "cookie": { "name": "session", "domain": ".example.com", "…": "…" } }
```

for each cookie the browser changes, and

```json
{ "type": "snapshot", "domains": ["example.com"], "cookies": [ … ] }
```

on connect, every five minutes, and on **Sync now**. `domains` lists only the domains this
browser could actually read — Kurlo treats a snapshot as authoritative and clears cookies
missing from it, so an unreadable domain is left out rather than reported as empty.

An app-level `ping` every 20 seconds keeps the MV3 service worker alive while the socket is
open; a `chrome.alarms` timer reconnects it if the worker is evicted anyway.

Kurlo closes the socket with a code that says what to do next: `1008` means this browser was
disconnected on purpose, so the extension drops its token and asks to connect again, while
`1001` means Kurlo is shutting down and the token stays. A socket that never opens while
`/discover` still answers is treated the same as `1008` — that is a token Kurlo no longer
accepts.

## Testing it

`make test-extension` loads this folder into a real headless Chromium, points it at a Kurlo
bridge started by the Go test, and walks the whole path: discovery, the approval handshake,
a cookie set in the browser arriving in the jar, a cookie cleared in the browser leaving it,
and — after Kurlo disconnects the browser — the extension pairing again by itself. The test
copies the extension to a temp directory and moves the test domain into `host_permissions`,
since a headless browser cannot answer the optional-permission prompt; everything else runs
against these files unchanged.

## Privacy

- The bridge is loopback-only; no cookie leaves the machine.
- Kurlo answers extension origins only — a web page probing the port gets a `403`.
- No token exists until you approve the request in Kurlo, and it is only ever sent to
  `127.0.0.1`.
- **Disconnect it** in Kurlo revokes this browser immediately; **Forget** here drops the
  token and the cached allowlist.
- Host access is requested per domain (`*://*.example.com/*`), never for all sites.
