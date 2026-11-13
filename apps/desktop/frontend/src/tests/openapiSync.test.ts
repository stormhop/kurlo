import { describe, expect, it } from 'vitest';
import { openApiImportFromSpec } from '../lib/openapi';
import { makeCollection, normalizeSavedRequest } from '../lib/normalizers';
import {
  acceptAllOpenApiSelection,
  applyOpenApiPlan,
  defaultOpenApiSelection,
  openApiMatchKey,
  openApiPlanSummary,
  planOpenApiSync,
} from '../lib/openapiSync';
import type { Collection, SavedRequest } from '../lib/types/models';

type Spec = Record<string, unknown>;

function spec(paths: Record<string, unknown>, extra: Spec = {}): Spec {
  return { openapi: '3.0.3', info: { title: 'Pets' }, servers: [{ url: 'https://api.example.test' }], paths, ...extra };
}

const getPet = (overrides: Spec = {}) => ({
  operationId: 'getPet',
  summary: 'Get pet',
  parameters: [
    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'limit', in: 'query', schema: { type: 'integer', example: 10 } },
  ],
  ...overrides,
});

const baseSpec = spec({
  '/pets/{id}': { get: getPet() },
  '/pets': { post: { operationId: 'createPet', summary: 'Create pet', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', example: 'Rex' } } } } } } } },
});

function importCollection(source: Spec): { collection: Collection; requests: SavedRequest[] } {
  const collection = makeCollection('ws1', 'Pets');
  const imported = openApiImportFromSpec(source, collection.id, collection.name);
  collection.defaults = { ...collection.defaults, variables: imported.defaults.variables };
  collection.openapi = { source: 'https://api.example.test/openapi.json', intervalMinutes: 15 };
  const requests = imported.requests.map(request => normalizeSavedRequest(request, [collection], 'ws1'));
  return { collection, requests };
}

function byKey(requests: SavedRequest[], key: string) {
  return requests.find(request => request.openapi === key)!;
}

function edit(requests: SavedRequest[], key: string, change: (request: SavedRequest) => SavedRequest) {
  return requests.map(request => request.openapi === key ? change(request) : request);
}

describe('openApiImportFromSpec links requests to operations', () => {
  it('stores the method and path template on every request', () => {
    const { requests } = importCollection(baseSpec);
    expect(requests.map(request => request.openapi).sort()).toEqual(['GET /pets/{id}', 'POST /pets']);
  });
});

describe('planOpenApiSync field merge', () => {
  it('takes the spec when only the spec changed', () => {
    const { collection, requests } = importCollection(baseSpec);
    const next = spec({ ...baseSpec.paths as Spec, '/pets/{id}': { get: getPet({ description: 'Returns one pet' }) } });
    const plan = planOpenApiSync({ collection, requests, baseSpec, nextSpec: next });
    expect(plan.counts).toMatchObject({ changed: 1, conflict: 0 });
    const change = plan.endpoints[0];
    expect(change.fields.map(field => field.field)).toEqual(['docs']);
    const result = applyOpenApiPlan(plan, defaultOpenApiSelection(plan), requests, collection);
    expect(byKey(result.requests, 'GET /pets/{id}').requestNotes).toBe('Returns one pet');
  });

  it('keeps a local edit when the spec did not change that field', () => {
    const { collection, requests } = importCollection(baseSpec);
    const edited = edit(requests, 'GET /pets/{id}', request => ({ ...request, requestNotes: 'My notes' }));
    const plan = planOpenApiSync({ collection, requests: edited, baseSpec, nextSpec: baseSpec });
    expect(plan.endpoints).toEqual([]);
    expect(openApiPlanSummary(plan)).toBe('In sync');
  });

  it('marks a field changed on both sides as a conflict and keeps the local value by default', () => {
    const { collection, requests } = importCollection(baseSpec);
    const edited = edit(requests, 'GET /pets/{id}', request => ({ ...request, requestNotes: 'My notes' }));
    const next = spec({ ...baseSpec.paths as Spec, '/pets/{id}': { get: getPet({ description: 'Spec notes' }) } });
    const plan = planOpenApiSync({ collection, requests: edited, baseSpec, nextSpec: next });
    expect(plan.counts.conflict).toBe(1);
    expect(plan.endpoints[0].fields[0]).toMatchObject({ field: 'docs', conflict: true, local: 'My notes', spec: 'Spec notes' });
    const kept = applyOpenApiPlan(plan, defaultOpenApiSelection(plan), edited, collection);
    expect(byKey(kept.requests, 'GET /pets/{id}').requestNotes).toBe('My notes');
    const taken = applyOpenApiPlan(plan, acceptAllOpenApiSelection(plan), edited, collection);
    expect(byKey(taken.requests, 'GET /pets/{id}').requestNotes).toBe('Spec notes');
  });

  it('applies the non-conflicting fields of a conflicting endpoint when keeping local', () => {
    const { collection, requests } = importCollection(baseSpec);
    const edited = edit(requests, 'GET /pets/{id}', request => ({ ...request, requestNotes: 'Mine' }));
    const next = spec({
      ...baseSpec.paths as Spec,
      '/pets/{id}': { get: getPet({ description: 'Theirs', parameters: [...getPet().parameters, { name: 'X-Trace', in: 'header', schema: { type: 'string', example: 't1' } }] }) },
    });
    const plan = planOpenApiSync({ collection, requests: edited, baseSpec, nextSpec: next });
    const result = applyOpenApiPlan(plan, defaultOpenApiSelection(plan), edited, collection);
    const request = byKey(result.requests, 'GET /pets/{id}');
    expect(request.requestNotes).toBe('Mine');
    expect(request.headers.map(row => [row.key, row.value])).toEqual([['X-Trace', 't1']]);
  });

  it('never touches scripts, tests and settings', () => {
    const { collection, requests } = importCollection(baseSpec);
    const edited = edit(requests, 'GET /pets/{id}', request => ({
      ...request,
      testScript: 'pm.test("ok", () => {})',
      preRequestScript: 'pm.variables.set("a", 1)',
      settings: { ...request.settings, timeoutMs: 1234 },
    }));
    const next = spec({ ...baseSpec.paths as Spec, '/pets/{id}': { get: getPet({ description: 'New docs' }) } });
    const plan = planOpenApiSync({ collection, requests: edited, baseSpec, nextSpec: next });
    const result = applyOpenApiPlan(plan, acceptAllOpenApiSelection(plan), edited, collection);
    const request = byKey(result.requests, 'GET /pets/{id}');
    expect(request.testScript).toBe('pm.test("ok", () => {})');
    expect(request.preRequestScript).toBe('pm.variables.set("a", 1)');
    expect(request.settings.timeoutMs).toBe(1234);
    expect(request.requestNotes).toBe('New docs');
  });
});

describe('planOpenApiSync rows', () => {
  it('adds new params, drops removed ones, keeps user rows and {{variables}}', () => {
    const { collection, requests } = importCollection(baseSpec);
    const edited = edit(requests, 'GET /pets/{id}', request => ({
      ...request,
      params: [
        ...request.params.map(row => row.key === 'limit' ? { ...row, value: '{{pageSize}}' } : row),
        { ...request.params[0], id: 999, key: 'debug', value: '1' },
      ],
    }));
    const next = spec({
      ...baseSpec.paths as Spec,
      '/pets/{id}': { get: getPet({ parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', example: 10 } },
        { name: 'sort', in: 'query', schema: { type: 'string', example: 'name' } },
      ] }) },
    });
    const plan = planOpenApiSync({ collection, requests: edited, baseSpec, nextSpec: next });
    expect(plan.counts).toMatchObject({ changed: 1, conflict: 0 });
    const result = applyOpenApiPlan(plan, defaultOpenApiSelection(plan), edited, collection);
    expect(byKey(result.requests, 'GET /pets/{id}').params.map(row => [row.key, row.value])).toEqual([
      ['limit', '{{pageSize}}'],
      ['debug', '1'],
      ['sort', 'name'],
    ]);

    const removed = spec({ ...baseSpec.paths as Spec, '/pets/{id}': { get: getPet({ parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] }) } });
    const untouched = planOpenApiSync({ collection, requests, baseSpec, nextSpec: removed });
    const dropped = applyOpenApiPlan(untouched, defaultOpenApiSelection(untouched), requests, collection);
    expect(byKey(dropped.requests, 'GET /pets/{id}').params).toEqual([]);
  });
});

