import { testRequest, testRow, postmanExport, strip } from './support/importers';
import { describe, it, expect } from 'vitest';
import { postmanRequestsFromItems, postmanCollectionBundle, postmanVariableBundle, buildPostmanEnvironment, buildPostmanCollection } from '../lib/postman';
import { mkRow, DEFAULT_REQUEST_SETTINGS } from '../lib/constants';
import { emptyAuthState } from '../lib/utils';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import { buildInsomniaExport } from '../lib/insomnia';

describe('postmanRequestsFromItems', () => {
  it('imports collection folders, params, headers, auth, and JSON body', () => {
    const items = [
      {
        name: 'Products',
        item: [
          {
            name: 'Create product',
            request: {
              method: 'POST',
              url: {
                raw: '{{baseUrl}}/products?dryRun=true',
                query: [{ key: 'dryRun', value: 'true' }],
              },
              header: [{ key: 'X-Trace-ID', value: '{{traceId}}' }],
              auth: {
                type: 'bearer',
                bearer: [{ key: 'token', value: '{{token}}' }],
              },
              body: {
                mode: 'raw',
                raw: '{"name":"Coffee"}',
                options: { raw: { language: 'json' } },
              },
            },
          },
        ],
      },
    ];

    const requests = postmanRequestsFromItems(items, 'collection-1', 'Postman API', undefined);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      name: 'Create product',
      collectionId: 'collection-1',
      collection: 'Postman API',
      folderPath: ['Products'],
      method: 'POST',
      url: '{{baseUrl}}/products',
      bodyType: 'json',
      rawBodyType: 'json',
      bodyContent: '{"name":"Coffee"}',
    });
    expect(requests[0].params[0]).toMatchObject({ key: 'dryRun', value: 'true', enabled: true });
    expect(requests[0].headers[0]).toMatchObject({ key: 'X-Trace-ID', value: '{{traceId}}', enabled: true });
    expect(requests[0].auth).toMatchObject({ type: 'bearer', bearerToken: '{{token}}' });
  });

  it('skips Postman request placeholders without URLs', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Folder',
        item: [
          { name: 'Blank draft', request: { method: 'GET', header: [] } },
          { name: 'Ping', request: { method: 'GET', url: 'https://api.example.test/ping' } },
        ],
      },
    ], 'collection-1', 'Postman API', undefined);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      name: 'Ping',
      url: 'https://api.example.test/ping',
      folderPath: ['Folder'],
    });
  });

  it('imports Postman GraphQL bodies as GraphQL requests', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Viewer',
        request: {
          method: 'POST',
          url: 'https://api.example.test/graphql',
          body: {
            mode: 'graphql',
            graphql: {
              query: 'query Viewer($id: ID!) { viewer(id: $id) { name } }',
              variables: '{"id":"123"}',
            },
          },
        },
      },
    ], 'collection-1', 'Graph API', undefined);

    expect(requests[0]).toMatchObject({
      requestType: 'graphql',
      method: 'POST',
      requestTab: 'query',
      bodyType: 'graphql',
    });
    expect(JSON.parse(requests[0].bodyContent)).toMatchObject({
      query: 'query Viewer($id: ID!) { viewer(id: $id) { name } }',
      variables: { id: '123' },
    });
  });

  it('imports Postman GraphQL variables objects and operation names', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Viewer',
        request: {
          method: 'POST',
          url: 'https://api.example.test/graphql',
          body: {
            mode: 'graphql',
            graphql: {
              query: 'query Viewer($id: ID!) { viewer(id: $id) { name } }',
              variables: { id: '123' },
              operationName: 'Viewer',
            },
          },
        },
      },
    ], 'collection-1', 'Graph API', undefined);

    expect(requests[0]).toMatchObject({ requestType: 'graphql', method: 'POST', requestTab: 'query' });
    expect(JSON.parse(requests[0].bodyContent)).toEqual({
      query: 'query Viewer($id: ID!) { viewer(id: $id) { name } }',
      variables: { id: '123' },
      operationName: 'Viewer',
    });
  });

  it('imports Postman raw GraphQL bodies as GraphQL requests', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Raw GraphQL',
        request: {
          method: 'POST',
          url: 'https://api.example.test/graphql',
          body: {
            mode: 'raw',
            raw: 'query Viewer { viewer { name } }',
            options: { raw: { language: 'graphql' } },
          },
        },
      },
    ], 'collection-1', 'Graph API', undefined);

    expect(requests[0]).toMatchObject({ requestType: 'graphql', bodyType: 'graphql', requestTab: 'query' });
    expect(JSON.parse(requests[0].bodyContent)).toMatchObject({
      query: 'query Viewer { viewer { name } }',
      variables: {},
    });
  });

  it('imports Postman raw JSON GraphQL bodies as GraphQL requests', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Raw JSON GraphQL',
        request: {
          method: 'POST',
          url: 'https://api.example.test/graphql',
          body: {
            mode: 'raw',
            raw: '{"query":"query Viewer { viewer { name } }","variables":{"id":"123"}}',
            options: { raw: { language: 'json' } },
          },
        },
      },
    ], 'collection-1', 'Graph API', undefined);

    expect(requests[0]).toMatchObject({ requestType: 'graphql', bodyType: 'graphql', requestTab: 'query' });
    expect(JSON.parse(requests[0].bodyContent)).toMatchObject({
      query: 'query Viewer { viewer { name } }',
      variables: { id: '123' },
    });
  });

  it('imports Postman WebSocket URLs as realtime requests', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Echo',
        request: {
          method: 'GET',
          url: 'wss://realtime.example.test/ws',
          body: {
            mode: 'raw',
            raw: 'hello',
            options: { raw: { language: 'text' } },
          },
        },
      },
    ], 'collection-1', 'Realtime API', undefined);

    expect(requests[0]).toMatchObject({
      requestType: 'ws',
      requestTab: 'body',
      url: 'wss://realtime.example.test/ws',
      bodyType: 'text',
      bodyContent: 'hello',
    });
  });

  it('imports Postman Socket.IO handshakes as Socket.IO requests', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Socket.IO',
        request: {
          method: 'GET',
          url: {
            raw: 'wss://realtime.example.test/socket.io/?EIO=4&transport=websocket',
            query: [
              { key: 'EIO', value: '4' },
              { key: 'transport', value: 'websocket' },
            ],
          },
        },
      },
    ], 'collection-1', 'Realtime API', undefined);

    expect(requests[0]).toMatchObject({
      requestType: 'socketio',
      requestTab: 'events',
      url: 'https://realtime.example.test',
      params: [],
      settings: expect.objectContaining({ sioPath: '/socket.io', sioClientVersion: 'v3' }),
    });
  });

  it('preserves Postman Socket.IO EIO v3 handshakes when query params are split out', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Socket.IO v2',
        request: {
          method: 'GET',
          url: {
            raw: 'wss://realtime.example.test/socket.io/?EIO=3&transport=websocket',
            query: [
              { key: 'EIO', value: '3' },
              { key: 'transport', value: 'websocket' },
            ],
          },
        },
      },
    ], 'collection-1', 'Realtime API', undefined);

    expect(requests[0]).toMatchObject({
      requestType: 'socketio',
      url: 'https://realtime.example.test',
      params: [],
      settings: expect.objectContaining({ sioClientVersion: 'v2' }),
    });
  });

  it('imports pre-request and test scripts, and the request description', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Login',
        event: [
          { listen: 'prerequest', script: { type: 'text/javascript', exec: ['pm.variables.set("nonce", "1")'] } },
          { listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("ok", () => {', '  pm.response.to.have.status(200)', '})'] } },
        ],
        request: {
          method: 'POST',
          url: 'https://api.example.test/login',
          description: 'Exchanges credentials for a token.',
        },
      },
    ], 'collection-1', 'Postman API', undefined);

    expect(requests[0].preRequestScript).toBe('pm.variables.set("nonce", "1")');
    expect(requests[0].testScript).toBe('pm.test("ok", () => {\n  pm.response.to.have.status(200)\n})');
    expect(requests[0].requestNotes).toBe('Exchanges credentials for a token.');
  });

  it('accepts a script exec written as a single string and skips disabled events', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Ping',
        event: [
          { listen: 'prerequest', script: { exec: 'pm.variables.set("a", "1")' } },
          { listen: 'test', disabled: true, script: { exec: ['pm.test("never", () => {})'] } },
        ],
        request: { method: 'GET', url: 'https://api.example.test/ping' },
      },
    ], 'collection-1', 'Postman API', undefined);

    expect(requests[0].preRequestScript).toBe('pm.variables.set("a", "1")');
    expect(requests[0].testScript).toBe('');
  });

  it('keeps folder scripts on the folder instead of copying them into requests', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Billing',
        event: [{ listen: 'prerequest', script: { exec: ['pm.variables.set("scope", "billing")'] } }],
        item: [
          {
            name: 'Invoices',
            event: [{ listen: 'prerequest', script: { exec: ['pm.variables.set("page", "1")'] } }],
            request: { method: 'GET', url: 'https://api.example.test/invoices' },
          },
        ],
      },
    ], 'collection-1', 'Postman API', undefined);

    expect(requests[0].preRequestScript).toBe('pm.variables.set("page", "1")');
    expect(requests[0].folderPath).toEqual(['Billing']);
  });

  it('carries the whole OAuth 2.0 flow across, not just the access token', () => {
    const requests = postmanRequestsFromItems([
      {
        name: 'Me',
        request: {
          method: 'GET',
          url: 'https://api.example.test/me',
          auth: {
            type: 'oauth2',
            oauth2: [
              { key: 'accessToken', value: 'stale-token' },
              { key: 'grant_type', value: 'authorization_code_with_pkce' },
              { key: 'accessTokenUrl', value: 'https://id.example.test/token' },
              { key: 'authUrl', value: 'https://id.example.test/authorize' },
              { key: 'clientId', value: 'client-1' },
              { key: 'clientSecret', value: 'secret-1' },
              { key: 'scope', value: 'read write' },
              { key: 'audience', value: 'https://api.example.test' },
              { key: 'refreshToken', value: 'refresh-1' },
              { key: 'client_authentication', value: 'body' },
            ],
          },
        },
      },
    ], 'collection-1', 'Postman API', undefined);

    expect(requests[0].auth).toMatchObject({
      type: 'oauth2',
      oauth2Token: 'stale-token',
      oauth2GrantType: 'authorization_code',
      oauth2UsePKCE: true,
      oauth2TokenURL: 'https://id.example.test/token',
      oauth2AuthURL: 'https://id.example.test/authorize',
      oauth2ClientID: 'client-1',
      oauth2Secret: 'secret-1',
      oauth2Scope: 'read write',
      oauth2Audience: 'https://api.example.test',
      oauth2RefreshToken: 'refresh-1',
      oauth2ClientAuth: 'body',
    });
  });

  it('leaves a request with no auth anywhere inheriting from the collection', () => {
    const requests = postmanRequestsFromItems([
      { name: 'Ping', request: { method: 'GET', url: 'https://api.example.test/ping' } },
    ], 'collection-1', 'Postman API', undefined);

    expect(requests[0].auth.type).toBe('inherit');
  });
});

