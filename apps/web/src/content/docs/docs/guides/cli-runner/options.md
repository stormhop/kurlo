---
title: "Flags and exit codes"
---

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
| `--env-file <path>` | `KEY=VALUE` file or Postman environment JSON that overrides environment variables. |
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
| `--verbose` | Print request/response detail and script output for each request. |
| `--secret-providers on\|off` | Fetch [linked variables](/docs/guides/environments/secret-managers/#in-the-cli-and-ci) from secret managers (default `on`). With `off`, pass them with `--var` or `--env-file`. |
| `--secret-timeout <duration>` | Time limit for each secret manager call, such as `30s`. Defaults to the provider's setting. |
| `--allow-secret-commands` | Let secret providers of type `command` run their program. Without it, a variable linked to one stops the run with exit code `2`. |

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Every request succeeded and every assertion passed. |
| `1` | At least one request errored or one assertion failed. |
| `2` | Setup problem — workspace not found, unknown environment, no requests matched, or a linked secret could not be fetched. |
