import { testRequest, testRow, strip } from './support/importers';
import { describe, it, expect } from 'vitest';
import { openCollectionBundleFromFiles, buildOpenCollectionFiles } from '../lib/opencollection';
import { emptyAuthState } from '../lib/utils';
import { DEFAULT_REQUEST_SETTINGS } from '../lib/constants';
import { type Environment } from '../lib/types/models';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';

describe('openCollectionBundleFromFiles', () => {
  it('imports OpenCollection YAML requests, folders, scripts, auth, body, and environments', () => {
    const bundle = openCollectionBundleFromFiles([
      {
        path: 'opencollection.yml',
        content: `info:\n  name: Bruno API\ndocs: |-\n  Collection docs.\nvariables:\n  - name: workspace\n    value: core\nheaders:\n  - name: X-Collection\n    value: kurlo\nauth:\n  type: bearer\n  token: "{{collectionToken}}"\nruntime:\n  scripts:\n    - type: before-request\n      code: |-\n        bru.setVar("collection", "yes");\nsettings:\n  timeout: 9000\n  sslVerification: false\n  proxyUrl: http://localhost:8080\n`,
      },
      {
        path: 'users/folder.yml',
        content: `info:\n  name: Users\n  type: folder\n  seq: 1\n`,
      },
      {
        path: 'users/create-user.yml',
        content: `info:\n  name: Create User\n  type: http\n  seq: 1\nhttp:\n  method: POST\n  url: "{{baseUrl}}/users"\n  params:\n    - name: dryRun\n      value: "true"\n      type: query\n  headers:\n    - name: X-Trace\n      value: "{{traceId}}"\n  body:\n    type: json\n    data: |-\n      {"name":"Ada"}\n  auth:\n    type: bearer\n    token: "{{token}}"\nruntime:\n  scripts:\n    - type: before-request\n      code: |-\n        bru.setVar("stamp", Date.now());\n    - type: tests\n      code: |-\n        test("created", () => expect(res.status).to.equal(201));\nsettings:\n  timeout: 12000\n  followRedirects: false\ndocs: |-\n  Creates a user.\n`,
      },
      {
        path: 'environments/local.yml',
        content: `info:\n  name: Local\nvariables:\n  - name: baseUrl\n    value: https://api.example.test\n  - name: token\n    value: "{{kurloSecret:token}}"\n    secret: true\n`,
      },
    ], 'collection-1', 'Fallback', 'workspace-1');

    expect(bundle.name).toBe('Bruno API');
    expect(bundle.description).toBe('Collection docs.');
    expect(bundle.defaults.variables[0]).toMatchObject({ key: 'workspace', value: 'core' });
    expect(bundle.defaults.headers[0]).toMatchObject({ key: 'X-Collection', value: 'kurlo' });
    expect(bundle.defaults.auth).toMatchObject({ type: 'bearer', bearerToken: '{{collectionToken}}' });
    expect(bundle.defaults.preRequestScriptJs).toContain('collection');
    expect(bundle.defaults.settings.timeoutMs).toBe(9000);
    expect(bundle.defaults.settings.enableSSLVerification).toBe(false);
    expect(bundle.defaults.settings.proxyUrl).toBe('http://localhost:8080');
    expect(bundle.folderPaths).toEqual([['Users']]);
    expect(bundle.requests).toHaveLength(1);
    expect(bundle.requests[0]).toMatchObject({
      name: 'Create User',
      collectionId: 'collection-1',
      collection: 'Bruno API',
      folderPath: ['Users'],
      method: 'POST',
      url: '{{baseUrl}}/users',
      bodyType: 'json',
      bodyContent: '{"name":"Ada"}',
      preRequestScriptJs: 'bru.setVar("stamp", Date.now());',
      testScriptJs: 'test("created", () => expect(res.status).to.equal(201));',
      requestNotes: 'Creates a user.',
    });
    expect(bundle.requests[0].params[0]).toMatchObject({ key: 'dryRun', value: 'true' });
    expect(bundle.requests[0].headers[0]).toMatchObject({ key: 'X-Trace', value: '{{traceId}}' });
    expect(bundle.requests[0].auth).toMatchObject({ type: 'bearer', bearerToken: '{{token}}' });
    expect(bundle.requests[0].settings.timeoutMs).toBe(12000);
    expect(bundle.requests[0].settings.followRedirects).toBe(false);
    expect(bundle.requests[0].settingsOverrides).toMatchObject({ timeoutMs: true, followRedirects: true });
    expect(bundle.environments[0]).toMatchObject({ workspaceId: 'workspace-1', name: 'Local' });
    expect(bundle.environments[0].values).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'baseUrl', value: 'https://api.example.test' }),
      expect.objectContaining({ key: 'token', secret: true }),
    ]));
  });

  it('imports legacy Bruno .bru request files', () => {
    const bundle = openCollectionBundleFromFiles([
      { path: 'bruno.json', content: JSON.stringify({ name: 'Legacy Bruno' }) },
      {
        path: 'collection.bru',
        content: `auth {\n  mode: apikey\n}\n\nauth:apikey {\n  key: X-Collection-Key\n  value: {{collectionKey}}\n  placement: header\n}\n\nheaders {\n  X-Collection: yes\n}\n\nvars {\n  collectionHost: https://collection.example.test\n  collectionSecret: {{secret}}\n}\n\nvars:secret {\n  collectionSecret\n}\n\nsettings {\n  timeout: 7000\n  followRedirects: false\n}\n\nscript:pre-request {\n  bru.setVar("legacy", "yes");\n}\n\ndocs {\n  Legacy docs.\n}\n`,
      },
      {
        path: 'auth/login.bru',
        content: `meta {\n  name: Login\n  type: http\n  seq: 1\n}\n\npost {\n  url: {{baseUrl}}/login\n  body: json\n  auth: basic\n}\n\nheaders {\n  Content-Type: application/json\n}\n\nauth:basic {\n  username: admin\n  password: {{password}}\n}\n\nbody:json {\n  {\n    "username": "admin"\n  }\n}\n\ntests {\n  test("ok", () => expect(res.status).to.equal(200));\n}\n`,
      },
    ], 'collection-1', 'Fallback', 'workspace-1');

    expect(bundle.name).toBe('Legacy Bruno');
    expect(bundle.description).toBe('Legacy docs.');
    expect(bundle.defaults.headers[0]).toMatchObject({ key: 'X-Collection', value: 'yes' });
    expect(bundle.defaults.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'collectionHost', value: 'https://collection.example.test' }),
      expect.objectContaining({ key: 'collectionSecret', secret: true }),
    ]));
    expect(bundle.defaults.auth).toMatchObject({ type: 'apikey', apiKeyName: 'X-Collection-Key', apiKeyValue: '{{collectionKey}}' });
    expect(bundle.defaults.preRequestScriptJs).toContain('legacy');
    expect(bundle.defaults.settings.timeoutMs).toBe(7000);
    expect(bundle.defaults.settings.followRedirects).toBe(false);
    expect(bundle.requests).toHaveLength(1);
    expect(bundle.requests[0]).toMatchObject({
      name: 'Login',
      folderPath: ['auth'],
      method: 'POST',
      url: '{{baseUrl}}/login',
      bodyType: 'json',
      auth: expect.objectContaining({ type: 'basic', basicUser: 'admin', basicPass: '{{password}}' }),
    });
    expect(bundle.requests[0].headers[0]).toMatchObject({ key: 'Content-Type', value: 'application/json' });
    expect(bundle.requests[0].testScriptJs).toContain('expect(res.status)');
  });

  it('imports non-HTTP legacy Bruno .bru request files when type metadata is present', () => {
    const bundle = openCollectionBundleFromFiles([
      { path: 'bruno.json', content: JSON.stringify({ name: 'Legacy Realtime Bruno' }) },
      {
        path: 'graphql/viewer.bru',
        content: `meta {\n  name: Viewer\n  type: graphql\n  seq: 1\n}\n\npost {\n  url: {{baseUrl}}/graphql\n  body: graphql\n}\n\nbody:graphql {\n  query Viewer {\n    viewer {\n      id\n    }\n  }\n}\n\nbody:graphql:vars {\n  {\n    "id": "1"\n  }\n}\n`,
      },
      {
        path: 'realtime/ws.bru',
        content: `meta {\n  name: Events WS\n  type: websocket\n  seq: 2\n}\n\nwebsocket {\n  url: wss://api.example.test/events\n}\n\nheaders {\n  X-Trace: {{traceId}}\n}\n\nbody:text {\n  ping\n}\n`,
      },
      {
        path: 'realtime/sio.bru',
        content: `meta {\n  name: Events SIO\n  type: socketio\n  seq: 3\n}\n\nsocketio {\n  url: https://api.example.test/socket.io\n  ack: true\n}\n\nevents {\n  message: enabled\n}\n\nbody:json {\n  {\n    "ok": true\n  }\n}\n`,
      },
      {
        path: 'grpc/get-item.bru',
        content: `meta {\n  name: Get Item\n  type: grpc\n  seq: 4\n}\n\ngrpc {\n  url: grpc.example.test:443\n  method: shop.Inventory/GetItem\n  useReflection: false\n}\n\nmetadata {\n  authorization: Bearer {{token}}\n}\n\nbody:json {\n  {\n    "id": "1"\n  }\n}\n`,
      },
    ], 'collection-1', 'Fallback', 'workspace-1');

    expect(bundle.requests.map(request => request.requestType).sort()).toEqual(['graphql', 'grpc', 'socketio', 'ws']);
    expect(bundle.requests.find(request => request.requestType === 'graphql')).toMatchObject({
      bodyType: 'graphql',
      requestTab: 'query',
    });
    expect(bundle.requests.find(request => request.requestType === 'ws')).toMatchObject({
      url: 'wss://api.example.test/events',
      bodyType: 'text',
      headers: [expect.objectContaining({ key: 'X-Trace', value: '{{traceId}}' })],
    });
    expect(bundle.requests.find(request => request.requestType === 'socketio')).toMatchObject({
      url: 'https://api.example.test/socket.io',
      requestTab: 'events',
      sioAck: true,
      sioEvents: [expect.objectContaining({ key: 'message' })],
      sioArgs: [expect.objectContaining({ bodyType: 'json' })],
    });
    expect(bundle.requests.find(request => request.requestType === 'grpc')).toMatchObject({
      url: 'grpc.example.test:443',
      grpcMethod: 'shop.Inventory/GetItem',
      grpcUseReflection: false,
      grpcMetadata: [expect.objectContaining({ key: 'authorization', value: 'Bearer {{token}}' })],
      bodyContent: expect.stringContaining('"id": "1"'),
    });
  });

  it('preserves Bruno auth inheritance explicitly', () => {
    const bundle = openCollectionBundleFromFiles([
      { path: 'opencollection.yml', content: `info:\n  name: Bruno API\n` },
      {
        path: 'ping.yml',
        content: `info:\n  name: Ping\n  type: http\nhttp:\n  method: GET\n  url: https://api.example.test/ping\n  auth: inherit\n`,
      },
    ], 'collection-1', 'Fallback', 'workspace-1');

    expect(bundle.requests[0].auth.type).toBe('inherit');
  });

  it('imports empty OpenCollection folder paths without requiring a request inside them', () => {
    const bundle = openCollectionBundleFromFiles([
      { path: 'opencollection.yml', content: `info:\n  name: Bruno API\n` },
      { path: 'parent/folder.yml', content: `info:\n  name: Parent\n  type: folder\n` },
      { path: 'parent/empty-child/folder.yml', content: `info:\n  name: Empty Child\n  type: folder\n` },
      {
        path: 'parent/with-request/folder.yml',
        content: `info:\n  name: With Request\n  type: folder\n`,
      },
      {
        path: 'parent/with-request/ping.yml',
        content: `info:\n  name: Ping\n  type: http\nhttp:\n  method: GET\n  url: https://api.example.test/ping\n`,
      },
    ], 'collection-1', 'Fallback', 'workspace-1');

    expect(bundle.folderPaths).toEqual([
      ['Parent'],
      ['Parent', 'Empty Child'],
      ['Parent', 'With Request'],
    ]);
    expect(bundle.requests[0].folderPath).toEqual(['Parent', 'With Request']);
  });

  it('imports a folder-only OpenCollection as an empty collection tree', () => {
    const bundle = openCollectionBundleFromFiles([
      { path: 'opencollection.yml', content: `info:\n  name: Empty API\n` },
      { path: 'empty/folder.yml', content: `info:\n  name: Empty\n  type: folder\n` },
      { path: 'empty/nested/folder.yml', content: `info:\n  name: Nested\n  type: folder\n` },
    ], 'collection-1', 'Fallback', 'workspace-1');

    expect(bundle.name).toBe('Empty API');
    expect(bundle.folderPaths).toEqual([['Empty'], ['Empty', 'Nested']]);
    expect(bundle.requests).toEqual([]);
  });
});

