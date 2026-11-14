import { backend, TestApp, settleMicrotasks, row } from './support/appIntegration';
import { describe, it, vi, expect } from 'vitest';
import { normalizeRequestExample } from '../lib/examples';
import { type SavedRequest } from '../lib/types/models';
import { normalizeSavedRequest } from '../lib/normalizers';

describe('creating a request', () => {
  it('keeps a request added to a collection as a draft until Save in manual mode', async () => {
    backend.state.savedStores = [];
    const app = new TestApp() as TestApp & Record<string, any>;
    app.prompts.push('Orders');
    await app.createCollection();
    const collection = app.collections[0];
    app.autosave = false;
    const selectDialog = vi.spyOn(app, 'openSelectDialog');

    await app.createNewRequest(collection.id);
    const id = app.activeRequestId;
    expect(app.requestsById.get(id)).toMatchObject({ isDraft: true, collectionId: '' });
    expect(backend.state.savedStores.at(-1)?.requests.find(request => request.id === id && request.collectionId)).toBeUndefined();

    app.url = 'https://api.example.test/orders';
    await app.saveActiveRequest();
    expect(selectDialog).not.toHaveBeenCalled();
    expect(app.requestsById.get(id)).toMatchObject({ isDraft: false, collectionId: collection.id, url: 'https://api.example.test/orders' });
    expect(backend.state.savedStores.at(-1)?.requests.find(request => request.id === id)?.collectionId).toBe(collection.id);

    app.prompts.push('Auth');
    await app.createFolderInCollection(collection.id);
    await app.createRequestInFolder(collection.id, ['Auth']);
    const folderDraftId = app.activeRequestId;
    expect(app.requestsById.get(folderDraftId)?.isDraft).toBe(true);
    await app.saveActiveRequest();
    expect(app.requestsById.get(folderDraftId)).toMatchObject({ isDraft: false, collectionId: collection.id, folderPath: ['Auth'] });
    expect(selectDialog).not.toHaveBeenCalled();
  });

  it('asks before closing a draft only after it was edited', async () => {
    backend.state.savedStores = [];
    const app = new TestApp() as TestApp & Record<string, any>;
    app.prompts.push('Orders');
    await app.createCollection();
    const collection = app.collections[0];
    app.autosave = false;
    const saveChanges = vi.spyOn(app, 'openSaveChangesDialog');
    const selectDialog = vi.spyOn(app, 'openSelectDialog');

    await app.createNewRequest(collection.id);
    const untouched = app.activeRequestId;
    await app.closeRequestTab(untouched);
    expect(saveChanges).not.toHaveBeenCalled();
    expect(app.requestsById.has(untouched)).toBe(false);

    await app.createDraftRequest();
    const blank = app.activeRequestId;
    await app.closeRequestTab(blank);
    expect(selectDialog).not.toHaveBeenCalled();
    expect(app.requestsById.has(blank)).toBe(false);

    await app.createNewRequest(collection.id);
    const discarded = app.activeRequestId;
    app.url = 'https://api.example.test/scratch';
    saveChanges.mockResolvedValueOnce('discard');
    await app.closeRequestTab(discarded);
    expect(saveChanges).toHaveBeenCalledTimes(1);
    expect(app.requestsById.has(discarded)).toBe(false);

    await app.createNewRequest(collection.id);
    const kept = app.activeRequestId;
    app.url = 'https://api.example.test/kept';
    saveChanges.mockResolvedValueOnce('cancel');
    await app.closeRequestTab(kept);
    expect(app.openRequestIds).toContain(kept);
    saveChanges.mockResolvedValueOnce('save');
    await app.closeRequestTab(kept);
    expect(app.openRequestIds).not.toContain(kept);
    expect(app.requestsById.get(kept)).toMatchObject({ isDraft: false, collectionId: collection.id, url: 'https://api.example.test/kept' });
    expect(selectDialog).not.toHaveBeenCalled();
  });

  it('starts every new request as HTTP without asking for a protocol', async () => {
    backend.state.savedStores = [];
    const app = new TestApp() as TestApp & Record<string, any>;
    const selectDialog = vi.spyOn(app, 'openSelectDialog');

    app.prompts.push('Quick');
    await app.createCollection();
    const collection = app.collections[0];

    await app.createNewRequest(collection.id);
    expect(app.requestType).toBe('http');
    await app.createDraftRequest();
    expect(app.requestType).toBe('http');
    app.prompts.push('Auth');
    await app.createFolderInCollection(collection.id);
    await app.createRequestInFolder(collection.id, ['Auth']);
    expect(app.requestType).toBe('http');
    expect(selectDialog).not.toHaveBeenCalled();
  });

  it('lets a saved request change protocol until it has a URL', async () => {
    backend.state.savedStores = [];
    const app = new TestApp() as TestApp & Record<string, any>;

    app.prompts.push('Protocols');
    await app.createCollection();
    const collection = app.collections[0];

    await app.createNewRequest(collection.id);
    app.setRequestHeaderName('Schema');
    app.method = 'POST';
    await app.saveActiveRequest();
    expect(app.requestTypeEditable).toBe(true);
    app.selectRequestType('grpc');
    expect(app.requestType).toBe('grpc');
    expect(app.requestTypeEditable).toBe(true);
    app.selectRequestType('graphql');
    expect(app.requestType).toBe('graphql');
    expect(app.requestTab).toBe('query');

    app.url = 'https://api.example.test/graphql';
    expect(app.requestTypeEditable).toBe(false);
    await app.saveActiveRequest();
    app.selectRequestType('http');
    expect(app.requestType).toBe('graphql');
    expect(app.requests.find(req => req.id === app.activeRequestId)?.requestType).toBe('graphql');
  });
});

