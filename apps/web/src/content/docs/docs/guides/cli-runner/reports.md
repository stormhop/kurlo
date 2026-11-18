---
title: "Reports and exported variables"
---

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
