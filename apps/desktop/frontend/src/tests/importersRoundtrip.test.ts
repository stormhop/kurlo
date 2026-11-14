import { postmanExport, testRequest, strip, testRow } from './support/importers';
import { describe, it, expect } from 'vitest';
import { postmanRequestsFromItems, buildPostmanCollection } from '../lib/postman';
import { mkRow } from '../lib/constants';
import { harRequestsFromLog } from '../lib/har';
import { openApiRequestsFromSpec } from '../lib/openapi';
import { buildOpenCollectionFiles, openCollectionBundleFromFiles } from '../lib/opencollection';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import { insomniaRequestsFromResources } from '../lib/insomnia';

describe('multipart part content types', () => {
  it('keeps a Postman formdata contentType through import', () => {
    const requests = postmanRequestsFromItems([{
      name: 'Upload',
      request: {
        method: 'POST',
        url: 'https://api.example.com/upload',
        body: {
          mode: 'formdata',
          formdata: [
            { key: 'avatar', type: 'file', src: '/tmp/a.png', contentType: 'image/png' },
            { key: 'meta', value: '{"a":1}', contentType: 'application/json' },
            { key: 'note', value: 'hi' },
          ],
        },
      },
    }], 'col-1', 'My API');

    expect(requests[0].bodyType).toBe('form');
    expect(requests[0].formRows[0]).toMatchObject({ key: 'avatar', isFile: true, contentType: 'image/png' });
    expect(requests[0].formRows[1]).toMatchObject({ key: 'meta', contentType: 'application/json' });
    expect(requests[0].formRows[2].contentType).toBeFalsy();
  });

  it('writes the contentType back out to Postman', () => {
    const collection = postmanExport(buildPostmanCollection('My API', '', [testRequest({
      method: 'POST',
      bodyType: 'form',
      formRows: [
        { ...mkRow(), key: 'avatar', value: '/tmp/a.png', isFile: true, contentType: 'image/png' },
        { ...mkRow(), key: 'note', value: 'hi' },
      ],
    })], strip));

    const formdata = collection.item[0].request.body.formdata;
    expect(formdata[0]).toMatchObject({ key: 'avatar', contentType: 'image/png' });
    expect(formdata[1].contentType).toBeUndefined();
  });
});

