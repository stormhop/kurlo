---
title: Request types
description: HTTP, GraphQL, SSE, WebSocket, Socket.IO, gRPC, MCP, and AI requests in Kurlo.
---

Kurlo has separate request modes for protocols that behave differently on the wire. Each mode changes the editor tabs, send/connect controls, response panel, and export behavior to match.

A new request always starts as HTTP — the `+` in the tab bar, `Cmd/Ctrl N`, and **Add request** in the sidebar open it straight away, with no dialog. To use another protocol, pick it from the menu at the start of the address bar, or run **New GraphQL request**, **New WebSocket request**, **New Socket.IO request**, **New gRPC request**, **New MCP request**, or **New AI request** from the command palette.

![Method and protocol picker in the address bar](../../../../assets/screenshots/request-protocol-picker.png)

The picker holds both decisions: the HTTP methods on top, the other protocols below. A draft can switch protocol at any time — pick `POST` on a GraphQL draft and it becomes an HTTP request. A saved request can switch until it has a URL; after that its protocol is fixed, the picker still changes an HTTP request's method, and a request of any other type shows its protocol without a menu.

## At a glance

| Type | Use it for | Main tabs | Response surface | Runner support |
|------|------------|-----------|------------------|----------------|
| HTTP | REST, JSON APIs, forms, files, regular request/response flows | Params, Auth, Headers, Body, Scripts, Settings | Body, Headers, Scripts | Yes |
| GraphQL | Queries, mutations, variables, schema exploration | Query, Auth, Headers, Schema, Scripts, Settings | Body, Headers, Scripts | Yes |
| SSE | `text/event-stream` subscriptions over HTTP | Params, Auth, Headers, Settings | SSE event stream | No |
| WebSocket | Raw `ws://` / `wss://` sessions | Params, Auth, Headers, Message, Settings | Frames, handshake, logs | No |
| Socket.IO | Socket.IO servers with namespaces/events | Params, Auth, Headers, Events, Message, Settings | Events, handshake, logs | No |
| gRPC | Protobuf RPCs with metadata/reflection/proto files | Metadata, Body, Service, Scripts, Settings | Messages, metadata, trailers, scripts | Yes |
| MCP | Model Context Protocol servers — list their tools and call one by hand | Arguments, Auth, Headers, Scripts, Settings | Result, raw exchange, notifications | Yes |
| AI | Prompts to OpenAI, Anthropic and OpenAI-compatible models, with MCP tools | Prompt, Auth, Headers, Tools, Scripts, Settings (model) | Conversation, raw stream, tests | No |

Realtime requests are intentionally skipped by the Collection Runner because they are long-lived sessions. gRPC is runnable because each invocation produces a bounded response. AI requests are skipped too for now: a model answer is not repeatable the way an HTTP response is, and a run could spend real money.

## HTTP

HTTP is the default mode. It supports:

- Methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, and `SSE`.
- Query params, path variables, and headers as editable rows.
- Auth, body, scripts, request notes, and per-request settings.
- JSON, text, XML, HTML, form-data, urlencoded, GraphQL-shaped body, and binary-file bodies.
- cURL import from the URL bar.

Use HTTP for normal REST APIs. Use the `SSE` method only when the endpoint keeps an event stream open.

### Path variables

A path segment that starts with a colon is a path variable: type `{{baseUrl}}/users/:userId/posts/:postId` and the **Params** tab lists `userId` and `postId` under **Path variables**, below the query params. Fill in the values there, and Kurlo puts them into the URL when it sends the request, so `/users/:userId` goes out as `/users/42`. The URL field keeps showing `:userId`.

