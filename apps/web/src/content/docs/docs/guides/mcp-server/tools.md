---
title: "MCP tools"
---

## Tools

| Tool | What it does |
|------|--------------|
| `list_requests` | Lists saved requests with their path (`Collection/Folder/Name`), id, protocol, method and URL. Can be filtered to one collection, and searched with `query`: every word has to appear in the path, method or URL, so `post orders` finds `POST /orders`. |
| `get_request` | Shows how one request is defined: method, URL, query parameters, headers, body, auth type, scripts and browser settings, plus its saved [examples](/docs/guides/examples/) with their status, content type and body, so the assistant can compare a live response with the expected one. Credentials are left out: secret rows show `<secret>`, and a value typed straight into an `Authorization`, `Proxy-Authorization`, `Cookie` or `X-API-Key` header shows `[secret]`. A header that holds only a `{{variable}}` is shown as written. |
| `list_environments` | Lists environments and their variables. Secret values are hidden, and a variable linked to a secret manager shows `[secret from <provider>]`. |
| `check_openapi_sync` | For a collection connected to an [OpenAPI source](/docs/guides/openapi-sync/), downloads the current spec and lists the operations added, changed, moved or removed since the last sync applied in Kurlo. It changes nothing; you review and apply the changes in the app. Protected environments cannot be used to resolve the source URL. |
| `run_request` | Sends a saved HTTP, GraphQL, unary gRPC, MCP or AI request. HTTP responses include timings, redirects and TLS details. For MCP, pass `mcpMethod` as `tools/list` or `tools/call`. Pass `mcpName` and `mcpArguments` to call a tool, and `mcpCursor` to read another page. |
| `run_collection` | Runs HTTP, GraphQL and unary gRPC requests in order, with per-request results and assertions. Use `iterations`, `delayMs`, `failFast` and a workspace-relative CSV or JSON `dataFile`. A data file runs one iteration per row. Pass a `progressToken` for progress after each request. |
| `send_request` | Sends an unsaved HTTP request. `{{variables}}` in the URL, headers and body are resolved from the environment. |
| `list_history` | Lists the requests you recently sent from the Kurlo app, newest first, with status, timing and the saved request each came from. Can be searched, or narrowed to failures. |
| `get_history_entry` | Shows one request you sent from the app and the response you got: status, headers, body, error, test results and script logs. Without an entry it shows the last one. |
| `diagnose_last_failure` | Explains why a request sent from the app failed. See [When a request fails](/docs/guides/mcp-server/diagnostics/#when-a-request-fails). |
| `import_preview`, `import_apply` | Preview imported YAML, then confirm and apply that preview. |
| `list_files`, `read_file`, `search_code` | List, read or search the read-only source folder supplied with `--project-root`. |
| `get_docs`, `save_docs` | Read or replace Markdown docs for a saved request or collection. |
| `code_snippet` | Generate a snippet in cURL, HTTPie, JavaScript, Node.js, Axios, Python, Go, Java, C#, PHP, Ruby, Swift, Kotlin or Rust. |
| `sync_collection`, `cover_endpoint` | Get a workflow for using the connected source folder to update collection coverage. |
| `list_load_tests`, `get_load_test`, `save_load_test` | List, read or save a collection's load tests. Omit the test ID to create a test, or keep it to replace its definition. |
| `start_load_test`, `load_test_status`, `stop_load_test` | Start k6 in the background, inspect progress or stop the active run. |
| `list_load_runs`, `load_test_result`, `compare_load_runs` | Find completed runs and compare their summaries by test ID and `startedAt` timestamp. |
| `start_mock_server`, `mock_server_log`, `stop_mock_server` | Serve a collection's saved examples on localhost, check the recent request log or stop the server. |
| `list_cookies`, `clear_cookie_jar` | Inspect cookie metadata for a domain or clear the jar used by this MCP connection. |
| `create_collection` | Creates an empty collection. |
| `save_request` | Creates or edits any supported request type using workspace YAML. The HTTP and GraphQL shorthand is also available. |
| `patch_request` | Changes individual fields of a saved request with JSON Merge Patch. |
| `list_globals` | Reads globals in the active local profile. Secret values are hidden. |
| `authorize_oauth2` | Authorizes a saved request for the current session. See [OAuth 2.0 sign-in](/docs/guides/mcp-server/edit/#oauth-20-sign-in). |
| `apply_changes` | Applies an ordered batch of workspace edits. Agent Mode reviews the combined diff once. |
| `delete_request` | Deletes a saved request and its examples. |
| `save_example` | Saves a response as an [example](/docs/guides/examples/) of a request: the response of the last `run_request` of that request, or one the assistant describes with `status` and `body`. |
| `set_variable` | Sets a non-secret variable in an environment, and creates the environment if there is none with that name. |
| `generate_tests` | Writes a request's status, `Content-Type` and JSON schema tests from a real or described response. See [Tests from a response](/docs/guides/mcp-server/prompts/#tests-from-a-response). |
| `git_status` | Shows the branch, its upstream, commits ahead and behind, and which workspace files have uncommitted changes. |
| `git_diff` | Shows the uncommitted diff of the workspace files or one file; with `outgoing`, the committed changes not pushed yet. |
| `pull_request_url` | Builds the link that starts a pull request for the current branch on GitHub, or a merge request on GitLab and Bitbucket. |
| `git_create_branch` | Creates a branch from the current commit and switches to it. |
| `git_commit` | Commits uncommitted workspace files, or only the `paths` given, with a `message`. Other files in the repository are never committed. |
| `git_push` | Pushes the current branch to its remote, never with force. The assistant is told to push only when you ask. |

A request can be named by its id, its full path, or just its name when that name is unique. When a name matches more than one request, the tool lists the matches with their ids so the assistant can pick one.

Request and collection runs accept an `environment` and a `variables` object of overrides for that call. `run_request` and `send_request` return up to 64 KB of the response body by default. An assistant can ask for up to 1 MB with `maxBodyBytes`. Binary bodies are described but not included.

Live connection tools are available in the desktop app’s [Agent Mode](/docs/guides/agent/requests/). A mock or k6 run started through `kurlo mcp` belongs to that process and stops when it exits. The cookie jar is local to the process.

## Import requests and read project source

Start the server with `kurlo mcp /path/to/kurlo-workspace --project-root /path/to/source`. Source paths for `list_files`, `read_file` and `search_code` are relative to the connected folder. The server skips symlinks, hidden configuration, credential files and common dependency and build directories. These tools only read the source. Workspace tools still operate on the Kurlo workspace supplied separately.

Call `import_preview` with a relative `file`, pasted `content` or an OpenAPI `url`. A file path is relative to the source folder when supplied and otherwise to the Kurlo workspace. Supported inputs include OpenAPI and Swagger, Postman v2 collection JSON, Insomnia Export v4 JSON, HAR, and cURL. For Postman v3 Native Git folders, use the [desktop importer](/docs/guides/import-export/postman/#postman-v3-folders). Format detection is automatic, or you can pass `format` explicitly. For a spec with external references, bundle it into one file before importing.

The preview reports the intended collection, requests and environments and shows the YAML diff. Omit `collection` to create a collection, or supply its name or ID to append requests. Pass `workspace` when the Kurlo folder contains multiple workspaces and you are creating a collection. If the diff spans several pages, call `import_preview` again with the `importId` and `nextOffset` as `offset`. Review the result and pass its `importId` and `confirm: true` to `import_apply`. A file changed since the preview requires a new preview. Agent Mode asks you to approve the diff in the chat.

## Capture metadata

Start the server with `--capture-har /path/to/session.har` to enable `proxy_status`, `list_captured`, `get_captured` and `check_captured_openapi`. `list_captured` lists method, host, path, status, duration and protocol, and its `query` finds exchanges by text in headers, bodies or stream messages. `get_captured` reads one exchange with its headers, decoded bodies up to `maxBodyBytes`, WebSocket or SSE messages and timings. Credential headers are left out, and secrets saved in Kurlo appear as `[secret]`. With write access, `create_captured_collection` turns one host’s operations into request templates with status assertions. The comparison takes a collection, host and optional base path. The agent in the Kurlo app gets the same tools for the traffic in **Capture** without a HAR file. [Record a session](/docs/guides/capture-proxy/).
