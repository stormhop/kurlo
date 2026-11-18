---
title: "Binary responses and previews"
---

## Binary responses

A body that is not text — an image, a PDF, an archive, a font — is not rendered as text. Kurlo inspects the actual bytes rather than trusting `Content-Type`, so a payload mislabelled as `text/html` is still recognised, and shows what it found (the sniffed type and the size) with buttons to open the [preview](/docs/guides/response-viewer/preview/#preview) or save the body to a file.

## Preview

A **Preview** tab appears next to Body when the response is something worth rendering:

- **Images** (PNG, JPEG, GIF, WebP, BMP, AVIF, SVG, ICO) render on a checkerboard with their dimensions and size. An image response opens on this tab automatically, since the raw bytes are meaningless in the text view. An image served as `application/octet-stream` is still detected by sniffing its contents.
- **HTML** renders in a fully sandboxed frame. Scripts do not run and the page cannot reach the network or the app around it, so the preview is safe for a response from any server. It is a rendering aid, not a browser.

Images travel to the viewer through a separate lossless channel, because the response body crosses to the interface as text and binary bytes would not survive intact. Images over 16 MB, and any truncated response, are not previewed.

## Related

- [Per-request settings](/docs/guides/request-settings/) — `httpVersion`, redirect policy, timeout, cookie jar
- [Request types](/docs/guides/request-types/) — GraphQL, SSE, WebSocket, Socket.IO, and gRPC response surfaces
- [Request history](/docs/guides/history/) — find recent requests and responses, with [retention and body limits](/docs/guides/history/retention/)
- [Code snippets](/docs/guides/code-generation/) — copy the request that produced this response in any supported language
- [Response examples](/docs/guides/examples/) — keep a response as a reviewable file, and diff against it later
- [Mock server](/docs/guides/mock-server/) — serve those examples over HTTP
