---
title: Performance fixtures
description: Reproducible large workspaces and responses for local performance checks.
---

Kurlo includes a fixture generator for exercising the highest-risk UI and storage paths before a release: large sidebars, deep folder trees, request history, huge responses, and Git/YAML diagnostics.

Generated files are written to `perf/fixtures/` and are ignored by Git because the default set can be hundreds of megabytes.

## Generate fixtures

From the repository root:

```sh
npm run perf:fixtures
```

For a faster smoke set:

```sh
npm run perf:fixtures -- --requests 250 --folders 50 --history 500 --response-mb 2
```

Useful options:

| Option | Default | Meaning |
|--------|---------|---------|
| `--requests` | `5000` | Saved requests spread across collections and request types. |
| `--folders` | `500` | Nested folder paths preserved in collections and YAML workspaces. |
| `--history` | `10000` | Request history rows. |
| `--response-mb` | `50` | Approximate size of `huge-response.json`. |
| `--collections` | `5` | Collections in the generated workspace. |
| `--out` | `perf/fixtures` | Output directory. |

The YAML workspace is written by Kurlo's own Go writer (`TestPerfFixtureWorkspace` in `apps/desktop/internal/api`), so it always matches the current file format. Generation fails if the written workspace has diagnostics or if saving it again would change any file. Generating needs Go on the `PATH`.

Run the generated data through the app UI (Playwright, Chromium and WebKit):

```bash
cd apps/desktop/frontend
KURLO_PERF_FIXTURES=$PWD/../../../perf/fixtures npx playwright test -g "perf fixtures"
```

It prints first paint, sidebar search, opening a request, the history view and loading the huge response, and fails when first paint takes over 10 s or search or opening a request takes over 3 s.

## Outputs

- `request-store-large.json` - all-data payload with workspaces, collections, folders, requests, environments, history, and cookies.
- `huge-response.json` - large JSON response body for response viewer rendering, paging, and search.
- `kurlo-yaml-large/` - Git/YAML workspace written by the Kurlo writer: collections, nested folders, requests with examples and setting overrides, an environment with a secret, and workspace cookies.
- `manifest.json` - counts, generated paths, and suggested manual checks.

## P0 checks

Use the fixtures to smoke-test these surfaces after storage, sidebar, import/export, or response-viewer changes:

- Import `request-store-large.json` through the all-data import path.
- Open collections and verify expand/collapse, nested folders, search, and starred rows remain responsive.
- Open history and verify date collapse/search keep stable layout.
- Load `huge-response.json` into the response viewer and check raw view, paging, and search.
- Open `kurlo-yaml-large/` as a Git-backed workspace and confirm diagnostics stay clean.
- Toggle autosave/manual-save and verify request and environment dirty states behave the same way on large data.
