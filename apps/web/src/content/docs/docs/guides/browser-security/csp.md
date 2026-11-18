---
title: "Enforce CSP connect-src"
---

Paste the page's `Content-Security-Policy` value and enable **Enforce CSP connect-src**. Kurlo checks the target before opening the network connection and checks redirect targets as they are followed.

Kurlo uses `connect-src` when present and otherwise falls back to `default-src`. If neither directive exists, this check does not block the request.

Supported source matching includes:

- `'self'` and `'none'`
- `*`
- Explicit schemes such as `https:`
- Hosts, ports, and wildcard subdomains
- HTTP-to-HTTPS and WS-to-WSS upgrades allowed by the implemented source rules

This is focused `connect-src` emulation, not a complete browser CSP engine. Directives unrelated to network connections are ignored.
