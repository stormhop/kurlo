---
title: Import & export
description: Move collections and workspaces between Kurlo, Postman, Insomnia, Bruno/OpenCollection, OpenAPI, HAR, curl, and Git.
---

Kurlo supports both one-off interchange formats and full Kurlo backups. Imports are non-destructive unless you explicitly choose the all-data restore path.

## Supported sources

| Source | What Kurlo imports |
|--------|--------------------|
| Postman Collection v2.1 | Collections, nested folders, requests, auth, bodies, GraphQL, scripts, collection variables, and request documentation. Environment and globals exports import through the same picker. |
| Insomnia v4 JSON | Workspaces, folders, requests, auth, bodies, and environments. |
| Bruno/OpenCollection | Collections, explicit empty folders, requests, GraphQL, and supported metadata. |
| OpenAPI/Swagger | From a file or a URL. HTTP/SSE requests generated from operations, plus the collection defaults that make them sendable: the server becomes a `{{baseUrl}}` variable, path parameters become the request's path variables seeded from the spec's examples, and declared security schemes become the request's auth. |
| HAR | Captured HTTP requests. |
| `.http` / `.rest` | JetBrains HTTP Client and VS Code REST Client files: requests, names, headers, bodies, and file variables. |
| cURL | A single request pasted into the URL bar, including the flags that map onto a request setting — `-k`, `--max-time`, `--proxy` — and a form part's `;type=`. |
| Kurlo all-data backup | Workspaces, collections, environments, requests, history, cookies, and selected UI/request preferences. |
| Kurlo Git/YAML workspace | Reviewable workspace files with local-only secrets. |

![Import source selector with Postman, Insomnia, OpenAPI, HAR, and Bruno options](../../../../assets/screenshots/import-postman.png)

## From Postman

Kurlo reads Postman Collection v2.1 — the JSON export, not the cloud-sync format.

1. In Postman: right-click the collection → **Export** → choose v2.1.
2. In Kurlo: click the **import** icon in the sidebar header (next to **+**) and pick the JSON file — or drag the file onto the sidebar.
3. Kurlo creates a new collection in the current workspace, preserving the folder tree.

What carries over:

- Folder hierarchy — including folders that hold no requests — request names, methods, URLs.
- Headers, query params, path variables (`:id` and its value), body (JSON, form-data, raw, urlencoded).
- Pre-request and test scripts. JavaScript scripts map to Kurlo's sandboxed JavaScript fields; legacy Tengo fields remain available for existing requests.
- Request descriptions, which become the request's **Docs** tab.
- Collection-level variables, auth, and scripts, which become the collection's [defaults](/docs/guides/collection-defaults/). A request that declared no auth of its own is set to **Inherit auth**, so the collection's auth applies exactly as it did in Postman.
- The whole OAuth 2.0 configuration, not just a stored access token: grant type, authorization and token URLs, client id and secret, scope, audience, and refresh token.

Folders in Postman can carry their own scripts. Kurlo has no folder layer, so a folder's script is copied into each request it contains, marked with a `// --- from Postman folder "…" ---` comment.

### Environments and globals

Postman exports environments and globals as separate JSON files. Pick **Postman collection** in the import dialog and choose one of those files — Kurlo recognises it and imports it as an environment (made active) or merges it into **Globals**. Values Postman marked as secrets stay marked as secrets.

What doesn't carry over:

- Postman cloud Monitors. Cloud **Mock Servers** do not come across as such, but the saved responses they were built from import as [examples](/docs/guides/examples/), which Kurlo's own [mock server](/docs/guides/mock-server/) serves locally.
- Visualizer scripts.
- Variable types beyond string/secret.

## From OpenAPI / Swagger

Pick **OpenAPI / Swagger** and choose a JSON or YAML spec. Kurlo builds one request per operation, grouped into folders by the operation's first tag, with the summary as the request name and the description as its Docs tab.

The point is a collection you can send straight away, so three things land on the collection rather than being baked into each request:

