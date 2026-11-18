---
title: "Run a collection with kurlo run"
---

## Quick start

```bash
kurlo run ./my-workspace --env Staging
```

```
✓ GET https://api.example.com/health → 200  42ms  [2/2 tests]
✓ POST https://api.example.com/login → 200  88ms  [1/1 tests]

2 requests, 2 passed, 0 failed · 3/3 assertions · 131ms
```

The first argument is the workspace directory (the folder that contains `kurlo.yml`); it defaults to the current directory, so inside a workspace you can just run `kurlo run --env Staging`.

## What it runs

- **HTTP and GraphQL requests**, in the order they load from the workspace.
- **Pre-request and test scripts** — the same sandboxed JavaScript `pm.*` API as the app. Assertions become the pass/fail signal.
- **Collection defaults** — a collection's auth, headers, scripts, and settings are applied exactly as they are in the app, so a request set to **Inherit auth** authenticates in CI too.
- **Variable chaining**: a value a test writes with `pm.environment.set(...)` is visible to later requests in the same run, so a login step can hand a token to the requests after it.
- **Browser checks**: a request with [browser emulation](/docs/guides/browser-security/) turned on, by itself or through its collection, is sent the way the browser would send it, and a CORS or CSP refusal fails the run. Keep it on for the requests your frontend makes, and CI catches a CORS change before the frontend ships.

A request can keep both JavaScript and Tengo scripts. `kurlo run` runs the JavaScript fields when either is present; the app runs the engine selected in **Settings → General → Script engine**, because the workspace file does not record that choice.

`kurlo run` skips SSE, WebSocket, Socket.IO, gRPC, MCP, and AI requests. Use the [desktop Collection Runner](/docs/guides/collection-runner/) for gRPC. A request whose pre-request script calls `pm.execution.skipRequest()` is reported as skipped and does not fail the run.

Scripts get the same sandbox as the app, including [`pm.crypto` and `CryptoJS`](/docs/reference/scripting-api/crypto/) for request signing. Two capabilities are opt-in because they change what a run can do:

- `pm.sendRequest` needs `--allow-send-request`. Without it, a script that calls it fails, which keeps a CI run from making unannounced HTTP calls.
- Scripts are capped at 2000 ms; raise it with `--script-timeout` when a heavy assertion suite or signing step needs longer.
