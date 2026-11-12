---
title: Scripting
description: Pre-request and test scripts in JavaScript or Tengo — inject headers, assert responses, set variables.
---

Kurlo scripts run in a sandboxed JavaScript VM by default. Existing requests can still use the legacy [Tengo](https://github.com/d5/tengo) engine. Both engines expose the same `pm.*` API and execution caps at **2 seconds**.

There are two script hooks per request:

- **Pre-request** — runs after variable substitution, before the wire send. Use it to inject auth, set query params, log inputs.
- **Tests** — runs after the response is received. Use it to assert and to extract values for chained requests.

Collection variables set or removed in a pre-request script are available to the test script of the same request.

![Pre-request JavaScript in the request Scripts tab](../../../../assets/screenshots/scripting-pre-request.png)

![Legacy Tengo pre-request script in the request Scripts tab](../../../../assets/screenshots/scripting-tengo.png)

## Anatomy of a pre-request script

```js
// Set a trace header for every request
pm.request.headers.set("X-Trace", "kurlo-" + pm.variables.get("runId"))

// Override the URL conditionally
if (pm.environment.get("region") === "eu") {
  pm.request.set_url("https://eu.api.example.com" + pm.request.url)
}
```

## Anatomy of a test script

```js
pm.test("status is 200", () => pm.response.to.have.status(200))
pm.test("response under 500ms", () => pm.expect(pm.response.responseTime).to.be.below(500))

const body = pm.response.json()
pm.test("has user id", () => pm.expect(body.user).to.have.property("id"))
pm.test("role is admin", () => pm.expect(body.user.role).to.equal("admin"))

// Persist for downstream requests
pm.environment.set("userId", body.user.id)
pm.log("captured userId:", body.user.id)
```

Test results appear in the response **Scripts** panel with pass/fail counts.

## Assertions

For checks that need no code, open **Scripts → Assertions** on an HTTP or GraphQL request. Each row is a target, a check and the expected value. The **Add** row inserts common ones: status 200, a 2xx status, a response faster than one second, a JSON content type and a field that exists.

![Three assertions on the status, the content type and the length of a JSON array](../../../../assets/screenshots/request-assertions.png)

| Target | What it reads |
|--------|---------------|
| `status` | The status code, such as `201`. |
| `responseTime` | Total time in milliseconds. |
| `size` | Body size in bytes. |
| `header.<Name>` | A response header, matched without regard to case. |
| `body` | The whole body: parsed JSON, or the text when the body is not JSON. |
| `body.<path>` or `$.<path>` | A value inside a JSON body: `body.data.id`, `body.items[0].sku`, `body.items[-1]` for the last item, `body["key with spaces"]`. Filters and wildcards are not supported; use a test script for those. |

Checks: **equals**, **does not equal**, **is greater than**, **is at least**, **is less than**, **is at most**, **is one of** and **is not one of** (a list such as `200, 201` or `[200, 201]`), **contains** and **does not contain** (text, an array item or an object key), **matches regex**, **exists**, **does not exist**, **is of type** (`string`, `number`, `boolean`, `object`, `array` or `null`) and **has length** (of text, an array or an object).

The expected value is read as JSON when it is valid JSON, so `201`, `true`, `null` and `{"a": 1}` compare as values, and as text otherwise. Numbers compare exactly, including integers larger than JavaScript can hold. Header values are always text. `{{variables}}` work in both the target and the expected value.

Assertions run after the test script and show up next to its tests, named after the check, such as `status equals 201`, with the reason when one fails, such as `got 404`. A failed or skipped request fails every assertion. The same results count in the collection runner, in `kurlo run` (and its JUnit report) and in `kurlo mcp`. Untick a row to keep it without running it. A request can have up to 200 assertions; the add buttons turn off at the limit. A request file written by hand with more keeps all of them, and they all run.

Assertions are saved in the request file as `assertions`. A Postman export turns them into `pm.test` code so Postman runs the same checks; importing that export back into Kurlo restores the rows without doubling the tests. Insomnia and OpenCollection exports leave them out.

## Snippets

The **Snippets** row above the editor inserts working code at the end of the current script — setting a variable, adding a header, editing or signing the body, asserting a status, checking a JSON schema. The list follows the active engine, so Tengo requests get Tengo snippets. Hovering a snippet shows the code it will insert.

## Building the request body

A pre-request script can read and rewrite the body that goes on the wire, which is what request signing needs:

```js
const payload = pm.request.body.json()
payload.nonce = pm.crypto.randomHex(8)
pm.request.body.update(JSON.stringify(payload))
pm.request.headers.set("X-Signature", pm.crypto.hmacSha256(pm.request.body.raw, pm.environment.get("secret")))
```

See [`pm.request.body`](/docs/reference/scripting-api/#pmrequest) for the details, including how binary file bodies behave.

## Common patterns

**Chained auth — fetch token in pre-request:** put the login call in a separate request, run it once, persist the token with `pm.environment.set("authToken", ...)`. Downstream requests reference `{{authToken}}`. To do it inline instead, turn on **Allow pm.sendRequest** in the request's Settings tab, call [`pm.sendRequest`](/docs/reference/scripting-api/#pmsendrequest) and store the token with `pm.environment.set("authToken", ...)` — a value a pre-request script stores is already used by `{{authToken}}` in the same request.

**Conditional skip:** `pm.execution.skipRequest()` in a pre-request script skips the send. It is reported as a skip rather than a failure, so a conditional request does not fail a run or a CI exit code.

**Schema checks:** `pm.response.to.have.jsonSchema(schema)` validates the body against a JSON Schema. `tv4` and `require("ajv")` are available for collections that were written against those.

**Logging:** `pm.log(...)` writes to the **Scripts** panel. Output is per-request and cleared on next send.

## Limits

- 2-second wall clock per script by default, configurable per request up to 60 seconds.
- No module imports, process access, filesystem access, or direct network sockets. `require` resolves only [Kurlo's bundled stand-ins](/docs/reference/scripting-api/#require) — `lodash`, `ajv`, `tv4`, `uuid`, `crypto-js`, `chai`.
- Scripts make HTTP calls only through `pm.sendRequest`, and only when the request opts in.
- Tengo uses expression-style assertions: `pm.test("status", pm.response.code == 200)`.
- JavaScript supports Postman-style callbacks: `pm.test("status", () => pm.response.to.have.status(200))`.

See the full method reference in [Scripting API](/docs/reference/scripting-api/).
