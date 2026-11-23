---
title: "Reading the response body"
---

## Body view

The body view auto-detects how to render the payload:

![JSON response with status, timing, test count, and line numbers](../../../../../assets/screenshots/response-viewer-json.png)

- **JSON** — syntax-highlighted, two-space indent, line numbers in the gutter. Objects and arrays can be folded.
- **HTML** / **XML** — indented and syntax-highlighted with line numbers. Elements can be folded.
- **Plain text or no `Content-Type`** — if the body is valid JSON, or looks like XML or HTML, Kurlo formats it that way. Anything else is shown verbatim.
- **Binary or `application/octet-stream`** — Kurlo shows the detected type and size. Click **Preview** for a supported format or **Save to file** to keep the body.
- **Server-Sent Events (`text/event-stream`)** — Kurlo switches automatically to the SSE panel with streamed event rows.
- **WebSocket / Socket.IO / gRPC** — realtime and RPC requests use dedicated response surfaces for frames, events, metadata, status, and logs.

## Choosing a format

The format menu next to the response actions shows **Auto** and the format Kurlo detected, for example **Auto · JSON**. Choose **JSON**, **XML**, **HTML** or **Text** to override it for the current request, for example when an API returns JSON as `text/plain` or you want to see the unformatted body. Kurlo keeps the choice for that request until you close its tab or choose **Auto** again.

If the body is not valid in the chosen format, Kurlo shows it as text with a note above it. The format menu is not shown for binary bodies or for responses larger than 10 MB, which are paged as text. When a body is shown as JSON, you can filter it with JSONPath, and **Save to file** suggests the matching extension.

## Folding

Hover over the body to see an arrow next to the line number of each JSON object or array and each XML or HTML element that spans several lines. Click it to fold the block into one line, such as `"customer": {⋯},`. Click the arrow or the `⋯` marker to unfold it.

**Fold all** next to the response actions folds every block below the top level, so you can open the structure one level at a time. When anything is folded, the same button shows **Unfold all**. Line numbers keep their original values, so you can see how many lines a folded block hides.

Search also looks inside folded blocks and unfolds the block that holds the current match. Plain-text responses cannot be folded. Folds reset when a new response arrives or you change the format.

## Wrapping long lines

Long lines wrap to the width of the panel by default. Click **Wrap lines** next to the response actions to keep each line on one row and scroll sideways instead, which helps with long tokens or minified fields. Kurlo remembers the choice. Very large responses that Kurlo renders on demand always keep lines on one row.
