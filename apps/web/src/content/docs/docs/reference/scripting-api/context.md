---
title: "Run context and cookies"
---

## `pm.info`

Read-only facts about the current run.

| Property | Description |
|----------|-------------|
| `pm.info.requestName` | The request's name |
| `pm.info.eventName` | `"prerequest"` or `"test"` |
| `pm.info.iteration` | Current iteration (1-based) |
| `pm.info.iterationCount` | Total iterations in this run |

## `pm.cookies`

Read-only access to the cookies the request's jar would send for this URL. Domain, path, and `Secure` matching is already applied.

| Method | Description |
|--------|-------------|
| `pm.cookies.get(name)` | Cookie value, or `undefined` |
| `pm.cookies.has(name)` | Whether the cookie is present |
| `pm.cookies.names()` | Array of cookie names |

## `pm.execution.skipRequest()`

Called from a **pre-request** script, skips the send entirely. The request is reported as skipped rather than failed, so a conditional request does not fail a collection run or a `kurlo run` exit code. Calling it from a test script does nothing — the response already exists.

```js
// Only hit the billing API when the environment opts in.
if (pm.environment.get("mode") !== "live") pm.execution.skipRequest()
```
