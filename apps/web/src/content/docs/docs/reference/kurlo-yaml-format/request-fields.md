---
title: "Request fields"
---

| Field | Contract |
|-------|----------|
| `requestType` | `http`, `graphql`, `ws`, `socketio`, `grpc`, `mcp`, or `ai` |
| `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, or `SSE` |
| `folderPath` | Display names only. Request files are stored flat; `folderPath` is the UI source of truth. |
| `params`, `pathParams`, `vars`, `postResponseVars`, `headers`, `formRows`, `sioEvents`, `grpcMetadata` | Arrays of row objects: `id`, `enabled`, `key`, `value`, `description`, optional `secret`, `isFile`, `fileName`. A row with `secret: true` keeps its value in the encrypted local store, with a `{{kurloSecret:...}}` placeholder in the file. |
| `vars` | [Request variables](/docs/guides/environments/request-variables/) set before the send, as rows. They win over environment, collection and global values. Omitted when empty. |
| `postResponseVars` | Post-response variables, as rows whose `value` is a JavaScript expression over `res`, such as `res.body.token`. HTTP and GraphQL only. Omitted when empty. |
| `pathParams` | Values of the `:name` path variables in `url`. The names come from the URL; a row whose name the URL no longer has is dropped. |
| `savedMessages` | WebSocket and Socket.IO only. Messages kept in the **Saved** menu, each with a `name`. A WebSocket message has `content` and `bodyType` (`text`, the default, `json`, `html`, `xml` or `binary`); a Socket.IO message has `event`, `args` (the same shape as `sioArgs`) and `ack: true` when it waits for an acknowledgement. Omitted when empty. |
| `mcpMethod`, `mcpName`, `mcpArguments` | The MCP call: the method (`tools/list`, `tools/call` and the like), the tool, resource or prompt name, and the arguments as JSON text. |
| `mcpProtocolVersion` | Pins an MCP protocol revision, such as `2025-06-18`. Empty lets Kurlo find the one the server speaks. |
| `grpcMethod`, `grpcUseReflection`, `grpcProtoFilePath`, `grpcProtoFileName`, `grpcProtoImportPaths` | gRPC method and service-definition source metadata. |
| `aiProvider` | `openai` (Chat Completions, also for OpenAI-compatible servers), `anthropic` (Messages), or `kurlo` (the default connection in Settings → AI on the machine that sends; `url` is empty). Otherwise `url` is the provider's base URL. |
| `aiModel`, `aiSystem`, `aiPrompt` | Model ID, system prompt (up to 50,000 characters) and prompt (up to 200,000); all accept `{{variables}}`. |
| `aiTemperature`, `aiTopP`, `aiMaxTokens`, `aiMaxSteps`, `aiIdleTimeoutSec` | Strings; empty means the default: the provider's, 8 steps for `aiMaxSteps`, 300 seconds of silence for `aiIdleTimeoutSec`. |
| `aiThinking` | Empty, or `summarized` to show an Anthropic model's thinking. |
| `aiStream` | `false` to wait for the whole answer; omitted when `true`. |
| `aiToolRequestIds` | IDs of saved MCP requests whose tools the model may call. |
| `aiKurloTools` | `true` to give the model Kurlo's read and run tools for the workspace; omitted when `false`. |
| `aiConnectionId` | With `aiProvider: kurlo`, the id of the AI connection from Settings → AI to use; omitted for the default connection. |
| `bodyType` | `none`, `json`, `text`, `xml`, `html`, `form`, `urlencoded`, `binary`, or `graphql`. |
| `rawBodyType` | `text`, `json`, `html`, or `xml`. |
| `preRequestScriptJs`, `testScriptJs` | JavaScript pre-request/test scripts. |
| `assertions` | HTTP and GraphQL only. A list of [assertions](/docs/guides/scripting/assertions/), each with `enabled`, `target` (`status`, `responseTime`, `size`, `header.<Name>`, `body`, `body.<path>` or `$.<path>`), `operator` (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `contains`, `notContains`, `matches`, `exists`, `notExists`, `type`, `length`) and `value`, a string. Rows without a target are dropped on save. |
| `auth.type` | `inherit`, `none`, `bearer`, `basic`, `apikey`, `jwt`, `oauth1`, `oauth2`, `aws`, `digest`, or `ntlm`. NTLM uses `basicUser` and `basicPass`. |
| `auth.jwtAlgorithm`, `auth.jwtSecretBase64`, `auth.jwtPayload`, `auth.jwtHeaders`, `auth.jwtExpiresIn`, `auth.jwtAddTo`, `auth.jwtHeaderPrefix`, `auth.jwtQueryParam` | JWT Bearer settings. `jwtAlgorithm` is `HS256` (default), `HS384`, `HS512`, `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384` or `ES512`. `jwtPayload` and `jwtHeaders` are JSON objects written as strings. `jwtExpiresIn` is a number of seconds as a string and adds `iat` and `exp`. `jwtAddTo` is `header` (default) or `query`; `jwtHeaderPrefix` defaults to `Bearer` and `jwtQueryParam` to `token`. Defaults are left out of the file, so `auth: { type: jwt }` with nothing else is valid. The token is signed on every send and never stored. |
| `auth.oauth1ConsumerKey`, `auth.oauth1SignatureMethod`, `auth.oauth1AddTo`, `auth.oauth1Realm`, `auth.oauth1Callback`, `auth.oauth1Verifier`, `auth.oauth1Version`, `auth.oauth1Timestamp`, `auth.oauth1Nonce`, `auth.oauth1IncludeBodyHash`, `auth.oauth1AddEmptyParams` | OAuth 1.0 settings. `oauth1SignatureMethod` is `HMAC-SHA1` (default), `HMAC-SHA256`, `HMAC-SHA512`, `RSA-SHA1`, `RSA-SHA256`, `RSA-SHA512` or `PLAINTEXT`; `oauth1AddTo` is `header` (default), `query` or `body`. An empty timestamp or nonce is generated on every send. |
| `auth.oauth2GrantType`, `auth.oauth2AuthURL`, `auth.oauth2TokenURL`, `auth.oauth2ClientID`, `auth.oauth2Scope`, `auth.oauth2TokenExpiry`, `auth.oauth2UsePKCE` | OAuth 2.0 grant metadata. `oauth2GrantType` is `client_credentials`, `authorization_code`, `password`, or `device_code`. Authorization Code can use PKCE. |
| `openapi` | The OpenAPI operation this request was imported from, as the method and path template, for example `GET /users/{id}`. [OpenAPI sync](/docs/guides/openapi-sync/) uses it to match the request to the spec. Left out for requests that are not linked. |
| `settings` | Request transport settings. Unknown settings must be preserved by third-party tools. |
| `settingsOverrides` | Per-request override markers for inherited collection defaults. |

Secret-bearing auth fields (`bearerToken`, `basicPass`, `apiKeyValue`, `oauth2Secret`, `oauth2Token`, `oauth2RefreshToken`, `awsAccessKey`, `awsSecretKey`, `oauth1ConsumerSecret`, `oauth1Token`, `oauth1TokenSecret`, `oauth1PrivateKey`, `jwtSecret`, and `jwtPrivateKey`) are replaced with `{{kurloSecret:...}}` placeholders in shared Git/YAML workspaces. Their plaintext values stay in Kurlo's encrypted local profile A value that is only a variable reference, such as `{{apiToken}}`, holds no secret and is written as is.
