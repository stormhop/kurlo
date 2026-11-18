---
title: "Browser origin and credentials"
---

## Browser origin

Enter the page origin that would initiate the request:

```text
http://localhost:5173
https://app.example.com
```

Kurlo accepts `http://`, `https://`, or the special CORS origin `null`. It normalizes host casing and removes default ports. CORS and CSP checks require an origin even if **Browser request emulation** itself is off.

For CSP checks, use an HTTP or HTTPS origin; `null` cannot act as the protected page origin.

## Request emulation

**Browser request emulation** sends a browser-like `User-Agent`, the configured `Origin`, and fetch metadata:

- HTTP and SSE requests receive `Sec-Fetch-Dest`, `Sec-Fetch-Mode`, and `Sec-Fetch-Site`.
- WebSocket and Socket.IO handshakes send `Origin` but do not add fetch metadata headers.
- Same-origin and cross-origin status is calculated from scheme, hostname, and effective port.

Enabling CORS or CSP checks also activates the browser-like user agent and origin handling.

## Credentials mode

**Include browser credentials** controls cross-origin cookie behavior and CORS validation:

- Off: Kurlo suppresses cookie-jar cookies on an active cross-origin browser-security request.
- On: cookies may be sent according to the normal cookie-jar rules, and CORS requires `Access-Control-Allow-Credentials: true`.

With credentials enabled, `Access-Control-Allow-Origin: *` is rejected; the server must return the exact emulated origin.

This option does not enable the cookie jar by itself. The request's **Disable cookie jar** setting still wins.