describe('buildOpenCollectionFiles', () => {
  it('exports a Bruno-compatible OpenCollection folder and redacts secrets by default', () => {
    const request = testRequest({
      id: 'req-oc',
      name: 'Create User',
      folderPath: ['Users'],
      method: 'POST',
      url: '{{baseUrl}}/users',
      params: [testRow('dryRun', 'true')],
      headers: [testRow('Authorization', 'Bearer raw-token')],
      auth: { ...emptyAuthState(), type: 'bearer', bearerToken: 'raw-token' },
      bodyType: 'json',
      bodyContent: '{"name":"Ada"}',
      preRequestScriptJs: 'bru.setVar("stamp", Date.now());',
      testScriptJs: 'test("created", () => expect(res.status).to.equal(201));',
      requestNotes: 'Creates a user.',
      settings: { ...DEFAULT_REQUEST_SETTINGS, timeoutMs: 12000, followRedirects: true },
      settingsOverrides: { timeoutMs: true, followRedirects: true },
    });
    const env: Environment = {
      id: 'env-1',
      workspaceId: 'workspace-1',
      name: 'Local',
      filesystemName: 'Local',
      values: [testRow('baseUrl', 'https://api.example.test'), { ...testRow('token', 'raw-token'), secret: true }],
    };
    const defaults = emptyCollectionDefaults();
    defaults.headers = [testRow('X-Collection', 'collection-secret')];
    defaults.variables = [{ ...testRow('tenant', 'acme'), secret: true }];
    defaults.auth = { ...emptyAuthState(), type: 'apikey', apiKeyName: 'X-Collection-Key', apiKeyValue: 'collection-secret', apiKeyIn: 'header' };
    defaults.preRequestScriptJs = 'bru.setVar("collection", "yes");';
    defaults.settings = { ...DEFAULT_REQUEST_SETTINGS, timeoutMs: 9000, followRedirects: false, proxyUrl: 'http://localhost:8080' };

    const files = buildOpenCollectionFiles('Bruno API', 'Docs', defaults, [request], [env], strip);
    expect(files.map(file => file.path)).toEqual(expect.arrayContaining([
      'opencollection.yml',
      'Users/folder.yml',
      'Users/Create-User.yml',
      'environments/Local.yml',
    ]));
    const rootFile = files.find(file => file.path === 'opencollection.yml')?.content ?? '';
    expect(rootFile).toContain('docs: Docs');
    expect(rootFile).toContain('name: X-Collection');
    expect(rootFile).toContain('value: collection-secret');
    expect(rootFile).toContain('name: tenant');
    expect(rootFile).toContain('value: ""');
    expect(rootFile).toContain('type: apikey');
    expect(rootFile).toContain('key: X-Collection-Key');
    expect(rootFile).toContain('before-request');
    expect(rootFile).toContain('timeout: 9000');
    expect(rootFile).toContain('followRedirects: false');
    expect(rootFile).toContain('proxyUrl: http://localhost:8080');
    const requestFile = files.find(file => file.path === 'Users/Create-User.yml')?.content ?? '';
    expect(requestFile).toContain('info:');
    expect(requestFile).toContain('method: POST');
    expect(requestFile).toContain('type: bearer');
    expect(requestFile).toContain('token: ""');
    expect(requestFile).toContain('before-request');
    expect(requestFile).toContain('tests');
    expect(requestFile).toContain('docs: |-');
    expect(requestFile).toContain('timeout: 12000');
    expect(requestFile).toContain('followRedirects: true');
    expect(requestFile).not.toContain('timeout: 9000');
    expect(requestFile).not.toContain('X-Collection-Key');
    expect(requestFile).not.toContain('tenant');
    const envFile = files.find(file => file.path === 'environments/Local.yml')?.content ?? '';
    expect(envFile).toContain('name: baseUrl');
    expect(envFile).toContain('name: token');
    expect(envFile).toContain('secret: true');
    expect(envFile).toContain('value: ""');
  });

  it('redacts raw URL query secrets in OpenCollection HTTP and gRPC targets', () => {
    const files = buildOpenCollectionFiles('API', '', emptyCollectionDefaults(), [
      testRequest({
        id: 'req-http-secret-url',
        name: 'HTTP Secret URL',
        requestType: 'http',
        url: 'https://api.example.test/search?token=raw-token&visible=yes',
      }),
      testRequest({
        id: 'req-grpc-secret-target',
        name: 'gRPC Secret Target',
        requestType: 'grpc',
        url: 'grpc.example.test:443?api_key=raw-key',
        grpcMethod: 'shop.Inventory/GetItem',
      }),
    ], [], strip);

    const combined = files.map(file => file.content).join('\n');
    expect(combined).toContain('token=&visible=yes');
    expect(combined).toContain('api_key=');
    expect(combined).not.toContain('raw-token');
    expect(combined).not.toContain('raw-key');
  });

  it('exports explicit empty collection folders as folder.yml files', () => {
    const files = buildOpenCollectionFiles(
      'Bruno API',
      '',
      emptyCollectionDefaults(),
      [],
      [],
      strip,
      false,
      [['Parent'], ['Parent', 'Empty Child']],
    );

    expect(files.map(file => file.path)).toEqual(expect.arrayContaining([
      'Parent/folder.yml',
      'Parent/Empty-Child/folder.yml',
    ]));
    expect(files.find(file => file.path === 'Parent/Empty-Child/folder.yml')?.content).toContain('name: Empty Child');
  });

  it('round-trips all Kurlo request types through OpenCollection files', () => {
    const files = buildOpenCollectionFiles('Mixed API', '', emptyCollectionDefaults(), [
      testRequest({ id: 'req-http', name: 'HTTP', requestType: 'http', url: 'https://api.example.test/ping' }),
      testRequest({
        id: 'req-gql',
        name: 'GraphQL',
        requestType: 'graphql',
        requestTab: 'query',
        bodyType: 'graphql',
        bodyContent: JSON.stringify({ query: '{ viewer { id } }', variables: {} }),
      }),
      testRequest({
        id: 'req-ws',
        name: 'WS',
        requestType: 'ws',
        requestTab: 'body',
        url: 'wss://api.example.test/ws',
        bodyType: 'text',
        rawBodyType: 'text',
        bodyContent: 'hello',
      }),
      testRequest({
        id: 'req-sio',
        name: 'Socket.IO',
        requestType: 'socketio',
        requestTab: 'events',
        url: 'https://api.example.test/realtime',
        settings: { ...DEFAULT_REQUEST_SETTINGS, sioClientVersion: 'v2', sioPath: '/socket.io' },
        sioEvents: [testRow('server:event', '')],
        sioArgs: [{ id: 'arg-1', content: '{"ok":true}', bodyType: 'json', encoding: 'base64' }],
      }),
      testRequest({
        id: 'req-grpc',
        name: 'gRPC',
        requestType: 'grpc',
        requestTab: 'body',
        url: 'grpc.example.test:443',
        bodyType: 'json',
        bodyContent: '{"id":"1"}',
        grpcMethod: 'shop.Inventory/GetItem',
        grpcMetadata: [testRow('authorization', 'Bearer {{token}}')],
      }),
    ], [], strip, true);

    const bundle = openCollectionBundleFromFiles(files, 'collection-2', 'Mixed API', 'workspace-1');

    expect(bundle.requests.map(request => request.requestType)).toEqual(['graphql', 'grpc', 'http', 'socketio', 'ws']);
    expect(bundle.requests.find(request => request.requestType === 'socketio')).toMatchObject({
      sioArgs: [expect.objectContaining({ content: '{"ok":true}', bodyType: 'json' })],
      settings: expect.objectContaining({ sioClientVersion: 'v2', sioPath: '/socket.io' }),
    });
    expect(bundle.requests.find(request => request.requestType === 'grpc')).toMatchObject({
      grpcMethod: 'shop.Inventory/GetItem',
      grpcMetadata: [expect.objectContaining({ key: 'authorization', value: 'Bearer {{token}}' })],
      bodyContent: '{"id":"1"}',
    });
  });
});
