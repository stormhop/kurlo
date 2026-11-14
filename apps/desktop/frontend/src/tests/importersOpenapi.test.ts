import { testRequest, testRow, strip, operation, exportDocument } from './support/importers';
import { describe, it, expect } from 'vitest';
import { parseOpenApiDocument, openApiImportFromSpec, openApiRequestsFromSpec, buildOpenApiDocument, buildSwaggerDocument } from '../lib/openapi';
import { emptyAuthState } from '../lib/utils';

describe('openApiRequestsFromSpec', () => {
  it('imports OpenAPI YAML paths into tag folders with examples', () => {
    const spec = parseOpenApiDocument(`
openapi: 3.0.3
info:
  title: Petstore
servers:
  - url: https://api.example.test/v1
paths:
  /pets/{petId}:
    get:
      tags: [Pets]
      summary: Get pet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
        - name: verbose
          in: query
          schema:
            type: boolean
    post:
      tags:
        - Pets
      summary: Update pet
      requestBody:
        content:
          application/json:
            example:
              name: Fluffy
              age: 3
`);

    const { requests, defaults } = openApiImportFromSpec(spec, 'collection-1', 'Petstore');

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      folderPath: ['Pets'],
      url: '{{baseUrl}}/pets/:petId',
    });
    expect(requests[0].pathParams).toEqual([expect.objectContaining({ key: 'petId', enabled: true })]);
    expect(defaults.variables).toContainEqual(
      expect.objectContaining({ key: 'baseUrl', value: 'https://api.example.test/v1' }),
    );
    expect(defaults.variables).not.toContainEqual(expect.objectContaining({ key: 'petId' }));
    expect(requests[0].params[0]).toMatchObject({ key: 'verbose', value: 'true' });
    expect(requests[1]).toMatchObject({ method: 'POST', bodyType: 'json' });
    expect(JSON.parse(requests[1].bodyContent)).toEqual({ name: 'Fluffy', age: 3 });
  });

  it('imports Swagger 2 body schemas and base URLs', () => {
    const requests = openApiRequestsFromSpec({
      swagger: '2.0',
      info: { title: 'Legacy API' },
      host: 'legacy.example.test',
      basePath: '/api',
      schemes: ['https'],
      paths: {
        '/users': {
          post: {
            tags: ['Users'],
            parameters: [
              {
                name: 'body',
                in: 'body',
                schema: {
                  type: 'object',
                  properties: {
                    email: { type: 'string', format: 'email' },
                  },
                },
              },
            ],
          },
        },
      },
    }, 'collection-1', 'Legacy API');

    expect(requests[0].url).toBe('{{baseUrl}}/users');
    expect(JSON.parse(requests[0].bodyContent)).toEqual({ email: 'user@example.com' });
  });

  it('maps a document-level security scheme onto the collection', () => {
    const { requests, defaults } = openApiImportFromSpec({
      openapi: '3.0.0',
      info: { title: 'Secure API' },
      servers: [{ url: 'https://api.example.test' }, { url: 'https://staging.example.test' }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearerAuth: [] }],
      paths: { '/me': { get: { summary: 'Me' } } },
    }, 'collection-1', 'Secure API');

    expect(defaults.auth).toMatchObject({ type: 'bearer', bearerToken: '{{bearerToken}}' });
    expect(defaults.variables).toContainEqual(expect.objectContaining({ key: 'bearerToken', secret: true }));
    expect(requests[0].auth.type).toBe('inherit');
    expect(defaults.variables.filter(row => row.key === 'baseUrl').map(row => [row.value, row.enabled])).toEqual([
      ['https://api.example.test', true],
      ['https://staging.example.test', false],
    ]);
  });

  it('maps an API key scheme with its declared name and location', () => {
    const { requests, defaults } = openApiImportFromSpec({
      openapi: '3.0.0',
      info: { title: 'Keyed API' },
      components: { securitySchemes: { key: { type: 'apiKey', name: 'X-Token', in: 'query' } } },
      paths: { '/things': { get: { summary: 'Things', security: [{ key: [] }] } } },
    }, 'collection-1', 'Keyed API');

    expect(requests[0].auth).toMatchObject({ type: 'apikey', apiKeyName: 'X-Token', apiKeyIn: 'query', apiKeyValue: '{{apiKey}}' });
    expect(defaults.variables).toContainEqual(expect.objectContaining({ key: 'apiKey' }));
  });

  it('treats an operation with empty security as public', () => {
    const { requests } = openApiImportFromSpec({
      openapi: '3.0.0',
      info: { title: 'Mixed API' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearerAuth: [] }],
      paths: {
        '/private': { get: { summary: 'Private' } },
        '/health': { get: { summary: 'Health', security: [] } },
      },
    }, 'collection-1', 'Mixed API');

    const byName = Object.fromEntries(requests.map(request => [request.name, request]));
    expect(byName.Private.auth.type).toBe('inherit');
    expect(byName.Health.auth.type).toBe('none');
  });

  it('carries an oauth2 scheme through with its endpoints and scopes', () => {
    const { requests } = openApiImportFromSpec({
      openapi: '3.0.0',
      info: { title: 'OAuth API' },
      components: {
        securitySchemes: {
          oauth: {
            type: 'oauth2',
            flows: { clientCredentials: { tokenUrl: 'https://auth.example.test/token', scopes: { read: 'Read', write: 'Write' } } },
          },
        },
      },
      paths: { '/orders': { get: { summary: 'Orders', security: [{ oauth: ['read'] }] } } },
    }, 'collection-1', 'OAuth API');

    expect(requests[0].auth).toMatchObject({
      type: 'oauth2',
      oauth2GrantType: 'client_credentials',
      oauth2TokenURL: 'https://auth.example.test/token',
      oauth2Scope: 'read write',
    });
  });
});

