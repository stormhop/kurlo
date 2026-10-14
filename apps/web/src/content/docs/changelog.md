---
title: Release notes
description: Notable Kurlo changes and links to the exact notes for each published release.
tableOfContents:
  maxHeadingLevel: 2
---

This page summarizes the notable-change log maintained in the source repository. For the exact notes and artifacts attached to every published tag, use the [Kurlo releases page](https://github.com/stormhop/kurlo/releases).

## Unreleased

### Fixed

- **Long release notes no longer hide the update button** in Settings → About.

## 2.3.0

### Added

- **AI agents can keep your collections up to date.** `kurlo mcp` can create collections, add and change saved requests with their `pm.*` tests, save responses as examples and set environment variables, writing the same YAML the app does. Secrets are never written. See [Writing to the workspace](/docs/guides/mcp-server/#writing-to-the-workspace).
- **Your agent sees what you just sent.** `list_history` and `get_history_entry` read the requests you send from the app, with responses, tests and logs, secrets masked. See [What you just sent from the app](/docs/guides/mcp-server/#what-you-just-sent-from-the-app).
- **`kurlo mcp install`** adds Kurlo to Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf and Gemini CLI in one command, or to a repository's shared config with `--project`. See [Connect an assistant](/docs/guides/mcp-server/#connect-an-assistant).
- **Protected environments** that AI agents cannot send requests with or change. See [Environments](/docs/guides/environments/#protecting-an-environment-from-ai-agents).
- **Docs for language models**: [llms.txt](/llms.txt) and [llms-full.txt](/llms-full.txt).

### Changed

- **A token that is only a `{{variable}}`** stays in the shared YAML instead of moving to the encrypted local file, so a cloned workspace works with your own environment.

### Fixed

- **Files changed outside Kurlo are no longer overwritten.** The app reloads changes made by `kurlo mcp`, an editor or `git pull` within a second, and a save that races with one keeps both.

## 2.2.6

### Added

- **The cookie sync extension comes with the app.** In Cookies → Sync cookies, pick your browser and Kurlo puts the extension in a folder with the steps to load it, at the same version as the app. Releases also attach it as a zip. See [Cookies](/docs/guides/cookies/).
- **`kurlo mcp` lists the variables a request was missing** in `unresolvedVariables`. See [MCP server](/docs/guides/mcp-server/).

### Changed

- **Updates moved into About**, with the update state, one action, automatic install and release notes in one place.
- **Large workspaces open, search and save much faster**: 10,000 requests appear in about a second instead of 24, and importing them saves in seconds instead of minutes on macOS.
- **Workspace files no longer carry `createdAt` and `updatedAt`**, so reloading no longer changes cookie timestamps in Git.

### Fixed

- **No more changes you never made after opening a workspace, switching branches or pulling.**
- **An interrupted save can no longer lock the workspace or lose a new secret.**
- **Bruno, OpenCollection and Insomnia exports keep `{{variables}}` and scripts.**
- **Save to file keeps binary responses intact.**
- **Cancelling and resending, or switching environments mid-request, no longer mixes up results.**
- **Search covers Starred requests**, and the **GraphQL explorer** shows arguments and every field of the schema.

## 2.2.5

### Added

- **The command line is on npm: `npx -y @kurlo/cli`.** `kurlo run` and `kurlo mcp` work without the desktop app, on macOS, Linux and Windows. An AI agent connects with `claude mcp add kurlo -- npx -y @kurlo/cli mcp`, and CI runs a workspace with `npx -y @kurlo/cli run ./workspace --env CI`. See [MCP server](/docs/guides/mcp-server/) and [CLI runner](/docs/guides/cli-runner/).
- **AI assistants can check a call the way a browser would.** `run_request` and `send_request` take `browserOrigin` and report the CORS error a browser on that page would raise. See [Checking a call the way a browser would](/docs/guides/mcp-server/#checking-a-call-the-way-a-browser-would).
- **`list_requests` searches** with `query`, **`get_request` shows saved examples** and the browser settings in effect, and **`run_collection` reports progress** after every request.

### Fixed

- **`kurlo run` and `kurlo mcp` now honor browser emulation.** Requests with Enforce CORS or CSP on, by themselves or through their collection, were sent as plain requests. A CORS or CSP refusal now fails the run, as it would in the browser.

## 2.2.4

### Fixed

- **On Linux, closing the window quits Kurlo.** It used to hide the window and keep running with no way back, and opening Kurlo again could bring back a blank window. Windows quits on close too; macOS keeps the app in the Dock as before.
- **Quit works when the window has stopped responding.** If the window does not answer within five seconds, Kurlo quits anyway. A window still asking whether to save your changes is never cut short.
- **Restart after an update reopens Kurlo** on Windows, where the new version started hidden, and on Linux, where it did not start at all.
- **The Linux AppImage installs updates.** Kurlo replaces the `.AppImage` file it was started from, so keep it in a folder you can write to. AppImages from 2.2.3 and earlier cannot update themselves: download 2.2.4 by hand once. See [Installation](/docs/getting-started/installation/#auto-updates).

## 2.2.3

### Changed

- **A new landing page** shows how to bring a Postman, Insomnia or Bruno collection across, which features other clients keep behind a paid plan, and a dated side-by-side comparison of Kurlo, Postman, Insomnia and Bruno. `kurlo.dev/pricing` answers with a 404, because there is nothing to buy.

### Fixed

- **The Linux AppImage starts on Ubuntu 24.04 and later.** Linux builds now use WebKitGTK 4.1, available on Ubuntu 22.04 and later, Debian 12 and later and Fedora 37 and later. Ubuntu 20.04 and Debian 11 are no longer supported. See [Installation](/docs/getting-started/installation/#linux) for the packages to install.

## 2.2.2

### Fixed

- **A fresh install no longer opens on "Folder missing"** before the first save creates the default workspace folder.
- **Kurlo can always be closed:** when the last save fails, it asks whether to quit without saving.
- **Moving Kurlo's data folder no longer leaves the default workspaces "missing"**, and a missing workspace folder can switch back to Kurlo's built-in storage in one click.

## 2.2.1

### Fixed

- **The macOS disk image window no longer scrolls** when Finder shows hidden files.
- **The download buttons on this site** show a new release as soon as it is published.

## 2.2.0

### Changed

- **A new app icon:** a pigeon in Kurlo's blue, in the app, the installers, the browser extension and on this site.
- **The macOS disk image is quieter and sharp on Retina displays** — a small wordmark, an arrow to Applications and one line of instructions.
- **The Windows installer artwork follows the new icon.**
- **The documentation lives only at [kurlo.dev](https://kurlo.dev).**

## 2.1.1

### Added

- **AI assistants can use Kurlo as tools.** `kurlo mcp` runs the desktop binary as a Model Context Protocol server, so Claude, Cursor and other MCP clients can list your requests and environments, run a saved request or a whole collection, and send one-off calls with your `{{variables}}`. Values a script sets carry over to later calls, and secret values are masked in everything the assistant gets back. See [MCP server](/docs/guides/mcp-server/).

### Changed

- **The installers look like Kurlo.** The Windows installer is a modern wizard with Kurlo's artwork and a quieter install, and the macOS disk image has a branded background laid out for dragging the app to Applications.
- **The site moved to [kurlo.dev](https://kurlo.dev)**, and its download button now downloads the right file for your platform instead of opening the releases page.

### Fixed

- **Importing a `.env` file keeps backslashes**, so Windows paths such as `C:\new\tmp` survive.
- **`kurlo run` no longer crashes on a very large `--iterations`.**
- **Swift snippets** encode multipart field names with a backslash or quote the way browsers do.
- **The cookie-sync dialog's guide link** opens *Connecting a browser* instead of the top of the page.

### Security

- **The client key passphrase is no longer saved in plain text by *Save as default*.** A passphrase an earlier version stored is removed on the next launch.

---

## 2.1.0

### Added

- **Kurlo opens on the request editor** — your tabs, or a new request when there are none. *Settings → General → On launch* can reopen **Where you left off** or always start on the **Workspace overview**. See [Settings](/docs/guides/settings/).
- **Zoom.** `Cmd/Ctrl =`, `Cmd/Ctrl −` and `Cmd/Ctrl 0` scale the whole window from 80% to 150%, as in Postman; on macOS they are also in the new **View** menu. See [Keyboard shortcuts](/docs/reference/keyboard-shortcuts/).
- **Browser emulation goes further.** The Headers tab marks the response headers page code cannot read under CORS, a page on HTTPS is checked for mixed content, and a request from a public page to a loopback or private address warns about Local Network Access. See [Browser security](/docs/guides/browser-security/).

### Changed

- **One look across the app.** Text, buttons, fields, menus, tabs, dialogs, checkboxes and empty states come from one set of sizes, weights, corners and spacing, so the same control looks the same on every screen. Destructive actions and status colours follow the theme, and the last system checkboxes and radio buttons are gone.

### Fixed

- **CORS follows every redirect** — the redirect must pass CORS, a new origin is preflighted, cookies and `Authorization` are dropped as a browser drops them — and header values are checked as the Fetch standard does. A redirect on the same host keeps `Authorization`.
- **Variables resolve as expected.** Globals reach `{{...}}`, a value set by a pre-request script is used in the same send, names with non-Latin letters, spaces or colons resolve, the Collection Runner hands scripts the data row, and `kurlo run` resolves nested variables. See [Environments](/docs/guides/environments/).
- **A timeout of `0` waits as long as the server takes**, in the app and in `kurlo run`. See [Request settings](/docs/guides/request-settings/#timeout).
- **Large responses scroll without blank frames** on the scrollbar, the trackpad and the keyboard, and **response search** highlights matches across a key and its value.
- **Arrow keys stay where you are.** In a response, a dialog or Settings they no longer switch the request in the sidebar, and `↓` in Settings no longer skips a section.
- **Streaming and sockets:** a `POST` to an event-stream endpoint shows the stream, SSE follows the event-stream specification, a quiet WebSocket with keep-alive off stays open, handshake headers copied from DevTools no longer break connections, and Socket.IO shows binary events.
- **Pasted cURL commands and generated snippets** keep the body — `-d`, `--json`, `$'...'` quoting, `-d @file` — and the snippets run as generated in every language. See [Code generation](/docs/guides/code-generation/).
- **Also:** the mock server replays compressed examples, a hand-written multipart `Content-Type` no longer loses its boundary, force push refuses to overwrite commits it has not seen, common legacy Postman script helpers work, OpenAPI import honours servers on a path or operation, and the Runner's checkboxes stay checked during a run.

---

## 2.0.3

### Changed

- **A new request opens straight away as HTTP.** The `+` in the tab bar, `Cmd/Ctrl N` and **Add request** no longer ask for a protocol first. Switch protocol in the picker at the start of the address bar — on a saved request until it has a URL — or run **New GraphQL request**, **New WebSocket request** and the rest from the command palette. See [Request types](/docs/guides/request-types/).
- **Shortcuts are drawn as keys** in Settings, the command palette and the hints — `⌘ ⇧ ⌥` on macOS; `Ctrl`, `Alt`, `⇧ Shift` and the Windows logo on Windows.
- **The Windows installer no longer asks for administrator rights.** It installs for the current user, so there is no UAC prompt and the in-app updater can replace the app. It offers to remove an older all-users copy; your data is kept. See [Installation](/docs/getting-started/installation/#windows).
- **The Windows icon fills its space** on the taskbar and in the Start menu instead of sitting inside the macOS margin.

### Fixed

- **Updating the MSIX install failed with a permission error.** Kurlo now recognises the packaged install and offers the new `.msix` for this machine instead of trying to replace itself.
- **Some shortcuts never fired on Windows and Linux** — *Reopen closed tab*, *Toggle right sidebar*, *Switch to next/previous tab* and *Force close tab*. Shortcuts also follow the physical key now, so they work on Cyrillic and other non-Latin layouts.
- **`Cmd/Ctrl+Enter` in a WebSocket or Socket.IO message dropped the connection**, and in a gRPC message invoked the method twice. It sends once now.
- **Shortcut hints ignored your own bindings**; they show the current binding now.
- **Some text kept the previous theme's colour** — the *Mock server* heading stayed black after switching to Nord — and **buttons on light accents were hard to read** in Nord, the dark Catppuccin flavours, Dark Pastel and Dark Monochrome.
- **Full release notes did nothing** in *What's new*; it opens the release page now.

---

## 2.0.2

### Added

- **Kurlo runs on Windows on Arm.** Releases now carry an Arm64 installer and MSIX package beside the x64 ones; the x64 installer refused to start on Arm machines. See [Installation](/docs/getting-started/installation/#windows). ([#34](https://github.com/stormhop/kurlo/issues/34))
- **A middle click closes a tab**, as in a browser — request tabs and the Runner, Git, Mock, collection and History tabs. A tab with unsaved changes still asks first.

### Fixed

- **Enter in the URL field did nothing.** It now sends the request, or connects a WebSocket, Socket.IO or SSE request. It never cancels a request in flight or drops a live connection, and it still picks a suggestion while the variable list is open.

---

## 2.0.1

### Fixed

- **An update on macOS left the old icon behind.** The in-app updater replaced only the program inside `Kurlo.app`, so the icon and the version Finder shows stayed from the day Kurlo was first installed. Updates now replace the whole signed app, and a copy that was updated the old way repairs itself on its next start — the new icon appears from the launch after that.
- **Every release called itself 1.0.0 to the operating system.** The release build stamped its real version into the program but never into the app's own description, so Finder and *About This Mac* on macOS, and the file properties and *Apps & features* on Windows, showed 1.0.0 whatever version was installed. They show the actual version now.

---

## 2.0.0

Kurlo 2.0 is a new look — the Graphite design, from the window chrome to every screen, menu and dialog — plus MCP requests, a command palette, a page for each history entry and the last run of each collection. It needs macOS 12 or later.

### Added

- **MCP is a request type.** Point Kurlo at a Model Context Protocol server, press *Discover*, pick a tool, fill the arguments from its schema and send — and read the raw JSON-RPC exchange that went over the wire. An MCP call is an ordinary saved request: diffed in review, run by the collection runner, asserted on by a test script. See [Request types](/docs/guides/request-types/#mcp).
- **A command palette.** `Cmd/Ctrl K` finds a saved request and also runs Kurlo's commands — send, save, duplicate, copy as cURL, create, import, jump to any view, change the layout or theme. See [Workspaces](/docs/guides/workspaces/#command-palette).
- **Environments side by side.** A *Matrix* view puts every variable in a row and every environment in a column, edited in place. See [Environments](/docs/guides/environments/#comparing-environments).
- **A page for each history entry**, with what was sent next to the stored response. See [Request history](/docs/guides/history/#the-entry-view).
- **Each collection remembers its last run**, shown in the runner and on the collection's page. See [Collection Runner](/docs/guides/collection-runner/#last-run).

### Changed

- **The Graphite design.** Neutral greys with hairline borders, colour kept for what carries meaning — methods, status codes, variables — and the accent only on the primary action. An activity rail replaces the sidebar's section labels, tabs sit in the title bar, the method lives inside the URL field, and the response opens beside the request in a wide window. Every screen, menu and dialog was brought to it, and every screenshot in these docs was retaken.
- **A new app icon** — two offset chevrons in the brand blue — on the Dock, the installer, the start-up screen and these pages.
- **Kurlo needs macOS 12 Monterey or later**, with the system WebKit from Safari 16.2 or newer. Windows and Linux are unchanged.

### Fixed

- A dropdown inside a labelled field reopened after an option was picked on macOS. The end-to-end suite now also runs in WebKit, the engine Kurlo uses there.
- A stored history response over 2 MB could not be read back.
- Response line numbers fell behind the text while scrolling fast on macOS, and a sideways scroll could strand them in the middle of a wide response.

## Older releases

Notes for 1.0.0 through 1.8.1 are in [Release notes 1.x](/changelog/v1/).