describe('examples from imports', () => {
  const makeHar = (entries: unknown[]) => ({ log: { version: '1.2', entries } });

  it('imports Postman saved responses as examples', () => {
    const requests = postmanRequestsFromItems([{
      name: 'Create order',
      request: { method: 'POST', url: { raw: 'https://api.example.com/orders' }, body: { mode: 'raw', raw: '{"amount":5}' } },
      response: [
        {
          name: 'Created',
          originalRequest: { method: 'POST', url: { raw: 'https://api.example.com/orders' }, body: { mode: 'raw', raw: '{"amount":5}' } },
          status: 'Created',
          code: 201,
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: '{"id":"ord_1"}',
        },
        {
          status: 'Too Many Requests',
          code: 429,
          header: [{ key: 'Retry-After', value: '30' }],
          body: 'slow down',
          _postman_previewlanguage: 'text',
        },
      ],
    }], 'col-1', 'Orders');

    const examples = requests[0].examples ?? [];
    expect(examples).toHaveLength(2);
    expect(examples[0]).toMatchObject({ name: 'Created', source: 'postman' });
    expect(examples[0].response).toMatchObject({ statusCode: 201, status: '201 Created', bodyMediaType: 'application/json' });
    expect(examples[0].response.body).toBe('{"id":"ord_1"}');
    expect(examples[0].snapshot.bodyContent).toBe('{"amount":5}');
    expect(examples[0].match.pathTemplate).toBe('/orders');

    expect(examples[1].name).toBe('429 Too Many Requests');
    expect(examples[1].response.bodyMediaType).toBe('text/plain');
  });

  it('writes examples back out to Postman', () => {
    const collection = postmanExport(buildPostmanCollection('Orders', '', [testRequest({
      method: 'POST',
      examples: [{
        id: 'ex-1', requestId: 'req-1', name: 'Created', filesystemName: 'created',
        source: 'captured', createdAt: 1,
        snapshot: { method: 'POST', url: 'https://api.example.com/orders', params: [], headers: [], bodyType: 'json', bodyContent: '{"amount":5}' },
        response: {
          statusCode: 201, status: '201 Created',
          headers: [{ ...mkRow(), key: 'Content-Type', value: 'application/json' }],
          body: '{"id":"ord_1"}', bodyMediaType: 'application/json',
        },
        match: { pathTemplate: '/orders' },
      }],
    })], strip));

    const saved = (collection.item[0] as unknown as { response?: Array<Record<string, unknown>> }).response ?? [];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Created', code: 201, status: 'Created', _postman_previewlanguage: 'json' });
    expect(saved[0].body).toContain('ord_1');
    expect((saved[0].originalRequest as Record<string, unknown>).method).toBe('POST');
  });

  it('round-trips a Postman example back into Kurlo', () => {
    const original = testRequest({
      method: 'POST',
      examples: [{
        id: 'ex-1', requestId: 'req-1', name: 'Created', filesystemName: 'created',
        source: 'captured', createdAt: 1,
        snapshot: { method: 'POST', url: 'https://api.example.test/orders', params: [], headers: [], bodyType: 'json', bodyContent: '' },
        response: {
          statusCode: 201, status: '201 Created',
          headers: [{ ...mkRow(), key: 'Content-Type', value: 'application/json' }],
          body: '{"id":"ord_1"}', bodyMediaType: 'application/json',
        },
        match: { pathTemplate: '/orders' },
      }],
    });
    const collection = buildPostmanCollection('Orders', '', [original], strip);
    const reimported = postmanRequestsFromItems((collection as { item: unknown[] }).item, 'col-2', 'Orders');

    const example = (reimported[0].examples ?? [])[0];
    expect(example).toBeTruthy();
    expect(example.name).toBe('Created');
    expect(example.response.statusCode).toBe(201);
    expect(example.response.body).toContain('ord_1');
    expect(example.response.bodyMediaType).toBe('application/json');
  });

  it('imports the response a HAR entry recorded', () => {
    const har = makeHar([{
      request: { method: 'GET', url: 'https://api.example.com/orders/8123', queryString: [], headers: [] },
      response: {
        status: 200,
        statusText: 'OK',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        content: { mimeType: 'application/json', text: '{"id":8123}' },
      },
    }]);

    const requests = harRequestsFromLog(har, 'col-1', 'My HAR');
    const example = (requests[0].examples ?? [])[0];
    expect(example).toBeTruthy();
    expect(example.response).toMatchObject({ statusCode: 200, status: '200 OK', bodyMediaType: 'application/json' });
    expect(example.response.body).toBe('{"id":8123}');
    expect(example.match.pathTemplate).toBe('/orders/:id');
  });

  it('keeps no body for a base64 HAR response, and skips an entry with no response', () => {
    const har = makeHar([
      {
        request: { method: 'GET', url: 'https://api.example.com/logo.png', queryString: [], headers: [] },
        response: {
          status: 200, statusText: 'OK', headers: [],
          content: { mimeType: 'image/png', text: 'iVBORw0KGgo=', encoding: 'base64' },
        },
      },
      {
        request: { method: 'GET', url: 'https://api.example.com/dead', queryString: [], headers: [] },
        response: { status: 0, statusText: '', headers: [], content: {} },
      },
    ]);

    const requests = harRequestsFromLog(har, 'col-1', 'My HAR');
    expect((requests[0].examples ?? [])[0].response.body).toBe('');
    expect((requests[0].examples ?? [])[0].response.bodyMediaType).toBe('image/png');
    expect(requests[1].examples).toBeUndefined();
  });

  it('imports documented OpenAPI responses as examples', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Orders', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/orders': {
          post: {
            summary: 'Create order',
            responses: {
              201: {
                description: 'Created',
                headers: { 'X-Request-Id': { schema: { type: 'string' }, example: 'req-1' } },
                content: { 'application/json': { example: { id: 'ord_1' } } },
              },
              422: {
                description: 'Invalid',
                content: { 'application/json': { examples: { bad: { value: { errors: ['amount'] } } } } },
              },
              default: { description: 'Unexpected' },
            },
          },
        },
      },
    };

    const requests = openApiRequestsFromSpec(spec, 'col-1', 'Orders');
    const examples = requests[0].examples ?? [];
    expect(examples.map(item => item.response.statusCode)).toEqual([201, 422]);
    expect(examples[0].name).toBe('201 Created');
    expect(JSON.parse(examples[0].response.body)).toEqual({ id: 'ord_1' });
    expect(examples[0].response.headers.map(h => h.key)).toContain('X-Request-Id');
    expect(examples[0].response.headers.find(h => h.key === 'Content-Type')?.value).toBe('application/json');
    expect(JSON.parse(examples[1].response.body)).toEqual({ errors: ['amount'] });
  });

  it('derives an OpenAPI example from the response schema when none is written', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Orders', version: '1' },
      paths: {
        '/orders': {
          get: {
            responses: {
              200: {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { id: { type: 'string', example: 'ord_1' }, total: { type: 'integer' } } },
                  },
                },
              },
            },
          },
        },
      },
    };

    const example = (openApiRequestsFromSpec(spec, 'col-1', 'Orders')[0].examples ?? [])[0];
    expect(example).toBeTruthy();
    expect(JSON.parse(example.response.body)).toMatchObject({ id: 'ord_1' });
  });
});

