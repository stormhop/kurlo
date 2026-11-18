---
title: "Cookies and URL encoding"
---

## Cookie jar

The toggle **Use the cookie jar** controls whether `Set-Cookie` responses are stored and replayed:

- **On** (default) — cookies sent in responses are added to the per-workspace cookie jar. On subsequent requests to the same domain, matching cookies are attached automatically.
- **Off** — Kurlo neither stores nor sends jar cookies for this request. You can still set cookies manually via the `Cookie` header.

The jar is shared across all requests in a workspace. View / edit it via the cookie icon at the bottom of the activity rail.

See [Cookies](/docs/guides/cookies/) for manual cookie editing, matching rules, and backup behavior.

## URL encoding

**Encode URL automatically** (on by default) percent-encodes characters in path segments and query values when Kurlo sends the request. Examples:

- A space in a query value (`q=hello world`) becomes `q=hello%20world`.
- Cyrillic / emoji / other non-ASCII characters are encoded per RFC 3986.

Turn this off if your server uses non-standard encoding rules — Kurlo will then transmit your URL byte-for-byte as you typed it.