describe('opening a saved request', () => {
  it('does not mark it dirty', async () => {
    backend.state.savedStores = [];
    const app = new TestApp() as TestApp & Record<string, any>;

    app.prompts.push('Dirty check');
    await app.createCollection();
    const collection = app.collections[0];

    await app.createNewRequest(collection.id, 'http');
    await settleMicrotasks();
    const first = app.activeRequestId;
    app.setRequestHeaderName('Opened request');
    app.method = 'POST';
    app.url = 'https://api.example.test/things?tag=a&tag=b';
    app.reqHeaders = [row('X-Trace', 'abc'), row('X-Off', 'no', { enabled: false })];
    app.bodyType = 'json';
    app.rawBodyType = 'json';
    app.bodyContent = '{"a":1}';
    app.requestExamples = [normalizeRequestExample({
      id: 'ex-1',
      name: 'Created',
      source: 'captured',
      createdAt: 1_700_000_000_000,
      response: { statusCode: 201, status: '201 Created', headers: [row('Content-Type', 'application/json')], body: '{"id":1}', bodyMediaType: 'application/json', durationMs: 12 },
      snapshot: { method: 'POST', url: 'https://api.example.test/things', headers: [row('X-Trace', 'abc')] },
      match: { pathTemplate: '/things' },
    } as never, first)];
    await app.saveActiveRequest();
    expect(app.isRequestDirty(first)).toBe(false);

    await app.createNewRequest(collection.id, 'http');
    await settleMicrotasks();
    const second = app.activeRequestId;
    app.setRequestHeaderName('Somewhere else');
    app.url = 'https://api.example.test/other';
    await app.saveActiveRequest();

    await app.switchRequest(first);
    await settleMicrotasks();

    const stored = app.requests.find((req: SavedRequest) => req.id === first)!;
    const reopened = app.snapshotActiveRequest();
    if (app.requestDirtyFingerprint(reopened) !== app.requestDirtyFingerprint(stored)) {
      const a = JSON.parse(app.requestDirtyFingerprint(stored));
      const b = JSON.parse(app.requestDirtyFingerprint(reopened));
      const drifted = Object.keys({ ...a, ...b })
        .filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
        .map(key => `${key}: stored ${JSON.stringify(a[key])} vs reopened ${JSON.stringify(b[key])}`);
      expect(drifted).toEqual([]);
    }
    expect(app.isRequestDirty(first)).toBe(false);
    expect(app.activeRequestId).toBe(first);
    expect(second).not.toBe(first);
  });

  it('does not mark an HTTP request from an older store dirty once it is sent', async () => {
    backend.state.savedStores = [];
    const app = new TestApp() as TestApp & Record<string, any>;

    app.prompts.push('Older store');
    await app.createCollection();
    const collection = app.collections[0];
    await app.createNewRequest(collection.id, 'http');
    await settleMicrotasks();
    const first = app.activeRequestId;
    app.url = 'https://api.example.test/market';
    await app.saveActiveRequest();

    await app.createNewRequest(collection.id, 'http');
    await settleMicrotasks();
    app.url = 'https://api.example.test/other';
    await app.saveActiveRequest();

    const legacy = { ...app.requests.find((req: SavedRequest) => req.id === first)! } as Record<string, unknown>;
    for (const key of Object.keys(legacy)) if (key.startsWith('mcp')) delete legacy[key];
    const restored = normalizeSavedRequest(legacy as never, app.collections, app.activeWorkspaceId);
    app.requests = app.requests.map((req: SavedRequest) => (req.id === first ? restored : req));
    app.recordSavedRequestSnapshots(app.requests);

    await app.switchRequest(first);
    await settleMicrotasks();
    app.updateRequestDirtyState(first, app.snapshotActiveRequest());

    const stored = app.requests.find((req: SavedRequest) => req.id === first)!;
    const reopened = app.snapshotActiveRequest();
    const a = JSON.parse(app.requestDirtyFingerprint(stored));
    const b = JSON.parse(app.requestDirtyFingerprint(reopened));
    const drifted = Object.keys({ ...a, ...b })
      .filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
      .map(key => `${key}: stored ${JSON.stringify(a[key])} vs reopened ${JSON.stringify(b[key])}`);
    expect(drifted).toEqual([]);
    expect(app.isRequestDirty(first)).toBe(false);
  });

  it('survives the trip through the store on disk', async () => {
    backend.state.savedStores = [];
    const app = new TestApp() as TestApp & Record<string, any>;

    app.prompts.push('Round trip');
    await app.createCollection();
    const collection = app.collections[0];

    await app.createNewRequest(collection.id, 'http');
    await settleMicrotasks();
    const id = app.activeRequestId;
    app.setRequestHeaderName('Stored request');
    app.method = 'POST';
    app.url = 'https://api.example.test/things?tag=a';
    app.params = [row('dryRun', 'true')];
    app.reqHeaders = [row('X-Trace', 'abc'), row('X-Off', 'no', { enabled: false })];
    app.bodyType = 'json';
    app.rawBodyType = 'json';
    app.bodyContent = '{"a":1}';
    app.selectAuthType('bearer');
    app.bearerToken = 'tok';
    await app.saveActiveRequest();

    const persisted = backend.state.savedStores.at(-1)!;
    const raw = persisted.requests!.find((req: SavedRequest) => req.id === id)!;
    const loaded = normalizeSavedRequest(raw as never, app.collections, app.activeWorkspaceId);
    const inMemory = app.requests.find((req: SavedRequest) => req.id === id)!;

    const a = JSON.parse(app.requestDirtyFingerprint(inMemory));
    const b = JSON.parse(app.requestDirtyFingerprint(loaded));
    const drifted = Object.keys({ ...a, ...b })
      .filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
      .map(key => `${key}: in memory ${JSON.stringify(a[key])} vs loaded ${JSON.stringify(b[key])}`);
    expect(drifted).toEqual([]);
  });
});