describe('examples through OpenCollection and Postman settings', () => {
  const exampleFixture = {
    id: 'ex-1', requestId: 'req-1', name: 'Created', filesystemName: 'created',
    source: 'captured' as const, createdAt: 1,
    snapshot: {
      method: 'POST' as const, url: 'https://api.example.test/orders',
      params: [], headers: [{ ...mkRow(), key: 'Accept', value: 'application/json' }],
      bodyType: 'json' as const, bodyContent: '{"amount":5}',
    },
    response: {
      statusCode: 201, status: '201 Created',
      headers: [{ ...mkRow(), key: 'Content-Type', value: 'application/json' }],
      body: '{"id":"ord_1"}', bodyMediaType: 'application/json',
    },
    match: { pathTemplate: '/orders' },
  };

  it('round-trips examples through OpenCollection files', () => {
    const files = buildOpenCollectionFiles('Orders', '', emptyCollectionDefaults(), [
      testRequest({ id: 'req-1', name: 'Create order', method: 'POST', examples: [exampleFixture] }),
    ], [], strip);

    const requestFile = files.find(file => file.path.endsWith('.yml') && file.content.includes('examples:'));
    expect(requestFile).toBeTruthy();

    const bundle = openCollectionBundleFromFiles(files, 'col-2', 'Orders', 'workspace-1');
    const example = (bundle.requests[0].examples ?? [])[0];
    expect(example).toBeTruthy();
    expect(example.name).toBe('Created');
    expect(example.response.statusCode).toBe(201);
    expect(example.response.body).toContain('ord_1');
    expect(example.response.bodyMediaType).toBe('application/json');
    expect(example.snapshot.bodyContent).toContain('amount');
    expect(example.match.pathTemplate).toBe('/orders');
  });

  it('reads Postman protocolProfileBehavior into request settings', () => {
    const requests = postmanRequestsFromItems([{
      name: 'No redirects',
      protocolProfileBehavior: { followRedirects: false, strictSSL: false, maxRedirects: 3, followOriginalHttpMethod: true },
      request: { method: 'GET', url: { raw: 'https://api.example.com/thing' } },
    }], 'col-1', 'API');

    expect(requests[0].settings).toMatchObject({
      followRedirects: false,
      enableSSLVerification: false,
      maxRedirects: 3,
      followOriginalMethod: true,
    });
  });

  it('keeps Postman path variables as path variables', () => {
    const requests = postmanRequestsFromItems([{
      name: 'Get user',
      request: {
        method: 'GET',
        url: { raw: 'https://api.example.com/users/:userId/posts/:postId', variable: [{ key: 'userId', value: '42' }] },
      },
    }], 'col-1', 'API');

    expect(requests[0].url).toBe('https://api.example.com/users/:userId/posts/:postId');
    expect(requests[0].pathParams?.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: 'userId', value: '42' },
      { key: 'postId', value: '' },
    ]);
  });

  it('builds a URL from Postman host/path parts with its path variables', () => {
    const requests = postmanRequestsFromItems([{
      name: 'Get user',
      request: {
        method: 'GET',
        url: { protocol: 'https', host: ['api', 'example', 'com'], path: ['users', ':userId'], variable: [{ key: 'userId', value: '7' }] },
      },
    }], 'col-1', 'API');

    expect(requests[0].url).toBe('https://api.example.com/users/:userId');
    expect(requests[0].pathParams?.map(({ key, value }) => ({ key, value }))).toEqual([{ key: 'userId', value: '7' }]);
  });
});

