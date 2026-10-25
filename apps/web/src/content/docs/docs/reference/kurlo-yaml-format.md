---
title: Kurlo YAML format
description: Public contract for Git-backed Kurlo workspaces.
---

Kurlo stores Git-backed workspaces as plain YAML files. The contract below is intended for review tools, formatters, generators, and import/export integrations.

Schema: `schemas/kurlo-workspace-yaml-v1.schema.json`

## Contract

| Field | Value |
|-------|-------|
| Storage kind | `workspace-yaml` |
| Format | `kurlo.workspace.yaml.v1` |
| File version | `1` |
| Path layout | `yaml-filesystem-names.v1` |
| Encoding | UTF-8 YAML |

Kurlo preserves unknown fields inside workspace, collection, request, environment, auth, settings, and row objects when it can. Tools should do the same to stay forward-compatible.

## Directory layout

```text
kurlo.yml
workspaces/
  <workspace filesystemName>/
    workspace.yml
    collections/
      <collection filesystemName>/
        collection.yml
        requests/
          <request filesystemName>.yml
        examples/
          <request filesystemName>/
            <example filesystemName>.yml
        loadtests/
          <load test filesystemName>.yml
    environments/
      <environment filesystemName>.yml
```

`filesystemName` is the path segment of an object: its folder or file name. It is not written inside the YAML; readers take it from the path. Kurlo derives it from the object's name: spaces become `-`, Cyrillic is transliterated (`Общий` → `Obshchiy`), accents are dropped, and anything else outside `a-z A-Z 0-9 . _ -` becomes `-`. Two objects with the same name in one folder get `-1`, `-2` suffixes, compared without regard to case so the layout also works on macOS and Windows.

Kurlo keeps every path in line with its name. When it saves, any file or folder whose path no longer matches the name, whether the object was renamed in the app, by editing the YAML, or in a pulled commit, is moved; Git shows it as a rename. Loading never moves anything, and nothing moves while the workspace has a file Kurlo cannot read.

Request and environment files may include a top-level `order` for older exports. Newer writers should prefer `requestOrder`, `collectionOrder`, and `workspaceOrder`; readers must tolerate files without `order`.

## Root index

`kurlo.yml` identifies the shared workspace store and records workspace order.

```yaml
version: 1
format: kurlo.workspace.yaml.v1
workspaceOrder:
  - workspace-main
```

## Workspace file

Path: `workspaces/<workspace filesystemName>/workspace.yml`

```yaml
version: 1
workspace:
  id: workspace-main
  name: Main
  description: ""
collectionOrder:
  - collection-core
```

## Collection file

Path: `workspaces/<workspace>/collections/<collection filesystemName>/collection.yml`

```yaml
version: 1
collection:
  id: collection-core
  workspaceId: workspace-main
  name: Core API
  description: ""
  collapsed: false
  folderPaths:
    - - Auth
    - - Auth
      - Admin
requestOrder:
  - req-login
```

`collection.folderPaths` preserves explicit folders, including empty folders. Request files stay flat under `requests/`; the UI hierarchy comes from `request.folderPath` and `collection.folderPaths`, not from nested filesystem directories.

## Request file

Path: `workspaces/<workspace>/collections/<collection>/requests/<request filesystemName>.yml`

