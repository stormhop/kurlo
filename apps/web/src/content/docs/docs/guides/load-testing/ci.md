---
title: "Save, share and run in CI"
---

The load-test definition lives alongside its collection's requests:

```text
workspaces/<workspace>/collections/<collection>/loadtests/<test>.yml
```

Commit that definition and any shared data files with the workspace. Secret variable values belong in environment configuration rather than the test definition. See the [YAML reference](/docs/reference/kurlo-yaml-format/load-test/) for the file format.

The headless CLI reads the same tests:

```bash
kurlo load list --workspace ./api
kurlo load export "Checkout flow" --workspace ./api --dir ./k6-export
kurlo load run "Checkout flow" --workspace ./api --env CI --env-file ./ci.env --json summary.json --report report.html
```

The CLI can select a test by name, ID or YAML path. Threshold failures exit with code `99`; runtime errors use `1`, usage errors use `2`, and interrupted runs use `130`. See [CLI load testing](/docs/guides/cli-runner/load/) for variable precedence, all flags and report handling.
