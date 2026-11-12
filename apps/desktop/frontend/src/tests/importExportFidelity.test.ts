import { describe, expect, it } from 'vitest';
import { buildPostmanCollection, postmanCollectionBundle } from '../lib/postman';
import { buildInsomniaExport, insomniaRequestsFromResources } from '../lib/insomnia';
import { harRequestsFromLog } from '../lib/har';
import { parseCurl } from '../lib/curl';
import { buildOpenApiDocument, openApiImportFromSpec, parseOpenApiResponse } from '../lib/openapi';
import { openCollectionBundleFromFiles } from '../lib/opencollection';
import { parseYaml } from '../lib/yaml';
import { expandReplacement } from '../lib/findReplace';
import { mergeGlobalRowsWithImportedRows } from '../lib/stores/features/globals';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from '../lib/constants';
import type { SavedRequest } from '../lib/types/models';
import { emptyAuthState } from '../lib/utils';

const strip = (source: string) => source;

function row(key: string, value: string, enabled = true) {
  return { ...mkRow(), key, value, enabled };
}

function request(overrides: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id: 'r1',
    name: 'Request',
    collectionId: 'c1',
    collection: 'API',
    folderPath: [],
    method: 'GET',
    url: 'https://api.example.test/items',
    requestTab: 'params',
    params: [],
    headers: [],
    auth: emptyAuthState(),
    bodyType: 'none',
    rawBodyType: 'json',
    bodyContent: '',
    bodyFilePath: '',
    bodyFileName: '',
    formRows: [],
    preRequestScript: '',
    testScript: '',
    requestNotes: '',
    settings: { ...DEFAULT_REQUEST_SETTINGS },
    ...overrides,
  };
}

function postmanRoundTrip(req: SavedRequest, defaults?: Parameters<typeof buildPostmanCollection>[5]) {
  const exported = buildPostmanCollection('API', '', [req], strip, true, defaults);
  return postmanCollectionBundle(JSON.parse(JSON.stringify(exported)), 'c2', 'API').requests[0];
}

describe('Postman round trip', () => {
  it('keeps disabled query params out of the URL but in the request', () => {
    const exported = buildPostmanCollection('API', '', [request({ params: [row('page', '1'), row('debug', 'true', false)] })], strip, true);
    const url = (exported.item[0] as { request: { url: { raw: string } } }).request.url;
    expect(url.raw).toBe('https://api.example.test/items?page=1');

    const imported = postmanRoundTrip(request({ params: [row('page', '1'), row('debug', 'true', false)] }));
    expect(imported.params.map(item => [item.key, item.enabled])).toEqual([['page', true], ['debug', false]]);
  });

  it('keeps every OAuth 2.0 field', () => {
    const auth = {
      ...emptyAuthState(),
      type: 'oauth2' as const,
      oauth2GrantType: 'authorization_code' as const,
      oauth2UsePKCE: true,
      oauth2AuthURL: 'https://id.example.test/authorize',
      oauth2TokenURL: 'https://id.example.test/token',
      oauth2ClientID: 'client',
      oauth2Secret: 'secret',
      oauth2Scope: 'read write',
      oauth2Audience: 'api',
      oauth2RefreshToken: 'refresh',
      oauth2ClientAuth: 'body' as const,
    };
    const imported = postmanRoundTrip(request({ auth })).auth;
    expect(imported).toMatchObject({
      type: 'oauth2',
      oauth2GrantType: 'authorization_code',
      oauth2UsePKCE: true,
      oauth2AuthURL: 'https://id.example.test/authorize',
      oauth2TokenURL: 'https://id.example.test/token',
      oauth2Audience: 'api',
      oauth2RefreshToken: 'refresh',
      oauth2ClientAuth: 'body',
    });
  });

  it('reads the token URL Kurlo used to write', () => {
    const payload = { info: { name: 'API' }, item: [{ name: 'R', request: { url: 'https://api.example.test', auth: { type: 'oauth2', oauth2: [{ key: 'tokenUrl', value: 'https://id.example.test/token' }] } } }] };
    expect(postmanCollectionBundle(payload, 'c', 'API').requests[0].auth.oauth2TokenURL).toBe('https://id.example.test/token');
  });

  it('keeps an explicit "No auth" under a collection that has auth', () => {
    const defaults = { ...postmanCollectionBundle({ info: {}, item: [] }, 'c', 'API').defaults, auth: { ...emptyAuthState(), type: 'bearer' as const, bearerToken: 't' } };
    expect(postmanRoundTrip(request({ auth: emptyAuthState() }), defaults).auth.type).toBe('none');
    expect(postmanRoundTrip(request({ auth: { ...emptyAuthState(), type: 'inherit' } }), defaults).auth.type).toBe('inherit');
  });

  it('reads Postman v2.0 object auth params', () => {
    const payload = { info: { name: 'API' }, item: [{ name: 'R', request: { url: 'https://api.example.test', auth: { type: 'bearer', bearer: { token: 'abc' } } } }] };
    expect(postmanCollectionBundle(payload, 'c', 'API').requests[0].auth.bearerToken).toBe('abc');
  });
});