describe('request vars import', () => {
  it('reads Bruno .bru pre-request and post-response vars and folder vars', () => {
    const bundle = openCollectionBundleFromFiles([
      { path: 'bruno.json', content: '{"version":"1","name":"Bru API","type":"collection"}' },
      { path: 'collection.bru', content: 'vars:pre-request {\n  tenant: core\n}\n' },
      { path: 'users/folder.bru', content: 'meta {\n  name: Users\n}\n\nvars:pre-request {\n  userId: 1\n  region: eu\n}\n\nvars:post-response {\n  lastStatus: res.status\n}\n' },
      {
        path: 'users/get-user.bru',
        content: 'meta {\n  name: Get User\n  type: http\n  seq: 1\n}\n\nget {\n  url: {{baseUrl}}/users/{{userId}}\n  body: none\n  auth: none\n}\n\nvars:pre-request {\n  userId: 42\n  ~debug: true\n}\n\nvars:post-response {\n  token: res.body.token\n}\n',
      },
    ], 'collection-1', 'Fallback', 'workspace-1');

    expect(bundle.defaults.variables.map(row => [row.key, row.value])).toEqual([['tenant', 'core']]);
    const [request] = bundle.requests;
    expect(request.vars?.map(row => [row.key, row.value, row.enabled])).toEqual([
      ['region', 'eu', true],
      ['userId', '42', true],
      ['debug', 'true', false],
    ]);
    expect(request.postResponseVars?.map(row => [row.key, row.value])).toEqual([
      ['lastStatus', 'res.status'],
      ['token', 'res.body.token'],
    ]);
  });

  it('reads OpenCollection runtime variables, set-variable actions and folder variables', () => {
    const bundle = openCollectionBundleFromFiles([
      { path: 'opencollection.yml', content: 'opencollection: 1.0.0\ninfo:\n  name: YAML API\nrequest:\n  variables:\n    - name: tenant\n      value: core\n' },
      { path: 'users/folder.yml', content: 'info:\n  name: Users\n  type: folder\nrequest:\n  variables:\n    - name: region\n      value: eu\n' },
      {
        path: 'users/login.yml',
        content: 'info:\n  name: Login\n  type: http\n  seq: 1\nhttp:\n  method: POST\n  url: "{{baseUrl}}/login"\nruntime:\n  variables:\n    - name: user\n      value: ada\n    - name: off\n      value: "1"\n      disabled: true\n  actions:\n    - type: set-variable\n      phase: after-response\n      selector:\n        expression: res.body.token\n        method: jsonq\n      variable:\n        name: token\n        scope: runtime\n      description: Session token\n    - type: set-variable\n      phase: before-request\n      selector:\n        expression: ignored\n        method: jsonq\n      variable:\n        name: ignored\n',
      },
    ], 'collection-1', 'Fallback', 'workspace-1');

    expect(bundle.defaults.variables.map(row => [row.key, row.value])).toEqual([['tenant', 'core']]);
    const [request] = bundle.requests;
    expect(request.vars?.map(row => [row.key, row.value, row.enabled])).toEqual([
      ['region', 'eu', true],
      ['user', 'ada', true],
      ['off', '1', false],
    ]);
    expect(request.postResponseVars).toEqual([expect.objectContaining({ key: 'token', value: 'res.body.token', description: 'Session token', enabled: true })]);
  });

  it('writes request vars to OpenCollection the way Bruno reads them', () => {
    const files = buildOpenCollectionFiles('API', '', emptyCollectionDefaults(), [testRequest({
      vars: [testRow('userId', '42')],
      postResponseVars: [testRow('token', 'res.body.token')],
    })], [], source => source);
    const requestFile = files.find(file => file.path.endsWith('.yml') && file.content.includes('Test request'));

    expect(requestFile?.content).toContain('runtime:\n  variables:\n    - name: userId\n      value: "42"');
    expect(requestFile?.content).toContain('type: set-variable');
    expect(requestFile?.content).toContain('phase: after-response');
    expect(requestFile?.content).toContain('expression: res.body.token');
  });

  it('turns Insomnia folder environments into request vars', () => {
    const requests = insomniaRequestsFromResources({
      resources: [
        { _id: 'wrk', _type: 'workspace', name: 'API' },
        { _id: 'fld_outer', _type: 'request_group', parentId: 'wrk', name: 'Outer', environment: { region: 'eu', userId: 1 } },
        { _id: 'fld_inner', _type: 'request_group', parentId: 'fld_outer', name: 'Inner', environment: { userId: 7, filters: { active: true } } },
        { _id: 'req_1', _type: 'request', parentId: 'fld_inner', name: 'Get user', method: 'GET', url: '{{ _.baseUrl }}/users/{{ _.userId }}' },
      ],
    }, 'collection-1', 'API');

    expect(requests[0].folderPath).toEqual(['Outer', 'Inner']);
    expect(requests[0].vars?.map(row => [row.key, row.value])).toEqual([
      ['region', 'eu'],
      ['userId', '7'],
      ['filters', '{"active":true}'],
    ]);
  });

  it('runs Kurlo request vars in Postman as pm.variables.set lines', () => {
    const collection = buildPostmanCollection('API', '', [testRequest({ vars: [testRow('userId', '42'), { ...testRow('off', '1'), enabled: false }] })], source => source, true) as { item: Array<{ event?: Array<{ listen: string; script: { exec: string[] } }> }> };
    const pre = collection.item[0].event?.find(event => event.listen === 'prerequest');

    expect(pre?.script.exec).toEqual(['pm.variables.set("userId", pm.variables.replaceIn("42"));']);
  });
});
