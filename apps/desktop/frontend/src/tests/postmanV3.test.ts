import { describe, expect, it } from 'vitest';
import { postmanV3FromFiles, type PostmanV3File } from '../lib/postmanV3';
import { postmanCollectionBundle } from '../lib/postman';
import { isBrunoFolder, isPostmanV3Document, isPostmanV3Folder } from '../lib/importSource';
import type { SavedRequest } from '../lib/types/models';

function files(entries: Record<string, string>): PostmanV3File[] {
  return Object.entries(entries).map(([path, content]) => ({ path, content }));
}

function bundleOf(entries: Record<string, string>, fallback = 'Fallback') {
  const imported = postmanV3FromFiles(files(entries), fallback);
  expect(imported.collections.length).toBeGreaterThan(0);
  const [collection] = imported.collections;
  return { imported, bundle: postmanCollectionBundle(collection.payload, 'col-1', collection.name) };
}

function byName(requests: SavedRequest[], name: string): SavedRequest {
  const request = requests.find(item => item.name === name);
  if (!request) throw new Error(`missing request ${name}; have ${requests.map(item => item.name).join(', ')}`);
  return request;
}

const shop: Record<string, string> = {
  'Shop/.resources/definition.yaml': `$kind: collection
name: Shop API
description: |-
  Orders and users.

  Uses **bearer** auth.
variables:
  - key: baseUrl
    value: https://api.example.com
  - key: legacy
    value: "off"
    disabled: true
  - key: apiToken
    secret: true
    source:
      provider: postman
      postman:
        type: local
        secretId: apiToken
scripts:
  - type: http:beforeRequest
    code: pm.variables.set('stamp', Date.now());
    language: text/javascript
  - type: http:afterResponse
    code: pm.test('not 5xx', () => pm.expect(pm.response.code).to.be.below(500));
  - type: grpc:beforeInvoke
    code: console.log('grpc only');
auth:
  - id: 6514f1c8
    type: bearer
    name: bearer auth
    credentials:
      token: "{{apiToken}}"
`,
  'Shop/Users/.resources/definition.yaml': `$kind: collection
description: User endpoints
scripts:
  - type: http:beforeRequest
    code: console.log('users folder');
auth:
  type: basic
  credentials:
    - key: username
      value: admin
    - key: password
      value: "{{adminPass}}"
order: 2000
`,
  'Shop/Orders/.resources/definition.yaml': `$kind: collection
name: Orders & Billing
order: 1000
`,
  'Shop/Empty/.resources/definition.yaml': `$kind: collection
order: 3000
`,
  'Shop/Users/List users.request.yaml': `$kind: http-request
url: "{{baseUrl}}/users?page=1&limit=10"
method: get
headers:
  - key: Accept
    value: application/json
  - key: X-Off
    value: "1"
    disabled: true
queryParams:
  page: "1"
  limit: "10"
auth:
  type: noauth
scripts:
  - type: afterResponse
    code: pm.test('200', () => pm.response.to.have.status(200));
examples: ./.resources/List users.resources/examples
order: 1000
`,
  'Shop/Users/Get user.request.yaml': `$kind: http-request
name: Get user / by id
url: "{{baseUrl}}/users/:id"
method: GET
pathVariables:
  id: "42"
order: 500
`,
  'Shop/Users/Create user.request.yaml': `$kind: http-request
url: "{{baseUrl}}/users"
method: POST
headers:
  Content-Type: application/json
  X-Count: 3
body:
  type: json
  content: '{"name":"Ada"}'
settings:
  strictSSL: false
  followRedirects: false
  maxRedirects: 3
  protocolVersion: http2
  disableUrlEncoding: true
  disableCookies: true
scripts:
  - type: beforeRequest
    code: pm.variables.set('order', 'first');
  - type: beforeRequest
    code: |-
      const note = 'second';
      pm.variables.set('order', note);
  - type: afterResponse
    code: pm.test('created', () => pm.response.to.have.status(201));
order: 3000
`,
  'Shop/Users/.resources/List users.resources/examples/OK.example.yaml': `$kind: http-example
name: OK
request:
  url: "{{baseUrl}}/users?page=1"
  method: GET
  headers:
    Accept: application/json
response:
  statusCode: 200
  statusText: OK
  headers:
    Content-Type: application/json
  body:
    type: json
    content: '[{"id":1}]'
order: 1000
`,
  'Shop/Users/.resources/List users.resources/examples/Empty.example.yaml': `$kind: http-example
response:
  statusCode: 204
  statusText: "204"
  body:
    type: text
    content: ""
order: 500
`,
  'Shop/Users/.resources/Get user.resources/examples/Missing.example.yaml': `$kind: http-example
response:
  statusCode: 404
  statusText: Not Found
  body:
    type: text
    content: nope
`,
  'Shop/Orders/Bodies.request.yaml': `$kind: http-request
url: "{{baseUrl}}/orders/form"
method: POST
body:
  type: formdata
  content:
    - type: text
      key: note
      value: hello
    - type: text
      key: hidden
      value: x
      disabled: true
    - type: file
      key: receipt
      src: /tmp/receipt.pdf
      contentType: application/pdf
    - type: file
      key: many
      src:
        - /tmp/a.png
        - /tmp/b.png
order: 1000
`,
  'Shop/Orders/Urlencoded.request.yaml': `$kind: http-request
url: "{{baseUrl}}/orders/urlenc"
method: POST
body:
  type: urlencoded
  content:
    - key: a
      value: "1"
    - key: b
      value: "2"
      disabled: true
order: 2000
`,
  'Shop/Orders/Upload.request.yaml': `$kind: http-request
url: "{{baseUrl}}/orders/blob"
method: PUT
body:
  type: file
  content:
    src: /home/me/blob.bin
order: 3000
`,
  'Shop/Orders/SOAP.request.yaml': `$kind: http-request
url: "{{baseUrl}}/soap"
method: POST
body:
  type: xml
  content: <Envelope><Body/></Envelope>
order: 4000
`,
  'Shop/Orders/GraphQL body.request.yaml': `$kind: http-request
url: "{{baseUrl}}/graphql"
method: POST
body:
  type: graphql
  content:
    query: query Me { me { id } }
    variables: '{"a":1}'
    operationName: Me
order: 5000
`,
  'Shop/Orders/Purge.request.yaml': `$kind: http-request
url: "{{baseUrl}}/cache"
method: PURGE
body:
  type: none
order: 6000
`,
  'Shop/Orders/Script.request.yaml': `$kind: http-request
url: "{{baseUrl}}/script"
method: POST
body:
  type: javascript
  content: console.log(1)
order: 7000
`,
  'Shop/Health.request.yaml': `$kind: http-request
url: "{{baseUrl}}/health"
method: GET
order: 1500
`,
};

