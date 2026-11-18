---
title: "OpenAPI sync in CI and teams"
---

## Files and teams

The spec from the last applied sync is saved as `openapi/spec.json` next to `collection.yml`, and each linked request stores its operation as `openapi: GET /users/{id}`. Commit both with the collection: a teammate who pulls then sees the same changes you would, instead of every request looking edited. The fields are listed in the [YAML format reference](/docs/reference/kurlo-yaml-format/collection/#openapi-source).

The last check time, the `ETag` and a skipped version are kept on your computer only.

**Disconnect** removes the source and `openapi/spec.json`. Requests keep their `openapi` links, so connecting the same spec again matches them at once.

## In CI and for agents

`kurlo openapi check` compares the current spec with `openapi/spec.json` and exits with `1` when the spec has moved on, so a pipeline can flag drift. See [Contract drift](/docs/guides/cli-runner/openapi/#contract-drift-with-kurlo-openapi-check). The `check_openapi_sync` tool of [`kurlo mcp`](/docs/guides/mcp-server/) gives an assistant the same report.

## Limits

- Only HTTP requests take part. GraphQL, gRPC, WebSocket and other request types in the collection are left alone.
- Request names and folders are set when an endpoint is added and are not changed by later syncs.
- Changes are always reviewed; there is no option yet to apply them without the review.
