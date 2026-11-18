---
title: "pm.request"
---

| Method | Description |
|--------|-------------|
| `pm.request.url` | Current request URL (string) |
| `pm.request.method` | HTTP method |
| `pm.request.auth` | Effective authentication details for JavaScript scripts |
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

## Reading request authentication

JavaScript pre-request and test scripts can read the active authentication method for HTTP, GraphQL, and gRPC requests. This includes auth inherited from the collection or folder. Template values are resolved for the current request.

```js
const auth = pm.request.auth
if (auth.type === "bearer") {
  const token = auth.bearer.get("token")
  pm.expect(token).to.be.a("string")
}
```

`auth.parameters()` returns the active method's parameter list. For example, `auth.parameters().get("username")` reads a Basic username, and `auth.apikey.get("in")` reads an API key's location. Use `.has(key)` to check for a parameter and `.toObject()` to read the list as key-value pairs. With **No Auth**, `auth.type` is `"noauth"` and the list is empty. The auth object is read-only.

## Rewriting and signing the body

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

## Form and urlencoded bodies

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
