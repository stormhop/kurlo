---
title: "Browser emulation and privacy"
---

## Browser emulation and CORS

Browser request emulation can apply Origin, user-agent, CORS, and CSP checks, but it does not move cookies into a browser. Cookies remain in Kurlo's local jar and follow Kurlo's request settings.

If **Browser request emulation** and **Use the cookie jar** are both on, the request preview shows which headers come from emulation and which cookie header comes from the jar.

## Backup and privacy

Cookies are included in all-data backups and in the encrypted local request store. Collection exports do not include the runtime cookie jar.

Cookie sync adds one local surface: a loopback-only HTTP listener, off unless you turn it on,
reachable only with the pairing token. The token and the sync allowlist live in
`preferences.json` next to the request store, with the token encrypted by the same key as the
store; no cookie leaves the machine, and the browser extension talks to `127.0.0.1` and nothing else.

If you need to remove sensitive cookies, clear them from the cookie page or clear request history/all data from Settings.
