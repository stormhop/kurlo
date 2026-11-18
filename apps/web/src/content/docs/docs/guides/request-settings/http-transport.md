---
title: "HTTP transport"
description: "Configure HTTP version, redirects, and server certificate verification."
---

## HTTP version

Choose how Kurlo negotiates the protocol:

| Value | Behaviour |
|-------|-----------|
| `Auto` *(default)* | ALPN negotiates HTTP/2 if both ends support it, otherwise HTTP/1.1. |
| `1.1` | Force HTTP/1.1. Useful when an upstream proxy mishandles HTTP/2. |
| `2` | Require HTTP/2 over TLS. Connect fails if the server doesn't speak it. |

HTTP/3 is not yet supported.

## Redirect policy

By default Kurlo follows up to **10 redirects**. You can change this and decide what to do with them:

- **Follow redirects** — toggle. Off means a 3xx returns the redirect response itself, with the `Location` header visible in the Headers tab.
- **Max redirects** — integer cap. Set to `0` to behave like *Follow off*.
- **Preserve original method** — when on, a 301/302 redirect from `POST` stays `POST` instead of becoming `GET`. RFC 7231 allows the agent to switch the method; this toggle forces the safer "preserve" behaviour.
- **Preserve Authorization header** — by default, redirecting to a different host **drops** the `Authorization` header to avoid leaking credentials. Turn this on if you're following redirects within a trusted multi-host system. Same-host redirects always keep the header.
- **Remove Referer when downgrading** — drop the `Referer` header when redirecting from `https://` to `http://`. Matches browser behaviour.

## TLS / SSL verification

The toggle **Enable SSL certificate verification** is on by default. Turning it off makes Kurlo accept any certificate the server presents, including self-signed and expired ones.

When you disable it, Kurlo shows a one-time confirmation dialog explaining the risk. Re-enabling is one click in the same place.

:::caution
Disabling SSL verification opens you to MITM attacks on that request. Only use it against a server you control or a known-good staging endpoint.
:::

For corporate root CAs, the cleaner fix is to install the CA into your system trust store — Kurlo uses the OS trust roots, so once the CA is trusted system-wide it works in Kurlo too.