describe('postmanV3FromFiles', () => {
  it('builds the collection, folders and request order from definition and order keys', () => {
    const { imported, bundle } = bundleOf(shop);
    expect(imported.skipped).toEqual([]);
    expect(bundle.name).toBe('Shop API');
    expect(bundle.description).toContain('Uses **bearer** auth.');
    expect(bundle.folderPaths).toEqual([['Orders & Billing'], ['Users'], ['Empty']]);
    expect(bundle.requests.map(request => [request.folderPath.join('/'), request.name])).toEqual([
      ['Orders & Billing', 'Bodies'],
      ['Orders & Billing', 'Urlencoded'],
      ['Orders & Billing', 'Upload'],
      ['Orders & Billing', 'SOAP'],
      ['Orders & Billing', 'GraphQL body'],
      ['Orders & Billing', 'Purge'],
      ['Orders & Billing', 'Script'],
      ['', 'Health'],
      ['Users', 'Get user / by id'],
      ['Users', 'List users'],
      ['Users', 'Create user'],
    ]);
  });

  it('maps collection variables, secrets, scripts and multi-auth', () => {
    const { bundle } = bundleOf(shop);
    expect(bundle.defaults.variables.map(row => ({ key: row.key, value: row.value, enabled: row.enabled, secret: row.secret }))).toEqual([
      { key: 'baseUrl', value: 'https://api.example.com', enabled: true, secret: false },
      { key: 'legacy', value: 'off', enabled: false, secret: false },
      { key: 'apiToken', value: '', enabled: true, secret: true },
    ]);
    expect(bundle.defaults.auth).toMatchObject({ type: 'bearer', bearerToken: '{{apiToken}}' });
    expect(bundle.defaults.preRequestScriptJs).toBe("pm.variables.set('stamp', Date.now());");
    expect(bundle.defaults.testScriptJs).toContain('not 5xx');
    expect(bundle.defaults.preRequestScriptJs).not.toContain('grpc only');
  });

  it('maps folder auth and scripts', () => {
    const { bundle } = bundleOf(shop);
    const users = bundle.folderDefaults.find(folder => folder.path.join('/') === 'Users');
    expect(users?.auth).toMatchObject({ type: 'basic', basicUser: 'admin', basicPass: '{{adminPass}}' });
    expect(users?.preRequestScriptJs).toBe("console.log('users folder');");
  });

  it('reads headers, query and path variables in both list and map form', () => {
    const { bundle } = bundleOf(shop);
    const list = byName(bundle.requests, 'List users');
    expect(list.method).toBe('GET');
    expect(list.url).toBe('{{baseUrl}}/users?page=1&limit=10');
    expect(list.params.map(row => [row.key, row.value, row.enabled])).toEqual([['page', '1', true], ['limit', '10', true]]);
    expect(list.headers.map(row => [row.key, row.value, row.enabled])).toEqual([['Accept', 'application/json', true], ['X-Off', '1', false]]);
    expect(list.auth.type).toBe('none');
    expect(list.testScriptJs).toContain("pm.response.to.have.status(200)");

    const create = byName(bundle.requests, 'Create user');
    expect(create.headers.map(row => [row.key, row.value])).toEqual([['Content-Type', 'application/json'], ['X-Count', '3']]);
    expect(create.auth.type).toBe('inherit');

    const get = byName(bundle.requests, 'Get user / by id');
    expect(get.pathParams?.map(row => [row.key, row.value])).toEqual([['id', '42']]);
  });

  it('joins several scripts of the same phase in file order', () => {
    const { bundle } = bundleOf(shop);
    const create = byName(bundle.requests, 'Create user');
    expect(create.preRequestScriptJs).toBe("pm.variables.set('order', 'first');\n\nconst note = 'second';\npm.variables.set('order', note);");
    expect(create.testScriptJs).toContain('status(201)');
  });

  it('maps request settings to Kurlo settings', () => {
    const { bundle } = bundleOf(shop);
    const create = byName(bundle.requests, 'Create user');
    expect(create.settings).toMatchObject({
      enableSSLVerification: false,
      followRedirects: false,
      maxRedirects: 3,
      httpVersion: '2',
      encodeUrlAutomatically: false,
      disableCookieJar: true,
    });
  });

  it('maps every body mode', () => {
    const { bundle } = bundleOf(shop);
    const form = byName(bundle.requests, 'Bodies');
    expect(form.bodyType).toBe('form');
    expect(form.formRows.map(row => [row.key, row.value, row.enabled, row.isFile ?? false])).toEqual([
      ['note', 'hello', true, false],
      ['hidden', 'x', false, false],
      ['receipt', '/tmp/receipt.pdf', true, true],
      ['many', '/tmp/a.png', true, true],
    ]);
    expect(form.formRows[2].contentType).toBe('application/pdf');

    const urlencoded = byName(bundle.requests, 'Urlencoded');
    expect(urlencoded.bodyType).toBe('urlencoded');
    expect(urlencoded.formRows.map(row => [row.key, row.value, row.enabled])).toEqual([['a', '1', true], ['b', '2', false]]);

    const upload = byName(bundle.requests, 'Upload');
    expect(upload).toMatchObject({ method: 'PUT', bodyType: 'binary', bodyFilePath: '/home/me/blob.bin', bodyFileName: 'blob.bin' });

    expect(byName(bundle.requests, 'SOAP')).toMatchObject({ bodyType: 'xml', bodyContent: '<Envelope><Body/></Envelope>' });

    const graphql = byName(bundle.requests, 'GraphQL body');
    expect(graphql.bodyType).toBe('graphql');
    expect(JSON.parse(graphql.bodyContent)).toMatchObject({ query: 'query Me { me { id } }', operationName: 'Me' });

    expect(byName(bundle.requests, 'Purge')).toMatchObject({ method: 'PURGE', bodyType: 'none' });
    expect(byName(bundle.requests, 'Script')).toMatchObject({ bodyType: 'text', bodyContent: 'console.log(1)' });
  });

  it('loads examples from the referenced folder and the default resources folder in order', () => {
    const { bundle } = bundleOf(shop);
    const list = byName(bundle.requests, 'List users');
    expect(list.examples?.map(example => [example.name, example.response.statusCode, example.response.status])).toEqual([
      ['Empty', 204, '204'],
      ['OK', 200, '200 OK'],
    ]);
    const ok = list.examples?.[1];
    expect(ok?.response.body).toBe('[{"id":1}]');
    expect(ok?.response.bodyMediaType).toBe('application/json');
    expect(ok?.snapshot.url).toBe('{{baseUrl}}/users?page=1');
    expect(ok?.snapshot.params.map(row => [row.key, row.value])).toEqual([['page', '1']]);

    const get = byName(bundle.requests, 'Get user / by id');
    expect(get.examples?.map(example => example.name)).toEqual(['Missing']);
    expect(byName(bundle.requests, 'Create user').examples ?? []).toEqual([]);
  });
});

