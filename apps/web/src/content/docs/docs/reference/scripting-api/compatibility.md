---
title: "Bundled modules and compatibility"
---

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

## JetBrains HTTP Client globals

Scripts imported from `.http` files, written for the JetBrains HTTP Client, run in the JavaScript engine as well:

| Name | Meaning |
|------|---------|
| `client.global.set` / `get` / `clear` / `clearAll` / `isEmpty` | Same as `pm.globals`; `get` returns `null` for a missing name |
| `client.test(name, fn)` | Same as `pm.test` |
| `client.assert(condition, message)` | Throws `message` when the condition is false |
| `client.log(...values)` | Same as `pm.log` |
| `request.variables.set` / `get` | Same as `pm.variables` |
| `request.environment.get(name)` | Same as `pm.environment.get` |
| `request.method`, `request.url.getRaw()`, `request.url.tryGetSubstituted()` | The request being sent |
| `request.headers.findByName(name)` | A header with `getRawValue()` and `tryGetSubstituted()`, or `null` |
| `response.status`, `response.body` | The status code and the body, parsed when it is JSON, in post-response scripts |
| `response.headers.valueOf(name)` / `valuesOf(name)` | A response header |
| `response.contentType.mimeType` / `charset` | The parsed `Content-Type` header |

A script may declare its own `client`, `request` or `response` (`const response = pm.response.json()` works). `client.exit()` throws, because Kurlo cannot stop a script part-way.