describe('Insomnia binary bodies', () => {
  it('round-trips a file body', () => {
    const exported = buildInsomniaExport('API', '', [request({ method: 'POST', bodyType: 'binary', bodyFilePath: '/tmp/upload.bin', bodyFileName: 'upload.bin' })], strip, true);
    const imported = insomniaRequestsFromResources(JSON.parse(JSON.stringify(exported)), 'c', 'API')[0];
    expect(imported).toMatchObject({ bodyType: 'binary', bodyFilePath: '/tmp/upload.bin', bodyFileName: 'upload.bin' });
  });

  it('matches resource types regardless of case', () => {
    const payload = { resources: [
      { _id: 'wrk', _type: 'Workspace', name: 'WS' },
      { _id: 'fld', _type: 'Request_Group', parentId: 'wrk', name: 'Folder' },
      { _id: 'req', _type: 'Request', parentId: 'fld', name: 'R', method: 'GET', url: 'https://api.example.test' },
    ] };
    expect(insomniaRequestsFromResources(payload, 'c', 'API')[0]?.folderPath).toEqual(['Folder']);
  });
});

describe('HAR urlencoded bodies', () => {
  it('parses postData.text when params are missing', () => {
    const log = { log: { entries: [{ request: { method: 'POST', url: 'https://api.example.test/login', headers: [], postData: { mimeType: 'application/x-www-form-urlencoded', text: 'user=alice&note=a+b%26c' } } }] } };
    const imported = harRequestsFromLog(log, 'c', 'API')[0];
    expect(imported.bodyType).toBe('urlencoded');
    expect(imported.formRows.map(item => [item.key, item.value])).toEqual([['user', 'alice'], ['note', 'a b&c']]);
  });
});

describe('curl import', () => {
  it('does not take a flag value for the URL', () => {
    expect(parseCurl('curl --tls-max 1.3 https://api.example.test/x').url).toBe('https://api.example.test/x');
    expect(parseCurl('curl --pubkey id_rsa.pub https://api.example.test/x').url).toBe('https://api.example.test/x');
    expect(parseCurl('curl --some-new-flag 2.0 https://api.example.test/x').url).toBe('https://api.example.test/x');
  });

  it('keeps backslashes in double quotes that bash keeps', () => {
    const parsed = parseCurl('curl -H "X-Pattern: \\d+" -d "{\\"a\\":\\"x\\\\ny\\"}" https://api.example.test');
    expect(parsed.headers).toContainEqual({ key: 'X-Pattern', value: '\\d+' });
    expect(parsed.body).toBe('{"a":"x\\ny"}');
  });
});