describe('buildOpenApiDocument', () => {
  it('exports Kurlo requests as OpenAPI paths, parameters, JSON bodies, and auth', () => {
    const doc = buildOpenApiDocument('Shop API', 'Generated spec', [
      testRequest({
        id: 'req-users-get',
        name: 'Get user',
        folderPath: ['Users'],
        method: 'GET',
        url: 'https://api.example.test/v1/users/{{userId}}?expand=orders',
        params: [testRow('verbose', 'true')],
        headers: [testRow('X-Trace-ID', '{{traceId}}')],
        auth: { ...emptyAuthState(), type: 'bearer', bearerToken: '{{token}}' },
      }),
      testRequest({
        id: 'req-users-post',
        name: 'Create user',
        folderPath: ['Users'],
        method: 'POST',
        url: 'https://api.example.test/v1/users',
        headers: [testRow('Content-Type', 'application/json')],
        bodyType: 'json',
        bodyContent: '{"email":"user@example.com","active":true}',
      }),
    ], strip);

    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info).toMatchObject({ title: 'Shop API', description: 'Generated spec' });
    expect(doc.servers).toEqual([{ url: 'https://api.example.test' }]);

    const getUser = operation(doc, '/v1/users/{userId}', 'get');
    expect(getUser.tags).toEqual(['Users']);
    expect(getUser.security).toEqual([{ bearerAuth: [] }]);
    expect(getUser.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'userId', in: 'path', required: true }),
      expect.objectContaining({ name: 'verbose', in: 'query', example: 'true' }),
      expect.objectContaining({ name: 'expand', in: 'query', example: 'orders' }),
      expect.objectContaining({ name: 'X-Trace-ID', in: 'header', example: '{{traceId}}' }),
    ]));

    const createUser = operation(doc, '/v1/users', 'post');
    expect(createUser.requestBody?.content['application/json']?.schema).toMatchObject({
      type: 'object',
      properties: {
        email: { type: 'string' },
        active: { type: 'boolean' },
      },
    });
    expect(doc.components).toMatchObject({
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    });
  });

  it('throws a clear error when two requests would overwrite the same operation', () => {
    const requests = [
      testRequest({ id: 'req-1', name: 'First', method: 'GET', url: 'https://api.example.test/users' }),
      testRequest({ id: 'req-2', name: 'Second', method: 'GET', url: 'https://api.example.test/users' }),
    ];

    expect(() => buildOpenApiDocument('API', '', requests, strip)).toThrow(/duplicate GET \/users/);
  });

  it('exports localhost URLs without schemes as OpenAPI servers', () => {
    const doc = buildOpenApiDocument('Local API', '', [
      testRequest({
        id: 'req-local',
        name: 'Local health',
        method: 'GET',
        url: 'localhost:3000/api/health?verbose=true',
      }),
    ], strip);

    expect(doc.servers).toEqual([{ url: 'http://localhost:3000' }]);
    expect(operation(doc, '/api/health', 'get').parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'verbose', in: 'query', example: 'true' }),
    ]));
  });

  it('skips WebSocket requests when building OpenAPI documents', () => {
    const doc = buildOpenApiDocument('Mixed API', '', [
      testRequest({
        id: 'req-http',
        name: 'HTTP health',
        method: 'GET',
        url: 'https://api.example.test/health',
      }),
      testRequest({
        id: 'req-ws',
        name: 'WS echo',
        requestType: 'ws',
        url: 'wss://api.example.test/ws',
      }),
    ], strip);

    const paths = exportDocument(doc).paths;
    expect(paths['/health']).toBeTruthy();
    expect(paths['/ws']).toBeUndefined();
  });

  it('skips GraphQL requests when building OpenAPI documents', () => {
    const doc = buildOpenApiDocument('Mixed API', '', [
      testRequest({
        id: 'req-http',
        name: 'HTTP health',
        method: 'GET',
        url: 'https://api.example.test/health',
      }),
      testRequest({
        id: 'req-gql',
        name: 'GraphQL viewer',
        requestType: 'graphql',
        method: 'POST',
        url: 'https://api.example.test/graphql',
        bodyType: 'graphql',
        bodyContent: '{"query":"query Viewer { viewer { id } }","variables":{}}',
      }),
    ], strip);

    const paths = exportDocument(doc).paths;
    expect(paths['/health']).toBeTruthy();
    expect(paths['/graphql']).toBeUndefined();
  });

  it('throws a clear OpenAPI export error for GraphQL-only collections', () => {
    expect(() => buildOpenApiDocument('Graph API', '', [
      testRequest({
        id: 'req-gql',
        name: 'GraphQL viewer',
        requestType: 'graphql',
        method: 'POST',
        url: 'https://api.example.test/graphql',
        bodyType: 'graphql',
        bodyContent: '{"query":"query Viewer { viewer { id } }","variables":{}}',
      }),
    ], strip)).toThrow(/GraphQL, gRPC, MCP, AI and realtime requests are skipped/);
  });

  it('throws a clear OpenAPI export error for WebSocket-only collections', () => {
    expect(() => buildOpenApiDocument('WS API', '', [
      testRequest({
        id: 'req-ws',
        name: 'WS echo',
        requestType: 'ws',
        url: 'wss://api.example.test/ws',
      }),
    ], strip)).toThrow(/GraphQL, gRPC, MCP, AI and realtime requests are skipped/);
  });

  it('omits secret-like OpenAPI examples by default and can include them explicitly', () => {
    const request = testRequest({
      id: 'req-secret-openapi',
      name: 'Secret example',
      method: 'POST',
      url: 'https://raw-user:raw-pass@api.example.test/login?token=raw-token',
      headers: [testRow('Authorization', 'Bearer raw-token')],
      bodyType: 'json',
      bodyContent: '{"username":"admin","password":"raw-password"}',
    });

    const safeDoc = buildOpenApiDocument('API', '', [request], strip);
    expect(safeDoc.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://api.example.test' }),
    ]));
    expect(JSON.stringify(safeDoc)).not.toContain('raw-user');
    expect(JSON.stringify(safeDoc)).not.toContain('raw-pass');
    const safeOperation = operation(safeDoc, '/login', 'post');
    const safeTokenParam = safeOperation.parameters?.find(p => p.name === 'token');
    const safeAuthorizationParam = safeOperation.parameters?.find(p => p.name === 'Authorization');
    expect(safeTokenParam).toBeTruthy();
    expect(safeAuthorizationParam).toBeTruthy();
    expect(safeTokenParam).not.toHaveProperty('example');
    expect(safeAuthorizationParam).not.toHaveProperty('example');
    expect(safeOperation.requestBody?.content['application/json']?.example).toMatchObject({
      username: 'admin',
      password: '',
    });

    const fullDoc = buildOpenApiDocument('API', '', [request], strip, true);
    expect(fullDoc.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://raw-user:raw-pass@api.example.test' }),
    ]));
    const fullOperation = operation(fullDoc, '/login', 'post');
    expect(fullOperation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'token', example: 'raw-token' }),
      expect.objectContaining({ name: 'Authorization', example: 'Bearer raw-token' }),
    ]));
    expect(fullOperation.requestBody?.content['application/json']?.example).toMatchObject({ password: 'raw-password' });

    const safeSwagger = buildSwaggerDocument('API', '', [request], strip);
    expect(safeSwagger.host).toBe('api.example.test');
  });
});

