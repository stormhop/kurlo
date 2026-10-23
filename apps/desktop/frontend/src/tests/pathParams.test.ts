import { describe, expect, it } from 'vitest';
import { mkRow } from '../lib/constants';
import { toCurl } from '../lib/curl';
import { buildInsomniaExport, insomniaRequestsFromResources } from '../lib/insomnia';
import { normalizeSavedRequest } from '../lib/normalizers';
import { buildOpenApiDocument } from '../lib/openapi';
import { buildOpenCollectionFiles, openCollectionBundleFromFiles } from '../lib/opencollection';
import { applyPathParams, pathParamNames, pathParamsFromUrl } from '../lib/pathParams';
import { buildPostmanCollection, postmanRequestsFromItems } from '../lib/postman';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import { emptyAuthConfig, emptyHttpRequest } from '../lib/wire';
import type { SavedRequest } from '../lib/types/models';

const strip = (source: string) => source;
const rowOf = (key: string, value: string, extra: Partial<ReturnType<typeof mkRow>> = {}) => ({ ...mkRow(), key, value, ...extra });
const pairs = (rows: SavedRequest['pathParams']) => (rows ?? []).map(({ key, value }) => ({ key, value }));

function userRequest(): SavedRequest {
  return normalizeSavedRequest({
    id: 'req-1',
    name: 'Get post',
    collectionId: 'col-1',
    collection: 'API',
    method: 'GET',
    url: 'https://api.example.test/users/:userId/posts/:postId',
    params: [rowOf('expand', 'author')],
    pathParams: [rowOf('userId', '42', { description: 'Owner' }), rowOf('postId', '7')],
  }, [], 'ws-1');
}

describe('path variable helpers', () => {
  it('reads whole :name segments from the path only', () => {
    expect(pathParamNames('http://localhost:8080/users/:id/a:b/:id/:file.json?x=:q#:h')).toEqual(['id', 'file.json']);
    expect(pathParamNames('{{baseUrl}}/orgs/:org/repos/:repo')).toEqual(['org', 'repo']);
    expect(pathParamNames('localhost:3000/:id')).toEqual(['id']);
    expect(pathParamNames('https://api.test')).toEqual([]);
    expect(pathParamNames('https://api.test/users/:')).toEqual([]);
  });

  it('keeps values and descriptions for names still in the URL', () => {
    const existing = [rowOf('id', '1', { description: 'User' }), rowOf('gone', 'x')];
    const rows = pathParamsFromUrl('https://api.test/users/:id/posts/:post', existing);
    expect(rows.map(({ key, value, description }) => ({ key, value, description }))).toEqual([
      { key: 'id', value: '1', description: 'User' },
      { key: 'post', value: '', description: '' },
    ]);
    expect(rows[0].id).toBe(existing[0].id);
  });

  it('fills segments the same way the Go sender does', () => {
    const rows = [rowOf('id', '42'), rowOf('name', 'a b/c?d#e'), rowOf('enc', 'a%2Fb%zz'), rowOf('off', '1', { enabled: false }), rowOf('empty', '')];
    expect(applyPathParams('https://api.test/:id/:name/:enc/:off/:empty?q=:id', rows))
      .toBe('https://api.test/42/a%20b%2Fc%3Fd%23e/a%2Fb%25zz/:off/:empty?q=:id');
    expect(applyPathParams('http://[::1]:9000/u/:id', rows)).toBe('http://[::1]:9000/u/42');
    expect(applyPathParams('https://api.test/:id', undefined)).toBe('https://api.test/:id');
  });
});