describe('planOpenApiSync endpoints', () => {
  it('offers new endpoints in the folder of their first tag', () => {
    const { collection, requests } = importCollection(baseSpec);
    const next = spec({ ...baseSpec.paths as Spec, '/owners': { get: { operationId: 'listOwners', summary: 'List owners', tags: ['Owners'] } } });
    const plan = planOpenApiSync({ collection, requests, baseSpec, nextSpec: next });
    expect(plan.endpoints).toHaveLength(1);
    expect(plan.endpoints[0]).toMatchObject({ kind: 'new', key: 'GET /owners' });
    const result = applyOpenApiPlan(plan, defaultOpenApiSelection(plan), requests, collection);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ openapi: 'GET /owners', folderPath: ['Owners'], collectionId: collection.id });
  });

  it('remembers a new endpoint the user left unticked so it is not offered again', () => {
    const { collection, requests } = importCollection(baseSpec);
    const next = spec({ ...baseSpec.paths as Spec, '/owners': { get: { summary: 'List owners' } } });
    const plan = planOpenApiSync({ collection, requests, baseSpec, nextSpec: next });
    const selection = defaultOpenApiSelection(plan);
    selection.selected.clear();
    const result = applyOpenApiPlan(plan, selection, requests, collection);
    expect(result.ignored).toEqual(['GET /owners']);
    const again = planOpenApiSync({ collection: { ...collection, openapi: { ...collection.openapi!, ignored: result.ignored } }, requests, baseSpec: null, nextSpec: next });
    expect(again.endpoints.filter(endpoint => endpoint.kind === 'new')).toEqual([]);
  });

  it('lists endpoints gone from the spec as removed, unticked by default', () => {
    const { collection, requests } = importCollection(baseSpec);
    const next = spec({ '/pets/{id}': { get: getPet() } });
    const plan = planOpenApiSync({ collection, requests, baseSpec, nextSpec: next });
    expect(plan.endpoints).toEqual([expect.objectContaining({ kind: 'removed', key: 'POST /pets' })]);
    const kept = applyOpenApiPlan(plan, defaultOpenApiSelection(plan), requests, collection);
    expect(kept.requests).toHaveLength(2);
    const gone = applyOpenApiPlan(plan, acceptAllOpenApiSelection(plan), requests, collection);
    expect(gone.requests).toHaveLength(1);
    expect(gone.removed.map(request => request.openapi)).toEqual(['POST /pets']);
  });

  it('does not offer an endpoint again after the user deleted its request', () => {
    const { collection, requests } = importCollection(baseSpec);
    const withoutPost = requests.filter(request => request.openapi !== 'POST /pets');
    const plan = planOpenApiSync({ collection, requests: withoutPost, baseSpec, nextSpec: baseSpec });
    expect(plan.endpoints).toEqual([]);
  });

  it('treats a moved path with the same operationId as a URL change', () => {
    const { collection, requests } = importCollection(baseSpec);
    const edited = edit(requests, 'GET /pets/{id}', request => ({ ...request, testScript: 'keep me' }));
    const next = spec({ '/animals/{id}': { get: getPet() }, '/pets': (baseSpec.paths as Spec)['/pets'] });
    const plan = planOpenApiSync({ collection, requests: edited, baseSpec, nextSpec: next });
    expect(plan.endpoints).toHaveLength(1);
    expect(plan.endpoints[0]).toMatchObject({ kind: 'changed', key: 'GET /animals/{id}', renamedFrom: 'GET /pets/{id}' });
    expect(plan.endpoints[0].fields.map(field => field.field)).toEqual(['url']);
    const result = applyOpenApiPlan(plan, defaultOpenApiSelection(plan), edited, collection);
    const moved = byKey(result.requests, 'GET /animals/{id}');
    expect(moved.url).toBe('{{baseUrl}}/animals/:id');
    expect(moved.testScript).toBe('keep me');
    expect(result.requests).toHaveLength(2);
  });
});