```yaml
version: 1
request:
  id: req-login
  name: Login
  requestType: http
  isPinned: false
  collectionId: collection-core
  folderPath:
    - Auth
  method: POST
  url: "{{baseUrl}}/login"
  requestTab: body
  params: []
  headers:
    - id: 1
      enabled: true
      key: Content-Type
      value: application/json
      description: ""
  auth:
    type: bearer
    bearerToken: "{{kurloSecret:request:req-login:auth:bearerToken}}"
    basicUser: ""
    basicPass: ""
    apiKeyName: X-API-Key
    apiKeyValue: ""
    apiKeyIn: header
    oauth2GrantType: client_credentials
    oauth2AuthURL: ""
    oauth2TokenURL: ""
    oauth2ClientID: ""
    oauth2Secret: ""
    oauth2Scope: ""
    oauth2Token: ""
    oauth2RefreshToken: ""
    oauth2TokenExpiry: 0
    oauth2UsePKCE: true
    awsAccessKey: ""
    awsSecretKey: ""
    awsRegion: us-east-1
    awsService: execute-api
  bodyType: json
  rawBodyType: json
  bodyContent: |-
    {"username":"ada"}
  bodyFilePath: ""
  bodyFileName: ""
  formRows: []
  graphqlSchema: ""
  preRequestScript: ""
  preRequestScriptJs: ""
  testScript: ""
  testScriptJs: ""
  requestNotes: ""
  settings:
    httpVersion: auto
    enableSSLVerification: true
    followRedirects: true
    followOriginalMethod: false
    followAuthorizationHeader: false
    removeRefererHeader: false
    encodeUrlAutomatically: true
    disableCookieJar: false
    maxRedirects: 10
    timeoutMs: 30000
    proxyUrl: ""
    browserEmulation: false
    browserOrigin: ""
    browserWithCredentials: false
    browserEnforceCORS: false
    browserEnforceCSP: false
    browserCSP: ""
    wsHandshakeTimeoutMs: 0
    wsReconnectAttempts: 0
    wsReconnectIntervalMs: 5000
    wsMaxMessageSizeMb: 10
    sioClientVersion: v3
    sioPath: /socket.io
    sioNamespace: /
    grpcUseTls: false
    grpcUseReflection: true
    grpcServerName: ""
    grpcIncludeDefaultValues: true
    grpcMaxResponseMessageSizeMb: 10
  settingsOverrides: {}
  grpcMethod: ""
  grpcMetadata: []
  grpcUseReflection: true
  grpcProtoFilePath: ""
  grpcProtoFileName: ""
  grpcProtoImportPaths: []
```

### Request fields