describe('postmanCollectionBundle', () => {
  const collection = {
    info: { name: 'Billing API', description: 'Everything about invoices.', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{collectionToken}}' }] },
    event: [
      { listen: 'prerequest', script: { exec: ['pm.variables.set("collection", "yes")'] } },
      { listen: 'test', script: { exec: ['pm.test("json", () => pm.response.json())'] } },
    ],
    variable: [
      { key: 'baseUrl', value: 'https://api.example.test' },
      { key: 'apiKey', value: 'k-1', type: 'secret' },
      { key: 'legacy', value: 'off', disabled: true },
    ],
    item: [
      { name: 'Empty folder', item: [] },
      { name: 'Ping', request: { method: 'GET', url: '{{baseUrl}}/ping' } },
    ],
  };

  it('lifts collection variables, auth, scripts, and description onto the defaults', () => {
    const bundle = postmanCollectionBundle(collection, 'collection-1', 'fallback');

    expect(bundle.name).toBe('Billing API');
    expect(bundle.description).toBe('Everything about invoices.');
    expect(bundle.defaults.auth).toMatchObject({ type: 'bearer', bearerToken: '{{collectionToken}}' });
    expect(bundle.defaults.preRequestScript).toBe('pm.variables.set("collection", "yes")');
    expect(bundle.defaults.testScript).toBe('pm.test("json", () => pm.response.json())');
    expect(bundle.defaults.variables).toMatchObject([
      { key: 'baseUrl', value: 'https://api.example.test', enabled: true },
      { key: 'apiKey', value: 'k-1', secret: true },
      { key: 'legacy', value: 'off', enabled: false },
    ]);
    expect(bundle.requests).toHaveLength(1);
  });

  it('keeps folders that hold no requests', () => {
    expect(postmanCollectionBundle(collection, 'collection-1', 'fallback').folderPaths).toEqual([['Empty folder']]);
  });

  it('rejects a payload that is not a collection', () => {
    expect(() => postmanCollectionBundle({ info: { name: 'x' } }, 'collection-1', 'fallback')).toThrow(/Postman collection/);
  });
});

