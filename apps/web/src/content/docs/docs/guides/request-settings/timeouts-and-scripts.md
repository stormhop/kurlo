---
title: "Timeouts and scripts"
---

## Timeout

**Request timeout (ms)** caps the total time from connection start to body fully read. Default: **30 000 ms** (30 seconds). Set to `0` to wait as long as the server takes — useful for **Send and download** of a large file.

The timeout includes:

- DNS resolution
- TCP connect / TLS handshake
- Request body upload (for `POST` / `PUT`)
- Server processing time
- Full response body read

If the timeout fires, the response shows a friendly error: *"The request timed out after 30 s. Check the URL and try again."* The duration counter still shows how long Kurlo actually waited.

## Script settings

**Script timeout (ms)** caps how long a single pre-request or test script may run. Leave it at `0` for the default **2 000 ms**; raise it for a heavy assertion suite or a signing step. The ceiling is 60 000 ms, so a runaway loop can never wedge a send.

**Allow pm.sendRequest** lets this request's scripts make their own HTTP calls — fetching a token before the send, or chaining setup. It is **off** by default: the script sandbox has no network access unless you ask for it. See [`pm.sendRequest`](/docs/reference/scripting-api/send-request/) for its limits.

Both live under *Collection settings → Settings* as well, and a request that has not touched them inherits the collection's value — in the app and in [`kurlo run`](/docs/guides/cli-runner/) alike. `--script-timeout` and `--allow-send-request` override the whole run.