| Field | Contract |
|-------|----------|
| `requestType` | `http`, `graphql`, `ws`, `socketio`, `grpc`, `mcp`, or `ai` |
| `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, or `SSE` |
| `folderPath` | Display names only. Request files are stored flat; `folderPath` is the UI source of truth. |
| `params`, `pathParams`, `headers`, `formRows`, `sioEvents`, `grpcMetadata` | Arrays of row objects: `id`, `enabled`, `key`, `value`, `description`, optional `secret`, `isFile`, `fileName`. A row with `secret: true` keeps its value in the encrypted local store, with a `{{kurloSecret:...}}` placeholder in the file. |
| `pathParams` | Values of the `:name` path variables in `url`. The names come from the URL; a row whose name the URL no longer has is dropped. |
| `mcpMethod`, `mcpName`, `mcpArguments` | The MCP call: the method (`tools/list`, `tools/call` and the like), the tool, resource or prompt name, and the arguments as JSON text. |
| `mcpProtocolVersion` | Pins an MCP protocol revision, such as `2025-06-18`. Empty lets Kurlo find the one the server speaks. |
| `grpcMethod`, `grpcUseReflection`, `grpcProtoFilePath`, `grpcProtoFileName`, `grpcProtoImportPaths` | gRPC method and service-definition source metadata. |
| `aiProvider` | `openai` (Chat Completions, also for OpenAI-compatible servers) or `anthropic` (Messages). `url` is the provider's base URL. |
| `aiModel`, `aiSystem`, `aiPrompt` | Model ID, system prompt (up to 50,000 characters) and prompt (up to 200,000); all accept `{{variables}}`. |
| `aiTemperature`, `aiTopP`, `aiMaxTokens`, `aiMaxSteps`, `aiIdleTimeoutSec` | Strings; empty means the default: the provider's, 8 steps for `aiMaxSteps`, 300 seconds of silence for `aiIdleTimeoutSec`. |
| `aiThinking` | Empty, or `summarized` to show an Anthropic model's thinking. |
| `aiStream` | `false` to wait for the whole answer; omitted when `true`. |
| `aiToolRequestIds` | IDs of saved MCP requests whose tools the model may call. |
| `bodyType` | `none`, `json`, `text`, `xml`, `html`, `form`, `urlencoded`, `binary`, or `graphql`. |
| `rawBodyType` | `text`, `json`, `html`, or `xml`. |
| `preRequestScript`, `testScript` | Legacy Tengo scripts. |
| `preRequestScriptJs`, `testScriptJs` | JavaScript pre-request/test scripts. |
| `auth.type` | `inherit`, `none`, `bearer`, `basic`, `apikey`, `oauth1`, `oauth2`, `aws`, or `digest`. |
| `auth.oauth1ConsumerKey`, `auth.oauth1SignatureMethod`, `auth.oauth1AddTo`, `auth.oauth1Realm`, `auth.oauth1Callback`, `auth.oauth1Verifier`, `auth.oauth1Version`, `auth.oauth1Timestamp`, `auth.oauth1Nonce`, `auth.oauth1IncludeBodyHash`, `auth.oauth1AddEmptyParams` | OAuth 1.0 settings. `oauth1SignatureMethod` is `HMAC-SHA1` (default), `HMAC-SHA256`, `HMAC-SHA512`, `RSA-SHA1`, `RSA-SHA256`, `RSA-SHA512` or `PLAINTEXT`; `oauth1AddTo` is `header` (default), `query` or `body`. An empty timestamp or nonce is generated on every send. |
| `auth.oauth2GrantType`, `auth.oauth2AuthURL`, `auth.oauth2TokenURL`, `auth.oauth2ClientID`, `auth.oauth2Scope`, `auth.oauth2TokenExpiry`, `auth.oauth2UsePKCE` | OAuth 2.0 grant metadata. `oauth2GrantType` is `client_credentials` or `authorization_code`; Authorization Code can use PKCE. |
| `settings` | Request transport settings. Unknown settings must be preserved by third-party tools. |
| `settingsOverrides` | Per-request override markers for inherited collection defaults. |

Secret-bearing auth fields (`bearerToken`, `basicPass`, `apiKeyValue`, `oauth2Secret`, `oauth2Token`, `oauth2RefreshToken`, `awsAccessKey`, `awsSecretKey`, `oauth1ConsumerSecret`, `oauth1Token`, `oauth1TokenSecret`, and `oauth1PrivateKey`) are replaced with `{{kurloSecret:...}}` placeholders in shared Git/YAML workspaces. Their plaintext values stay in Kurlo's encrypted local profile A value that is only a variable reference, such as `{{apiToken}}`, holds no secret and is written as is.

## Example file

Path: `workspaces/<workspace>/collections/<collection>/examples/<request filesystemName>/<example filesystemName>.yml`

An example is a saved response together with the request snapshot that produced
it. Examples sit in a directory beside `requests/`, not inside it: readers walk
`requests/` recursively, so a `.yml` file anywhere under that tree is a request.

```yaml
version: 1
order: 0
example:
  id: ex-created
  requestId: req-create-order
  name: Created
  source: captured
  snapshot:
    method: POST
    url: "{{baseUrl}}/orders"
    bodyType: json
    bodyContent: |
      {"amount": 500}
  response:
    statusCode: 201
    status: 201 Created
    bodyMediaType: application/json
    body: |-
      {
        "id": "ord_1"
      }
    headers:
      - id: 1
        enabled: true
        key: Content-Type
        value: application/json
  match:
    pathTemplate: /orders
```

The response body is stored in `response.body`, byte for byte. A multi-line
body is written as a YAML block, so a JSON or XML body still diffs line by line.
A body the YAML block form cannot hold exactly, for example one with Windows
line endings or trailing spaces, is written as a quoted string instead.

Older workspaces kept the body in a sibling file named by `response.bodyFile`.
Readers still load that file, and Kurlo moves the body into `response.body` and
removes the file on the next save. `bodyFile` must be a plain file name; a
reader must refuse a value containing a path separator.

`match` records how a mock server would select the example. It is written from
the start so that serving examples later needs no change to stored workspaces.

Examples are optional. A workspace written before they existed has no
`examples/` directory, and readers must treat that as "no examples" rather than
an error.

## Load test file

Path: `workspaces/<workspace>/collections/<collection>/loadtests/<load test filesystemName>.yml`

A load test is a flow of requests from the same collection plus the load to put
on it and the criteria for passing. Each load test is one file; `order` keeps
the order of load tests within the collection.

```yaml
version: 1
order: 0
loadTest:
  id: lt-checkout
  name: Checkout flow
  settings:
    environment: staging
  thresholds:
    - metric: http_req_duration
      stat: p(95)
      op: <
      value: 300
    - metric: http_req_duration
      stat: p(99)
      op: <
      value: 400
      step: st-create
    - metric: http_req_failed
      stat: rate
      op: <
      value: 0.01
      abortOnFail: true
  data:
    path: data/users.csv
    mode: per-vu
  scenarios:
    - id: sc-main
      name: Checkout
      executor:
        type: ramping-vus
        stages:
          - durationMs: 120000
            target: 100
          - durationMs: 600000
            target: 100
          - durationMs: 60000
            target: 0
      steps:
        - id: st-login
          requestId: req-login
          once: true
          extract:
            - var: token
              from: json
              path: $.access_token
          checks:
            - type: status
              value: "200"
        - id: st-create
          requestId: req-create-order
          name: create_order
          thinkTimeMs: 500
          thinkJitterMs: 1000
          checks:
            - type: jsonExists
              path: $.id
