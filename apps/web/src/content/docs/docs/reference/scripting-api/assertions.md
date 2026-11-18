---
title: "Assertions"
---

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
