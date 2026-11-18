---
title: "Build a request body"
---

## Building the request body

A pre-request script can read and rewrite the body that goes on the wire, which is what request signing needs:

```js
const payload = pm.request.body.json()
payload.nonce = pm.crypto.randomHex(8)
pm.request.body.update(JSON.stringify(payload))
pm.request.headers.set("X-Signature", pm.crypto.hmacSha256(pm.request.body.raw, pm.environment.get("secret")))
```

See [`pm.request.body`](/docs/reference/scripting-api/request/) for the details, including how binary file bodies behave.