```

| Field | Meaning |
|-------|---------|
| `scenarios` | The flow. Kurlo uses exactly one scenario. |
| `executor.type` | `constant-vus` (`vus`, `durationMs`), `ramping-vus` (`stages` of virtual users), `constant-arrival-rate` (`rate`, `durationMs`, `preAllocatedVUs`, `maxVUs`), `ramping-arrival-rate` (`stages` of iterations per time unit, `preAllocatedVUs`, `maxVUs`). `timeUnitMs` defaults to 1000. |
| `steps[].requestId` | An HTTP or GraphQL request in the same collection. The step sends it with the collection's defaults, auth and the selected environment. |
| `steps[].once` | Run the step once per virtual user, for example to log in. |
| `steps[].extract` | Save a value from the response as a variable for later steps: `from: json` with a `$.` path, `from: header` with the header name, or `from: regex` with a pattern that has one `( )` group. |
| `steps[].checks` | `status` (`value` is the expected code), `jsonExists` (`path`), `bodyContains` (`value`). A failed check does not stop the test. |
| `steps[].thinkTimeMs`, `thinkJitterMs` | Wait after the step, plus a random extra wait up to `thinkJitterMs`. |
| `thresholds` | `metric` is `http_req_duration` (stats `avg`, `min`, `med`, `max`, `p(90)`, `p(95)`, `p(99)`; `value` in milliseconds), `http_req_failed` or `checks` (stat `rate`; `value` from 0 to 1). `step` limits a threshold to one step by its id; `abortOnFail` stops the test when it fails. |
| `data` | A CSV or JSON file relative to the workspace folder. `mode` is `per-vu`, `per-iteration` or `random`. |
| `settings` | `environment` to run against, `insecure` to skip TLS certificate checks, `timeoutMs` per request. |

Durations are in milliseconds. A load test holds no secrets: values such as
passwords come from the environment when the test runs. Unlike other objects,
a load test keeps only the fields listed here; Kurlo drops unknown fields on
the next save. Load tests are optional, and a collection without a
`loadtests/` directory has none.

## Environment file

Path: `workspaces/<workspace>/environments/<environment filesystemName>.yml`

```yaml
version: 1
environment:
  id: environment-local
  workspaceId: workspace-main
  name: Local
  values:
    - id: 1
      enabled: true
      key: baseUrl
      value: https://api.example.test
      description: ""
    - id: 2
      enabled: true
      key: token
      value: "{{kurloSecret:environment:environment-local:row:2}}"
      description: ""
      secret: true
```

`protected: true` on the environment marks it as one that AI agents connected through [`kurlo mcp`](/docs/guides/mcp-server/#protected-environments) may not send requests with or change. It is left out when false.

## Secrets

Shared YAML files may contain placeholders in sensitive request auth fields and in rows marked `secret: true`.

```text
{{kurloSecret:<stable key>}}
```

Kurlo stores the actual values in its encrypted local `requests.json` profile. They are not part of the workspace directory or this shared public contract.

Secret-aware tools should preserve placeholders as-is. If a tool cannot resolve a placeholder, it should keep the placeholder instead of replacing it with an empty string.

## Git behavior

Kurlo treats these paths as managed Git content:

- `kurlo.yml`
- `.gitignore`
- `workspaces/**/*.yml`

Other files in the repository are intentionally left alone by commit, discard, stash, and conflict-resolution operations unless Kurlo explicitly adds support for them in a future format version.
