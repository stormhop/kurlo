---
title: CLI runner (kurlo run)
description: Run a Kurlo YAML workspace's requests and test scripts from the terminal or CI, with pretty, JSON, or JUnit output.
---

`kurlo run` executes a [Git-backed YAML workspace](/docs/guides/git-workspaces/) from the command line — the same requests and JavaScript test scripts you run in the app, without the window. It's built for CI: a non-zero exit code fails the build when a request errors or an assertion fails.

## Install

On a CI runner or any machine with Node.js 18 or later, use the npm package. It has prebuilt binaries for macOS, Linux and Windows on x64 and arm64, and needs no desktop app:

```bash
npx -y @kurlo/cli run ./my-workspace --env CI
```

or install it once and call `kurlo` directly:

```bash
npm install -g @kurlo/cli
kurlo run ./my-workspace --env CI
```

The desktop app is the CLI as well. If it is installed, `/Applications/Kurlo.app/Contents/MacOS/kurlo run` on macOS, or the `kurlo` executable on Linux and Windows, works the same way.

### `EACCES: permission denied` on `npm install -g`

npm could not write to the folder that holds global packages. It happens with Node from the nodejs.org installer, which puts that folder in `/usr/local`, owned by the system. It is not specific to Kurlo, and any global package fails the same way. Either skip the install and run the CLI with `npx -y @kurlo/cli`, or move global packages into your home folder once:

```bash
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
npm install -g @kurlo/cli
```

Node installed with Homebrew, Volta or nvm keeps global packages in your home folder already. Avoid `sudo npm install -g`: it works, but leaves root-owned files that break later installs.

## Quick start

```bash
kurlo run ./my-workspace --env Staging
```

```
✓ GET https://api.example.com/health → 200  42ms  [2/2 tests]
✓ POST https://api.example.com/login → 200  88ms  [1/1 tests]

2 requests, 2 passed, 0 failed · 3/3 assertions · 131ms
```

The first argument is the workspace directory (the folder that contains `kurlo.yml`); it defaults to the current directory, so inside a workspace you can just run `kurlo run --env Staging`.

## What it runs

- **HTTP and GraphQL requests**, in the order they load from the workspace.
- **Pre-request and test scripts** — the same sandboxed JavaScript `pm.*` API as the app. Assertions become the pass/fail signal.
- **Collection defaults** — a collection's auth, headers, scripts, and settings are applied exactly as they are in the app, so a request set to **Inherit auth** authenticates in CI too.
- **Variable chaining**: a value a test writes with `pm.environment.set(...)` is visible to later requests in the same run, so a login step can hand a token to the requests after it.
- **Browser checks**: a request with [browser emulation](/docs/guides/browser-security/) turned on, by itself or through its collection, is sent the way the browser would send it, and a CORS or CSP refusal fails the run. Keep it on for the requests your frontend makes, and CI catches a CORS change before the frontend ships.

Realtime request types (WebSocket, SSE, Socket.IO, gRPC) need a live session and are skipped, and so are MCP and AI requests. A request whose pre-request script calls `pm.execution.skipRequest()` is also skipped — reported as such, and it does not fail the run.