- The rows follow the URL. Adding `:name` to the path adds a row, and removing it from the path removes the row. Renaming a variable means editing the URL.
- Only a whole segment counts. `/users/:id` has a variable, while `/v1:beta` and `http://localhost:8080` do not, and the query string and fragment are left alone.
- A value can use `{{variables}}`, such as `{{userId}}` from the environment.
- Characters that would change the URL's structure, such as `/`, `?`, `#` and spaces, are percent-encoded. Sequences that are already encoded, like `%2F`, are kept as they are.
- A variable with an empty value stays in the URL as `:name`.
- Pre-request scripts see the URL with `:name` in it, as Postman's do, and can read and change the values with [`pm.request.pathVariables`](/docs/reference/scripting-api/).
- Path variables apply to HTTP, GraphQL, and SSE requests. Copy as cURL and generated code put the values into the URL. The mock server treats `:name` as "any value" when it matches requests against saved examples.

## GraphQL

GraphQL requests use `POST` and store the query, variables, and operation name as a GraphQL payload. The Query tab is optimized for editing GraphQL text and variables; the Schema tab can hold an imported schema or an introspection result.

GraphQL still uses the normal auth, headers, scripts, environments, cookies, and response viewer paths. Exports preserve GraphQL where the target format supports it.

![GraphQL request with query editor and JSON response](../../../../assets/screenshots/request-graphql.png)

## Server-Sent Events

SSE is an HTTP request with long-lived streaming semantics:

1. Create an HTTP request.
2. Set the method to `SSE`.
3. Enter the stream URL and any auth/headers.
4. Press **Connect**.

Kurlo adds `Accept: text/event-stream`, `Cache-Control: no-cache`, and `Connection: keep-alive` when building the request. Events appear as they arrive and the session is written to history once the stream connects or errors.