describe('postmanVariableBundle', () => {
  it('reads a Postman environment export', () => {
    const bundle = postmanVariableBundle({
      name: 'Staging',
      values: [
        { key: 'baseUrl', value: 'https://staging.example.test', enabled: true, type: 'default' },
        { key: 'token', value: 't-1', enabled: true, type: 'secret' },
        { key: 'old', value: '', enabled: false, type: 'default' },
      ],
      _postman_variable_scope: 'environment',
    }, 'fallback');

    expect(bundle).toMatchObject({ scope: 'environment', name: 'Staging' });
    expect(bundle?.values).toMatchObject([
      { key: 'baseUrl', value: 'https://staging.example.test', enabled: true },
      { key: 'token', value: 't-1', secret: true },
      { key: 'old', enabled: false },
    ]);
  });

  it('recognises a globals export', () => {
    expect(postmanVariableBundle({ values: [{ key: 'g', value: '1' }], _postman_variable_scope: 'globals' }, 'fallback'))
      .toMatchObject({ scope: 'globals', name: 'fallback' });
  });

  it('ignores collections', () => {
    expect(postmanVariableBundle({ info: { name: 'API' }, item: [], values: [] }, 'fallback')).toBeNull();
  });
});

describe('buildPostmanEnvironment', () => {
  it('omits secret values by default and can include them explicitly', () => {
    const env = {
      id: 'env-1',
      workspaceId: 'workspace-1',
      name: 'Local',
      values: [
        { ...mkRow(), key: 'token', value: 'super-secret', secret: true },
        { ...mkRow(), key: 'baseUrl', value: 'http://localhost:3000' },
      ],
    };

    expect(buildPostmanEnvironment(env).values).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'token', value: '', type: 'secret' }),
      expect.objectContaining({ key: 'baseUrl', value: 'http://localhost:3000', type: 'default' }),
    ]));
    expect(buildPostmanEnvironment(env, true).values).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'token', value: 'super-secret', type: 'secret' }),
    ]));
  });
});

