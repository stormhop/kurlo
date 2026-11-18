---
title: "pm.crypto"
---

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

## `CryptoJS`

A `CryptoJS` global is available for compatibility with scripts imported from Postman: `MD5`, `SHA1`, `SHA256`, `SHA384`, `SHA512`, the matching `Hmac*` functions, and `enc.Hex` / `enc.Base64` / `enc.Utf8`. It covers the digest and encoding calls that appear in real collections, not the whole library — for new scripts prefer `pm.crypto`.

```js
const sig = CryptoJS.HmacSHA256("payload", pm.environment.get("secret")).toString()
const b64 = CryptoJS.enc.Base64.stringify(CryptoJS.SHA256("payload"))
```
