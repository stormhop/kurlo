---
title: "Response status"
---

## The status bar

The thin row at the top of the response panel summarizes the result:

- **HTTP status** — `200 OK`, `404 Not Found`, etc. Colour-coded by class: green for 2xx, yellow for 3xx, orange for 4xx, red for 5xx and transport errors.
- **Duration** — total time from request build to body fully read, in milliseconds. Hover the duration pill to see a timing breakdown (DNS, TCP connect, TLS handshake, time-to-first-byte, body read).
- **Size** — uncompressed body size. For [paged responses](/docs/guides/response-viewer/large-responses/), this is the size of the whole payload.

Click **Save to file** (the download arrow) to write the body to a file. Click **Copy response** to copy it to the clipboard.