describe('buildPostmanCollection', () => {
  it('omits raw secret-like values by default and can include them explicitly', () => {
    const request = testRequest({
      id: 'req-secret',
      method: 'POST',
      url: 'https://api.example.test/login',
      params: [testRow('api_key', 'raw-key')],
      headers: [testRow('Authorization', 'Bearer raw-token')],
      auth: { ...emptyAuthState(), type: 'bearer', bearerToken: 'raw-token' },
      bodyType: 'urlencoded',
      formRows: [testRow('username', 'admin'), testRow('password', 'raw-password')],
    });

    const safe = postmanExport(buildPostmanCollection('API', '', [request], strip));
    const safeItem = safe.item[0].request;
    expect(safeItem.auth.bearer[0]).toMatchObject({ key: 'token', value: '' });
    expect(safeItem.header[0]).toMatchObject({ key: 'Authorization', value: '' });
    expect(safeItem.url.query[0]).toMatchObject({ key: 'api_key', value: '' });
    expect(safeItem.body.urlencoded).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'username', value: 'admin' }),
      expect.objectContaining({ key: 'password', value: '' }),
    ]));

    const withSecrets = postmanExport(buildPostmanCollection('API', '', [request], strip, true));
    const itemWithSecrets = withSecrets.item[0].request;
    expect(itemWithSecrets.auth.bearer[0]).toMatchObject({ key: 'token', value: 'raw-token' });
    expect(itemWithSecrets.body.urlencoded).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'password', value: 'raw-password' }),
    ]));
  });

  it('redacts raw URL query secrets and preserves duplicate raw query params', () => {
    const request = testRequest({
      id: 'req-url-secret',
      method: 'GET',
      url: 'https://api.example.test/search?tag=one&api_key=raw-key&tag=two#results',
      params: [testRow('tag', 'three')],
    });

    const safe = postmanExport(buildPostmanCollection('API', '', [request], strip));
    expect(safe.item[0].request.url?.raw).toBe('https://api.example.test/search?tag=one&api_key=&tag=two&tag=three#results');

    const withSecrets = postmanExport(buildPostmanCollection('API', '', [request], strip, true));
    expect(withSecrets.item[0].request.url?.raw).toContain('api_key=raw-key');
  });

  it('redacts raw URL userinfo and keeps templated URL userinfo', () => {
    const rawCreds = testRequest({
      id: 'req-url-userinfo-secret',
      method: 'GET',
      url: 'https://raw-user:raw-pass@api.example.test/me?view=full',
    });
    const templatedCreds = testRequest({
      id: 'req-url-userinfo-template',
      method: 'GET',
      url: 'https://{{apiCreds}}@api.example.test/me',
    });
    const protocolRelativeCreds = testRequest({
      id: 'req-url-userinfo-protocol-relative',
      method: 'GET',
      url: '//raw-user:raw-pass@api.example.test/protocol-relative',
    });

    const safe = postmanExport(buildPostmanCollection('API', '', [rawCreds, templatedCreds, protocolRelativeCreds], strip));
    expect(safe.item[0].request.url?.raw).toBe('https://api.example.test/me?view=full');
    expect(safe.item[1].request.url?.raw).toBe('https://{{apiCreds}}@api.example.test/me');
    expect(safe.item[2].request.url?.raw).toBe('//api.example.test/protocol-relative');

    const withSecrets = postmanExport(buildPostmanCollection('API', '', [rawCreds], strip, true));
    expect(withSecrets.item[0].request.url?.raw).toContain('raw-user:raw-pass@');
  });

  it('keeps variable references in secret-like fields', () => {
    const request = testRequest({
      id: 'req-vars',
      method: 'GET',
      url: 'https://api.example.test/me',
      headers: [testRow('Authorization', 'Bearer {{token}}')],
      auth: { ...emptyAuthState(), type: 'bearer', bearerToken: '{{token}}' },
    });

    const safe = postmanExport(buildPostmanCollection('API', '', [request], strip));
    const safeItem = safe.item[0].request;
    expect(safeItem.auth.bearer[0]).toMatchObject({ key: 'token', value: '{{token}}' });
    expect(safeItem.header[0]).toMatchObject({ key: 'Authorization', value: 'Bearer {{token}}' });
  });

  it('exports GraphQL requests in Postman GraphQL body mode', () => {
    const request = testRequest({
      id: 'req-gql',
      requestType: 'graphql',
      method: 'GET',
      url: 'https://api.example.test/graphql',
      requestTab: 'query',
      bodyType: 'graphql',
      bodyContent: JSON.stringify({
        query: 'query Viewer($id: ID!) { viewer(id: $id) { name } }',
        variables: { id: '{{viewerId}}' },
        operationName: 'Viewer',
      }),
    });

    const exported = postmanExport(buildPostmanCollection('Graph API', '', [request], strip));
    const item = exported.item[0].request;
    expect(item.method).toBe('POST');
    expect(item.body?.mode).toBe('graphql');
    expect(item.body?.graphql).toMatchObject({
      query: 'query Viewer($id: ID!) { viewer(id: $id) { name } }',
      operationName: 'Viewer',
    });
    expect(JSON.parse(String(item.body?.graphql?.variables))).toEqual({ id: '{{viewerId}}' });
  });

  it('round-trips all Kurlo request types through Postman export metadata', () => {
    const requests = [
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
        sioAck: true,
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
    ];

    const exported = buildPostmanCollection('Mixed API', '', requests, strip, true);
    const imported = postmanRequestsFromItems(exported.item, 'collection-2', 'Mixed API', undefined);

    expect(imported.map(request => request.requestType)).toEqual(['http', 'graphql', 'ws', 'socketio', 'grpc']);
    expect(imported.find(request => request.requestType === 'socketio')).toMatchObject({
      sioAck: true,
      sioArgs: [expect.objectContaining({ content: '{"ok":true}', bodyType: 'json' })],
    });
    expect(imported.find(request => request.requestType === 'grpc')).toMatchObject({
      grpcMethod: 'shop.Inventory/GetItem',
      grpcMetadata: [expect.objectContaining({ key: 'authorization', value: 'Bearer {{token}}' })],
      bodyContent: '{"id":"1"}',
    });
  });

  it('round-trips scripts, docs, and collection defaults through Postman', () => {
    const request = testRequest({
      id: 'req-scripts',
      name: 'Login',
      preRequestScript: 'pm.variables.set("nonce", "1")',
      testScript: 'pm.test("ok", () => pm.response.to.have.status(200))',
      requestNotes: 'Exchanges credentials for a token.',
    });
    const defaults = {
      ...emptyCollectionDefaults(),
      variables: [testRow('baseUrl', 'https://api.example.test')],
      auth: { ...emptyAuthState(), type: 'bearer' as const, bearerToken: '{{collectionToken}}' },
      preRequestScript: 'pm.variables.set("collection", "yes")',
      testScript: 'pm.test("json", () => pm.response.json())',
    };

    const exported = buildPostmanCollection('API', 'Docs.', [request], strip, true, defaults);
    expect(exported.item[0]).toMatchObject({ event: expect.any(Array) });
    expect(exported.item[0].request).toMatchObject({ description: 'Exchanges credentials for a token.' });

    const bundle = postmanCollectionBundle(exported, 'collection-2', 'API');
    expect(bundle.requests[0]).toMatchObject({
      preRequestScript: 'pm.variables.set("nonce", "1")',
      testScript: 'pm.test("ok", () => pm.response.to.have.status(200))',
      requestNotes: 'Exchanges credentials for a token.',
    });
    expect(bundle.defaults).toMatchObject({
      preRequestScript: 'pm.variables.set("collection", "yes")',
      testScript: 'pm.test("json", () => pm.response.json())',
      auth: expect.objectContaining({ type: 'bearer', bearerToken: '{{collectionToken}}' }),
    });
    expect(bundle.defaults.variables).toMatchObject([{ key: 'baseUrl', value: 'https://api.example.test' }]);
  });

  it('redacts raw URL query secrets in Insomnia export URLs', () => {
    const request = testRequest({
      id: 'req-insomnia-url-secret',
      method: 'GET',
      url: 'https://api.example.test/me?access_token=raw-token&view=full',
    });

    const safe = buildInsomniaExport('API', '', [request], strip);
    const safeRequest = safe.resources.find(resource => resource._type === 'request');
    expect(safeRequest?.url).toBe('https://api.example.test/me?access_token=&view=full');

    const withSecrets = buildInsomniaExport('API', '', [request], strip, true);
    const requestWithSecrets = withSecrets.resources.find(resource => resource._type === 'request');
    expect(requestWithSecrets?.url).toBe('https://api.example.test/me?access_token=raw-token&view=full');
  });
});