Scripts get the same sandbox as the app, including [`pm.crypto` and `CryptoJS`](/docs/reference/scripting-api/#pmcrypto) for request signing. Two capabilities are opt-in because they change what a run can do:

- `pm.sendRequest` needs `--allow-send-request`. Without it, a script that calls it fails, which keeps a CI run from making unannounced HTTP calls.
- Scripts are capped at 2000 ms; raise it with `--script-timeout` when a heavy assertion suite or signing step needs longer.

## OAuth 2.0 in CI

A run gets its own access token rather than relying on one the app saved. The saved token lives in the machine-local secret store and never reaches a checkout, so relying on it would mean an OAuth-protected collection simply could not run in CI.

Which grants a run can complete on its own:

| Grant | In a run |
|-------|----------|
| Client Credentials | Fetched from the token endpoint. |
| Password | Fetched from the token endpoint with the configured credentials. |
| Authorization Code / Device Code | Both need a person at a browser. A run swaps the stored **refresh token** instead, which is how these grants are meant to be renewed unattended. |

All the requests in a run that share one configuration authenticate once — fifty requests do not mean fifty round trips to the token endpoint.

When a grant needs a browser and there is no refresh token to fall back on, the run stops on that request and says so, rather than sending it unauthenticated and reporting a 401 you then have to diagnose.

Keep the client secret out of the workspace and pass it in:

```bash
kurlo run . --env CI --var oauthClientSecret="$OAUTH_CLIENT_SECRET"
```

## Variables

Variables resolve exactly as they do in the app, in ascending priority:

1. **Globals** (`--globals <file>`, `--global-var KEY=VALUE`).
2. **Collection variables** (collection defaults).
3. **The selected environment**, chosen with `--env <name>`.
4. **`--env-file`** — a `KEY=VALUE` file.
5. **`--var KEY=VALUE`** — repeatable, highest priority.

The full set of dynamic variables (`{{$guid}}`, `{{$timestamp}}`, `{{$randomEmail}}`, and the rest — see [Environments & variables](/docs/guides/environments/#dynamic-variables)) is generated per use, identical to the desktop app.

Secrets are the reason `--var` and `--env-file` exist: keep them out of the committed workspace and inject them from the CI environment.

```bash
kurlo run . --env CI --var authToken="$API_TOKEN" --env-file .ci.env
```

## Data-driven runs

Point `--data` at a CSV or JSON file to run the selected requests once per row. Each row's columns become variables for that iteration, and the row is also readable in scripts as `pm.iterationData.get("column")` — the same as Postman/Newman.

```bash
kurlo run . --env CI --data users.csv
```

```
users.csv
─────────
name,role
ada,admin
grace,engineer
```

A request URL like `{{baseUrl}}/users?name={{name}}` runs three times (one per row), each with its own `name`. Values a test writes with `pm.environment.set` still carry forward between requests; the data row is a read-only overlay on top. `--iterations` is ignored when `--data` is set — the row count is the iteration count.

JSON data files accept an array of objects, or an object wrapping the rows under `data`/`rows`.

## Reporters

Run one or more reporters with `--reporters` (comma-separated). Each can go to stdout or a file:

| Reporter | Use | File flag |
|----------|-----|-----------|
| `cli` *(default)* | Human-readable lines, a summary, and a failure list, for the terminal. | — (stdout) |
| `json` | A machine-readable summary and per-request results. | `--reporter-json-export <file>` |
| `junit` | A JUnit XML testsuite, for CI test-report UIs. | `--reporter-junit-export <file>` |

```bash
# CLI summary on screen, JSON and JUnit written to files
kurlo run . --env CI --reporters cli,json,junit \
  --reporter-json-export report.json \
  --reporter-junit-export report.xml
```

`--reporter <one>` is a shorthand for a single reporter. Naming an export file implies its reporter, so `--reporter-junit-export report.xml` alone is enough.

## Exporting variables

Write the final variable state (including whatever tests set during the run) to a Postman-compatible file:

```bash
kurlo run . --env CI --export-environment final-env.json --export-globals final-globals.json
```

The exported file reads back through `--env-file` or `--globals`, and imports into Postman.

## Selecting what to run

```bash
kurlo run . --env CI --collection "Billing"          # one collection, by name
kurlo run . --env CI --folder "Billing/Refunds"      # a folder subtree
```

## All flags

| Flag | Meaning |
|------|---------|
| `--workspace <dir>` | Workspace directory (or pass it as the first positional argument). |
| `--env <name>` | Environment to resolve variables from. |
| `--collection <name>` | Only run requests in this collection. |
| `--folder <a/b>` | Only run requests under this folder path. |
| `--data <file>` | CSV or JSON data file; each row is one iteration. |
| `--var KEY=VALUE` | Override a variable (repeatable). |
| `--env-file <path>` | `KEY=VALUE` file that overrides environment variables. |
| `--globals <file>` | `KEY=VALUE` or JSON file of global variables. |
| `--global-var KEY=VALUE` | Set a global variable (repeatable). |
| `--reporters <list>` | Comma-separated: `cli`, `json`, `junit`. |
| `--reporter <fmt>` | Shorthand for a single reporter. |
| `--reporter-json-export <file>` | Write the JSON report to a file. |
| `--reporter-junit-export <file>` | Write the JUnit report to a file. |
| `--export-environment <file>` | Write final environment variables after the run. |
| `--export-globals <file>` | Write final global variables after the run. |
| `--timeout <ms>` | Per-request timeout, overriding request settings. |
| `--script-timeout <ms>` | Per-script execution timeout (default `2000`, max `60000`). |
| `--allow-send-request` | Allow `pm.sendRequest` to make HTTP calls from scripts. |
| `--delay <ms>` | Delay between requests. |
| `--iterations <n>` | Run the selected set `n` times (ignored with `--data`). |
| `--fail-fast`, `--bail` | Stop at the first failing request. |
| `--insecure`, `-k` | Disable TLS certificate verification for every request. |
| `--verbose` | Print request/response detail for each request. |

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Every request succeeded and every assertion passed. |
| `1` | At least one request errored or one assertion failed. |
| `2` | Setup problem — workspace not found, unknown environment, or no requests matched. |

## Example: GitHub Actions

```yaml
- name: API smoke tests
  run: npx -y @kurlo/cli run ./workspace --env CI --reporter junit --var token="${{ secrets.API_TOKEN }}" > results.xml
```

## Related

- [Collection Runner](/docs/guides/collection-runner/) — the same idea inside the app, with a data file and parallelism.
- [Git-backed workspaces](/docs/guides/git-workspaces/) — the YAML format `kurlo run` reads.
- [Scripting API](/docs/reference/scripting-api/) — the `pm.*` API your test scripts use.
