---
title: "pm.sendRequest"
---

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

Options follow Postman's request format:

| Option | Accepted forms |
|---|---|
| `url` | A string, or an object with `raw` |
| `header` (or `headers`) | An object, an array of `{ key, value, disabled }`, an array of `"Name: value"` strings, or one `"Name: value"` string with one header per line. Disabled entries are skipped. |
| `body` | A string, or `{ mode, … }` with `raw`, `urlencoded`, `formdata` or `graphql`. A plain object is sent as JSON. |

Kurlo sets `Content-Type` from the body when you do not set it yourself:

| Body | `Content-Type` |
|---|---|
| `{ mode: "raw", options: { raw: { language: "json" } } }` | `application/json` (`xml`, `html`, `javascript` and `text` map the same way) |
| `{ mode: "urlencoded", urlencoded: [{ key, value }] }` | `application/x-www-form-urlencoded`; the fields are URL-encoded |
| `{ mode: "formdata", formdata: [{ key, value }] }` | `multipart/form-data` with a generated boundary, always; text fields only |
| `{ mode: "graphql", graphql: { query, variables } }` | `application/json` |
| A plain object | `application/json` |

```js
pm.sendRequest({
  url: "https://auth.example.com/token",
  method: "POST",
  body: {
    mode: "urlencoded",
    urlencoded: [
      { key: "grant_type", value: "password" },
      { key: "username", value: pm.environment.get("user") },
    ],
  },
}, (err, res) => pm.environment.set("token", res.json().access_token))
```

The response object mirrors `pm.response`: `.code`, `.status`, `.responseTime`, `.size`, `.text()`, `.json()`, `.headers.get(name)`, and `.to` for assertions.

Limits and deliberate omissions:

- 30 second timeout, 8 MB response cap, at most 5 redirects.
- The call does **not** inherit the parent request's auth or cookie jar, and does not run scripts of its own. It does use the request's transport settings: proxy, TLS verification, and client certificate. Anything more would be a hidden second request carrying your credentials.
- A non-2xx status is a normal response, not an error; only a transport failure produces one.
- File bodies (`mode: "file"`) and file fields in `formdata` are not supported; the call throws and says so.

## Script timeout

A script is capped at **2000 ms** by default. Raise it per request with **Script timeout** in the Settings tab, or for a whole run with `kurlo run --script-timeout`. The ceiling is 60000 ms, so a runaway loop can never wedge a send or a CI job. The same cap bounds a [`pm.sendRequest`](/docs/reference/scripting-api/send-request/) call: a call that would run past the script deadline is canceled at that deadline.

## `pm.iterationData`

| Method | Description |
|--------|-------------|
| `.get(key)` | Read the current data-row value for `key` (read-only) |

During a data-driven run — the [Collection Runner](/docs/guides/collection-runner/) with a data file, or [`kurlo run --data`](/docs/guides/cli-runner/data/#data-driven-runs) — `pm.iterationData` exposes the current row. It's read-only; outside a data run every key is `undefined`.

```js
pm.test("greets the row's user", () => {
  const body = pm.response.json()
  pm.expect(body.name).to.equal(pm.iterationData.get("name"))
})
```
