---
title: Scripting API
description: Full pm.* reference for pre-request and test scripts.
---

Scripts run in a sandboxed JavaScript VM by default. Existing requests can still use the legacy [Tengo](https://github.com/d5/tengo) engine. Both engines expose the same `pm.*` surface for request mutation, response assertions, variables, environments, and logs.

Module imports, process access, and filesystem access are disabled; `require` resolves only the [bundled stand-ins](#require). Network access is disabled too, unless a request opts into [`pm.sendRequest`](#pmsendrequest). Execution is capped at 2 seconds by default — see [Script timeout](#script-timeout).

## `pm.request`

| Method | Description |
|--------|-------------|
| `pm.request.url` | Current request URL (string) |
| `pm.request.method` | HTTP method |
| `pm.request.headers.get(name)` | Get request header |
| `pm.request.headers.set(name, value)` | Set / override header |
| `pm.request.headers.unset(name)` | Remove header |
| `pm.request.params.get(name)` | Get query param |
| `pm.request.params.set(name, value)` | Set query param |
| `pm.request.pathVariables.get(name)` | Get the value of the `:name` path variable |
| `pm.request.pathVariables.set(name, value)` | Set a path variable's value before sending |
| `pm.request.pathVariables.has(name)` | Whether the request has that path variable |
| `pm.request.pathVariables.toObject()` | All enabled path variables as `{ name: value }` |
| `pm.request.set_url(url)` | Override URL before sending |

Header and parameter writes are an upsert, matching Postman: the first row with that name takes the new value, further rows with the same name are dropped, and a name the request does not have is appended. A row the script never names is left exactly as it was written — including two rows that share a name, which is how a repeated query parameter (`?tag=a&tag=b`) or a multi-valued header survives a script untouched.


| `pm.request.body.raw` | Raw request body — readable and writable |
| `pm.request.body.mode` | Body mode, in Postman's names: `raw`, `urlencoded`, `formdata`, `file`, `graphql`, `none` |
| `pm.request.body.json()` | Body parsed as JSON |
| `pm.request.body.update(value)` | Replace the body; objects are stringified |
| `pm.request.body.urlencoded` | Field list — only when the mode is `urlencoded` |
| `pm.request.body.formdata` | Field list — only when the mode is `formdata` |

### Rewriting and signing the body

A pre-request script owns the body it writes: the value it sets is what goes on the wire, and a test script sees the same value afterwards.

```js
const payload = pm.request.body.json()
payload.timestamp = Date.now()
pm.request.body.update(JSON.stringify(payload))

// Sign what will actually be sent
pm.request.headers.set("X-Signature", pm.crypto.hmacSha256(pm.request.body.raw, pm.environment.get("secret")))
```

Two things to know:

- A body written onto a request that has **no body** is sent anyway — Kurlo picks `json` or `text` from the content. The same applies to a **binary** request with no file chosen yet.
- A **binary** body read from a file is left alone. The script never sees those bytes, so it cannot replace them.

### Form and urlencoded bodies

Those two modes are sent from their fields, not from raw text, so they are edited as a list. Writing `.raw` on them changes nothing, and Kurlo says so in the script log instead of dropping the write silently.

```js
// mode === "urlencoded"
pm.request.body.urlencoded.upsert({ key: "grant_type", value: "client_credentials" })
pm.request.body.urlencoded.add({ key: "scope", value: "read write" })
pm.request.body.urlencoded.remove("client_secret")

const fields = pm.request.body.urlencoded.toObject()   // { grant_type: "...", scope: "..." }
```

| Method | Description |
|--------|-------------|
| `.get(key)` / `.one(key)` | The value / the whole field |
| `.has(key)` / `.count()` | Presence / number of fields |
| `.add(field)` | Append `{ key, value, disabled?, type? }` |
| `.upsert(field)` | Replace the field with that key, or append it |
| `.remove(key \| predicate)` | Drop matching fields |
| `.each(fn)` / `.all()` | Iterate / read the whole list |
| `.clear()` / `.toObject()` | Empty the body / read it as an object |

A file field keeps its attachment when a script rewrites its value; `type: "file"` marks it in the list. `pm.request.body.update({ mode: "urlencoded", urlencoded: [...] })` replaces every field at once.

In Tengo the same surface is `pm.request.body`, `pm.request.body_type` (Kurlo's own names, not Postman's), and `pm.request.set_body(value)`. Tengo has no form-field API.

## `pm.response` (test scripts only)

| Method | Description |
|--------|-------------|
| `pm.response.code` | HTTP status code (int) |
| `pm.response.status` | Status string, e.g. `"200 OK"` |
| `pm.response.responseTime` | Duration in milliseconds (alias: `pm.response.time`) |
| `pm.response.size` | Body size in bytes |
| `pm.response.body()` | Raw body as string |
| `pm.response.json()` | Body parsed as JSON (map/array) |
| `pm.response.headers.get(name)` | Get response header (case-insensitive) |

## Variable scopes

`pm.variables`, `pm.globals`, `pm.environment`, and `pm.collectionVariables` all expose the same four methods:

| Method | Description |
|--------|-------------|
| `.get(key)` | Read a variable |
| `.set(key, value)` | Write a variable |
| `.unset(key)` | Delete a variable |
| `.clear()` | Clear all variables |

They differ in which scope they touch:

| Scope | Reads | Writes |
|-------|-------|--------|
| `pm.variables` | All scopes, in precedence order: data row → environment → collection → session | The session scope |
| `pm.globals` | The session scope | The session scope |
| `pm.environment` | The active environment | The active environment |
| `pm.collectionVariables` | The request's collection | The request's collection, saved back to the collection after the send |

Kurlo has a single runtime variable scope, so `pm.globals` and `pm.variables.set` write to the same place — they are aliases, not two separate stores.

**`pm.variables.replaceIn(text)`** fills every `{{name}}` in a string from the scopes above, plus `{{$guid}}` and the other [dynamic variables](/docs/guides/environments/#dynamic-variables) — handy for signing the URL a request will actually hit. A name nothing defines is left as written.

Globals persist. They are saved with your data, survive a restart, and are shared across every workspace. Edit them under **Environments → Globals** in the sidebar; a value a script writes appears there after the send. In [`kurlo run`](/docs/guides/cli-runner/) they come from `--globals` / `--global-var` and can be written back with `--export-globals`.

`pm.collectionVariables.set` persists: after the request finishes, the value is written onto the collection's variables (a Git-backed workspace records it in `collection.yml`). An existing row keeps its id, enabled state, secret flag, and description; only the value changes.

```js
// Cache a value for every later request in the collection.
pm.collectionVariables.set("lastOrderId", pm.response.json().id)
```

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

## `pm.crypto`

Hashing, HMAC, and encoding, for signing requests. Every digest function takes an optional encoding — `"hex"` (default), `"base64"`, `"base64url"`, or `"latin1"`.

| Method | Description |
|--------|-------------|
| `pm.crypto.md5(data, enc?)` | MD5 digest |
| `pm.crypto.sha1 / sha256 / sha384 / sha512(data, enc?)` | SHA digest |
| `pm.crypto.hash(algorithm, data, enc?)` | Digest under a named algorithm |
| `pm.crypto.hmacSha1 / hmacSha256 / hmacSha384 / hmacSha512(data, key, enc?)` | HMAC |
| `pm.crypto.hmac(algorithm, data, key, enc?)` | HMAC under a named algorithm |
| `pm.crypto.base64Encode(data)` / `base64Decode(data)` | Base64 |
| `pm.crypto.randomHex(bytes)` | Random hex string (default 16 bytes) |
| `pm.crypto.uuid()` | Random v4 UUID |

Supported algorithms: `md5`, `sha1`, `sha256`, `sha384`, `sha512`, `sha512-256`. An unknown name throws rather than signing with an empty digest.

```js
// Sign the request the way a partner API expects.
const ts = String(Date.now())
const sig = pm.crypto.hmacSha256(pm.request.method + "\n" + ts, pm.environment.get("apiSecret"))
pm.request.headers.set("X-Timestamp", ts)
pm.request.headers.set("X-Signature", sig)
```

### `CryptoJS`

A `CryptoJS` global is available for compatibility with scripts imported from Postman: `MD5`, `SHA1`, `SHA256`, `SHA384`, `SHA512`, the matching `Hmac*` functions, and `enc.Hex` / `enc.Base64` / `enc.Utf8`. It covers the digest and encoding calls that appear in real collections, not the whole library — for new scripts prefer `pm.crypto`.

```js
const sig = CryptoJS.HmacSHA256("payload", pm.environment.get("secret")).toString()
const b64 = CryptoJS.enc.Base64.stringify(CryptoJS.SHA256("payload"))
```

## `pm.sendRequest`

Makes an HTTP call from a script — for fetching a token before the send, or chaining setup. **Off by default:** turn on **Allow pm.sendRequest** in the request's Settings tab, or pass `--allow-send-request` to [`kurlo run`](/docs/guides/cli-runner/). Without it, the call throws and explains how to enable it.

Both Postman's callback form and a direct return value work; the call is synchronous, so the callback runs immediately rather than on a later tick.

```js
// Callback form — what imported Postman scripts use.
pm.sendRequest({
  method: "POST",
  url: "https://auth.example.com/token",
  header: { "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
}, (err, res) => {
  if (err) throw err
  pm.request.headers.set("Authorization", "Bearer " + res.json().access_token)
})

// Return-value form.
const res = pm.sendRequest("https://api.example.com/health")
pm.test("dependency is up", () => pm.expect(res.code).to.equal(200))
```

The response object mirrors `pm.response`: `.code`, `.status`, `.responseTime`, `.size`, `.text()`, `.json()`, `.headers.get(name)`, and `.to` for assertions.

Limits and deliberate omissions:

- 30 second timeout, 8 MB response cap, at most 5 redirects.
- The call does **not** inherit the parent request's auth, client certificate, or cookie jar, and does not run scripts of its own. It is a plain HTTP request — anything more would be a hidden second request carrying your credentials.
- A non-2xx status is a normal response, not an error; only a transport failure produces one.

## Script timeout

A script is capped at **2000 ms** by default. Raise it per request with **Script timeout** in the Settings tab, or for a whole run with `kurlo run --script-timeout`. The ceiling is 60000 ms, so a runaway loop can never wedge a send or a CI job.

## `pm.iterationData`

| Method | Description |
|--------|-------------|
| `.get(key)` | Read the current data-row value for `key` (read-only) |

During a data-driven run — the [Collection Runner](/docs/guides/collection-runner/) with a data file, or [`kurlo run --data`](/docs/guides/cli-runner/#data-driven-runs) — `pm.iterationData` exposes the current row. It's read-only; outside a data run every key is `undefined`.

```js
pm.test("greets the row's user", () => {
  const body = pm.response.json()
  pm.expect(body.name).to.equal(pm.iterationData.get("name"))
})
```

## Assertions

JavaScript:

```js
pm.test("status is 200", () => pm.response.to.have.status(200))
pm.test("has id", () => pm.expect(pm.response.json()).to.have.property("id"))
```

Tengo:

```js
body := pm.response.json()
pm.test("status is 200", pm.response.code == 200)
pm.test("has id", pm.expect(body).has_key("id"))
```

**`pm.test(name, fnOrResult)`** — register a named assertion. JavaScript accepts a callback or boolean. Tengo accepts a boolean expression.

**`pm.expect(value)`** — chainable assertion builder.

| Chain | Description |
|-------|-------------|
| `.equal(v)` | Strict equality |
| `.not_equal(v)` | Inverse of `equal` |
| `.contains(s)` | Substring or array membership |
| `.exists()` | Not null/undefined |
| `.is_null()` | Strict null check |
| `.greater_than(n)` | `value > n` |
| `.less_than(n)` | `value < n` |
| `.has_key(k)` | Map contains key |
| `.type_of()` | Returns the type as a string (`"string"`, `"int"`, `"map"`, etc.) |

JavaScript also supports Chai-style aliases for the common Postman patterns:

| Chain | Description |
|-------|-------------|
| `.to.equal(v)` | Strict equality |
| `.to.include(v)` | Substring or array membership |
| `.to.have.property(k)` | Object has property |
| `.to.have.all.keys(...k)` | Object has exactly these keys; `.keys` alone means the same |
| `.to.have.any.keys(...k)` | Object has at least one of these keys |
| `.to.be.above(n)` | `value > n` |
| `.to.be.below(n)` | `value < n` |
| `pm.response.to.have.status(code)` | Response status code check |
| `pm.response.to.have.header(name)` | Response carries the header |
| `pm.response.to.have.jsonBody(path?, value?)` | Body is JSON; optionally check a dotted path, optionally its value |
| `pm.response.to.have.jsonSchema(schema)` | Body matches a JSON Schema |

### JSON Schema

`jsonSchema` validates against a draft-07 subset: `type`, `required`, `properties`, `patternProperties`, `additionalProperties`, `items`, `additionalItems`, `enum`, `const`, `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`, `minLength`/`maxLength`/`pattern`, `minItems`/`maxItems`/`uniqueItems`, `minProperties`/`maxProperties`, `allOf`/`anyOf`/`oneOf`/`not`, OpenAPI's `nullable`, and local `$ref` (`#/definitions/…`, `#/$defs/…`).

Not implemented: remote `$ref` (the sandbox has no network) and `format` assertions — Ajv does not check formats by default either.

```js
const schema = {
  type: "object",
  required: ["id", "name"],
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string" }
  }
}
pm.test("body matches the schema", () => pm.response.to.have.jsonSchema(schema))
```

A failure names the path and the reason, for example `/items/1: missing required property "sku"`.

## `require`

JavaScript scripts can `require` a small set of stand-ins so imported Postman collections keep working. These are Kurlo implementations, not the npm packages.

| Module | What you get |
|--------|--------------|
| `lodash` (also `underscore`) | The common collection/object helpers: `get`, `set`, `has`, `pick`, `omit`, `merge`, `cloneDeep`, `map`, `filter`, `find`, `reduce`, `uniq`/`uniqBy`, `groupBy`, `keyBy`, `countBy`, `sortBy`, `chunk`, `flatten`/`flattenDeep`, `difference`, `intersection`, `sum`/`sumBy`, `maxBy`/`minBy`, `range`, `times`, `isEmpty`/`isEqual`/`isNil`, and friends |
| `ajv` | Constructor with `validate(schema, data)`, `compile(schema)`, `errors`, and `errorsText()` |
| `tv4` | `validate(data, schema)`, `validateResult`, `validateMultiple`, `error` |
| `uuid` | `v4()`, `validate(value)` |
| `crypto-js` | The same shim exposed as the `CryptoJS` global |
| `chai` | `{ expect }` |

`_`, `tv4`, `Ajv`, `atob`, and `btoa` are also available as globals, and a script may shadow any of them (`const _ = require("lodash")` works).

Anything outside that list fails with a message naming what was asked for — including an unsupported lodash member, so a missing helper surfaces as `lodash.debounce is not available in Kurlo's script sandbox` rather than a confusing `undefined is not a function`.

## Postman legacy globals

JavaScript scripts written for Postman's older API run unchanged:

| Name | Meaning |
|------|---------|
| `tests["name"] = condition` | Records a test that passes when the value is truthy, alongside `pm.test` results |
| `responseBody`, `responseCode.code`, `responseHeaders`, `responseTime` | The response, in test scripts |
| `postman.setEnvironmentVariable` / `getEnvironmentVariable` / `clearEnvironmentVariable` | Same as `pm.environment` |
| `postman.setGlobalVariable` / `getGlobalVariable` / `clearGlobalVariable` | Same as `pm.globals` |
| `postman.getResponseHeader(name)` | Same as `pm.response.headers.get(name)` |
| `xml2Json(xml)` | Parses XML into an object: attributes under `$`, text beside child elements under `_`, repeated elements as arrays; `null` when the input is not XML |

`postman.setNextRequest` throws, because the Collection Runner always runs requests in their declared order.

## Logging

**`pm.log(...values)`** — prints to the Scripts panel. Accepts any number of arguments, joined with spaces. Useful for debugging — the panel clears on each send.

## Engine notes

- JavaScript is the default engine for new requests and Postman-style scripts.
- Tengo is kept for older requests and teams that already wrote Tengo snippets.
- Both engines use the same variable/environment mutation contract.
- Both engines block module imports and host APIs; only the [bundled `require` stand-ins](#require) resolve. Use `pm.sendRequest`, Kurlo requests, and the Collection Runner for chained HTTP calls.

```js
// blocked in JavaScript
require("fs")
import("node:fs")

// blocked in Tengo
json := import("json")
```