describe('imported requests stay unchanged when opened', () => {
  it('opens every request of an imported OpenAPI spec without asking to save it', async () => {
    backend.state.savedStores = [];
    const app = new TestApp() as TestApp & Record<string, any>;
    app.autosave = false;
    const spec = {
      openapi: '3.0.1',
      info: { title: 'T-API', version: '1' },
      servers: [{ url: 'https://business.example.test/openapi' }],
      security: [{ bearerAuth: [] }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      paths: {
        '/api/v2/nominal-accounts/{accountNumber}/beneficiaries/scoring': {
          get: {
            summary: 'Получить результаты проверки бенефициаров',
            description: '\nВозвращает информацию о результатах проверки.',
            parameters: [
              { name: 'accountNumber', in: 'path', required: true, schema: { type: 'string' }, example: '40702810' },
              { name: 'beneficiaryId', in: 'query', description: '\nИдентификатор бенефициара.\nЕсли параметр не передается, возвращаются все.', schema: { type: 'string' } },
              { name: 'X-Request-Id', in: 'header', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK', content: { 'application/json': { example: { results: [] } } } } },
          },
          post: {
            summary: 'Создать',
            requestBody: { content: { 'application/json': { example: { name: 'Rex' } } } },
            responses: { '201': { description: 'Created' } },
          },
        },
      },
    };
    await app.importOpenApiPayload(spec, 'tapi.json');
    const ids = app.requests.filter((req: SavedRequest) => !req.isDraft).map((req: SavedRequest) => req.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      await app.switchRequest(id);
      app.updateRequestDirtyState(id, app.snapshotActiveRequest({ forPersistence: true }));
      expect(app.dirtyRequestIds.has(id), app.requestsById.get(id)?.name).toBe(false);
    }
  });
});