const protocols: Record<string, string> = {
  '.resources/definition.yaml': `$kind: collection
name: Protocols
`,
  'Viewer.request.yaml': `$kind: graphql-request
url: "{{baseUrl}}/graphql"
query: |-
  query Viewer($id: ID!) { user(id: $id) { id } }
variables: '{"id": 1}'
operationName: Viewer
headers:
  - key: X-Client
    value: kurlo
scripts:
  - type: beforeQuery
    code: pm.variables.set('q', 1);
  - type: afterResponse
    code: pm.test('gql ok', () => {});
order: 1000
`,
  '.resources/Viewer.resources/examples/Found.example.yaml': `$kind: graphql-example
request:
  url: "{{baseUrl}}/graphql"
  query: query Viewer { user { id } }
response:
  events:
    - id: e1
      type: received-response
      content: '{"data":{"user":{"id":"1"}}}'
  http:
    status: 200 OK
    headers:
      - key: Content-Type
        value: application/json
    body: '{"data":{"user":{"id":"1"}}}'
`,
  'Say hello.request.yaml': `$kind: grpc-request
url: grpc.example.com:443
methodPath: /helloworld.Greeter/SayHello
message:
  content: '{"name":"Ada"}'
metadata:
  - key: x-tenant
    value: acme
  - key: x-off
    value: "1"
    disabled: true
settings:
  secureConnection: true
  strictSSL: false
  serverNameOverride: internal.example
  includeDefaultFields: true
  maxResponseMessageSize: 8388608
scripts:
  - type: beforeInvoke
    code: console.log('invoke');
order: 2000
`,
  'Ticker.request.yaml': `$kind: websocket-request
url: wss://stream.example.com/ticker
headers:
  - key: X-Api-Key
    value: "{{apiKey}}"
queryParams:
  - key: symbols
    value: ACME,FOO
settings:
  handshakeTimeout: 5000
  retryCount: 3
  retryDelay: 1000
  maxPayload: 1048576
messages:
  - $kind: websocket-message
    name: subscribe
    content: '{"op":"sub"}'
    contentType: json
  - $kind: websocket-message
    name: ping
    content: ping
    contentType: text
order: 3000
`,
  'Chat.request.yaml': `$kind: socket.io-request
url: https://chat.example.com
events:
  - name: message
    subscribeOnConnect: true
  - name: typing
    subscribeOnConnect: false
settings:
  version: "2"
  path: /chat-io
messages:
  - $kind: socket.io-message
    name: hello
    eventName: join
    acknowledgement: true
    args:
      - content: room-1
        contentType: text
      - content: '{"nick":"ada"}'
        contentType: json
      - content: 00ff
        contentType: hex
  - $kind: socket.io-message
    name: bye
    eventName: leave
    args:
      - content: room-1
        contentType: text
order: 4000
`,
  'Remote MCP.request.yaml': `$kind: mcp-request
transport: sse
url: https://mcp.example.com/mcp
headers:
  - key: X-Team
    value: core
message: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"q":"kurlo"}}}'
order: 5000
`,
  'Local MCP.request.yaml': `$kind: mcp-request
transport: stdio
command: npx -y server
order: 6000
`,
  'Sensors.request.yaml': `$kind: mqtt-request
url: mqtts://broker.example.com:8883
order: 7000
`,
  'Orders.request.yaml': `$kind: kafka-request
url: kafka.example.com:9092
order: 8000
`,
  'Ask.request.yaml': `$kind: llm-request
url: https://api.example.com
order: 9000
`,
};

