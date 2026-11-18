---
title: "Load tests with k6"
---

Build the flow and load profile in the app with [load testing with k6](/docs/guides/load-testing/). `kurlo load` reads the load tests saved in a collection's `loadtests/` folder. It uses the same flow, collection defaults, auth, data, load profile and thresholds as the app. k6 runs the generated script as a separate process; install Grafana k6 on the machine that runs the test. Listing and exporting work without k6.

```bash
kurlo load list --workspace ./api
kurlo load export "API smoke" --workspace ./api -o smoke.k6.js
kurlo load export "API smoke" --workspace ./api --dir ./k6-export
kurlo load run "API smoke" --workspace ./api --env CI --env-file ./ci.env --json summary.json --report report.html
```

The workspace defaults to the current directory. A test can be selected by its name, ID or YAML path, either absolute or relative to the workspace. Names are case-insensitive. If a name appears more than once, use `--collection NAME`, the unique test ID or its YAML path. `list` prints the collection, test name, ID and path; `--collection` also accepts a collection ID.

## Export

Without `-o` or `--dir`, `export` writes a self-contained script to stdout. Warnings about request scripts, unsupported auth or request bodies go to stderr, so redirecting stdout produces a clean script. CSV/JSON test data is included in a single-script export. `--dir` creates a new folder with `script.k6.js` and a separate `data.json` when the test uses data. An existing export folder is preserved; choose a new path for another export.

```bash
kurlo load export "API smoke" --workspace ./api > smoke.k6.js
k6 run smoke.k6.js
```

Request scripts are not translated into k6 checks. Review the warnings and add the checks and extracted values to your load-test flow.

## Environments and secrets

The environment saved in the load test is the default. `--env NAME` overrides it and selects an environment in the collection's workspace. Variables resolve in this order, with later values taking precedence:

1. `--globals FILE` and repeated `--global-var KEY=VALUE` supply global defaults.
2. Collection defaults, then enabled values in the selected environment.
3. Process environment values for declared variables.
4. `--env-file FILE`, then repeated `--var KEY=VALUE` overrides.

`--env-file` accepts a KEY=VALUE file or JSON, like `kurlo run`. Its values and process overrides stay external in exports, as do saved variables marked secret. k6 reads them from `__ENV`. `run` passes the selected values through the process environment, never through command-line arguments. The machine-local encrypted secret store is not read by the CLI; provide CI secrets through environment variables or an env file. Test-data paths are relative to the workspace root.

Use `--inline-secrets` with `export` only when you want secret values written into the exported script. Do not commit or share that file. `run` never writes secret variables into its temporary script, and masks their values in the k6 log.

## Run, reports and exit codes

`run` finds k6 on PATH, or uses `--k6 PATH`. It prints the target hosts and starts immediately, so it works in non-interactive CI. k6 output and progress go to stderr; stdout shows the status, totals and a table of thresholds with their actual values. The CLI does not replace the app's last-run result.

`--json FILE` saves the raw k6 summary. `--report FILE` saves k6's dashboard HTML report. Both are saved after a threshold failure too. Output files replace existing files; their parent directories must already exist. Very short tests may not produce an HTML report: use a run long enough for the k6 dashboard to collect samples. A requested report that k6 did not produce is reported as an error.

Ctrl+C or SIGTERM asks k6 to stop. On macOS and Linux it gets SIGINT, with a forced stop after ten seconds if needed. On Windows the process is killed. The requested summary is saved if k6 produced one; temporary run files are removed afterwards.

| Exit code | Meaning |
| --- | --- |
| `0` | Passed, or list/export/help completed |
| `99` | k6 thresholds failed |
| `1` | Workspace, validation, export, k6 or artifact error |
| `2` | Invalid command or flags |
| `130` | Interrupted run |

A run that already completed successfully or failed its thresholds keeps its completed exit code even if a stop arrives at the end. Use `kurlo load list --help`, `export --help` or `run --help` for all flags.