describe('path variables in imports and exports', () => {
  it('round-trips through a Postman collection', () => {
    const collection = buildPostmanCollection('API', '', [userRequest()], strip) as { item: Array<{ request: { url: { raw: string; variable?: unknown[] } } }> };
    const url = collection.item[0].request.url;
    expect(url.raw).toBe('https://api.example.test/users/:userId/posts/:postId?expand=author');
    expect(url.variable).toEqual([
      { key: 'userId', value: '42', description: 'Owner' },
      { key: 'postId', value: '7' },
    ]);
    const [imported] = postmanRequestsFromItems(collection.item, 'col-2', 'API');
    expect(imported.url).toBe('https://api.example.test/users/:userId/posts/:postId');
    expect(pairs(imported.pathParams)).toEqual([{ key: 'userId', value: '42' }, { key: 'postId', value: '7' }]);
    expect(imported.pathParams?.[0].description).toBe('Owner');
  });

  it('round-trips through OpenCollection YAML', () => {
    const files = buildOpenCollectionFiles('API', '', emptyCollectionDefaults(), [userRequest()], [], strip);
    const bundle = openCollectionBundleFromFiles(files, 'col-2', 'API', 'ws-1');
    const [imported] = bundle.requests;
    expect(imported.url).toBe('https://api.example.test/users/:userId/posts/:postId');
    expect(imported.params.map(({ key, value }) => ({ key, value }))).toEqual([{ key: 'expand', value: 'author' }]);
    expect(pairs(imported.pathParams)).toEqual([{ key: 'userId', value: '42' }, { key: 'postId', value: '7' }]);
  });

  it('imports params:path blocks from Bruno .bru files', () => {
    const bundle = openCollectionBundleFromFiles([
      { path: 'bruno.json', content: JSON.stringify({ name: 'Bruno' }) },
      {
        path: 'users/get.bru',
        content: 'meta {\n  name: Get user\n  type: http\n  seq: 1\n}\n\nget {\n  url: {{baseUrl}}/users/:id\n  body: none\n  auth: none\n}\n\nparams:query {\n  verbose: true\n}\n\nparams:path {\n  id: 99\n}\n',
      },
    ], 'col-1', 'Fallback', 'ws-1');
    const [imported] = bundle.requests;
    expect(imported.url).toBe('{{baseUrl}}/users/:id');
    expect(imported.params.map(({ key, value }) => ({ key, value }))).toEqual([{ key: 'verbose', value: 'true' }]);
    expect(pairs(imported.pathParams)).toEqual([{ key: 'id', value: '99' }]);
  });

  it('round-trips through an Insomnia export', () => {
    const exported = buildInsomniaExport('API', '', [userRequest()], strip);
    const resource = exported.resources.find(item => item._type === 'request') as Record<string, unknown>;
    expect(resource.pathParameters).toEqual([
      { name: 'userId', value: '42', description: 'Owner' },
      { name: 'postId', value: '7' },
    ]);
    const [imported] = insomniaRequestsFromResources(exported, 'col-2', 'API');
    expect(pairs(imported.pathParams)).toEqual([{ key: 'userId', value: '42' }, { key: 'postId', value: '7' }]);
  });

  it('describes path parameters in an OpenAPI export', () => {
    const doc = buildOpenApiDocument('API', '', [userRequest()], strip) as { paths: Record<string, { get: { parameters: unknown[] } }> };
    const operation = doc.paths['/users/{userId}/posts/{postId}'].get;
    expect(operation.parameters).toEqual(expect.arrayContaining([
      { name: 'userId', in: 'path', required: true, schema: { type: 'string' }, description: 'Owner', example: '42' },
      { name: 'postId', in: 'path', required: true, schema: { type: 'string' }, example: '7' },
    ]));
  });

  it('fills path variables when copying as cURL', () => {
    const curl = toCurl({
      ...emptyHttpRequest(),
      method: 'GET',
      url: 'https://api.example.test/users/:userId',
      pathParams: [{ key: 'userId', value: '42', enabled: true, isFile: false, fileName: '', contentType: '' }],
      auth: emptyAuthConfig(),
    });
    expect(curl).toContain("'https://api.example.test/users/42'");
  });
});