describe('postmanV3FromFiles protocols', () => {
  it('imports GraphQL requests with scripts and examples', () => {
    const { bundle } = bundleOf(protocols);
    const viewer = byName(bundle.requests, 'Viewer');
    expect(viewer).toMatchObject({ requestType: 'graphql', method: 'POST', url: '{{baseUrl}}/graphql' });
    expect(JSON.parse(viewer.bodyContent)).toMatchObject({ query: 'query Viewer($id: ID!) { user(id: $id) { id } }', operationName: 'Viewer' });
    expect(viewer.headers.map(row => row.key)).toEqual(['X-Client']);
    expect(viewer.preRequestScriptJs).toBe("pm.variables.set('q', 1);");
    expect(viewer.testScriptJs).toContain('gql ok');
    expect(viewer.examples?.map(example => [example.name, example.response.statusCode, example.response.body])).toEqual([
      ['Found', 200, '{"data":{"user":{"id":"1"}}}'],
    ]);
  });

  it('imports gRPC method, message, metadata and connection settings', () => {
    const { bundle } = bundleOf(protocols);
    const grpc = byName(bundle.requests, 'Say hello');
    expect(grpc).toMatchObject({
      requestType: 'grpc',
      url: 'grpc.example.com:443',
      grpcMethod: 'helloworld.Greeter/SayHello',
      bodyContent: '{"name":"Ada"}',
      preRequestScriptJs: "console.log('invoke');",
    });
    expect(grpc.grpcMetadata?.map(row => [row.key, row.value, row.enabled])).toEqual([['x-tenant', 'acme', true], ['x-off', '1', false]]);
    expect(grpc.settings).toMatchObject({
      grpcUseTls: true,
      enableSSLVerification: false,
      grpcServerName: 'internal.example',
      grpcIncludeDefaultValues: true,
      grpcMaxResponseMessageSizeMb: 8,
    });
  });

  it('imports WebSocket requests with saved messages and settings', () => {
    const { bundle } = bundleOf(protocols);
    const ws = byName(bundle.requests, 'Ticker');
    expect(ws).toMatchObject({ requestType: 'ws', url: 'wss://stream.example.com/ticker?symbols=ACME%2CFOO', bodyContent: '{"op":"sub"}', bodyType: 'json' });
    expect(ws.params.map(row => [row.key, row.value])).toEqual([['symbols', 'ACME,FOO']]);
    expect(ws.savedMessages?.map(message => [message.name, message.content, message.bodyType])).toEqual([
      ['subscribe', '{"op":"sub"}', 'json'],
      ['ping', 'ping', 'text'],
    ]);
    expect(ws.settings).toMatchObject({ wsHandshakeTimeoutMs: 5000, wsReconnectAttempts: 3, wsReconnectIntervalMs: 1000, wsMaxMessageSizeMb: 1 });
  });

  it('imports Socket.IO events, the first message and every saved message', () => {
    const { bundle } = bundleOf(protocols);
    const sio = byName(bundle.requests, 'Chat');
    expect(sio.requestType).toBe('socketio');
    expect(sio.sioEvents?.map(row => [row.key, row.enabled])).toEqual([['message', true], ['typing', false]]);
    expect(sio.sioEventName).toBe('join');
    expect(sio.sioAck).toBe(true);
    expect(sio.sioArgs?.map(arg => [arg.content, arg.bodyType, arg.encoding])).toEqual([
      ['room-1', 'text', 'base64'],
      ['{"nick":"ada"}', 'json', 'base64'],
      ['00ff', 'binary', 'hex'],
    ]);
    expect(sio.savedMessages?.map(message => [message.name, message.event, message.ack])).toEqual([
      ['hello', 'join', true],
      ['bye', 'leave', false],
    ]);
    expect(sio.settings).toMatchObject({ sioClientVersion: 'v2', sioPath: '/chat-io' });
  });

  it('imports remote MCP calls and parses the JSON-RPC message', () => {
    const { bundle } = bundleOf(protocols);
    const mcp = byName(bundle.requests, 'Remote MCP');
    expect(mcp).toMatchObject({ requestType: 'mcp', url: 'https://mcp.example.com/mcp', mcpMethod: 'tools/call', mcpName: 'search' });
    expect(JSON.parse(mcp.mcpArguments ?? '')).toEqual({ q: 'kurlo' });
    expect(mcp.headers.map(row => row.key)).toEqual(['X-Team']);
  });

  it('skips item kinds Kurlo cannot run and says why', () => {
    const { imported, bundle } = bundleOf(protocols);
    expect(bundle.requests.map(request => request.name)).toEqual(['Viewer', 'Say hello', 'Ticker', 'Chat', 'Remote MCP']);
    expect(imported.skipped).toEqual([
      { path: 'Local MCP.request.yaml', reason: 'MCP requests over stdio are not supported' },
      { path: 'Sensors.request.yaml', reason: 'MQTT requests are not supported' },
      { path: 'Orders.request.yaml', reason: 'Kafka requests are not supported' },
      { path: 'Ask.request.yaml', reason: 'LLM requests are not supported' },
    ]);
  });
});