describe('OpenAPI', () => {
  it('leaves gRPC, MCP and AI requests out of the export', () => {
    const doc = buildOpenApiDocument('API', '', [
      request({ id: 'h', url: 'https://api.example.test/items' }),
      request({ id: 'g', requestType: 'grpc', url: 'grpc.example.test:443' }),
      request({ id: 'm', requestType: 'mcp', url: 'https://mcp.example.test/mcp' }),
      request({ id: 'a', requestType: 'ai', url: 'https://ai.example.test/v1/chat' }),
    ], strip) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(['/items']);
  });

  it('prefers a +json media type and merges path and operation parameters', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1' },
      servers: [{ url: 'https://{region}.api.example.test' }],
      paths: {
        '/items': {
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', example: 1 } }],
          post: {
            parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', example: 5 } }],
            requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' } }, 'application/vnd.api+json': { example: { a: 1 } } } },
            responses: { '2XX': { description: 'ok' } },
          },
        },
      },
    };
    const result = openApiImportFromSpec(spec, 'c', 'API');
    const [imported] = result.requests;
    expect(imported.bodyType).toBe('json');
    expect(imported.params.filter(item => item.key === 'limit')).toHaveLength(1);
    expect(result.defaults.variables.find(item => item.key === 'baseUrl')?.value).toBe('https://{{region}}.api.example.test');
    expect(imported.examples?.[0]?.response.statusCode).toBe(200);
  });
});

describe('Bruno', () => {
  it('reads ~disabled rows and folder.bru names', () => {
    const bundle = openCollectionBundleFromFiles([
      { path: 'bruno.json', content: '{"name":"API"}' },
      { path: 'orders/folder.bru', content: 'meta {\n  name: Customer Orders\n}\n' },
      { path: 'orders/list.bru', content: 'meta {\n  name: List\n  type: http\n}\n\nget {\n  url: https://api.example.test/orders\n}\n\nparams:query {\n  page: 1\n  ~debug: true\n}\n' },
    ], 'c', 'API', 'ws');
    const [listed] = bundle.requests;
    expect(listed.folderPath).toEqual(['Customer Orders']);
    expect(listed.params.map(item => [item.key, item.enabled])).toEqual([['page', true], ['debug', false]]);
  });
});

describe('YAML anchors', () => {
  it('resolves anchors, aliases and merge keys', () => {
    const doc = parseYaml([
      'components:',
      '  schemas:',
      '    Base: &base',
      '      type: object',
      '      properties:',
      '        id:',
      '          type: string',
      '    User:',
      '      <<: *base',
      '      title: User',
      '    List:',
      '      items: *base',
      'params:',
      '  - &p',
      '    name: q',
      '    in: query',
      '  - *p',
      '  - <<: *p',
      '    name: r',
    ].join('\n')) as { components: { schemas: Record<string, Record<string, unknown>> }; params: unknown[] };
    expect(doc.components.schemas.User).toEqual({ type: 'object', properties: { id: { type: 'string' } }, title: 'User' });
    expect(doc.components.schemas.List.items).toEqual(doc.components.schemas.Base);
    expect(doc.params).toEqual([{ name: 'q', in: 'query' }, { name: 'q', in: 'query' }, { name: 'r', in: 'query' }]);
  });

  it('refuses an alias to an unknown anchor', () => {
    expect(() => parseYaml('a: *missing')).toThrow(/unknown anchor/);
  });
});

