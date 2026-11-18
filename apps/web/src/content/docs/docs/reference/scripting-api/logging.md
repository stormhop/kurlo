---
title: "Logging and engine notes"
---

## Logging

**`pm.log(...values)`** — prints to the Scripts panel. Accepts any number of arguments, joined with spaces. Useful for debugging — the panel clears on each send.

`console.log`, `console.info` and `console.debug` print the same way. `console.warn` lines are shown in amber and `console.error` lines in red, and `kurlo run` prints them with a `[warn]` or `[error]` prefix.

Every [`pm.sendRequest`](/docs/reference/scripting-api/send-request/) call adds a line of its own: the method, URL, status and time, or the reason it failed. A 4xx or 5xx answer is shown as a warning, so a rejected token call is visible without logging it yourself.

When a script throws, the response shows a red banner with the error above the body, and the **Scripts** tab shows how many errors there were. **Open Scripts** in the banner jumps to the full output. A failing pre-request script stops the send; the output then appears under **Could not send request**, and so it does after a network error.

Each script keeps its first 200 log lines; when it prints more, the last line says how many were left out. A line longer than 600 characters or 8 lines shows a preview with **Show all** and its size, so a logged response body does not fill the panel. Line breaks are kept, so `JSON.stringify(value, null, 2)` prints indented.

## Engine notes

- JavaScript is the default engine for new requests and Postman-style scripts.
- Tengo is kept for older requests and teams that already wrote Tengo snippets.
- Both engines use the same variable/environment mutation contract.
- Both engines block module imports and host APIs; only the [bundled `require` stand-ins](/docs/reference/scripting-api/compatibility/#require) resolve. Use `pm.sendRequest`, Kurlo requests, and the Collection Runner for chained HTTP calls.

```js
// blocked in JavaScript
require("fs")
import("node:fs")

// blocked in Tengo
json := import("json")
```
