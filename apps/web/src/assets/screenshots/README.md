# Documentation screenshots

Screenshots in this directory are referenced by the guide pages and optimized by Astro during the site build.

## Reproducible capture

The desktop frontend's full Playwright flow can populate the core guide screenshots with deterministic mock data:

```bash
make screenshots
```

Capture mode writes only when `KURLO_DOCS_SCREENSHOT_DIR` is set; a normal E2E run does not
modify documentation assets.

Three rules keep the set consistent, and all three live in `captureDocsScreenshot`:

- **A 1200×780 light-theme viewport, captured at 2× device pixels** (so the files are
  2400×1560). The docs column is 800px wide, so a wider *layout* is downscaled until its UI
  text stops being readable — 1200 is the narrowest width the app still lays out normally,
  its only breakpoint being 700px. The pixel density is separate: most displays showing
  these pages have two device pixels per CSS pixel, and a 1× capture has nothing to give
  the second one. `playwright.config.ts` switches `deviceScaleFactor` to 2 only when
  `KURLO_DOCS_SCREENSHOT_DIR` is set, so ordinary E2E runs are unaffected.
- **A modal is cropped to itself**, plus 26px of the app behind it. A settings dialog inside
  a full-window shot is unreadable at page scale; on its own it renders close to 1:1. Any
  `[role="dialog"][aria-modal="true"]` is detected and cropped automatically, and a capture
  can name another element to crop to.
- **The app frame is scrolled back to the top first.** `html`, `body` and `#app` are
  `overflow: hidden`, which browsers still scroll programmatically, so an earlier
  `scrollIntoView` would otherwise push the app out of frame and fill the rest of the shot
  with page background.

## Suggested set

Each guide page benefits from at least one screenshot. To take the doc site from "good text" to "great visual", capture and save:

| Filename                       | Where shown                                  | What to capture                                              |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------ |
| `request-editor.png`           | First request guide                          | Filled URL + Send button + bottom response                   |
| `headers-tab.png`              | First request guide                          | Headers tab with 2–3 rows                                    |
| `auth-bearer.png`              | Authentication guide                         | Auth tab with Bearer selected and a masked environment token |
| `auth-oauth2-token-fetch.png`  | Authentication guide                         | OAuth2 client-credentials section with `Fetch token` button  |
| `environments-panel.png`       | Environments guide                           | Environment editor with 4–5 variables, one secret            |
| `workspace-overview.png`       | Workspaces guide                             | The full workspace overview with notes + quick actions       |
| `git-workspace.png`            | Git workspaces guide                         | Git tab with branch, changed YAML files, and diff preview    |
| `sidebar-collections.png`      | Workspaces guide                             | Sidebar with collections, folders, and a starred request     |
| `response-viewer-json.png`     | Response viewer guide                        | JSON response with syntax highlight + line numbers           |
| `response-viewer-search.png`   | Response viewer guide                        | Active search highlighting matches in a body                 |
| `response-viewer-large-body.png` | Response viewer guide                      | Large response paging / virtualization controls              |
| `response-viewer-tests.png`    | Response viewer / Scripting guides           | Test-results panel with assertions and script output         |
| `request-settings.png`         | Per-request settings guide                   | Settings tab open showing toggles                            |
| `request-graphql.png`          | Request types guide                          | GraphQL editor with a successful JSON response               |
| `request-sse.png`              | Request types guide                          | SSE stream connected with several events                     |
| `request-websocket.png`        | Request types guide                          | WebSocket connection with sent and echoed messages           |
| `request-socketio.png`         | Request types guide                          | Socket.IO event emit with acknowledgement                    |
| `request-grpc.png`             | Request types guide                          | gRPC method selection and response messages                  |
| `history.png`                  | Request history guide                        | History panel with grouped days                              |
| `scripting-pre-request.png`    | Scripting guide / Scripting API reference    | Pre-request script with `pm.request.headers.set(...)`        |
| `scripting-tengo.png`          | Scripting guide / Scripting API reference    | Tengo pre-request script and reference snippets              |
| `import-postman.png`           | Migration guide                              | Sidebar import dialog                                        |
| `cookie-jar-populated.png`     | Cookies guide                                | Cookie jar with a saved domain cookie                        |
| `code-snippets.png`            | Code generation guide                        | Side panel with `curl` selected                              |
| `settings-general.png`         | (optional) generic Settings reference        | Settings modal General tab with collapsible cards open       |
| `settings-shortcuts.png`       | Keyboard shortcuts reference                 | Settings → Shortcuts list                                    |

## Capturing tips

- Prefer the automated capture flow for screens it covers.
- Capture at 2× device pixels to match the automated set; Astro optimizes the delivered images.
- Match the automated set: 1200×780 for a whole window, cropped tight for a dialog or a
  single panel. Narrow fragments such as `sidebar-collections.png` and `status-bar.png` are
  captured from their own element.
- Use one theme consistently within a guide. The automated set uses the light theme.
- Redact tokens / personal data in image editor before committing.
- Save as PNG. Filenames lowercase-kebab-case.

## Referencing from docs

Once a file is in this directory, import it from a guide:

```mdx
import responseViewer from '../../../assets/screenshots/response-viewer-json.png';
import { Image } from 'astro:assets';

<Image src={responseViewer} alt="JSON response with line numbers and syntax highlight" />
```

Astro's image pipeline will optimize and serve responsive variants automatically.