An SSE request has no Scripts tab: a subscription is opened rather than sent, and pre-request and test scripts do not run on that path. Reconnection is configurable — see [SSE-specific settings](/docs/guides/request-settings/#sse-specific-settings).

The `SSE` method subscribes with a `GET` and no body. An endpoint that streams events back from a `POST` — the streaming mode of most LLM APIs — is sent as an ordinary `POST`: Kurlo reads the stream until the server closes it and shows the raw events as the response body, within the request timeout.

The SSE event list keeps the latest events bounded for UI performance. Clear or restore visible events from the SSE panel while the session is open.

![SSE request connected with incoming stream events](../../../../assets/screenshots/request-sse.png)

## WebSocket

WebSocket requests connect to `ws://` or `wss://` URLs. Kurlo shows:

- A handshake record with request/response headers.
- Incoming/outgoing frames.
- Text, binary, ping, pong, close, reconnect, and error events.
- Reconnect settings and a max-message-size guard.

Use the Message tab to send a text or binary payload after connecting. Per-request headers and cookies are applied to the handshake, and so is the Authorization tab — Bearer, Basic, Digest and API-key auth all go out with the upgrade request, the same way they would on an ordinary send. There is no Scripts tab: the handshake does not run pre-request or test scripts.

![WebSocket request with sent payload and echoed frame](../../../../assets/screenshots/request-websocket.png)

## Socket.IO

Socket.IO mode speaks the Socket.IO protocol rather than raw WebSocket frames. Configure:

- Client version: v2 or v3.
- Path, usually `/socket.io`.
- Namespace, usually `/`.
- Event name, arguments, and ack behavior.
- Reconnect attempts and interval.

Socket.IO events are displayed with namespace, direction, args, and system/error rows. Cookies, headers, and the Authorization tab are applied to the Engine.IO handshake unless the request disables the cookie jar. As with WebSocket, there is no Scripts tab.

![Socket.IO request with event payload and acknowledgement](../../../../assets/screenshots/request-socketio.png)

## gRPC

gRPC requests target `host:port` or a `grpc://` / `grpcs://` style target. Kurlo can discover services by reflection when enabled, or use a selected `.proto` file with import paths.

The request body is JSON in protobuf JSON shape. Metadata lives in its own tab. The response panel separates:

- Messages.
- Response metadata.
- Trailers.
- Script output and test results.

gRPC supports pre-request/test scripts, environment variables, collection defaults, and runner reports.

![gRPC request with selected method and response messages](../../../../assets/screenshots/request-grpc.png)

## MCP

An MCP request calls a [Model Context Protocol](https://modelcontextprotocol.io) server — the servers agents talk to — without an agent in the loop. Kurlo speaks protocol revision **2026-07-28**, which is stateless: every call is a single HTTP POST to the server's endpoint, so an MCP call is an ordinary saved request that can be replayed, diffed, scripted and committed.

Most servers in use today were built for the earlier revisions **2025-11-25**, **2025-06-18** and **2025-03-26**, which need a session. Kurlo finds that out by itself: when a server does not answer the stateless call, Kurlo sends `initialize` and `notifications/initialized`, keeps the `Mcp-Session-Id` the server hands out, and sends that call and the later ones to the same endpoint in the session. The panel then shows the revision next to the server's name, for example *MCP 2025-06-18*. If the server forgets the session, Kurlo opens a new one and sends the call again. The handshake carries the request's URL, headers and auth, but not its scripts, which run once around the call itself. To pin a revision, set `mcpProtocolVersion` on the request in its YAML file.

Put the server's endpoint in the URL bar, then press **Discover**. Kurlo calls `server/discover` and follows it with `tools/list`, `resources/list` and `prompts/list` for the capabilities the server actually declares, so a server with no prompts is never asked for any. The panel then names the server, its version and what it holds.

Choose a method and, for `tools/call`, `resources/read` or `prompts/get`, the tool, resource or prompt to address. Picking a tool seeds the **Arguments** editor from the tool's own input schema, and the arguments are checked for being a JSON object before anything is sent.

![MCP request with a discovered server, a chosen tool and its result](../../../../assets/screenshots/request-mcp.png)

The response panel has three views:

- **Result** — the content blocks the server returned, its `structuredContent`, and, when a tool asked for more input, the `inputRequests` it sent back.
- **Raw exchange** — the JSON-RPC envelope exactly as it arrived, including the individual frames when the server answered with a stream. This is the view that makes a failing tool call diagnosable.
- **Notifications** — the progress and log notifications a streamed answer carried before its result.

What Kurlo checks on your behalf:

- **A tool that contradicts its own output schema is called out.** If the server publishes an `outputSchema` and its `structuredContent` does not match, the mismatch is listed as a warning — and the content is still shown, because the server is the one at fault.
- **A tool whose `x-mcp-header` annotations the specification forbids cannot be called.** Kurlo names the reason instead of quietly dropping the tool from the list, which is what a conforming agent client does.
- **Headers the protocol derives from the body are yours to read, not to set.** `Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version` and the `Mcp-Param-*` headers are built from the call; a header of the same name in the Headers tab is replaced and you are told so, because a server must reject a request whose headers and body disagree.

Auth, proxy, client certificates, redirects and the response cap are the ordinary HTTP ones — an MCP call is an HTTP request, and it carries the same settings.

Not in this release: the **stdio** transport, so servers launched as a local command (`npx some-server`) cannot be reached yet; the old HTTP+SSE transport of revision `2024-11-05`; `subscriptions/listen`; and sampling, which Kurlo declines because it has no model and is not going to acquire one.

## AI

An AI request sends a prompt to a language model and shows the answer as a conversation. Pick the provider and the model in the box next to the URL: **OpenAI**, **Anthropic**, **OpenRouter**, **Groq**, **Ollama**, **LM Studio**, or **Custom URL** for anything else that speaks the OpenAI Chat Completions API, such as vLLM or your own gateway. The provider fills in the base URL and the auth: a bearer token from `{{openaiApiKey}}`, `{{openrouterApiKey}}` or `{{groqApiKey}}`, `x-api-key` from `{{anthropicApiKey}}`, and no auth for the local servers. Set the key in an environment, mark it secret, and it never lands in the YAML; if the variable is not set, Kurlo says so before sending. The model is the name the provider knows it by, such as `gpt-4o-mini` or `llama3.2`: when you open the box, Kurlo reads the provider's `/models` list so you can pick one, and you can always type a name instead.

The **Prompt** tab holds the system prompt and the prompt; `{{variables}}` work in both. **Settings** holds the model parameters (temperature, max tokens, top P, streaming, thinking for Anthropic models), how long to wait for a silent provider, and the SSL and proxy settings a local model or a company proxy may need. Auth and Headers are the usual ones: the provider presets fill Auth in, and Headers is there for gateways that want extra ones, such as OpenRouter's `HTTP-Referer`.

![AI request with a streamed answer, a tool call and its result](../../../../assets/screenshots/request-ai.png)

**Send** starts a new conversation with the saved prompt, so the request behaves the same every time you open it. The answer streams in as it is written:

- **Text** builds up word by word, and **thinking** sits in a collapsed block above it when the model shares it.
- **Tool calls** are cards with the tool's name, the server it came from, its call ID and its arguments, which grow while the model writes them. The result, or the tool's error, appears under the call.
- The status line shows the **time to the first token**, the **speed** in tokens per second and the **tokens** in and out, with cache reads; hover it for the breakdown per type.
- The **stop reason** is shown under the answer. An answer cut off by the token limit says so and offers to raise the limit and send again, and an error in the middle of a stream, which arrives with HTTP 200, is shown where the stream stopped, below the part that did arrive.

Type into **Reply** to continue the conversation: Kurlo sends the earlier messages, the tool calls and their results along with it. **New conversation** clears it. The conversation lives only while the request is open; each send is in History.

**Raw** shows each model call's stream exactly as it arrived, and **Tests** the results of the request's test scripts, which run once after the last step. `pm.response.llm()` gives them the answer in one shape for every provider, so a test reads the same for OpenAI and Anthropic:

```javascript
const llm = pm.response.llm();
pm.test("asks for the weather", () => {
  pm.expect(llm.toolCalls[0].name).to.equal("get_weather");
  pm.expect(llm.toolCalls[0].input.city).to.equal("Lisbon");
});
pm.test("stays short", () => pm.expect(llm.usage.output).to.be.below(300));
pm.test("answers fast", () => pm.expect(llm.timing.firstToken).to.be.below(800));
```

### Tools from MCP servers

The **Tools** tab lists the MCP requests saved in the workspace. Tick one and the model gets that server's tools. When it calls one, Kurlo runs the call with the MCP request's URL, auth and headers, sends the result back and asks the model again, until it answers without calling a tool or the **step limit** is reached (8 by default, 50 at most). Each step is visible in the conversation, and a tool that fails is reported to the model as an error so it can recover. Tool names the providers do not accept, such as `files.read`, are renamed to `files_read`, and two servers with a tool of the same name get the server's name in front.

### Good to know

- **Stop after silence** in Settings is the only timeout: the stream is stopped when no data has arrived for that long (five minutes when it is not set), so a long answer that keeps streaming is never cut off.
- Anthropic thinking blocks, with their signatures, are sent back unchanged in later steps, as the API requires during tool use.
- For OpenAI-compatible streams Kurlo asks for usage with `stream_options`. A server that ignores it shows no token counts.
- Not in this release: the OpenAI Responses API, Gemini's own API, images and files in the prompt, prices, and running AI requests with `kurlo run` or `kurlo mcp`.

## Import and export notes

| Format | Supported request types |
|--------|-------------------------|
| Postman export | HTTP, GraphQL, SSE |
| OpenAPI/Swagger export | HTTP, SSE |
| OpenCollection export | HTTP, GraphQL, explicit folders |
| All-data backup | All request types |
| Git/YAML workspace | All request types |

When a format cannot represent a request type, Kurlo skips it and shows an in-app message instead of writing a misleading partial export.
