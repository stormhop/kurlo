import { describe, expect, it } from 'vitest';
import { buildInsomniaExport, insomniaRequestsFromResources } from '../lib/insomnia';
import { buildPostmanCollection, postmanCollectionBundle } from '../lib/postman';
import { buildOpenCollectionFiles, openCollectionBundleFromFiles } from '../lib/opencollection';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from '../lib/constants';
import type { AuthType, BodyType, SavedRequest } from '../lib/types/models';
import { emptyAuthState } from '../lib/utils';

function row(key: string, value: string, enabled = true) {
  return { ...mkRow(), key, value, enabled };
}

function richRequest(id: string, overrides: Partial<SavedRequest>): SavedRequest {
  return {
    id,
    name: `Request ${id}`,
    collectionId: 'collection-1',
    collection: 'API',
    folderPath: [],
    method: 'POST',
    url: 'https://api.example.test/orders?limit=10&cursor={{cursor}}',
    requestTab: 'params',
    params: [row('limit', '10'), row('cursor', '{{cursor}}')],
    headers: [row('X-Trace', 'abc'), row('X-Disabled', 'off', false)],
    auth: emptyAuthState(),
    bodyType: 'none',
    rawBodyType: 'json',
    bodyContent: '',
    bodyFilePath: '',
    bodyFileName: '',
    formRows: [],
    preRequestScript: 'pm.variables.set("nonce", "1")',
    testScript: 'pm.test("ok", () => pm.response.to.have.status(200))',
    requestNotes: 'Creates an order.',
    settings: { ...DEFAULT_REQUEST_SETTINGS },
    ...overrides,
  };
}

function auth(type: AuthType, fields: Partial<ReturnType<typeof emptyAuthState>>) {
  return { ...emptyAuthState(), type, ...fields };
}

const bodies: Array<[string, BodyType, Partial<SavedRequest>]> = [
  ['json', 'json', { rawBodyType: 'json', bodyContent: '{\n  "amount": 500,\n  "note": "Привет 🚀"\n}' }],
  ['text', 'text', { rawBodyType: 'text', bodyContent: 'line one\nline two' }],
  ['xml', 'xml', { rawBodyType: 'xml', bodyContent: '<order><id>1</id></order>' }],
  ['urlencoded', 'urlencoded', { formRows: [row('grant_type', 'password'), row('skip', 'x', false)] }],
  ['form', 'form', { formRows: [row('title', 'Заказ'), row('count', '2')] }],
];

const auths: Array<[string, ReturnType<typeof auth>]> = [
  ['bearer', auth('bearer', { bearerToken: '{{token}}' })],
  ['basic', auth('basic', { basicUser: 'alice', basicPass: 's3cret' })],
  ['apikey header', auth('apikey', { apiKeyName: 'X-Key', apiKeyValue: 'k-1', apiKeyIn: 'header' })],
  ['apikey query', auth('apikey', { apiKeyName: 'api_key', apiKeyValue: 'k-2', apiKeyIn: 'query' })],
];

function corpus(): SavedRequest[] {
  const requests: SavedRequest[] = [];
  bodies.forEach(([name, bodyType, body], index) => {
    const [authName, authState] = auths[index % auths.length];
    requests.push(richRequest(`r-${name}`, {
      name: `${name} with ${authName} «юникод» 注文`,
      bodyType,
      ...body,
      auth: authState,
      folderPath: index % 2 === 0 ? ['Orders', 'Nested', 'Deep'] : ['Orders'],
      method: index % 2 === 0 ? 'POST' : 'PUT',
    }));
  });
  return requests;
}

function rows(list: SavedRequest['params']) {
  return list.filter(item => item.key).map(item => ({ key: item.key, value: item.value, enabled: item.enabled }));
}

function authFields(state: SavedRequest['auth']) {
  if (state.type === 'bearer') return { type: state.type, bearerToken: state.bearerToken };
  if (state.type === 'basic') return { type: state.type, basicUser: state.basicUser, basicPass: state.basicPass };
  if (state.type === 'apikey') return { type: state.type, apiKeyName: state.apiKeyName, apiKeyValue: state.apiKeyValue, apiKeyIn: state.apiKeyIn };
  return { type: state.type };
}

function essence(request: SavedRequest) {
  return {
    name: request.name,
    method: request.method,
    url: request.url.split('?')[0],
    folderPath: request.folderPath ?? [],
    params: rows(request.params),
    headers: rows(request.headers),
    auth: authFields(request.auth),
    bodyType: request.bodyType,
    bodyContent: ['json', 'text', 'xml'].includes(request.bodyType) ? request.bodyContent : '',
    formRows: ['form', 'urlencoded'].includes(request.bodyType) ? rows(request.formRows) : [],
    preRequestScript: request.preRequestScript,
    testScript: request.testScript,
    requestNotes: request.requestNotes,
  };
}

function byName(requests: SavedRequest[]) {
  return [...requests].sort((left, right) => left.name.localeCompare(right.name)).map(essence);
}

const strip = (source: string) => source;

describe('export then import keeps every request field', () => {
  it('through Postman', () => {
    const original = corpus();
    const exported = JSON.parse(JSON.stringify(buildPostmanCollection('API', '', original, strip, true)));
    const bundle = postmanCollectionBundle(exported, 'collection-2', 'API');
    expect(byName(bundle.requests)).toEqual(byName(original));
  });

  it('through OpenCollection files', () => {
    const original = corpus();
    const files = buildOpenCollectionFiles('API', '', emptyCollectionDefaults(), original, [], strip, true);
    const bundle = openCollectionBundleFromFiles(files, 'collection-2', 'API', 'workspace-1');
    expect(byName(bundle.requests)).toEqual(byName(original));
  });

  it('through Insomnia', () => {
    const original = corpus();
    const exported = JSON.parse(JSON.stringify(buildInsomniaExport('API', '', original, strip, true)));
    const imported = insomniaRequestsFromResources(exported, 'collection-2', 'API');
    expect(byName(imported)).toEqual(byName(original));
  });
});
