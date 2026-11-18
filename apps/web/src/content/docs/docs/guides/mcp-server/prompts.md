---
title: "Prompts and tests"
---

## Prompts

The server also offers three [prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts): ready-made instructions that clients show as commands. In Claude Code they are `/mcp__kurlo__sync_collection` and so on.

| Prompt | Arguments | What the assistant does |
|--------|-----------|-------------------------|
| `sync_collection` | `collection`, `source` | Finds the HTTP routes in your project's code (Express, FastAPI, Flask, Go routers, Spring, Rails, ASP.NET and others), matches them with the saved requests, and adds a request with tests for each route that has none. It deletes nothing: saved requests that match no route are listed for you to decide. |
| `cover_endpoint` | `endpoint` (required), `collection` | Does the same for one endpoint, such as `POST /orders`, and also saves its main error responses as examples. |
| `debug_last_failure` | `entry` | Calls `diagnose_last_failure`, explains the cause and proposes a fix, which it applies only after you agree. |

Requests are saved with `{{baseUrl}}` in the URL, so the address lives in an environment, not in each request. When no environment sets it, the prompts tell the assistant to look for it in the project (`docker-compose.yml`, launch settings, the README) and to ask you before calling `set_variable`, and never to point an environment at production. With `--read-only` only `debug_last_failure` is offered.

## Tests from a response

`generate_tests` writes a saved request's tests for it. With `from: run`, the default, it sends the request and writes three `pm.test` checks from the response:

- the status, such as `pm.response.to.have.status(200)`;
- the `Content-Type`;
- a JSON schema of the body, checked with `pm.response.to.have.jsonSchema`: the type of every field and which fields are required. Values are left out, so the tests do not break when the next order has another id, and nothing from the response is written into the request's file.

The response is also saved as an [example](/docs/guides/examples/), named after its status, so the [mock server](/docs/guides/mock-server/) serves it. Run `generate_tests` again later and an example of the same name is refreshed rather than added twice.

Sending the request has its effects: a `POST` creates what it creates. A response with a 4xx or 5xx status is refused, since the tests would assert a failure, unless the call passes `allowErrorStatus: true` to test that error on purpose.

When the API is not running anywhere yet, `from: example` takes what the code returns instead: a `status` and a `body`, or a `schema` built from the response type. The tests and the example are written the same way, and the tests pass once the server is up. A schema that does not accept its own body is refused.

Tests the request already has are kept and the new ones are added after them. A test with the same name, such as `status is 200`, is not added twice. When the request's tests already expect another status, an error response such as a `422` is saved as an example only, so the script never asserts two statuses. `replace: true` replaces the whole test script.