describe('postmanV3FromFiles project layout', () => {
  const project: Record<string, string> = {
    'postman/collections/Billing/.resources/definition.yaml': '$kind: collection\nname: Billing\n',
    'postman/collections/Billing/Invoices.request.yaml': '$kind: http-request\nurl: https://billing.example.com/invoices\nmethod: GET\n',
    'postman/collections/Accounts/.resources/definition.yaml': '$kind: collection\nvariables:\n  host: https://accounts.example.com\n  empty: ""\n',
    'postman/collections/Accounts/Profile/.resources/definition.yaml': '$kind: collection\norder: 1000\n',
    'postman/collections/Accounts/Profile/Me.request.yaml': '$kind: http-request\nurl: "{{host}}/me"\nmethod: GET\n',
    'postman/environments/Staging.environment.yaml': `name: Staging
values:
  - key: host
    value: https://staging.example.com
    enabled: true
  - key: token
    value: ""
    enabled: false
    type: secret
`,
    'postman/environments/Local.environment.yaml': 'values:\n  host: http://localhost:3000\n',
    'postman/globals/workspace.globals.yaml': 'name: Globals\nvalues:\n  - key: region\n    value: eu\n',
    'postman/README.md': '# notes',
    '.postman/resources.yaml': 'workspace: 1\n',
  };

  it('imports every collection, environment and the globals of a Native Git project', () => {
    const imported = postmanV3FromFiles(files(project), 'repo');
    expect(imported.collections.map(collection => [collection.root, collection.name])).toEqual([
      ['postman/collections/Accounts', 'Accounts'],
      ['postman/collections/Billing', 'Billing'],
    ]);
    const accounts = postmanCollectionBundle(imported.collections[0].payload, 'a', 'Accounts');
    expect(accounts.defaults.variables.map(row => [row.key, row.value])).toEqual([['host', 'https://accounts.example.com'], ['empty', '']]);
    expect(accounts.requests.map(request => [request.folderPath, request.name, request.url])).toEqual([[['Profile'], 'Me', '{{host}}/me']]);
    expect(imported.variableSets.map(set => [set.scope, set.name, set.values.map(row => [row.key, row.value, row.enabled, row.secret])])).toEqual([
      ['environment', 'Local', [['host', 'http://localhost:3000', true, false]]],
      ['environment', 'Staging', [['host', 'https://staging.example.com', true, false], ['token', '', false, true]]],
      ['globals', 'Globals', [['region', 'eu', true, false]]],
    ]);
  });

  it('treats a folder without a root definition as one collection named after the folder', () => {
    const imported = postmanV3FromFiles(files({
      'Ping.request.yaml': '$kind: http-request\nurl: https://example.com/ping\nmethod: GET\n',
      'Admin/.resources/definition.yaml': '$kind: collection\norder: 1000\n',
      'Admin/Users.request.yaml': '$kind: http-request\nurl: https://example.com/users\nmethod: GET\n',
    }), 'my-api');
    expect(imported.collections.map(collection => [collection.root, collection.name])).toEqual([['', 'my-api']]);
    const bundle = postmanCollectionBundle(imported.collections[0].payload, 'c', 'my-api');
    expect(bundle.requests.map(request => [request.folderPath.join('/'), request.name])).toEqual([['Admin', 'Users'], ['', 'Ping']]);
  });

  it('treats a folder without any definitions as one collection with subfolders', () => {
    const imported = postmanV3FromFiles(files({
      'Tag/List tags.request.yaml': '$kind: http-request\nurl: https://example.com/tags\nmethod: GET\n',
      'Item/Add item.request.yaml': '$kind: http-request\nurl: https://example.com/items\nmethod: POST\n',
      'Item/Deep/Nested.request.yaml': '$kind: http-request\nurl: https://example.com/deep\nmethod: GET\n',
    }), 'eagle');
    expect(imported.collections.map(collection => [collection.root, collection.name])).toEqual([['', 'eagle']]);
    const bundle = postmanCollectionBundle(imported.collections[0].payload, 'c', 'eagle');
    expect(bundle.folderPaths).toEqual([['Item'], ['Item', 'Deep'], ['Tag']]);
    expect(bundle.requests.map(request => [request.folderPath.join('/'), request.name])).toEqual([
      ['Item', 'Add item'],
      ['Item/Deep', 'Nested'],
      ['Tag', 'List tags'],
    ]);
  });

  it('climbs from folder definitions to the collection that holds them', () => {
    const imported = postmanV3FromFiles(files({
      'api/Users/.resources/definition.yaml': '$kind: collection\norder: 2000\n',
      'api/Users/List.request.yaml': '$kind: http-request\nurl: https://example.com/users\nmethod: GET\n',
      'api/Orders/.resources/definition.yaml': '$kind: collection\norder: 1000\n',
      'api/Orders/List.request.yaml': '$kind: http-request\nurl: https://example.com/orders\nmethod: GET\n',
    }), 'root');
    expect(imported.collections.map(collection => collection.name)).toEqual(['api']);
    const bundle = postmanCollectionBundle(imported.collections[0].payload, 'c', 'api');
    expect(bundle.folderPaths).toEqual([['Orders'], ['Users']]);
  });

  it('accepts .yml files, Windows separators and ./ prefixes', () => {
    const imported = postmanV3FromFiles([
      { path: 'Shop\\.resources\\definition.yml', content: '$kind: collection\nname: Shop\n' },
      { path: './Shop/Users/Get.request.yml', content: '$kind: http-request\nurl: https://example.com/u\nmethod: GET\nexamples: ./.resources/Get.resources/examples\n' },
      { path: 'Shop\\Users\\.resources\\Get.resources\\examples\\OK.example.yml', content: '$kind: http-example\nresponse:\n  statusCode: 200\n  statusText: OK\n  body:\n    type: text\n    content: hi\n' },
    ], 'x');
    expect(imported.collections.map(collection => collection.name)).toEqual(['Shop']);
    const bundle = postmanCollectionBundle(imported.collections[0].payload, 'c', 'Shop');
    expect(bundle.requests.map(request => [request.folderPath.join('/'), request.name, request.examples?.length])).toEqual([['Users', 'Get', 1]]);
  });
});

