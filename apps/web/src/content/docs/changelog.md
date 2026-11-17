---
title: Release notes
description: Notable Kurlo changes and links to the exact notes for each published release.
tableOfContents:
  maxHeadingLevel: 2
head:
  - tag: title
    content: Kurlo changelog and release notes
---

This page summarizes the notable-change log maintained in the source repository. For the exact notes and artifacts
attached to every published tag, use the [Kurlo releases page](https://github.com/stormhop/kurlo/releases).

## Unreleased

### Added

- **Postman v3 collections**: import the Git folder of `.request.yaml` files Postman v12 writes, or drop it into the
  window; collections, requests, auth, scripts, examples, environments and globals come across. See
  [Import and export](/docs/guides/import-export/#postman-v3-folders).
- **Move requests between folders** by dragging them onto a folder or back onto the collection header. See
  [Workspaces](/docs/guides/workspaces/).
- **PFX/P12 client certificates** for mTLS over HTTP and gRPC, with a password and certificate chain. See
  [Request settings](/docs/guides/request-settings/).
- **Performance dock**: CPU, memory and Kurlo's processes from the status bar gauge or Cmd/Ctrl Alt P. See
  [Performance dock](/docs/reference/performance/).

### Fixed

- **cURL paste keeps what the command sends**: uploads, Bearer, Digest, NTLM and AWS auth, `--url-query` and combined
  flags like `-sSLo out.json` come across; options Kurlo cannot import stop the paste with a message.
- **YAML imports read multi-line `[...]` and `{...}`**, and several `---` documents in one file are rejected instead of
  merged.
- **No false unsaved changes** after renaming a collection in manual-save mode.
- **Safer Git actions**: no stale autosave after a checkout or pull, and Git waits while an agent writes the workspace.
- **Responses and chats stay on their request**, and restored AI requests keep their chat.
- **Requests and connections always end**: unconfirmed cancels, unanswered WebSocket closes and deleted workspaces.
- **Lower memory use** for long gRPC streams, interrupted downloads and large signed file bodies.
- **Fewer places secrets show** in MCP `get_request` and `kurlo run` output.
- **Scripts behave the same everywhere**: runaway regexes time out, MCP logs appear once, `$isoTimestamp` has
  milliseconds in the CLI.
- **Faster with large workspaces**: big Git diffs, the JSON filter, the sidebar filter and typing in long requests.
- **Steady scrolling in long lists**, script editors that fill the panel, and update notes cut on a complete line.

## 3.1.3

### Added

- **Client certificates for gRPC**: the gRPC **Settings** tab has **Client certificate (mTLS)**, like HTTP, used for the
  call and for reflection whenever TLS is on. See [Request types](/docs/guides/request-types/#grpc).
- **Script output you cannot miss**: a failing script puts a red banner above the response body and a count on the
  **Scripts** tab, the output stays visible under "Could not send request", `console.warn` / `console.error` are
  coloured, every `pm.sendRequest` call is logged, and long or dropped log lines are marked. See
  [Logging](/docs/reference/scripting-api/#logging).
- **`{{variables}}` in every auth field**: auth fields suggest variables after `{{` and flag undefined ones; a secret
  field holding only `{{token}}` shows it as text. See [Authentication](/docs/guides/authentication/#bearer-token).
- **Preview tabs**: enable **Settings → General → Preview tabs** to reuse one temporary request tab while browsing.
  Double-clicking, editing or running the request keeps its tab open. Off by default; the preference and preview survive
  a restart. See [App settings](/docs/guides/settings/#preview-tabs).

### Changed

- **Less JavaScript on the first load**: the code editor is not loaded at start-up, which removes about 350 KB of
  JavaScript before the window is ready. Kurlo warms it in the background right after the first paint, so the first
  visit to the Body or Scripts tab does not wait.

### Fixed

- **`pm.sendRequest` works like Postman**: string headers, disabled headers, `urlencoded`, `formdata` and `graphql`
  bodies and `Content-Type` from the body are handled, so servers no longer answer 415, and the script timeout cancels a
  running call. See [`pm.sendRequest`](/docs/reference/scripting-api/#pmsendrequest).
- **Scripts behave as written**: pre-request `pm.test` results show and count everywhere, GraphQL body updates, form
  edits and `pm.globals.unset` keep what they should, and secret values in test names are masked.
- **gRPC requests inherit collection auth**: **Inherit auth** now uses the collection's or nearest folder's credentials
  and is offered in the gRPC Auth tab.
- **Saves no longer lose or undo edits**: collection settings are written when you leave early, Reset defaults clears
  JavaScript scripts too, and an older queued save cannot overwrite a newer one.
- **Environment pages behave**: editing on page 2 or later stays on that page, and the page count is right.
- **Idle windows stop burning CPU**: the perched bird and the status indicators settle after a few moves instead of
  redrawing the window every frame.
- **Imported names keep their slashes**: `Billing / Invoices` stays one request instead of becoming a folder.
- **`kurlo run` fixes**: flags around the workspace folder, environments scoped to their workspace, `--export-globals`
  with script values, UTF-8 BOM in data files, `--verbose` script output and masked secrets in reports. See
  [CLI runner](/docs/guides/cli-runner/).
- **`kurlo mcp` fixes**: combined curl flags import, echoed secret headers are masked, and `kurlo mcp install` rejects
  an unknown `--env`. See [MCP server](/docs/guides/mcp-server/).

## 3.1.2

### Fixed

- **No Documents permission prompt on macOS**: 3.1.1 watched every folder above the workspace, so macOS asked again for
  access to Documents at start-up. Kurlo now watches only the workspace folder.

## 3.1.1

### Added

- **Drop files to import**: drop a `.http`, `.rest`, Postman, Insomnia, OpenAPI or HAR file anywhere in the window to
  import it, instead of the window showing the file's text.
- **JetBrains HTTP Client scripts run**: the sandbox understands `client`, `request` and `response`, so scripts imported
  from `.http` files work as written.
  See [JetBrains HTTP Client globals](/docs/reference/scripting-api/#jetbrains-http-client-globals).

### Changed

- **One loader everywhere**: every wait in the app — responses, gRPC and MCP calls, diffs, history, cookies, examples,
  the mock server, model lists, settings checks and the Cancel button — shows the flying Kurlo bird instead of spinners
  and *Loading…* captions.
- **Claude Code models stay current**: models, the default and effort levels come from your installed CLI. Kurlo keeps
  the last successful list for temporary failures and preserves the model in existing chats.
- **Saving an edit writes only what changed**: from the first edit after opening, Kurlo sends and rewrites just the
  edited requests, so an autosave in a workspace with 1,300 requests takes about 20 ms instead of 280 ms. Structural
  changes and files edited outside Kurlo still use the full save.
- **Large workspaces open and save faster**: examples are read in the background after a workspace opens, so a
  1,300-request workspace opens in about 190 ms instead of 430 ms; the full save takes about 170 ms instead of 290 ms,
  and typing no longer rebuilds the sidebar.
- **Git status after a save checks only the saved files**, without refreshing the branch list on every edit.
- **File changes are noticed through the system**: FSEvents, `ReadDirectoryChangesW` and inotify replace the scan every
  second, which remains only as a fallback.

### Fixed

- **Edits save on the first launch**: on a new installation Kurlo refused every save with *changes could not be saved*,
  so nothing reached the disk. An empty profile now counts as a fresh start.
- **`.http` import keeps scripts out of requests**: pre-request scripts no longer make a request disappear, response
  handlers no longer land in the body, and XML bodies starting with `<` are kept.
- **Import dialog shows `.http` and `.rest` files on Linux**: import opens the system dialog filtered to the chosen
  format.
- **Tengo script timeouts**: Tengo scripts respect the configured script timeout instead of always using two seconds.
- **Compact release notes in About**: long update notes show about ten lines and a link to the full changelog on the
  website.
- **Mock server with thousands of examples**: the route list reads only methods, paths and statuses and the server reads
  responses from disk, so it opens quickly, scrolls without blank gaps and keeps the sidebar animation smooth; hiding
  the sidebar no longer moves the list away from the route you were looking at.
- **The sidebar hides and shows at once**: toggling it no longer restyles the whole window, so the slide starts without
  a pause in large workspaces.
- **Large workspaces stay responsive**: saving no longer re-encodes or resends examples already on disk, so typing,
  saving and switching requests do not stall with hundreds of requests.
- **Long lists scroll the same way everywhere**: the collection runner has no page buttons any more, and agent activity
  loads older calls as you scroll; its search and summary cover the whole log.
- **Chats and Git history load more as you scroll**: a long agent chat loads earlier messages as you scroll up instead
  of through a button, and Git history loads 100 older commits at a time.
- **Links without underlines**: links change colour on hover instead of being underlined.
- **Saving a response as an example stays on its request**, even if you open another request while examples are loading.
- **Editing a request with large examples stays light**: unchanged examples are no longer resent on every save.
- **Less memory after deleting requests**: previous responses of deleted requests are freed.
- **Git paths with spaces**: such files show without quotes in the Git panel and their diffs open.
- **No macOS suggestions in text fields**: filters and search boxes no longer show autocorrect or autocomplete pop-ups.
- **Settings open at once**: settings and search are prepared in the background after start-up.
- **Straight selection edge in editors**: a multi-line selection starts at the text column on every line instead of
  stepping out into the indent.

## 3.1.0

### Added

- **OpenAPI sync**: keep a collection linked to its spec URL or file, with no sync limit. Kurlo checks it in the
  background, shows new, changed, conflicting and removed endpoints for review, and merges three ways so your edits,
  scripts and tests stay. See [OpenAPI sync](/docs/guides/openapi-sync/).
- **`kurlo openapi check`**: flag spec drift in CI with exit code `1`, or ask an agent through the `check_openapi_sync`
  MCP tool. See [Contract drift](/docs/guides/cli-runner/#contract-drift-with-kurlo-openapi-check).
- **Request variables**: a **Vars** tab on every request with Pre Request variables that override the environment and
  Post Response variables taken from the response with expressions such as `res.body.token`. Imported from Bruno and
  Insomnia folders. See [Request variables](/docs/guides/environments/#request-variables).
- **JWT Bearer auth**: Kurlo signs a fresh JWT on every send from a secret or a private key, with claims, an optional
  lifetime and a token preview. See [JWT Bearer](/docs/guides/authentication/#jwt-bearer).
- **Assertions**: check the status, time, size, a header or a JSON field of a response without code, in **Scripts →
  Assertions**. Results show with the tests and count in the runner, `kurlo run` and `kurlo mcp`.
  See [Assertions](/docs/guides/scripting/#assertions).
- **Undo deletes**: a deleted request, folder, collection or environment can be brought back with **Undo** or from *
  *Recently deleted** until you quit Kurlo.
  See [Restoring deleted items](/docs/guides/workspaces/#restoring-deleted-items).
- **Environment colors**: mark an environment red, amber, green, blue or gray, and the title bar switcher, environment
  lists and pickers show it. See [Coloring an environment](/docs/guides/environments/#coloring-an-environment).
- **Reorder requests by dragging** above or below another request in the same collection or folder.
  See [Reordering requests](/docs/guides/workspaces/#reordering-requests).
- **Autosave delay**: choose how long Kurlo waits after an edit before saving.
  See [Saving](/docs/guides/settings/#saving).
- **Skip TLS check on URL import** for specs served with a self-signed or internal certificate.
  See [From a URL](/docs/guides/import-export/#from-a-url).
- **Show in Finder / Explorer**: open the YAML file of a request or the folder of a collection from its menu.
  See [The request ⋯ menu](/docs/guides/workspaces/#the-request--menu).
- **Edit menu in text fields**: right-click a field or a code editor for Cut, Copy, Paste and Select all.
  See [Keyboard shortcuts](/docs/reference/keyboard-shortcuts/).
- **Kurlo docs in search**: the search palette offers the documentation first, and with a query it searches the docs in
  your browser. See [Command palette](/docs/guides/workspaces/#command-palette).

### Performance

Large workspaces, such as an OpenAPI import of 500 requests with 3,400 examples, are faster at every step:

- **Opening**: the workspace is read once, while the window is still loading, and examples load only when needed. The
  sidebar is filled about 0.5 s after launch.
- **Saving**: a save sends about a tenth of the data and opens about a fifth as many files.
- **Quitting and closing tabs**: nothing is written when nothing changed, and a closed tab disappears at once. Quitting
  a 1,300-request workspace takes about 0.3 s on macOS instead of 1–7 s.
- **Scrolling**: the sidebar and the Git panel no longer show blank patches on a fast fling, draw the visible rows
  first, and keep native trackpad momentum. Git history loads older commits as you scroll.
- **Idle**: a minimised window stops checking the workspace folder until you come back.

### Changed

- **Portable app for Windows**: the standalone `.exe` is now named `kurlo-<version>-windows-<arch>-portable.exe` and is
  on the download page. See [Installation](/docs/getting-started/installation/#windows).
- **OpenAPI servers import like Bruno**: requests use `{{baseUrl}}`; document servers become a collection variable, path
  and operation servers go into the request's **Vars** tab, and alternatives such as Sandbox are switched-off rows you
  can tick instead. See [From OpenAPI / Swagger](/docs/guides/import-export/#from-openapi--swagger).
- **Imported collections start collapsed**, and remember your later expand and collapse choices.
- **New requests start as drafts with manual saving**: **Add request** opens a draft that already uses the collection's
  and folder's settings, and **Save** puts it there. Untouched drafts close without asking.
  See [Creating a request](/docs/guides/workspaces/#creating-a-request).
- **Starred requests are personal**: stars stay on your machine instead of in request files and Git, and the group
  scrolls within ten rows. See [Starred (favourites)](/docs/guides/workspaces/#starred-favourites).
- **Search moved to the status bar**: open it from **Search** at the bottom right or with `Cmd/Ctrl K`.
  See [Command palette](/docs/guides/workspaces/#command-palette).
- **More room in the tab row**: close buttons appear on hover or keyboard focus without moving the tabs, and on Windows
  and Linux there is always a free spot to drag the window by.
  See [Window title bar](/docs/guides/settings/#appearance).
- **Code snippet is next to Send** in the URL row.
- **Panels fold in and out**: the sidebar, Agent mode's **Chat details** and **Code snippet** open and close smoothly;
  reduced motion disables the animation.
- **Sidebar context menus open right under their row**, and above it near the bottom of the window.

### Fixed

- **Protection against wiping a workspace**: Kurlo will not save over a workspace it could not read, or save a state
  that drops every workspace in the folder.
- **Locked workspaces explain themselves**: a missing workspace or collection file locks only its own workspace, and the
  overview shows which file needs fixing.
- **Imported requests that would not load**: a request whose description began with a line break, for example from an
  OpenAPI import, loads again after a restart.
- **OpenAPI import reads generator-written YAML** from Jackson, springdoc and similar tools.
  See [OpenAPI / Swagger](/docs/guides/import-export/#from-openapi--swagger).
- **No false unsaved dot** when opening a request with path variables.
- **Send errors** such as a TLS certificate error show at once.
- **Long URLs stay on one line**: the URL bar scrolls the text sideways instead of growing downwards.
  See [Your first request](/docs/getting-started/first-request/).
- **Concurrent saves** no longer mistake a file being replaced for a missing one.
- Sidebar rows no longer keep their hover look after dragging, the load test environment selector keeps a fixed width, *
  *Open log folder** works on Windows again, **All open tabs** shows its list again, and the macOS workspace switcher
  icons no longer shift by a pixel.

## 3.0.4

### Added

- **Filter JSON responses** with JSONPath or a jq-style path.
  See [Filtering a JSON response](/docs/guides/response-viewer/#filtering-a-json-response).
- **Saved WebSocket and Socket.IO messages**, kept with the request: up to 100 per request, with search.
  See [Saved messages](/docs/guides/request-types/#saved-messages).
- **Import a .env file** into an environment.
  See [Importing a .env file](/docs/guides/environments/#importing-a-env-file).
- **Fable 5.2** in the Claude Code model menu. See [Agent](/docs/guides/agent/).
- Ten new themes: GitHub Light, GitHub Dark Dimmed, JetBrains Light, JetBrains Dark, One Dark, Tokyo Night, Everforest,
  Flexoki Paper, High Contrast Light and High Contrast Dark.

### Removed

- Light Monochrome, Light Pastel, Dark Monochrome, Dark Pastel, Catppuccin Frappé and Catppuccin Macchiato. A saved
  choice moves to Light, Flexoki Paper, Dark, Everforest or Catppuccin Mocha.

### Changed

- **Supported macOS is now 15 Sequoia or later.** Kurlo still starts on macOS 12–14, but those versions are no longer
  tested. Windows and Linux are unchanged.
- Environments open one at a time; the **Matrix** is one click away, lets you pick its columns and stays smooth with
  hundreds of variables. See [Comparing environments](/docs/guides/environments/#comparing-environments).
- Cookies open as a sidebar section with a page per domain and Kurlo's own date and time picker for **Expires**.
- Workspace **Notes** became a **README**, kept as `README.md` in the workspace folder.
- Clearer workspace and collection overviews with rename in place and a **•••** menu.
- Environments, global variables, collection and folder settings and the README use the same **Revert** and **Save**
  buttons as a request. See [Settings](/docs/guides/settings/).
- Theme contrast and highlight colours are more consistent, and dialogs dim the window without blurring it.
- On macOS, the title area is one band across the whole window.
- Markdown previews over 256 KB show a note instead of freezing the screen.

### Fixed

- **Manual save covers environments, global variables and the workspace README.**
  See [Saving](/docs/guides/settings/#saving).
- **The Collection Runner no longer sends unchecked requests** when opened from the activity rail.
- **Network errors mask environment secrets** before they reach history or script results.
- In the **Matrix**, **×** no longer deletes a variable set in only one environment, and typing into a **Not set** cell
  keeps every character.
- A long name no longer pushes the top bar and editor off screen.
- A Claude Code CLI that signed out shows **Signed out** and a **Sign in** button in Settings → AI.
- A Socket.IO event sent with an empty message carries no arguments.
- Long names in the GraphQL field list and on the AI connection button are cut with an ellipsis.
- Background MCP, gRPC, HTTP and SSE results stay with their own request tab.
- Redirect limits, timeouts, proxy DNS errors, `pm.response.body` and NTLM traces behave correctly.
- Saving examples and failed metadata reads no longer change unrelated workspace files.
- The cookie editor, agent chat scrolling, Git diff file headers and list scrolling over row labels work as expected.

## 3.0.3

### Changed

- **Pinning environments.** The collection Overview shows only pinned environments and adds others from a search picker
  instead of a checkbox for every environment.
  See [Pinning environments to a collection](/docs/guides/environments/#pinning-environments-to-a-collection).

- **Environment switcher.** Scrolls with many environments and adds a search field above eight; environment dropdowns
  get search too. See [Switching environments](/docs/guides/environments/#switching-environments).
- **Steady scrolling.** Dropdown lists and panels no longer bounce past their edges.

### Fixed

- **Unsaved mark on new requests.** Undoing an edit in a request created from a collection's settings no longer leaves
  it marked as changed.

## 3.0.2

### Fixed

- **Exports without secrets.** Remove custom API keys, client-key passwords, proxy credentials and secrets in saved
  example requests; detect secrets in settings and examples before exporting.
- **Agent host approvals.** Check the actual destination after applying request and session variable overrides.
- **CLI and MCP collection variables.** Keep each collection's variables separate when running requests.
- **Environment changes during sends and runs.** Collection runs keep their original environment, and gRPC script
  updates stay with the environment that started the request.
- **gRPC scripts.** Honor `pm.execution.skipRequest()` and pass pre-request collection-variable changes to test scripts.
- **Compressed SSE responses.** Read events when an explicit `Accept-Encoding` header requests compression.
- **Duplicate request.** Keep pending edits in the source request when duplicating before autosave finishes.
- **k6 export.** Resolve templates in header names, API-key header names and URL-encoded field names without generating
  invalid JavaScript.
- **Long environment lists.** Keep rows at full height and let the sidebar list scroll, also after resizing the window
  or switching tabs.
- **Selecting a response.** Cmd/Ctrl+A in the response panel selects only the body, and a selection dragged from the
  body leaves warnings above it out.
- **Creating environments through the agent.** Create many environments with their variables in one batch; `values` or
  `variables` can be a list of rows or a `key: value` object. See [Batch edits](/docs/guides/mcp-server/#batch-edits).

## 3.0.1

### Added

- **Environments pinned to a collection.** Pin a collection's environments so the switcher shows only them while you
  work in it, select its default environment when you open it, and go back to your previous environment when you leave
  it. See [Pinning environments to a collection](/docs/guides/environments/#pinning-environments-to-a-collection).

## 3.0.0

### Added

- **Agent mode.** Ask the Kurlo agent on your own model, Claude Code or Codex in plain words to run requests, explain
  failures, write tests and import specs. It asks before every change, can follow an approved plan, work on its own Git
  branch and use your MCP servers, and keeps chats on this computer. See [Agent](/docs/guides/agent/).

- **Kurlo tools in AI requests.** Give an AI request's model Kurlo's read and run tools for the workspace, and pick
  which AI connection a **Kurlo connection** request uses. See [Kurlo tools](/docs/guides/request-types/#kurlo-tools).

- **Create PR from the Git screen.** Open a pull or merge request page for a pushed branch.
  See [Daily Git flow](/docs/guides/git-workspaces/#daily-git-flow).

- **AI connections.** Settings → AI connects OpenRouter by signing in, an Anthropic, OpenAI or compatible key, or a
  local Ollama or LM Studio model. Keys are encrypted and stay out of workspace files, and AI requests can use the
  default connection. See [AI](/docs/guides/settings/#ai).

- **Environment inheritance.** An environment takes the variables it does not set from a parent environment; the matrix
  shows where each value comes from.
  See [Inheriting from another environment](/docs/guides/environments/#inheriting-from-another-environment).

- **Folder defaults.** Folders set headers, auth, scripts and tests for the requests inside them, and Postman and Bruno
  folder auth and scripts import onto the folder.
  See [Folder defaults](/docs/guides/collection-defaults/#folder-defaults).

- **NTLM sign-in.** HTTP requests can use NTLMv2 auth. See [Authentication](/docs/guides/authentication/).

- **Suggestions while you type.** The URL field completes URLs from history and saved requests, and finds a request by
  name; a JSON body offers the next key from the request's examples. `Tab` accepts.
  See [Suggestions while you type](/docs/guides/request-types/#suggestions-while-you-type).

- **Rename environments from their names.** Edit the environment name directly in the editor, or double-click it in the
  sidebar. **Rename** focuses the name field; Enter or leaving the field saves, and Escape cancels.

- **Zoom in Settings.** **Settings → Appearance** has a **Zoom** row with −, + and **Reset**.
  See [Appearance](/docs/guides/settings/#appearance).

### Changed

- **Settings layout.** Every Settings page now shares one layout: a title, then grouped rows with the control on the
  right. General shows all settings at once, Proxy shows its server fields only when on, and the AI page shows Codex
  with its model and plan limits first. See [App settings](/docs/guides/settings/).

- **Cookie jar redesign.** Domains on the left, cookies in a table with expiry and flags, and an editor with **Fields**
  and **Raw** modes. The **Sync** tab uses Settings-style cards.
  See [Managing cookies](/docs/guides/cookies/#managing-cookies).

- **Linux window without the system title bar.** Kurlo draws its own title bar on Linux, like on Windows, and drops the
  GTK menu bar. `Ctrl Q` quits and zoom is in **Settings → Appearance**.

### Fixed

- **No scroll bars on a short AI prompt.** The **Prompt** field of an AI request fits a short request panel and scrolls
  only when its text does not fit. See [AI](/docs/guides/request-types/#ai).

- **A clear message when an AI request's saved key is missing.** Kurlo says the key from the Auth tab is not on this
  computer instead of showing an internal reference. See [AI](/docs/guides/request-types/#ai).

- **Open Settings → AI goes to the connections and models.** The model box and the request bar of an AI request open
  Settings → AI on **Kurlo agent**. See [AI](/docs/guides/request-types/#ai).

- **Close tab closes the Mock tab.** `Cmd+W` closes the Mock server tab like the other tabs.
  See [Mock server](/docs/guides/mock-server/#starting-it).

- **URL-encoded bodies keep the order of their fields.** Fields are sent in the order of the form instead of sorted by
  name.

- **Sending a request.** Fixed a rare crash to the error screen right after the first request was sent.

- **Inherited secrets.** Script changes in a child environment keep inherited variables secret, masked and outside
  workspace YAML.

- **OAuth and tab switching.** Tokens stay with the original request, Send keeps its original request and variables, and
  the runner uses refreshed tokens for HTTP and gRPC.

- **Digest redirects.** Authentication follows the forwarding setting and is blocked on HTTPS-to-HTTP redirects.

- **Workspace cookies.** Pending cookie updates cannot overwrite another workspace's jar after switching.

- **Cookies without their secret.** A workspace cookie whose secret value is missing on this computer is no longer sent
  as `{{kurloSecret:…}}` text; the Cookies window marks it *no value*.

- **Saved runner results.** Totals and verdicts cover the full run; the 500 retained details prioritize failures, and
  limited details are labelled in the runner and HTML report.

- **Mock server headers and `HEAD`.** Repeated headers such as several `Set-Cookie` lines are all replayed, and `HEAD`
  is answered from the `GET` example.

- **Variables in MCP tools and runner gRPC.** An AI request's MCP tools resolve their own collection variables and
  globals, and gRPC requests in the runner see globals set earlier in the run.

- **cURL `--data-raw '@…'`.** The body is imported as text instead of a file.

- **AI requests in Git workspaces.** Workspace YAML accepts provider strings, so requests using the default Kurlo
  connection or a custom provider can load.

- **Owner-only variable exports.** `kurlo run --export-environment` and `--export-globals` write owner-only files on
  Unix, including when replacing an earlier export.

- **What's new dialog and update flow.** The dialog closes with Escape, and blocked browser storage no longer breaks the
  update check or the automatic install.

- **Manual request names.** The collection tree and starred list keep the saved name until you save a rename.

- **Environment actions dismiss normally.** Click outside the menu or press Escape to close it. The editor no longer
  duplicates environment switching with an **In use** or **Use environment** button; use the top bar or sidebar.

- **Selectable chat text on macOS and Linux.** AI request messages can be selected and copied again.

- **Primary icon buttons.** The icon on buttons such as **Send** in an AI request is no longer faint grey.

- **Dropdowns near the window edge** open towards the left instead of running off-screen.

- **No browser tooltips.** The grey hover tooltips are gone throughout the app.

- **No browser tooltips on folding arrows in code editors.** The arrows that fold and unfold lines no longer show a
  native "Fold line" tooltip.

- **Desktop scrollbars.** Transparent tracks and inset handles keep scrollbars from ending in a visible strip at panel
  edges.

- **Consistent add and close icons.** Plus and close icons have the same size and stroke across tabs, dialogs, panels,
  and the sidebar.

- **Collection test hint.** The Tests tab now says the collection script runs after each request's own tests.

- **Status bar alignment.** The branch name and the change count of the Git status sit on one baseline.

- **Globals Secret button.** Its highlight covers the whole word.

- **Storage indicator.** The local storage label and badge are centred and fit inside the status bar.

## Older releases

Notes for 2.0.0 through 2.6.1 are in [Release notes 2.x](/changelog/v2/), and notes for 1.0.0 through 1.8.1 are in
[Release notes 1.x](/changelog/v1/).
