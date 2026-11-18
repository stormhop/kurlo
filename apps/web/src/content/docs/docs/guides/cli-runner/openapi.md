---
title: "Check OpenAPI drift"
---

## Contract drift with kurlo openapi check

`kurlo openapi check` tells CI when the API's spec has moved on since a collection was last synced with it. It reads the collection's [OpenAPI source](/docs/guides/openapi-sync/), downloads the current spec and compares it with `openapi/spec.json`, the spec of the last sync applied in Kurlo and committed next to `collection.yml`. It changes no files: apply the changes in the app and commit them.

```bash
kurlo openapi check "Pets API" --workspace ./api
kurlo openapi check --workspace ./api --env CI --var specToken="$SPEC_TOKEN"
kurlo openapi check "Pets API" --workspace ./api --spec ./build/openapi.json --reporter json
```

The output lists operations new in the spec, changed (parameters, request body, responses, security or description, with `$ref`s followed), moved to another path under the same `operationId`, and removed, plus a change of servers. It also names requests in the collection that are not linked to any operation. `x-` extensions are ignored.

| Flag | Meaning |
|------|---------|
| `[collection]`, `--collection <name>` | Collection to check. Optional when only one collection is synced. |
| `--workspace <dir>` | Workspace directory (default `.`). |
| `--spec <file>` | Compare with this file, for example one your build generated, instead of the collection's source. |
| `--env <name>`, `--env-file <path>`, `--var KEY=VALUE` | Values for `{{variables}}` in the source URL and its headers. Collection variables are used too. |
| `--reporter cli\|json` | Text (default) or a JSON report. |
| `--insecure` | Skip TLS certificate verification when downloading the spec. |

| Exit code | Meaning |
| --- | --- |
| `0` | The spec matches the last sync. |
| `1` | The spec changed. |
| `2` | The check could not run: no such collection, no sync applied yet, an unset variable, or the spec could not be downloaded or read. |
