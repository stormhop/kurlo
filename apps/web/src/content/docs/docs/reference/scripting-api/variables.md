---
title: "Variable scopes"
---

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
| `pm.variables` | All scopes, in precedence order: data row → request → environment → collection → session | The session scope |
| `pm.globals` | The session scope | The session scope |
| `pm.environment` | The active environment | The active environment |
| `pm.collectionVariables` | The request's collection | The request's collection, saved back to the collection after the send |

Kurlo has a single runtime variable scope, so `pm.globals` and `pm.variables.set` write to the same place — they are aliases, not two separate stores.

**`pm.variables.replaceIn(text)`** fills every `{{name}}` in a string from the scopes above, plus `{{$guid}}` and the other [dynamic variables](/docs/guides/environments/dynamic-variables/) — handy for signing the URL a request will actually hit. A name nothing defines is left as written.

Globals persist. They are saved with your data, survive a restart, and are shared across every workspace. Edit them under **Environments → Globals** in the sidebar; a value a script writes appears there after the send. In [`kurlo run`](/docs/guides/cli-runner/) they come from `--globals` / `--global-var` and can be written back with `--export-globals`.

`pm.collectionVariables.set` persists: after the request finishes, the value is written onto the collection's variables (a Git-backed workspace records it in `collection.yml`). An existing row keeps its id, enabled state, secret flag, and description; only the value changes.

```js
// Cache a value for every later request in the collection.
pm.collectionVariables.set("lastOrderId", pm.response.json().id)
```
