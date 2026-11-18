---
title: "Variables and data files"
---

## Variables

Variables resolve exactly as they do in the app, in ascending priority:

1. **Globals** (`--globals <file>`, `--global-var KEY=VALUE`).
2. **Collection variables** (collection defaults).
3. **The selected environment**, chosen with `--env <name>`.
4. **`--env-file`** — a `KEY=VALUE` file.
5. **`--var KEY=VALUE`** — repeatable, highest priority.

The full set of dynamic variables (`{{$guid}}`, `{{$timestamp}}`, `{{$randomEmail}}`, and the rest — see [Environments & variables](/docs/guides/environments/dynamic-variables/)) is generated per use, identical to the desktop app.

Environment names are resolved in each collection's own workspace, so two workspaces in one store can both have a `Local` or `CI` environment. A variable marked secret is shown as `[secret]` in the terminal and JSON report, including when it appears in the request URL; a request header marked secret is masked the same way in test errors and script output.

Secrets are the reason `--var` and `--env-file` exist: keep them out of the committed workspace and inject them from the CI environment. A value from `--var` or `--env-file` whose name contains `token`, `secret`, `password`, `passwd`, `apikey`, `privatekey`, `credential`, `sessionid`, `cookie`, `authorization`, `bearer` or `jwt` (ignoring case, `-`, `_` and `.`) is masked as `[secret]` in the terminal, the JSON and JUnit reports and script logs. Other values, such as `baseUrl`, are printed as they are.

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