describe('YAML documents written by spec generators', () => {
  it('reads sequences that sit at the same indent as their key', () => {
    expect(parseYaml([
      'tags:',
      '- name: A',
      '- name: B',
      'paths:',
      '  /x: {}',
    ].join('\n'))).toEqual({ tags: [{ name: 'A' }, { name: 'B' }], paths: { '/x': {} } });
  });

  it('folds double-quoted strings that span lines', () => {
    expect(parseYaml([
      'tags:',
      '- name: "T-Bank ID"',
      '  description: "единая точка авторизации, которая уп\\',
      '    рощает вход"',
      '- name: "Second"',
      '  description: "first line',
      '    continues',
      '',
      '    after a blank line"',
      'pattern: "^[^\\\\n\\\\r\\\\x00\\\\/]{1,250}$\\',
      '  # not a comment\\',
      '  \\ tail"',
      'paths:',
      '  /x: {}',
    ].join('\n'))).toEqual({
      tags: [
        { name: 'T-Bank ID', description: 'единая точка авторизации, которая упрощает вход' },
        { name: 'Second', description: 'first line continues\nafter a blank line' },
      ],
      pattern: '^[^\\n\\r\\x00\\/]{1,250}$# not a comment tail',
      paths: { '/x': {} },
    });
  });

  it('folds single-quoted and plain strings that span lines', () => {
    expect(parseYaml([
      "single: 'it''s",
      "  folded'",
      'plain: first part',
      '  second part',
      "note: don't stop here",
      'after: yes',
    ].join('\n'))).toEqual({
      single: "it's folded",
      plain: 'first part second part',
      note: "don't stop here",
      after: 'yes',
    });
  });

  it('decodes double-quoted escapes once', () => {
    expect(parseYaml('a: "\\\\n \\u0041 \\/ \\t\\""')).toEqual({ a: '\\n A / \t"' });
  });

  it('keeps every key of a sequence item whose first key holds a block', () => {
    expect(parseYaml([
      'deps:',
      '- depInfo:',
      '    inn: "7710140679"',
      '  rates:',
      '  - rate: 13',
      '    recs:',
      '    - recCode: "201"',
      '  total: 2',
      'next: true',
    ].join('\n'))).toEqual({
      deps: [{ depInfo: { inn: '7710140679' }, rates: [{ rate: 13, recs: [{ recCode: '201' }] }], total: 2 }],
      next: true,
    });
  });

  it('reads sequences nested on one line', () => {
    expect(parseYaml([
      'example:',
      '- - - 100',
      '    - 0',
      '  - - 101',
      '    - 1',
    ].join('\n'))).toEqual({ example: [[[100, 0], [101, 1]]] });
  });

  it('keeps comment marks and blank lines inside block scalars', () => {
    expect(parseYaml([
      'literal: |',
      '  # heading',
      '',
      '  "unbalanced',
      'folded: >-',
      '  one',
      '  two',
      '',
      '  three',
      'after: 1.5E3',
    ].join('\n'))).toEqual({
      literal: '# heading\n\n"unbalanced',
      folded: 'one two\nthree',
      after: 1500,
    });
  });

  it('imports a Jackson-style OpenAPI document', () => {
    const spec = parseOpenApiResponse([
      'openapi: "3.0.1"',
      'info:',
      '  title: "T-API"',
      '  version: "1.0"',
      'tags:',
      '- name: "Accounts"',
      '  description: "Methods that list the company\\',
      '    \\ accounts"',
      'servers:',
      '- url: "https://example.test/api"',
      'paths:',
      '  /accounts:',
      '    get:',
      '      tags:',
      '      - "Accounts"',
      '      summary: "List accounts"',
      '      responses:',
      '        "200":',
      '          description: "OK"',
    ].join('\n'), 'text/plain');
    const { requests } = openApiImportFromSpec(spec, 'c', 'T-API');
    expect(requests.map(request => [request.method, request.name])).toEqual([['GET', 'List accounts']]);
  });
});

describe('Globals import', () => {
  it('keeps secret and disabled flags', () => {
    const merged = mergeGlobalRowsWithImportedRows([row('host', 'old')], [
      row('host', 'new'),
      { ...row('token', 's3cret'), secret: true },
      row('off', 'x', false),
    ]);
    expect(merged.filter(item => item.key).map(item => [item.key, item.value, item.enabled, item.secret ?? false]))
      .toEqual([['host', 'new', true, false], ['token', 's3cret', true, true], ['off', 'x', false, false]]);
  });
});

describe('Find and replace', () => {
  it('expands $10 like String.prototype.replace', () => {
    const match = /(a)(b)/.exec('ab')!;
    expect(expandReplacement('[$10]', match)).toBe('ab'.replace(/(a)(b)/, '[$10]'));
    expect(expandReplacement('[$30]', match)).toBe('ab'.replace(/(a)(b)/, '[$30]'));
  });
});
