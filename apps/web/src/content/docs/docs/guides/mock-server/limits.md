---
title: "Mock server scope and limits"
---

## Scope and safety

- **Loopback only.** The server binds `127.0.0.1`, never `0.0.0.0`. A mock built from real recorded responses — which may still hold data from a live system — is not something to put on the network by accident.
- **CORS is answered for pages served from this machine** — any `localhost`, `127.0.0.1` or `::1` origin on any port — because the first client to hit a mock is usually a browser app running on another port. A page served from anywhere else gets a `403` and no CORS headers: the mock replays responses recorded from real APIs, and a site you happen to have open should not be able to read them. The refusal is listed in the request log with the origin that was turned away.
- **One server at a time.** Starting it for a different collection switches it over; the panel says so before you do.
- **It stops when Kurlo quits.** There is no background daemon.

If the port is taken, Kurlo says so rather than failing silently — pick another one in the panel.

## What it does not do

- It does not fall through to the real API for unmatched requests.
- It does not template responses: what was captured is what is served, byte for byte.
- It does not serve HTTPS, and it does not match on the request body.

If you need any of those, [open an issue](https://github.com/stormhop/kurlo/issues) — they are all extensions of the same matching, not rewrites of it.
