# Kurlo Performance Fixtures

This folder contains reproducible fixture definitions for local performance testing. Generated payloads are intentionally ignored by Git because the default set can be hundreds of megabytes.

Generate the default stress set:

```bash
npm run perf:fixtures
```

Generate a smaller smoke set:

```bash
npm run perf:fixtures -- --requests 250 --folders 50 --history 500 --response-mb 2
```

The YAML workspace is written by Kurlo's own Go writer (`TestPerfFixtureWorkspace` in `apps/desktop/internal/api`), so it always matches the current file format. Generation fails if the written workspace has diagnostics or if saving it again would change any file. Generating needs Go on the `PATH`.

Run the generated data through the app UI (Playwright, Chromium and WebKit):

```bash
cd apps/desktop/frontend
KURLO_PERF_FIXTURES=$PWD/../../../perf/fixtures npx playwright test -g "perf fixtures"
```

It prints first paint, sidebar search, opening a request, the history view and loading the huge response, and fails when first paint takes over 10 s or search or opening a request takes over 3 s.

Outputs are written to `perf/fixtures/`:

- `request-store-large.json` - local request store payload with many collections, folders, requests, history entries, environments, and cookies.
- `huge-response.json` - large response body for response viewer rendering/search tests.
- `kurlo-yaml-large/` - Git/YAML workspace written by the Kurlo writer: collections, nested folders, requests with examples and setting overrides, an environment with a secret, and workspace cookies.
- `manifest.json` - counts, generated paths, and suggested manual checks.

Primary checks:

- Load `request-store-large.json` through the all-data import path or by using it as a local request-store payload in a dev build.
- Open the collections sidebar and verify folder expand/collapse/search stay responsive.
- Switch to history and verify date collapse/search do not shift layout.
- Open `huge-response.json` in a request response fixture and verify raw/view/search pagination.
- Open `kurlo-yaml-large/` as a folder workspace and verify diagnostics remain clean.
