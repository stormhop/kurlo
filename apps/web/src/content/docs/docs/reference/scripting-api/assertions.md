---
title: "Assertions"
---

```js
pm.test("status is 200", () => pm.response.to.have.status(200))
pm.test("has id", () => pm.expect(pm.response.json()).to.have.property("id"))
```

**`pm.test(name, fnOrResult)`** registers a named assertion and accepts a callback or a boolean. **`pm.expect(value)`** builds a chainable Chai-style assertion.

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

## JSON Schema

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
