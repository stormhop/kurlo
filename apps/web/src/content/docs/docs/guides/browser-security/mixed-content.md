---
title: "Mixed content and local networks"
---

## Mixed content

A page served over HTTPS may not fetch `http://` URLs or open `ws://` sockets. The exceptions are targets a browser already trusts — `localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]` — and, under Local Network Access, private IP literals such as `192.168.1.20` and `.local` names.

When **Enforce CORS** or **Enforce CSP connect-src** is on, Kurlo blocks a mixed-content request before it opens a connection, and checks redirect targets the same way. With only **Browser request emulation** on, it sends the request and adds a warning.

## Local Network Access

Chrome treats a request from a page to an address that is *less public* than the page's own as a local network request. The address spaces, from most to least public, are public, local network (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16`, `fc00::/7`, `fe80::/10`, and `.local` names) and loopback (`127.0.0.0/8`, `::1`, `localhost`).

Kurlo classifies the target by the address it actually connected to, so a public name that resolves to a private address counts. Through a proxy only the URL itself can be judged. The page's space comes from the origin you entered: an IP literal, `localhost` or `.local`, and public otherwise.

For such a request Kurlo adds a warning to the response instead of blocking it, because the outcome depends on the person using the page:

- From an HTTPS page, Chrome first asks the user for permission to reach devices on the local network, and the request fails if they decline.
- From an HTTP page on a public or local origin, Chrome refuses the request: local network access is only available to secure contexts.

A page on `localhost` may reach any address. WebSocket and Socket.IO handshakes are not checked, because Chrome does not gate them yet. The older Private Network Access preflight (`Access-Control-Request-Private-Network`) is not sent; Chrome replaced it with the permission prompt.

## Recommended workflow

1. Send the request with browser security disabled to verify basic connectivity.
2. Enter the frontend page origin and enable request emulation.
3. Enable CORS and fix server response headers until the request passes.
4. Paste the deployed page policy and enable CSP.
5. Turn on credentials only if frontend code intentionally sends cookies across origins.

## In CI and for AI assistants

[`kurlo run`](/docs/guides/cli-runner/) and [`kurlo mcp`](/docs/guides/mcp-server/) honor the same settings, saved on a request or inherited from its collection. A run fails on a request the browser would refuse, so a CORS change breaks the build before it breaks the frontend. An assistant can also check any call against an origin with the `browserOrigin` argument of `run_request` and `send_request`.

For cookie storage and domain matching, see [Cookies](/docs/guides/cookies/).