describe('postmanV3FromFiles robustness', () => {
  it('reports broken files and requests it cannot import instead of failing', () => {
    const imported = postmanV3FromFiles(files({
      '.resources/definition.yaml': '$kind: collection\nname: Broken\n',
      'Good.request.yaml': '$kind: http-request\nurl: https://example.com/ok\nmethod: GET\n',
      'List.request.yaml': '- one\n- two\n',
      'No url.request.yaml': '$kind: http-request\nmethod: GET\n',
      'No kind.request.yaml': 'url: https://example.com\n',
      'Future.request.yaml': '$kind: hologram-request\nurl: https://example.com\n',
    }), 'x');
    const bundle = postmanCollectionBundle(imported.collections[0].payload, 'c', 'Broken');
    expect(bundle.requests.map(request => request.name)).toEqual(['Good']);
    expect(imported.skipped.map(item => [item.path, item.reason])).toEqual(expect.arrayContaining([
      ['List.request.yaml', 'File is not a YAML mapping'],
      ['No url.request.yaml', 'Request has no URL'],
      ['No kind.request.yaml', 'Missing $kind'],
      ['Future.request.yaml', 'Unknown item kind hologram-request'],
    ]));
    expect(imported.skipped).toHaveLength(4);
  });

  it('ignores request-like files inside resources folders and unrelated YAML', () => {
    const imported = postmanV3FromFiles(files({
      '.resources/definition.yaml': '$kind: collection\nname: Clean\n',
      'A.request.yaml': '$kind: http-request\nurl: https://example.com/a\nmethod: GET\n',
      '.resources/A.resources/scripts/hidden.request.yaml': '$kind: http-request\nurl: https://example.com/hidden\nmethod: GET\n',
      'docker-compose.yaml': 'services:\n  api:\n    image: x\n',
    }), 'x');
    expect(imported.skipped).toEqual([]);
    const bundle = postmanCollectionBundle(imported.collections[0].payload, 'c', 'Clean');
    expect(bundle.requests.map(request => request.url)).toEqual(['https://example.com/a']);
  });

  it('keeps examples scoped to their own request', () => {
    const imported = postmanV3FromFiles(files({
      'A.request.yaml': '$kind: http-request\nurl: https://example.com/a\nmethod: GET\n',
      'AB.request.yaml': '$kind: http-request\nurl: https://example.com/ab\nmethod: GET\n',
      '.resources/A.resources/examples/One.example.yaml': '$kind: http-example\nresponse:\n  statusCode: 200\n  statusText: OK\n  body:\n    type: text\n    content: a\n',
      '.resources/AB.resources/examples/Two.example.yaml': '$kind: http-example\nresponse:\n  statusCode: 201\n  statusText: Created\n  body:\n    type: text\n    content: ab\n',
    }), 'x');
    const bundle = postmanCollectionBundle(imported.collections[0].payload, 'c', 'x');
    expect(bundle.requests.map(request => [request.name, request.examples?.map(example => example.name)])).toEqual([
      ['A', ['One']],
      ['AB', ['Two']],
    ]);
  });

  it('uses the first entry of a multi-auth list and treats inherit as no own auth', () => {
    const imported = postmanV3FromFiles(files({
      '.resources/definition.yaml': `$kind: collection
name: Auth
auth:
  - id: a
    name: api key
    type: apikey
    rules:
      - key: url
        value: https://example.com/*
    credentials:
      - key: key
        value: X-Key
      - key: value
        value: secret
      - key: in
        value: query
  - id: b
    name: none
    type: noauth
`,
      'Inherit.request.yaml': '$kind: http-request\nurl: https://example.com/i\nmethod: GET\nauth:\n  type: inherit\n  credentials: []\n',
      'Jwt.request.yaml': `$kind: http-request
url: https://example.com/j
method: GET
auth:
  type: jwt
  credentials:
    algorithm: HS256
    secret: s
    payload:
      sub: "1"
`,
      'Oauth.request.yaml': `$kind: http-request
url: https://example.com/o
method: GET
auth:
  type: oauth2
  credentials:
    clientId: cid
    accessTokenUrl: https://example.com/token
    grant_type: client_credentials
`,
    }), 'x');
    const bundle = postmanCollectionBundle(imported.collections[0].payload, 'c', 'Auth');
    expect(bundle.defaults.auth).toMatchObject({ type: 'apikey', apiKeyName: 'X-Key', apiKeyValue: 'secret', apiKeyIn: 'query' });
    expect(byName(bundle.requests, 'Inherit').auth.type).toBe('inherit');
    expect(byName(bundle.requests, 'Jwt').auth).toMatchObject({ type: 'jwt', jwtAlgorithm: 'HS256', jwtSecret: 's' });
    expect(JSON.parse(byName(bundle.requests, 'Jwt').auth.jwtPayload)).toEqual({ sub: '1' });
    expect(byName(bundle.requests, 'Oauth').auth).toMatchObject({ type: 'oauth2', oauth2ClientID: 'cid', oauth2TokenURL: 'https://example.com/token', oauth2GrantType: 'client_credentials' });
  });

  it('does not create an empty collection when every request of an undeclared folder was skipped', () => {
    const imported = postmanV3FromFiles(files({
      'Sensors.request.yaml': '$kind: mqtt-request\nurl: mqtts://broker.example.com\n',
    }), 'x');
    expect(imported.collections).toEqual([]);
    expect(imported.skipped).toEqual([{ path: 'Sensors.request.yaml', reason: 'MQTT requests are not supported' }]);
  });

  it('keeps a declared collection even when it is empty', () => {
    const imported = postmanV3FromFiles(files({ '.resources/definition.yaml': '$kind: collection\nname: Draft\n' }), 'x');
    expect(imported.collections.map(collection => collection.name)).toEqual(['Draft']);
  });

  it('returns nothing for folders without Postman v3 content', () => {
    const imported = postmanV3FromFiles(files({ 'opencollection.yml': 'info:\n  name: Bruno\n' }), 'x');
    expect(imported).toEqual({ collections: [], variableSets: [], skipped: [] });
  });
});

