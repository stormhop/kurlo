---
title: "Script patterns and limits"
---

## Common patterns

**Chained auth — fetch token in pre-request:** put the login call in a separate request, run it once, persist the token with `pm.environment.set("authToken", ...)`. Downstream requests reference `{{authToken}}`. To do it inline instead, turn on **Allow pm.sendRequest** in the request's Settings tab, call [`pm.sendRequest`](/docs/reference/scripting-api/send-request/) and store the token with `pm.environment.set("authToken", ...)` — a value a pre-request script stores is already used by `{{authToken}}` in the same request.

**Conditional skip:** `pm.execution.skipRequest()` in a pre-request script skips the send. It is reported as a skip rather than a failure, so a conditional request does not fail a run or a CI exit code.

**Schema checks:** `pm.response.to.have.jsonSchema(schema)` validates the body against a JSON Schema. `tv4` and `require("ajv")` are available for collections that were written against those.

**Logging:** `pm.log(...)` writes to the **Scripts** panel. Output is per-request and cleared on next send.

## Limits

- 2-second wall clock per script by default, configurable per request up to 60 seconds.
- A single regular-expression match stops after 2 seconds. A pattern with lookahead or a backreference that backtracks without end, such as `/^(a+)+(?=b)/` on a long string, no longer hangs the app or a CI run. Under the default 2-second script limit the script then fails with a time-out.
- No module imports, process access, filesystem access, or direct network sockets. `require` resolves only [Kurlo's bundled stand-ins](/docs/reference/scripting-api/compatibility/#require) — `lodash`, `ajv`, `tv4`, `uuid`, `crypto-js`, `chai`.
- Scripts make HTTP calls only through `pm.sendRequest`, and only when the request opts in.
- JavaScript supports Postman-style callbacks: `pm.test("status", () => pm.response.to.have.status(200))`.

See the full method reference in [Scripting API](/docs/reference/scripting-api/).
