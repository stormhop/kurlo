---
title: "Proxy and browser emulation"
---

## Proxy

**HTTP proxy** accepts a complete HTTP, HTTPS, or SOCKS5 proxy URL. A non-empty request value overrides both the collection proxy and the app-wide proxy.

Leave the field untouched to inherit the collection setting. If no collection URL applies, Kurlo uses **Settings -> Proxy**. Clearing the field after editing it creates an empty request override, skips the collection value, and falls back to the app-wide setting.

See [Proxy configuration](/docs/guides/proxy/) for the complete precedence and bypass rules.

## Browser security emulation

Use these controls to add a browser-like origin and user agent, enforce CORS preflights and response checks, or block URLs rejected by a page's CSP `connect-src`.

See [Browser security emulation](/docs/guides/browser-security/) for credentials mode, same-origin behavior, supported CSP sources, and protocol differences.