describe('planOpenApiSync for collections without links', () => {
  it('matches requests by method and path, whatever the path parameter style', () => {
    expect(openApiMatchKey('get', '{{baseUrl}}/pets/:id?x=1')).toBe('GET /pets/{}');
    expect(openApiMatchKey('GET', 'https://api.example.test/pets/{{petId}}/')).toBe('GET /pets/{}');
    expect(openApiMatchKey('GET', '/pets/{id}')).toBe('GET /pets/{}');
  });

  it('links old requests on connect and reports differences as conflicts', () => {
    const { collection, requests } = importCollection(baseSpec);
    const legacy = requests.map(request => {
      const { openapi: _key, ...rest } = request;
      return request.method === 'GET' ? { ...rest, url: '{{baseUrl}}/pets/{{petId}}', requestNotes: 'old' } : rest;
    }) as SavedRequest[];
    const next = spec({ ...baseSpec.paths as Spec, '/pets/{id}': { get: getPet({ description: 'Fresh' }) } });
    const plan = planOpenApiSync({ collection, requests: legacy, baseSpec: null, nextSpec: next });
    expect(plan.links.map(link => link.key).sort()).toEqual(['GET /pets/{id}', 'POST /pets']);
    expect(plan.endpoints.filter(endpoint => endpoint.kind === 'new')).toEqual([]);
    const conflict = plan.endpoints.find(endpoint => endpoint.key === 'GET /pets/{id}')!;
    expect(conflict.kind).toBe('conflict');
    const result = applyOpenApiPlan(plan, defaultOpenApiSelection(plan), legacy, collection);
    expect(result.requests.every(request => request.openapi)).toBe(true);
    expect(byKey(result.requests, 'GET /pets/{id}').requestNotes).toBe('old');
  });
});