describe('buildSwaggerDocument', () => {
  it('exports urlencoded forms and API key auth as Swagger 2.0', () => {
    const doc = buildSwaggerDocument('Legacy API', '', [
      testRequest({
        id: 'req-login',
        name: 'Login',
        method: 'POST',
        url: '{{baseUrl}}/login',
        auth: { ...emptyAuthState(), type: 'apikey', apiKeyName: 'X-API-Key', apiKeyValue: '{{apiKey}}', apiKeyIn: 'header' },
        bodyType: 'urlencoded',
        formRows: [testRow('username', 'admin'), testRow('password', 'secret')],
      }),
    ], strip);

    expect(doc.swagger).toBe('2.0');
    expect(doc['x-kurlo-server']).toBe('{baseUrl}');
    const login = operation(doc, '/login', 'post');
    expect(login.consumes).toEqual(['application/x-www-form-urlencoded']);
    expect(login.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'username', in: 'formData', type: 'string', default: 'admin' }),
      expect.objectContaining({ name: 'password', in: 'formData', type: 'string' }),
    ]));
    const passwordParam = login.parameters?.find(p => p.name === 'password');
    expect(passwordParam).toBeTruthy();
    expect(passwordParam).not.toHaveProperty('default');
    expect(doc.securityDefinitions).toMatchObject({
      apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    });
  });

  it('skips WebSocket requests when building Swagger documents', () => {
    const doc = buildSwaggerDocument('Mixed API', '', [
      testRequest({
        id: 'req-http',
        name: 'HTTP health',
        method: 'GET',
        url: 'https://api.example.test/health',
      }),
      testRequest({
        id: 'req-ws',
        name: 'WS echo',
        requestType: 'ws',
        url: 'wss://api.example.test/ws',
      }),
    ], strip);

    const paths = exportDocument(doc).paths;
    expect(paths['/health']).toBeTruthy();
    expect(paths['/ws']).toBeUndefined();
  });
});

