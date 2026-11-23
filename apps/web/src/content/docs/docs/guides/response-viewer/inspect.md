---
title: "Response status"
---

## The status bar

The thin row at the top of the response panel summarizes the result:

- **HTTP status** — `200 OK`, `404 Not Found`, etc. Colour-coded by class: green for 2xx, yellow for 3xx, orange for 4xx, red for 5xx and transport errors. Hover the status to read what the code means and what usually causes it, for example that some servers answer `404` instead of `401` or `403` to hide a private resource.
- **Duration** — total time from request build to body fully read, in milliseconds. Hover the duration pill to see a timing breakdown (DNS, TCP connect, TLS handshake, time-to-first-byte, body read).
- **Size** — uncompressed body size. For [paged responses](/docs/guides/response-viewer/large-responses/), this is the size of the whole payload. Hover it to see the size of the headers and the body. When the server compressed the body, for example with `gzip` or `br`, Kurlo also shows the compressed size it received, and the total uses that size.

Click **Save to file** (the download arrow) to write the body to a file. Click **Copy response** to copy it to the clipboard.
