---
title: "Connectivity"
---

## "The request timed out" on every request

Check, in order:

1. Can you `curl` the same URL from a terminal on the same machine?
2. Is your VPN / corporate proxy blocking it? See [Proxy setup](/docs/troubleshooting/connectivity/#requests-go-through-a-corporate-proxy).
3. Open *Per-request settings* and bump the timeout to `60000` (60 s). Some upstream services are slow to respond on the first request.

## "TLS handshake failure" / "certificate signed by unknown authority"

Most often a corporate root CA isn't trusted by your OS. Install the CA into your system trust store — Kurlo uses OS trust roots. After installing, restart Kurlo.

If you can't install the CA system-wide, you can disable verification just for the offending request in *Per-request settings → Enable SSL certificate verification* (a confirmation dialog explains the risk). Don't ship a request with this off to a server you don't control.

## Requests go through a corporate proxy

Open **Settings -> Proxy** and choose **System** to use standard environment proxy behavior:

- `HTTP_PROXY` / `HTTPS_PROXY` - proxy URL, optionally with credentials.
- `NO_PROXY` - comma-separated hosts that connect directly.

Alternatively, choose **On** and configure an HTTP, HTTPS, or SOCKS5 proxy directly in Kurlo. A non-empty request or collection proxy URL overrides the global mode.

See [Proxy configuration](/docs/guides/proxy/) for precedence, bypass matching, password persistence, and direct connections.

## DNS resolution fails inside Kurlo but works in browser

Check whether the browser and Kurlo are taking different proxy paths. In System mode, add the hostname to `NO_PROXY`. In custom On mode, add it to **Proxy Bypass**. Use a hostname only, without protocol or port.