describe('OpenAPI servers on a path or operation', () => {
  it('send those requests to their own server', () => {
    const imported = openApiImportFromSpec({
      openapi: '3.0.3',
      info: { title: 'T', version: '1' },
      servers: [{ url: 'https://api.example.test' }],
      paths: {
        '/users': { get: { operationId: 'list' } },
        '/upload': { servers: [{ url: 'https://{region}.files.example.test', variables: { region: { default: 'eu' } } }], post: { operationId: 'upload' } },
        '/report': { get: { operationId: 'report', servers: [{ url: 'https://reports.example.test/v2' }] } },
      },
    }, 'c1', 'T');
    const urls = Object.fromEntries(imported.requests.map(req => [req.name, req.url]));
    expect(urls).toEqual({
      list: '{{baseUrl}}/users',
      upload: '{{baseUrl}}/upload',
      report: '{{baseUrl}}/report',
    });
    expect(imported.defaults.variables.map(row => [row.key, row.value])).toEqual([['baseUrl', 'https://api.example.test']]);
    const vars = Object.fromEntries(imported.requests.map(req => [req.name, req.vars?.map(row => row.value)]));
    expect(vars).toEqual({
      list: undefined,
      upload: ['https://eu.files.example.test'],
      report: ['https://reports.example.test/v2'],
    });
  });
});
