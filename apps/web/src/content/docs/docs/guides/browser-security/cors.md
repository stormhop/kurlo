---
title: "Enforce CORS"
---

For cross-origin HTTP requests, **Enforce CORS** validates the response as a browser would.

For standard HTTP requests, Kurlo sends an `OPTIONS` preflight when the method or request headers are not CORS-safelisted. Safelisting looks at the value as well as the name, as the Fetch standard does:

- `Accept`, `Accept-Language`, `Content-Language`, `Content-Type` and `Range` are the only safelisted names, and each value must be 128 bytes or shorter.
- No value may contain `"`, `(`, `)`, `:`, `<`, `>`, `?`, `@`, `[`, `\`, `]`, `{`, `}` or a control character.
- `Accept-Language` and `Content-Language` allow only letters, digits, space and `*,-.;=`.
- `Content-Type` must be `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`.
- `Range` must be a single `bytes=N-` or `bytes=N-M`; a suffix range such as `bytes=-500` needs a preflight.
- When the safelisted values add up to more than 1 KB, all of them need a preflight.

The timeline shows separate preflight start and finish events. Request timings exclude the preflight.

The preflight:

- Does not include cookie-jar cookies.
- Does not follow redirects.
- Validates the 2xx status, allowed origin, method, headers, and credential rules.
- Honors `Access-Control-Max-Age`, capped at five minutes.

The actual response must also pass the origin and credential checks. Same-origin requests skip CORS enforcement.

## Redirects

Kurlo follows redirects the way a browser does in `cors` mode, checking every hop:

- A redirect response from a cross-origin server must pass the same origin and credential checks before Kurlo follows it.
- A request that starts same-origin becomes a CORS request as soon as a redirect leaves the page's origin, and stays one for the rest of the chain.
- A non-simple request is preflighted again at each new cross-origin target.
- When the chain moves from one cross origin to another, the `Origin` header becomes `null`, and the target must allow `null` or `*`.
- `Authorization` is removed whenever the origin changes, whatever the redirect settings say.
- Without **Include browser credentials**, cookies stop being sent and stored once the chain has left the page's origin.
- A `Location` with a username or password in it is refused.
- `Sec-Fetch-Site` stays `cross-site` once any URL in the chain was cross-origin.
- A `301` or `302` turns only `POST` into `GET`; a `303` turns everything but `GET` and `HEAD` into `GET` and drops `Content-Type` with the body.

## Headers hidden from page code

A browser hands page script only part of a cross-origin response: `Cache-Control`, `Content-Language`, `Content-Length`, `Content-Type`, `Expires`, `Last-Modified`, `Pragma`, and the headers the server lists in `Access-Control-Expose-Headers`. `Access-Control-Expose-Headers: *` exposes the rest, but not for a credentialed request, where `*` is just a header name. `Set-Cookie` is never exposed.

With **Enforce CORS** on, the response's Headers tab marks every other header *hidden from page*. They are still shown, and test scripts still see them, so a script can assert on `Access-Control-Allow-Origin`; the mark is there to explain why `response.headers.get("X-Total-Count")` returns `null` in the browser.

SSE validates the actual cross-origin response and follows the redirect rules above but does not run the separate preflight path. WebSocket and Socket.IO settings expose origin/CSP emulation but not browser CORS enforcement; browsers apply their handshake-origin rules instead of Fetch CORS preflights.

Common failures include:

- Missing or duplicate `Access-Control-Allow-Origin`.
- A different allowed origin than the one configured in Kurlo.
- Wildcard origin on a credentialed request.
- Missing method or header permission in the preflight response.
- `Authorization` covered only by a wildcard header rule; it must be named explicitly.