- **The server** becomes a `baseUrl` collection variable, and every request URL starts with `{{baseUrl}}`. Retargeting the whole import at staging is one edit. When the spec declares more than one server, the others are recorded in the variable's description.
- **Path parameters** become [path variables](/docs/guides/request-types/#path-variables): `/users/{userId}` imports as `/users/:userId`, with the value seeded from the spec's `example` or `default` in the request's **Params** tab. A parameter that is only part of a segment, such as `/files/{name}.json`, cannot be a path variable and becomes a collection variable instead.
- **Security schemes** become auth. A scheme declared for the whole document lands on the collection and each request is set to **Inherit auth**; an operation with its own `security` carries that instead, and `security: []` means the operation is public. HTTP basic, digest and bearer, API keys (with the name and location the spec gives), and OAuth 2.0 (with its token and authorization URLs and scopes) are mapped. The credentials themselves are not in a spec, so each one points at a collection variable — `{{bearerToken}}`, `{{apiKey}}`, `{{oauth2ClientSecret}}` — giving you one place to fill in.

`openIdConnect` is left as **No auth**: its endpoints can only be discovered by fetching the provider's configuration, which the importer does not do.

Declared `responses` come across as [examples](/docs/guides/examples/), including a body derived from the response schema when the spec writes none — which means an imported spec can drive the [mock server](/docs/guides/mock-server/) straight away.

### From a URL

Pick **OpenAPI / Swagger from URL** and paste the link. A spec URL is what teams actually pass around, because it is the one that stays current, and Kurlo builds exactly the collection the file import would.

The document is fetched by Kurlo itself rather than by the embedded browser, so a spec host that sends no CORS headers still works, redirects are followed, and your [proxy](/docs/guides/proxy/) and TLS settings apply. A link with no scheme is read as `https`, and no cookies are sent.

The collection is named from the spec's `info.title`. When the spec has none, Kurlo falls back to the host rather than to a path segment like `/v3/api-docs`, which names the format instead of the API.

One mistake is common enough to name: **linking to the Swagger UI page rather than the document it renders**. The page is HTML, and Kurlo says so and points at where the document usually lives — `/swagger.json`, `/openapi.json` or `/v3/api-docs` — instead of reporting a parse failure.

## From a `.http` / `.rest` file

Pick **.http / .rest file** in the import dialog. Kurlo reads the format shared by the JetBrains HTTP Client and the VS Code REST Client:

```http
@baseUrl = https://api.example.com

### List orders
GET {{baseUrl}}/orders?status=open
Accept: application/json

### Create order
# @name createOrder
POST {{baseUrl}}/orders
Content-Type: application/json

{ "sku": "KURLO-1" }
```

- `###` separates requests, and the text after it becomes the request name. A `# @name` directive takes priority.
- File variables (`@baseUrl = …`) become collection variables, so `{{baseUrl}}` keeps resolving after import.
- A bare URL line is treated as `GET`, and a trailing `HTTP/1.1` is ignored.
- `WEBSOCKET` requests and the `X-REQUEST-TYPE: GraphQL` header map to Kurlo's WebSocket and GraphQL request types.
- `< ./body.json` and `> ./out.json` reference files the importer cannot read. Kurlo records them in the request's Docs tab instead of dropping them silently, as it does for JetBrains response-handler scripts (`> {% … %}`), which use an API Kurlo does not run.

## From curl

Paste a curl command directly into the URL bar of a new request. Kurlo parses:

- Method (`-X`)
- Headers (`-H`)
- Body (`-d`, `--data-raw`, `--data-binary`)
- Basic auth (`-u`)
- Multipart fields (`-F`)

URL-only curl commands work too — `curl https://api.example.com/users` becomes a GET request.

## From Bruno/OpenCollection

Kurlo imports OpenCollection-style folders and request files. Empty folders are preserved explicitly, so a folder can exist before it contains a request.

Kurlo's OpenCollection export writes:

- `folder.yml` files for explicit folder paths.
- HTTP and GraphQL requests.
- Request-level scripts, settings, auth, params, headers, and bodies where the format supports them.

## Git-backed YAML workspaces

For team sharing, prefer Kurlo's Git/YAML storage over repeated JSON exports. It stores workspace state as plain YAML files:

- `kurlo.yml` and `workspaces/**/*.yml` are shared.
- Sensitive values become `{{kurloSecret:...}}` placeholders; the real values remain in Kurlo's encrypted local profile outside the repository.
- Folder hierarchy is represented by `request.folderPath` plus `collection.folderPaths`, so empty folders survive round-trips.

See [Kurlo YAML format](/docs/reference/kurlo-yaml-format/) for the public contract.

## All-data backups

Use **Settings -> General -> Advanced data -> Export all data** for a Kurlo-to-Kurlo profile backup. Unlike collection interchange formats, it includes history, cookies, all local workspaces, and selected preferences.

The file is plaintext and can contain secrets. Import replaces the current local profile rather than merging it. See [Backup & recovery](/docs/guides/backup-recovery/) for the exact contents, exclusions, recovery-key behavior, and a safe restore procedure.

## Export

Kurlo can export a collection as Postman v2.1, OpenAPI, or OpenCollection, and can export its workspace data plus selected preferences as an all-data backup.

Secrets marked as **secret** are stripped, redacted, or kept as Kurlo secret placeholders depending on the target format. Git/YAML workspaces keep the real values in Kurlo's encrypted local profile, outside shared files.

## Sharing within a team

For day-to-day collaboration:

1. Use Git-backed YAML workspace storage.
2. Commit `kurlo.yml`, `.gitignore`, and `workspaces/**/*.yml`.
3. Keep `{{kurloSecret:...}}` placeholders intact; Kurlo resolves them from each user's encrypted local profile.
4. Use import/export formats only for interoperability with another client.

For environment-specific variables, keep non-secret defaults in the workspace and put real secret values in local secrets.
