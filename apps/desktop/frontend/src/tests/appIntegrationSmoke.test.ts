import { backend, TestApp, settleMicrotasks, row, httpResponse } from './support/appIntegration';
import { describe, it, expect, vi } from 'vitest';
import { parseRunnerDataFile } from '../lib/runnerData';
import { buildPostmanCollection, postmanRequestsFromItems } from '../lib/postman';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import { buildOpenCollectionFiles, openCollectionBundleFromFiles } from '../lib/opencollection';
import { buildOpenApiDocument } from '../lib/openapi';
import { type SavedRequest, type CollectionRunnerResult, type KVRow } from '../lib/types/models';
import { makeWorkspace, normalizeSavedRequest } from '../lib/normalizers';
import { mkRow } from '../lib/constants';
import { type HttpResponse, type HttpRequest } from '../lib/backend';
import { requestExecutionFeature } from '../lib/stores/features/requestExecution';

describe('full application e2e smoke', () => {
  it('preflights every runner request before sending any request when a linked secret is broken', async () => {
    backend.state.sentHttpRequests = [];
    const app = new TestApp() as TestApp & Record<string, any>;
    app.collections = [{ id: 'preflight-collection', name: 'Preflight', folderPaths: [], defaults: emptyCollectionDefaults() }];
    app.activeWorkspaceId = 'workspace-test';
    const requests = ['No linked secret', 'Working linked secret', 'Broken linked secret'].map((name, index) => ({
      id: `preflight-${index}`,
      name,
      collectionId: 'preflight-collection',
      folderPath: [],
      requestType: 'http',
      method: 'GET',
      url: 'https://example.test',
      auth: { type: 'none', bearerToken: '', basicUser: '', basicPass: '', apiKeyName: '', apiKeyValue: '' },
      headers: index ? [row('Authorization', index === 1 ? '{{secret:env:path#field}}' : '{{secret:env:missing#field}}')] : [],
      params: [],
      pathParams: [],
      formRows: [],
      settings: { timeoutMs: 1000, scriptTimeoutMs: 1000, followRedirects: true },
      vars: [],
      preRequestScriptJs: '',
      testScriptJs: '',
      bodyContent: '',
      bodyType: 'none',
    })) as any[];
    app.requests = requests;
    backend.preflightCollectionRunner.mockResolvedValueOnce([
      { requestId: 'preflight-0', failures: [] },
      { requestId: 'preflight-1', failures: [] },
      { requestId: 'preflight-2', failures: [{ provider: 'env', path: 'missing', field: 'field', kind: 'not-found', message: 'Secret not found' }] },
    ]);

    await app.startCollectionRunner('Preflight', requests);

    expect(backend.preflightCollectionRunner).toHaveBeenCalledOnce();
    expect(backend.preflightCollectionRunner.mock.calls[0][1]).toHaveLength(3);
    expect(backend.state.sentHttpRequests).toHaveLength(0);
    expect(app.collectionRunnerRunning).toBe(false);
    expect(app.collectionRunnerPreflightFailures).toMatchObject([{ name: 'Broken linked secret', failures: [{ path: 'missing' }] }]);
  });

  it('creates collections, folders, environments, sends requests, records history, runs runner, and round-trips exports', async () => {
    backend.state.savedStores = [];
    backend.state.sentHttpRequests = [];
    backend.state.savedFiles = [];
    backend.state.environment = {};
    const app = new TestApp() as TestApp & Record<string, any>;

    app.prompts.push('Smoke API');
    await app.createCollection();
    const collection = app.collections[0];
    expect(collection.name).toBe('Smoke API');
    expect(backend.state.savedStores.at(-1)?.collections[0]?.name).toBe('Smoke API');

    app.prompts.push('Local');
    await app.createEnvironment();
    const env = app.environments[0];
    app.updateEnvironmentRow(env.id, 0, { key: 'baseUrl', value: 'https://api.example.test' });
    app.updateEnvironmentRow(env.id, 1, { key: 'token', value: 'raw-token', secret: true });
    await app.saveEnvironment();
    await app.selectEnvironment(env.id);
    expect(backend.setEnvironment).toHaveBeenLastCalledWith({ baseUrl: 'https://api.example.test', token: 'raw-token' });
    expect(app.redactedActiveEnvironmentValues()).toMatchObject({ token: '{{token}}' });

    app.prompts.push('Auth');
    await app.createFolderInCollection(collection.id);
    expect(app.collections[0].folderPaths).toEqual([['Auth']]);

    await app.createRequestInFolder(collection.id, ['Auth']);
    await settleMicrotasks();
    const loginId = app.activeRequestId;
    app.setRequestHeaderName('Login user');
    app.method = 'POST';
    app.url = '{{baseUrl}}/login?api_key={{token}}&tag=a&tag=b';
    app.params = [row('dryRun', 'true')];
    app.reqHeaders = [row('Authorization', 'Bearer {{token}}')];
    app.selectAuthType('bearer');
    app.bearerToken = '{{token}}';
    app.bodyType = 'json';
    app.rawBodyType = 'json';
    app.bodyContent = '{"username":"ada","password":"raw-password"}';
    app.testScriptJs = 'pm.test("status", () => pm.response.to.have.status(200));';
    app.applyRequestSettings({ ...app.currentRequestSettings(), timeoutMs: 12000, followRedirects: false });
    app.markRequestSettingOverride('timeoutMs');
    app.markRequestSettingOverride('followRedirects');
    await app.saveActiveRequest();

    const savedLogin = app.requests.find(req => req.id === loginId);
    expect(savedLogin).toMatchObject({
      name: 'Login user',
      folderPath: ['Auth'],
      method: 'POST',
      bodyType: 'json',
      auth: expect.objectContaining({ type: 'bearer', bearerToken: '{{token}}' }),
      settings: expect.objectContaining({ timeoutMs: 12000, followRedirects: false }),
    });

    await app.runActiveRequest();
    expect(app.response?.statusCode, app.requestError || app.response?.error).toBe(200);
    expect(app.responseTestSummary).toEqual({ passed: 1, total: 1, allPassed: true });
    expect(app.requestHistory).toHaveLength(1);
    expect(backend.state.sentHttpRequests[0]).toMatchObject({
      method: 'POST',
      url: '{{baseUrl}}/login',
      resolveTemplates: true,
      templateValues: expect.objectContaining({ baseUrl: 'https://api.example.test' }),
      bodyType: 'json',
      secretEnvironmentKeys: ['token'],
      secretEnvironmentValues: ['raw-token'],
    });

    await app.saveHistoryEntryToCollection(app.requestHistory[0].id, collection.id);
    const historyCloneId = app.activeRequestId;
    expect(app.requests.find(req => req.id === historyCloneId)).toMatchObject({
      name: 'Login user',
      collectionId: collection.id,
    });

    await app.createNewRequest(collection.id, 'graphql');
    await settleMicrotasks();
    const graphId = app.activeRequestId;
    app.setRequestHeaderName('Viewer query');
    app.url = '{{baseUrl}}/graphql';
    app.graphqlQuery = 'query Viewer { viewer { id } }';
    app.graphqlVariables = '{}';
    app.graphqlOperationName = '';
    await app.saveActiveRequest();
    await app.runActiveRequest();
    expect(app.responses.get(graphId)?.body).toContain('viewer-1');

    await app.createNewRequest(collection.id, 'ws');
    await settleMicrotasks();
    const wsId = app.activeRequestId;
    app.setRequestHeaderName('Events stream');
    app.url = 'wss://api.example.test/events';
    app.bodyContent = 'ping';
    await app.saveActiveRequest();
    await app.duplicateRequest(wsId);
    const duplicateWsId = app.activeRequestId;
    expect(app.requests.find(req => req.id === duplicateWsId)?.name).toBe('Events stream Copy');
    await app.deleteRequest(duplicateWsId);
    expect(app.requests.some(req => req.id === duplicateWsId)).toBe(false);

    const groups = app.buildCollectionGroups();
    expect(groups[0].folders[0]).toMatchObject({ name: 'Auth', requestCount: 2 });
    expect(groups[0].requests.map(req => req.name)).toEqual(expect.arrayContaining(['Login user', 'Viewer query', 'Events stream']));

    const runnerRows = parseRunnerDataFile('username\nada\nbob', 'smoke.csv');
    app.collectionRunnerDataFileName = 'smoke.csv';
    app.collectionRunnerDataRows = runnerRows;
    await app.startCollectionRunner(
      'Smoke API',
      app.requests.filter(req => [loginId, graphId, wsId].includes(req.id)),
      { dataRows: runnerRows, parallel: false, collectionId: collection.id },
    );
    expect(app.collectionRunnerResults).toHaveLength(4);
    expect(app.collectionLastRuns[collection.id]?.results).toHaveLength(4);
    expect(backend.state.savedStores.at(-1)?.collectionRuns?.[collection.id]?.results).toHaveLength(4);
    app.collectionRunnerResults = [];
    app.showCollectionLastRun(collection.id);
    expect(app.collectionRunnerResults).toHaveLength(4);
    expect(app.collectionRunnerShowingLastRun).toBe(true);
    expect(app.collectionRunnerResults.every(result => result.status === 'passed')).toBe(true);
    expect(app.collectionRunnerSummary).toMatchObject({ total: 4, passed: 4, failed: 0, allPassed: true });
    expect(app.collectionImportToast).toContain('Skipped 1 realtime request');
    expect(app.activeEnvironmentValues()).toMatchObject({ sessionId: 'session-from-login', viewerId: 'viewer-1' });

    await app.downloadCollectionRunnerReport();
    expect(backend.state.savedFiles[0]).toMatchObject({ name: expect.stringContaining('smoke-api') });
    expect(backend.state.savedFiles[0].content).toContain('smoke.csv (2 rows)');

    const exportableRequests = app.requests.filter(req => [loginId, graphId, wsId].includes(req.id));
    const postman = buildPostmanCollection('Smoke API', 'Full e2e export', exportableRequests, app.stripBodyComments.bind(app));
    const postmanJson = JSON.stringify(postman);
    expect(postmanJson).toContain('api_key=');
    expect(postmanJson).not.toContain('raw-token');
    expect(postmanJson).not.toContain('raw-password');
    expect(postmanRequestsFromItems(postman.item, 'collection-imported', 'Smoke API', undefined).map(req => req.requestType)).toEqual(['http', 'graphql', 'ws']);

    const defaults = emptyCollectionDefaults();
    defaults.variables = [row('baseUrl', 'https://api.example.test')];
    const openCollectionFiles = buildOpenCollectionFiles('Smoke API', 'Full e2e export', defaults, exportableRequests, app.environments, app.stripBodyComments.bind(app));
    const bundle = openCollectionBundleFromFiles(openCollectionFiles, 'collection-open', 'Fallback', app.activeWorkspaceId);
    expect(bundle.requests.map(req => req.requestType).sort()).toEqual(['graphql', 'http', 'ws']);
    expect(openCollectionFiles.map(file => file.path)).toEqual(expect.arrayContaining([
      'opencollection.yml',
      'Auth/folder.yml',
      'Auth/Login-user.yml',
      'Viewer-query.yml',
      'Events-stream.yml',
      'environments/Local.yml',
    ]));
    expect(openCollectionFiles.map(file => file.content).join('\n')).not.toContain('raw-token');

    const openApi = buildOpenApiDocument('Smoke API', 'HTTP export', exportableRequests, app.stripBodyComments.bind(app));
    expect(openApi.paths['/login']?.post?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'api_key', in: 'query' }),
      expect.objectContaining({ name: 'dryRun', in: 'query', example: 'true' }),
    ]));
    expect(openApi.paths['/graphql']).toBeUndefined();
  });

  it('keeps the replaced response as the diff baseline for that request', async () => {
    const app = new TestApp() as TestApp & Record<string, any>;
    app.activeRequestId = 'req-diff';

    const first = httpResponse(200, { id: 1, status: 'pending' });
    const second = httpResponse(200, { id: 1, status: 'done' });

    app.setActiveResponse(first);
    expect(app.previousResponse()).toBeNull();
    expect(app.responseDiff()).toBeNull();

    app.setActiveResponse(second);
    expect(app.previousResponse()).toBe(first);

    const diff = app.responseDiff();
    expect(diff).not.toBeNull();
    expect(diff.identical).toBe(false);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);

    app.activeRequestId = 'req-other';
    expect(app.previousResponse()).toBeNull();

    app.activeRequestId = 'req-diff';
    app.clearResponseDiffBaseline();
    expect(app.previousResponse()).toBeNull();
    expect(app.responseDiff()).toBeNull();
  });

  it('caps how many requests a parallel run has in flight at once', async () => {
    backend.state.savedStores = [];
    backend.state.sentHttpRequests = [];
    backend.state.environment = {};
    const app = new TestApp() as TestApp & Record<string, any>;

    app.prompts.push('Load API');
    await app.createCollection();
    const collection = app.collections[0];

    const requests: SavedRequest[] = [];
    for (let index = 0; index < 12; index += 1) {
      await app.createNewRequest(collection.id);
      app.url = `https://api.example.test/item/${index}`;
      app.method = 'GET';
      await app.saveActiveRequest();
      requests.push(app.requests.find(req => req.id === app.activeRequestId)!);
    }

    let inFlight = 0;
    let peak = 0;
    vi.mocked(backend.sendHttpRequest).mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      return httpResponse(200, { ok: true });
    });

    await app.startCollectionRunner('Load API', requests, { parallel: true, concurrency: 3 });

    expect(peak).toBe(3);
    expect(app.collectionRunnerResults).toHaveLength(12);
    expect(app.collectionRunnerResults.every((result: CollectionRunnerResult) => result.status === 'passed')).toBe(true);
    vi.mocked(backend.sendHttpRequest).mockReset();
  });

  it('creates a new request inside an empty workspace instead of jumping to another one', async () => {
    backend.state.savedStores = [];
    const app = new TestApp() as TestApp & Record<string, any>;

    app.prompts.push('API');
    await app.createCollection();
    const first = app.activeWorkspaceId;
    await app.createNewRequest(app.collections[0].id);
    const firstRequestId = app.activeRequestId;

    const empty = makeWorkspace('Workspace 2');
    app.workspaces = [...app.workspaces, empty];
    app.activeWorkspaceId = empty.id;
    app.topView = 'overview';

    await app.createNewRequest();

    expect(app.activeWorkspaceId).toBe(empty.id);
    const created = app.requests.find(req => req.id === app.activeRequestId)!;
    expect(created.id).not.toBe(firstRequestId);
    expect(app.collections.find(col => col.id === created.collectionId)?.workspaceId).toBe(empty.id);
    expect(app.collections.filter(col => col.workspaceId === first)).toHaveLength(1);
  });

  it('duplicates the current editor state for the active request', async () => {
    backend.state.savedStores = [];
    const app = new TestApp() as TestApp & Record<string, any>;

    app.prompts.push('API');
    await app.createCollection();
    const collection = app.collections[0];

    await app.createNewRequest(collection.id, 'http');
    const originalId = app.activeRequestId;
    app.setRequestHeaderName('Update profile');
    app.method = 'POST';
    app.url = 'https://api.example.test/profile';
    app.requestTab = 'body';
    app.bodyType = 'json';
    app.rawBodyType = 'json';
    app.bodyContent = '{"name":"Ada"}';
    await app.saveActiveRequest();

    app.method = 'PATCH';
    app.bodyContent = '{"name":"Grace"}';
    await app.duplicateRequest(originalId);

    const duplicate = app.requests.find(req => req.id === app.activeRequestId);
    expect(duplicate).toMatchObject({
      name: 'Update profile Copy',
      method: 'PATCH',
      url: 'https://api.example.test/profile',
      requestTab: 'body',
      bodyType: 'json',
      rawBodyType: 'json',
      bodyContent: '{"name":"Grace"}',
    });
    expect(app.requests.find(req => req.id === originalId)).toMatchObject({
      method: 'PATCH',
      bodyContent: '{"name":"Grace"}',
    });
  });

  it('resolves request vars above the environment and sends them with post-response vars', () => {
    const app = new TestApp() as TestApp & Record<string, any>;
    app.method = 'GET';
    app.url = '{{baseUrl}}/users/{{userId}}';
    app.reqHeaders = [{ ...mkRow(), key: 'X-Tenant', value: '{{tenant}}' }];
    app.requestVars = [
      { ...mkRow(), key: 'userId', value: '42' },
      { ...mkRow(), key: 'tenant', value: '{{tenant}}-eu' },
      { ...mkRow(), key: 'skipped', value: 'nope', enabled: false },
    ];
    app.postResponseVars = [
      { ...mkRow(), key: 'token', value: 'res.body.token' },
      { ...mkRow(), key: 'unused', value: 'res.status', enabled: false },
    ];

    const snapshot = app.snapshotActiveRequest();
    expect(snapshot.vars?.map((row: KVRow) => row.key)).toEqual(['userId', 'tenant', 'skipped']);
    expect(snapshot.postResponseVars?.map((row: KVRow) => row.key)).toEqual(['token', 'unused']);

    const values = app.environmentValuesForRequest(snapshot, { baseUrl: 'https://api.example.test', userId: '7', tenant: 'acme' });
    expect(values).toMatchObject({ userId: '42', tenant: 'acme-eu', baseUrl: 'https://api.example.test' });
    expect(values.skipped).toBeUndefined();

    const req = app.savedRequestToRunnableHttpRequest(snapshot, { baseUrl: 'https://api.example.test', userId: '7', tenant: 'acme' }, [], [], 'request-vars');
    expect(req.url).toBe('https://api.example.test/users/42');
    expect(req.headers).toEqual([expect.objectContaining({ key: 'X-Tenant', value: 'acme-eu' })]);
    expect(req.requestVariables).toEqual({ userId: '42', tenant: 'acme-eu' });
    expect(req.postResponseVars).toEqual([expect.objectContaining({ key: 'token', value: 'res.body.token', enabled: true })]);
  });

  it('restores request vars when a saved request is reopened', () => {
    const app = new TestApp() as TestApp & Record<string, any>;
    app.url = 'https://api.example.test';
    app.requestVars = [{ ...mkRow(), key: 'userId', value: '42' }];
    app.postResponseVars = [{ ...mkRow(), key: 'token', value: 'res.body.token' }];
    const saved = normalizeSavedRequest(JSON.parse(JSON.stringify(app.snapshotActiveRequest({ forPersistence: true }))), []);
    app.requestVars = [];
    app.postResponseVars = [];

    app.applySavedRequest(saved);

    expect(app.requestVars.filter((row: KVRow) => row.key).map((row: KVRow) => [row.key, row.value])).toEqual([['userId', '42']]);
    expect(app.postResponseVars.filter((row: KVRow) => row.key).map((row: KVRow) => [row.key, row.value])).toEqual([['token', 'res.body.token']]);
  });

  it('leaves post-response vars out of requests that cannot run them', () => {
    const app = new TestApp() as TestApp & Record<string, any>;
    app.requestType = 'ws';
    app.savedMessages = [];
    app.url = 'wss://echo.example.test';
    app.requestVars = [{ ...mkRow(), key: 'room', value: 'lobby' }];
    app.postResponseVars = [{ ...mkRow(), key: 'token', value: 'res.body.token' }];

    const snapshot = app.snapshotActiveRequest();

    expect(snapshot.vars?.map((row: KVRow) => row.key)).toEqual(['room']);
    expect(snapshot.postResponseVars).toBeUndefined();
  });

  it('strips CodeEditor comments before building runnable raw request bodies', () => {
    const app = new TestApp() as TestApp & Record<string, any>;
    app.method = 'POST';
    app.url = 'https://api.example.test/commented';
    app.bodyType = 'json';
    app.rawBodyType = 'json';
    app.bodyContent = `{
  "enabled": true,
  // "disabled": "{{secret}}",
  "name": "{{name}}"
}`;

    const req = app.savedRequestToRunnableHttpRequest(
      app.snapshotActiveRequest(),
      { name: 'Ada', secret: 'should-not-resolve' },
      [],
      [],
      'commented-json',
    );

    expect(req.body).not.toContain('//');
    expect(req.body).not.toContain('should-not-resolve');
    expect(JSON.parse(req.body)).toEqual({ enabled: true, name: 'Ada' });
  });

  it('keeps literal JSON body values even when matching values are secret-redacted elsewhere', () => {
    const app = new TestApp() as TestApp & Record<string, any>;
    const payload = {
      carts: [{
        productId: '4448cf41-7f4d-49c5-88fc-5f6e848537bf',
        count: 1,
      }],
      catalogItemId: 'c62aa06c-3041-4cbc-b16a-cca549e130ae',
      paymentSystemId: '077bdf4e-1377-4a4e-9942-92a66059f81c',
      accountUid: 'https://s.team/p/gcqf-jdhf/jmdtqmcm',
      server: 'test',
      region: 'UA',
    };
    app.method = 'POST';
    app.url = 'https://api.example.test/cart';
    app.bodyType = 'json';
    app.rawBodyType = 'json';
    app.bodyContent = JSON.stringify(payload, null, 2);

    const req = app.savedRequestToRunnableHttpRequest(
      app.snapshotActiveRequest(),
      {},
      [payload.accountUid, payload.server, payload.region],
      ['accountUid', 'server', 'region'],
      'literal-json',
    );

    expect(req.body).not.toContain('[REDACTED]');
    expect(JSON.parse(req.body)).toEqual(payload);
  });

  it('keeps the previous response visible while a retry is in flight', async () => {
    const previous = httpResponse(200, { version: 'previous' });
    const next = httpResponse(200, { version: 'next' });
    let activeResponse: HttpResponse | null = previous;
    let resolveRequest!: (response: HttpResponse) => void;

    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(
      () => new Promise<HttpResponse>(resolve => {
        resolveRequest = resolve;
      }),
    );

    const host = {
      activeRequestId: 'req-retry',
      activeWorkspaceId: 'workspace-1',
      authType: 'none',
      bearerToken: '',
      disableCookieJar: true,
      loading: false,
      method: 'GET',
      requestError: '',
      requestTab: 'params',
      requestType: 'http',
      responseBodyPage: 0,
      responseSearch: '',
      responseSearchIndex: 0,
      savedResponse: false,
      url: 'https://api.example.test/retry',
      activeEnvironmentValues: () => ({}),
      activeSecretEnvironmentKeys: () => [],
      activeSecretEnvironmentValues: () => [],
      globalVariableValues: () => ({}),
      cancelActiveRequest: async () => undefined,
      clearTransientSSESession: () => undefined,
      ensureValidOAuth2TokenForRequest: async (request: SavedRequest) => request,
      graphQLPayloadError: () => '',
      guardWorkspaceWritable: () => true,
      headerValidationErrorForRequest: () => '',
      isEventStreamResponse: () => false,
      markRequestLoading: () => undefined,
      noteSuccessfulSend: () => undefined,
      persistActiveRequestNow: async () => undefined,
      refreshCookieJar: async () => undefined,
      requestIsActive: (requestId: string) => requestId === 'req-retry',
      requestForEditing: (requestId: string) => ({ id: requestId }),
      savedRequestToRunnableHttpRequest: () => ({ requestId: 'req-retry' } as HttpRequest),
      setActiveResponse: (response: HttpResponse | null) => {
        activeResponse = response;
      },
      setActiveResponseTab: () => undefined,
      snapshotActiveRequest: () => ({ id: 'req-retry', method: 'GET' }) as SavedRequest,
      syncActiveEnvironmentFromBackend: async () => undefined,
      syncBackendEnvironment: async () => undefined,
      recordRequestHistory: async () => undefined,
    };

    const sendPromise = requestExecutionFeature.send.call(host as never);
    await vi.waitFor(() => expect(resolveRequest).toBeTypeOf('function'));

    expect(activeResponse).toBe(previous);

    resolveRequest(next);
    await sendPromise;

    expect(activeResponse).toBe(next);
  });
});