describe('planOpenApiSync collection defaults', () => {
  it('updates the baseUrl variable when the server moves and keeps a local override', () => {
    const { collection, requests } = importCollection(baseSpec);
    const next = { ...baseSpec, servers: [{ url: 'https://v2.example.test' }] };
    const plan = planOpenApiSync({ collection, requests, baseSpec, nextSpec: next });
    expect(plan.collection?.fields.map(field => field.field)).toEqual(['variables']);
    const result = applyOpenApiPlan(plan, defaultOpenApiSelection(plan), requests, collection);
    expect(result.defaults?.variables.find(row => row.key === 'baseUrl')?.value).toBe('https://v2.example.test');

    const overridden = { ...collection, defaults: { ...collection.defaults, variables: collection.defaults.variables.map(row => ({ ...row, value: 'http://localhost:3000' })) } };
    const local = planOpenApiSync({ collection: overridden, requests, baseSpec, nextSpec: next });
    expect(local.collection?.conflict).toBe(true);
    const kept = applyOpenApiPlan(local, defaultOpenApiSelection(local), requests, overridden);
    expect(kept.defaults?.variables.find(row => row.key === 'baseUrl')?.value).toBe('http://localhost:3000');
  });

  it('adopts a new collection auth scheme from the spec', () => {
    const { collection, requests } = importCollection(baseSpec);
    const next = {
      ...baseSpec,
      security: [{ bearer: [] }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    };
    const plan = planOpenApiSync({ collection, requests, baseSpec, nextSpec: next });
    expect(plan.collection?.fields.map(field => field.field)).toEqual(expect.arrayContaining(['auth']));
    const result = applyOpenApiPlan(plan, defaultOpenApiSelection(plan), requests, collection);
    expect(result.defaults?.auth.type).toBe('bearer');
  });
});

describe('planOpenApiSync examples', () => {
  it('replaces spec examples and keeps the ones the user captured', () => {
    const responses = (body: string) => ({ responses: { 200: { description: 'OK', content: { 'application/json': { example: { name: body } } } } } });
    const first = spec({ '/pets/{id}': { get: getPet(responses('Rex')) } });
    const { collection, requests } = importCollection(first);
    const captured = requests.map(request => ({
      ...request,
      examples: [...(request.examples ?? []), { ...request.examples![0], id: 'mine', name: 'Captured', source: 'captured' as const }],
    }));
    const next = spec({ '/pets/{id}': { get: getPet(responses('Max')) } });
    const plan = planOpenApiSync({ collection, requests: captured, baseSpec: first, nextSpec: next });
    expect(plan.endpoints[0].fields.map(field => field.field)).toEqual(['examples']);
    const result = applyOpenApiPlan(plan, defaultOpenApiSelection(plan), captured, collection);
    const examples = byKey(result.requests, 'GET /pets/{id}').examples!;
    expect(examples.map(example => example.source).sort()).toEqual(['captured', 'openapi']);
    expect(examples.find(example => example.source === 'openapi')!.response.body).toContain('Max');
  });
});
