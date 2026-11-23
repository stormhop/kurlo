---
title: "Headers and timeline"
---

## Headers view

Switch to the *Headers* tab to see the response headers exactly as the server sent them. They're listed in the order the server emitted them — for `Set-Cookie` and other headers that can repeat, each occurrence has its own row.

Hover any value to reveal a copy button. The header table is plain text — you can also select-and-copy with your usual editor shortcuts.

## Cookies view

When the response sets cookies, a *Cookies* tab appears next to *Headers* with the number of cookies. Each `Set-Cookie` header becomes a row with the cookie's name, value, domain, path, expiry and attributes such as `HttpOnly`, `Secure` and `SameSite`. A cookie without `Domain` is marked **Host only**, one without `Expires` or `Max-Age` lasts for the **Session**, and one whose expiry has passed is marked **Expired**, which is how servers delete cookies. To see the cookies Kurlo keeps between requests, open [Cookies](/docs/guides/cookies/) in the sidebar.

## Timeline view

The *Timeline* tab appears once a response carries connection details. It answers "where did the time go, and what did Kurlo actually send?".

- **Timeline** — connection requested, DNS lookup, TCP connect, TLS handshake, request sent, and first response byte, each stamped in milliseconds from the start of the send.
- **Connection** — whether the connection was newly opened or reused from the pool, the local and remote addresses, every resolved address, and the negotiated TLS version, cipher suite, ALPN protocol, and SNI server name.
- **Request** — the request line and headers as they went on the wire, after auth, cookie jar, and redirect handling. A redirect chain shows one block per hop, so you can see exactly what was re-sent and what was dropped.

Secret environment values are masked here the same way they are in script logs, so the panel is safe to screenshot.

A failed request keeps its timeline: when a connection times out or a TLS handshake fails, the last event tells you how far it got.
