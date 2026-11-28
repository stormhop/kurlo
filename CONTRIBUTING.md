# Contributing to Kurlo

Thanks for wanting to help. Bug reports, docs fixes, and pull requests are all welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Found a security problem?** Do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Fixing a bug?** Go ahead and open a pull request directly.
- **Adding a feature or changing behaviour?** Open an issue or a
  [discussion](https://github.com/stormhop/kurlo/discussions) first. Kurlo is
  deliberately local-first and opinionated, and it's much cheaper to agree on the shape of
  a change before it's written than to reject a finished PR.

## Development setup

Requirements:

- Go 1.25+
- Node.js 22.12+
- Python 3 for release script tests
- [Wails v2](https://wails.io/docs/gettingstarted/installation) — `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- macOS: Xcode Command Line Tools
- Linux: `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`
- Windows: NSIS for installer builds, Windows SDK for MSIX

```bash
git clone https://github.com/stormhop/kurlo
cd kurlo
npm install
make dev
```

`make dev` runs the Go backend and the Svelte frontend with hot reload. To iterate on UI
only, `npm run frontend:dev` serves the frontend by itself — note that the Wails bridge is
unavailable there, so anything touching the backend (sending requests, persistence, file
dialogs) won't work.

If you change the app icon, `wails dev` caches the generated `iconfile.icns`. Run
`make clean && make dev` to pick up the new one.

## What CI enforces

Run this before pushing — it covers most of what CI checks:

```bash
make check
```

While working on a change, `make check-fast` runs the same checks with Go in `-short`
mode: it skips the tests that run git, k6 or the native file watcher, the scale and
crash runs, the 100 MB body tests and other long waits, and takes about 70 seconds
instead of two minutes. `make test-fast` runs only that Go part. Run `make check`
before pushing; CI always runs the full suite.

Local `make` targets run up to four parallel Go tests per package. Use
`make test GO_TEST_PARALLEL=2` to reduce concurrency, or
`make test GO_TEST_FLAGS="-run TestGit"` to select tests. Independent Git tests use
their own temporary repositories. Crypto, history and Git credential tests use
explicit store instances, paths and key sources. Filesystem tests share a read-only
key created in the temporary test home; they do not replace process-wide providers.
Tests that change process environment or global fault injection hooks, measure
process-wide allocations, assert timing budgets, and the scale benchmark, remain
sequential. Network tests that start their own server or broker run in parallel;
an MQTT test broker listens on a socket the test opened, so parallel tests never
race for a port. Crash helpers receive their key through an
explicit temporary fixture file.

Browser tests live in `apps/desktop/frontend/e2e`, grouped by feature. Shared bridge,
fixtures and UI helpers live in `e2e/support`. Run a feature on its own with
`npm run test:e2e -- e2e/git.spec.ts --workers=2`, or filter by test title with `-g`.
The normal configuration already runs tests within each file in parallel.
`00-workflows.spec.ts` runs first in serial screenshot mode: later feature tests
refine some documentation captures from that initial walkthrough.
Screenshots a test takes for review, saved as `kurlo-*.png` in the temporary
directory, are written only with `KURLO_E2E_SHOTS=1`, for example
`KURLO_E2E_SHOTS=1 npm run test:e2e -- e2e/mqtt.spec.ts --workers=2`. Use
`reviewShot` from `e2e/support/reviewShot.ts` for new ones.

Frontend unit tests live in `src/tests`. Import/export tests are grouped by format
in `importers*.test.ts`; application integration tests use `appIntegration*.test.ts`.
Their shared fixtures live in `src/tests/support` and remain isolated per test file.
Large JSON tests call the response renderer used by the application.

The request File tab is covered at three levels. `e2e/file-tab.spec.ts` drives the
editor against a mocked bridge and captures `request-file-tab` in screenshot mode.
The `requestFile*`, `requestYaml*` and `requestTabPreferences` unit tests cover the
draft, the address-bar sync and completion. The real read, save, conflict and
format paths run in Go: `make test GO_TEST_FLAGS="-run 'TestRequestFileYAML|TestFormatRequestFileYAML|TestRequestDraftSchema'"`.

`npm run frontend:check` checks both the application and Playwright TypeScript.
Use `npm run test:e2e:check` to check only the browser tests and their configuration.
The test bridge uses generated Wails argument types and permits partial mock
responses, since the frontend normalizes incomplete wire data.

The full pipeline in [`ci.yml`](.github/workflows/ci.yml) runs:

| Check | Command |
|-------|---------|
| Lint | `npm run lint` |
| Frontend types | `npm run frontend:check` |
| Frontend unit tests | `npm --workspace @kurlo/desktop-frontend run test` |
| Release script tests | `make test-scripts` (Python 3 standard library) |
| Frontend build | `npm run frontend:build` |
| Docs site build | `npm run web:build` |
| Docs consistency | `npm run web:check-docs` |
| Go formatting | `gofmt -l apps/desktop/` must be empty |
| Go vet | `go vet ./apps/desktop/...` |
| Go tests | `go test -race ./apps/desktop/...` on Linux, repeated on macOS (with `-race`) and Windows (without) |
| Generated bindings | `make bindings` must produce no diff |
| Dead code | `golang.org/x/tools/cmd/deadcode` must report nothing |
| End-to-end | `npm run test:e2e:all` (Playwright, Chromium and WebKit) |

CI builds the npm CLI for macOS, Linux and Windows on x64 and arm64 in parallel
with the desktop and web checks. The required `Build & Test` check passes when both jobs succeed.

CI runs Chromium in one job and splits WebKit across two parallel jobs, with two
workers per job. A fourth job runs the `@scale` tests in both browsers with one worker.
Each job uploads its own `playwright-report-<suite>` artifact. All four jobs run to
completion even if one fails. The required `E2E (Playwright)` check passes when all four succeed.

`make test-extension` is not in that list: it drives the real Cookie Sync extension in a
headless Chromium against a Go-hosted bridge, and it is run locally when `apps/desktop/extension`
or `internal/api/cookie_sync.go` changes. See [`apps/desktop/extension/README.md`](apps/desktop/extension/README.md).

Two of these surprise people:

- **Dead code.** Unreachable Go code fails the build. Wire it up or delete it — don't leave
  a function around "for later".
- **Docs consistency.** `scripts/check-web-docs.mjs` cross-checks the YAML workspace
  reference in `apps/web` against the Go source and the JSON Schema. Adding a persisted
  auth field means updating `schemas/kurlo-workspace-yaml-v1.schema.json` and
  `apps/web/src/content/docs/docs/reference/kurlo-yaml-format/request-fields.md` too. It also checks the
  documents that nothing else reads: a new `SHORTCUT_DEFINITIONS` entry has to appear in the
  keyboard-shortcuts reference, and a new snippet target in the code-generation guide.

## Code style

Match the surrounding code. Beyond that:

- **Go** — standard `gofmt`. Doc comments on exported identifiers. Comments explain *why*,
  not *what*; the codebase is deliberately light on them, and a comment restating the line
  below it will be asked about in review.
- **Svelte 5** — runes (`$state`, `$derived`, `$effect`), not the legacy store API.
  Feature logic lives in `lib/stores/features/`; components stay presentational where
  practical.
- **TypeScript** — no `any` in new code. The wire types in `lib/wire.ts` are *derived* from
  the Go structs through the generated bindings, so there is nothing to keep in sync by hand.
  Don't restate a Go struct in TypeScript; add it to the Go model and regenerate.
- **Tests** — behaviour changes need a test. Runtime and persistence changes in particular
  should be covered by automated tests rather than manual UI checks, because those paths
  are the easiest to silently regress.

### Changing anything that crosses into Go

`apps/desktop/frontend/wailsjs/` is generated by Wails, and the frontend's wire types are
derived from it — so after changing `internal/model`, or the signature of a method bound to
`App`, regenerate and commit the result:

```bash
make bindings
```

CI regenerates and fails if the committed files differ, because a stale generated file means a
stale interface. Use `make bindings` rather than a `wails` on your `PATH`: the target pins the
generator version, and different versions produce different files.

### Changing anything the documentation shows

The screenshots under `apps/web/src/assets/screenshots/` are taken by the e2e walkthrough, not by
hand. After changing the interface, retake them and commit the result:

```bash
make screenshots
```

The run drives the app against a stubbed Wails bridge, so the shots are reproducible and contain
no real workspace data. `npm run web:check-docs` fails when a screenshot referenced by the docs is
missing, but it cannot tell a stale one from a current one — that part is on the pull request.

Three seams cannot be generated — the request-setting lists in `file_workspace_store_strip.go`,
the CLI's own decode structs, and the event payloads restated in `wire.ts`. Each is guarded by a
test in `internal/api/frontend_contract_test.go`; if you add a field there, that test tells you
what else needs it.

## Commits and pull requests

- Write commit messages in the imperative mood, with a short subject line: `fix: preserve
  port in Postman structured URLs`.
- Keep a pull request to one logical change. Unrelated cleanups belong in their own PR.
- Fill in the pull request template, and say how you verified the change.
- Add a `CHANGELOG.md` entry under `[Unreleased]` for anything user-visible.

## Reporting bugs

Use the issue templates. The two things that matter most are the Kurlo version
(Settings → About) and a reproduction — the smallest request or import file that shows the
problem. Screenshots help for UI issues.

Please scrub credentials from anything you attach: request bodies, headers, exported
collections, and screenshots of the auth tab all commonly carry real tokens.