describe('Postman v3 detection', () => {
  it('recognises v3 folders by request files or a collection definition', () => {
    expect(isPostmanV3Folder(files({ 'A/Get.request.yaml': '$kind: http-request\nurl: x\n' }))).toBe(true);
    expect(isPostmanV3Folder(files({ 'A/.resources/definition.yaml': '$kind: collection\nname: A\n' }))).toBe(true);
    expect(isPostmanV3Folder(files({ 'A\\.resources\\definition.yml': '$kind: "collection"\n' }))).toBe(true);
    expect(isPostmanV3Folder(files({ 'opencollection.yml': 'info:\n  name: x\n', 'r/get.yml': 'info:\n  name: Get\n' }))).toBe(false);
    expect(isPostmanV3Folder(files({ 'A/Get.request.yaml': 'url: x\n' }))).toBe(false);
    expect(isPostmanV3Folder(files({ '.resources/A.resources/x.request.yaml': '$kind: http-request\n' }))).toBe(false);
  });

  it('recognises single v3 documents', () => {
    expect(isPostmanV3Document('Get.request.yaml', '$kind: http-request\nurl: x\n')).toBe(true);
    expect(isPostmanV3Document('definition.yml', "$kind: 'collection'\n")).toBe(true);
    expect(isPostmanV3Document('OK.example.yaml', '$kind: http-example\n')).toBe(false);
    expect(isPostmanV3Document('Get.request.json', '$kind: http-request\n')).toBe(false);
    expect(isPostmanV3Document('spec.yaml', 'openapi: 3.0.0\n')).toBe(false);
  });

  it('recognises Bruno and OpenCollection folders', () => {
    expect(isBrunoFolder(files({ 'opencollection.yml': '' }))).toBe(true);
    expect(isBrunoFolder(files({ 'sub/bruno.json': '' }))).toBe(true);
    expect(isBrunoFolder(files({ 'a/Get.bru': '' }))).toBe(true);
    expect(isBrunoFolder(files({ 'A/Get.request.yaml': '$kind: http-request\n' }))).toBe(false);
  });
});
