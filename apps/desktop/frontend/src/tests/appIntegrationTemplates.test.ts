import { backend, TestApp, row, httpResponse } from './support/appIntegration';
import { describe, it, vi, expect } from 'vitest';
import { type OAuth2TokenResponse, type HttpRequest } from '../lib/backend';
import { type SavedRequest, type GrpcResponse } from '../lib/types/models';
import { grpcFeature } from '../lib/stores/features/grpc';

describe('request templates reach the backend unresolved', () => {
  async function appWithRequest(url: string) {
    backend.state.savedStores = [];
    backend.state.sentHttpRequests = [];
    backend.state.environment = {};
    backend.state.globals = {};
    const app = new TestApp() as TestApp & Record<string, any>;
    app.prompts.push('Templates');
    await app.createCollection();
    await app.createNewRequest(app.collections[0].id);
    app.url = url;
    app.method = 'GET';
    await app.saveActiveRequest();
    return app;
  }

  it('sends the original request, credentials and variables when tabs change during OAuth refresh', async () => {
    const app = await appWithRequest('{{host}}/source');
    const sourceId = app.activeRequestId;
    app.selectAuthType('oauth2');
    app.oauth2Token = 'expired-a';
    app.oauth2RefreshToken = 'refresh-a';
    app.oauth2TokenExpiry = 1;
    app.globalVariables = [row('host', 'https://source.example.test')];
    await app.saveActiveRequest();
    await app.createNewRequest(app.collections[0].id);
    const otherId = app.activeRequestId;
    app.url = 'https://other.example.test';
    app.selectAuthType('bearer');
    app.bearerToken = 'token-b';
    await app.saveActiveRequest();
    await app.switchRequest(sourceId);
    let resolve!: (result: OAuth2TokenResponse) => void;
    backend.refreshOAuth2Token.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    let sent: HttpRequest | undefined;
    backend.sendHttpRequest.mockImplementationOnce(async request => {
      sent = request;
      return httpResponse(200, { ok: true });
    });

    const sending = app.runActiveRequest();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await app.switchRequest(otherId);
    app.globalVariables = [row('host', 'https://other.example.test')];
    resolve({ access_token: 'fresh-a', refresh_token: 'rotated-a', token_type: 'Bearer', expires_in: 3600 });
    await sending;

    expect(sent).toMatchObject({ requestId: sourceId, url: '{{host}}/source', auth: { token: 'fresh-a' }, templateValues: { host: 'https://source.example.test' } });
    expect(app.activeRequestId).toBe(otherId);
    expect(app.bearerToken).toBe('token-b');
    expect(app.requests.find(request => request.id === sourceId)?.auth.oauth2RefreshToken).toBe('rotated-a');
  });

  it('keeps an inactive OAuth result unsaved until its request is saved in manual mode', async () => {
    const app = await appWithRequest('https://source.example.test');
    const sourceId = app.activeRequestId;
    app.selectAuthType('oauth2');
    app.oauth2Token = 'old-a';
    await app.saveActiveRequest();
    await app.createNewRequest(app.collections[0].id);
    const otherId = app.activeRequestId;
    app.url = 'https://other.example.test';
    await app.saveActiveRequest();
    app.autosave = false;
    await app.switchRequest(sourceId);
    let resolve!: (result: OAuth2TokenResponse) => void;
    backend.fetchOAuth2Token.mockReturnValueOnce(new Promise(done => { resolve = done; }));

    const fetching = app.fetchOAuth2Token();
    await app.switchRequest(otherId);
    resolve({ access_token: 'fresh-a', token_type: 'Bearer', expires_in: 3600 });
    await fetching;

    expect(app.requestForEditing(sourceId).auth.oauth2Token).toBe('fresh-a');
    expect(app.requestsForStore(app.requests).find((request: SavedRequest) => request.id === sourceId)?.auth.oauth2Token).toBe('old-a');
    await app.switchRequest(sourceId);
    expect(app.oauth2Token).toBe('fresh-a');
    await app.saveActiveRequest();
    expect(backend.state.savedStores.at(-1)?.requests.find(request => request.id === sourceId)?.auth.oauth2Token).toBe('fresh-a');
  });

  it.each(['http', 'grpc'] as const)('uses the refreshed token for %s requests in the runner', async protocol => {
    const app = await appWithRequest('https://source.example.test');
    app.selectAuthType('oauth2');
    app.oauth2Token = 'expired-a';
    app.oauth2RefreshToken = 'refresh-a';
    app.oauth2TokenExpiry = 1;
    await app.saveActiveRequest();
    const request = { ...app.requests[0], requestType: protocol, grpcMethod: 'example.Service/Call' };
    app.requests = [request];
    app.activeRequestId = 'another-request';
    app.collectionRunnerResults = [app.runnerResultShell(request, 'queued', 'run', 1)];
    backend.refreshOAuth2Token.mockResolvedValueOnce({ access_token: 'fresh-a', token_type: 'Bearer', expires_in: 3600 });
    if (protocol === 'http') backend.sendHttpRequest.mockResolvedValueOnce(httpResponse(200, { ok: true }));
    const refreshesBefore = backend.refreshOAuth2Token.mock.calls.length;
    await app.executeCollectionRunnerRequest(request, 'run', 1, {}, [], []);

    const sent = protocol === 'http' ? backend.sendHttpRequest.mock.calls.at(-1)?.[0] : backend.sendGrpcRequest.mock.calls.at(-1)?.[0];
    expect(sent?.auth.token).toBe('fresh-a');
    expect(app.collectionRunnerResults[0].status).toBe('passed');
    expect(app.requests[0].auth.oauth2Token).toBe('fresh-a');
    if (protocol === 'http') backend.sendHttpRequest.mockResolvedValueOnce(httpResponse(200, { ok: true }));
    await app.executeCollectionRunnerRequest(request, 'run', 2, {}, [], []);
    const repeated = protocol === 'http' ? backend.sendHttpRequest.mock.calls.at(-1)?.[0] : backend.sendGrpcRequest.mock.calls.at(-1)?.[0];
    expect(repeated?.auth.token).toBe('fresh-a');
    expect(backend.refreshOAuth2Token.mock.calls.length - refreshesBefore).toBe(1);
  });

  it('persists inherited script overrides as secrets and keeps masking them after reload', async () => {
    const app = await appWithRequest('https://source.example.test');
    const workspaceId = app.activeWorkspaceId;
    app.environments = [
      { id: 'base', workspaceId, name: 'Base', values: [row('credential', 'old-secret', { secret: true })] },
      { id: 'child', workspaceId, name: 'Child', parentId: 'base', values: [] },
    ];
    app.activeEnvironmentId = 'child';
    backend.sendHttpRequest.mockImplementationOnce(async () => {
      backend.state.environment.credential = 'new-secret';
      return { ...httpResponse(200, { ok: true }), environmentUpdates: { credential: 'new-secret' } };
    });
    await app.runActiveRequest();

    const stored = backend.state.savedStores.at(-1)!;
    expect(stored.environments.find(environment => environment.id === 'child')?.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'credential', value: 'new-secret', secret: true }),
    ]));
    app.environments = JSON.parse(JSON.stringify(stored.environments));
    expect(app.activeSecretEnvironmentValues()).toContain('new-secret');
    expect(app.redactedActiveEnvironmentValues().credential).toBe('{{credential}}');
    expect(app.environments[0].values[0].value).toBe('old-secret');
  });

  it('resolves globals below collection and environment values', async () => {
    const app = await appWithRequest('{{host}}/{{scope}}/{{only}}');
    app.globalVariables = [row('host', 'https://global.test'), row('scope', 'global'), row('only', 'from-globals')];
    app.collections[0].defaults.variables = [row('scope', 'collection')];
    const req = app.savedRequestToRunnableHttpRequest(app.snapshotActiveRequest(), { host: 'https://env.test' }, [], []);
    expect(req.url).toBe('https://env.test/collection/from-globals');
    expect(req.resolveTemplates).toBeUndefined();
  });

  it('keeps path variables in step with the URL, saves them and resolves them for sending', async () => {
    const app = await appWithRequest('{{host}}/users/:id/posts/:post');
    app.syncParamsFromUrl();
    expect(app.pathParams.map(r => r.key)).toEqual(['id', 'post']);
    app.pathParams[0].value = '{{userId}}';
    app.pathParams[1].value = '9';
    app.url = '{{host}}/users/:id';
    app.syncParamsFromUrl();
    expect(app.pathParams.map(r => [r.key, r.value])).toEqual([['id', '{{userId}}']]);
    await app.saveActiveRequest();
    const saved = app.requests.find(r => r.id === app.activeRequestId)!;
    expect(saved.pathParams?.map(r => [r.key, r.value])).toEqual([['id', '{{userId}}']]);
    app.pathParams = [];
    app.applySavedRequest(saved);
    expect(app.pathParams.map(r => [r.key, r.value])).toEqual([['id', '{{userId}}']]);
    const req = app.savedRequestToRunnableHttpRequest(app.snapshotActiveRequest(), { host: 'https://env.test', userId: 'u-1' }, [], []);
    expect(req.url).toBe('https://env.test/users/:id');
    expect(req.pathParams).toEqual([{ key: 'id', value: 'u-1', enabled: true, isFile: false, fileName: '', contentType: '' }]);
  });

  it('defers templates with the merged values, iteration data and GraphQL parts', async () => {
    const app = await appWithRequest('{{base}}/graphql');
    app.globalVariables = [row('base', 'https://global.test')];
    const snapshot = app.snapshotActiveRequest();
    const req = app.savedRequestToRunnableHttpRequest(
      { ...snapshot, requestType: 'graphql', bodyType: 'graphql', bodyContent: JSON.stringify({ query: 'query { user(id: "{{id}}") { name } }', variables: '{\n  // note\n  "id": "{{id}}"\n}', operationName: '' }) },
      { id: '7' },
      [],
      [],
      'deferred',
      { deferTemplates: true, iterationData: { row: 'r1' }, iteration: 2, iterationCount: 3 },
    );
    expect(req.url).toBe('{{base}}/graphql');
    expect(req.body).toBe('');
    expect(req.graphql).toEqual({ query: 'query { user(id: "{{id}}") { name } }', variables: expect.not.stringContaining('//'), operationName: '' });
    expect(req.templateValues).toEqual(expect.objectContaining({ base: 'https://global.test', id: '7', row: 'r1' }));
    expect(req).toMatchObject({ resolveTemplates: true, iterationData: { row: 'r1' }, iteration: 2, iterationCount: 3 });
  });

  it('sends single requests deferred so pre-request scripts can change variables', async () => {
    const app = await appWithRequest('{{base}}/items');
    app.globalVariables = [row('base', 'https://api.example.test')];
    let sent: HttpRequest | undefined;
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async (req: HttpRequest) => {
      sent = req;
      return httpResponse(200, { ok: true });
    });
    await app.runActiveRequest();
    expect(sent).toMatchObject({
      url: '{{base}}/items',
      resolveTemplates: true,
      templateValues: expect.objectContaining({ base: 'https://api.example.test' }),
    });
  });

  it('gives each runner request its data row, iteration and the globals written so far', async () => {
    const app = await appWithRequest('https://api.example.test/{{name}}');
    const saved = app.requests.find((req: SavedRequest) => req.id === app.activeRequestId)!;
    const sent: HttpRequest[] = [];
    vi.mocked(backend.sendHttpRequest).mockImplementation(async (req: HttpRequest) => {
      sent.push(req);
      backend.state.globals = { ...backend.state.globals, counter: String(sent.length) };
      return { ...httpResponse(200, { ok: true }), globalVariableUpdates: { counter: String(sent.length) } };
    });
    await app.startCollectionRunner('Templates', [saved], { dataRows: [{ name: 'ada' }, { name: 'bob' }], parallel: false });
    vi.mocked(backend.sendHttpRequest).mockReset();
    expect(sent.map(req => [req.iteration, req.iterationCount, req.iterationData])).toEqual([
      [1, 2, { name: 'ada' }],
      [2, 2, { name: 'bob' }],
    ]);
    expect(sent[0].templateValues?.counter).toBeUndefined();
    expect(sent[1].templateValues).toEqual(expect.objectContaining({ name: 'bob', counter: '1' }));
  });

  it('gives runner gRPC requests the globals written by earlier requests of the run', async () => {
    const app = await appWithRequest('https://api.example.test/login');
    const login = app.requests.find((req: SavedRequest) => req.id === app.activeRequestId)!;
    const grpc = { ...login, id: 'grpc-1', name: 'Greet', requestType: 'grpc', url: 'grpc.example.test:443', grpcMethod: 'greeter.Greeter/Hello', bodyContent: '{"token":"{{token}}"}' } as SavedRequest;
    vi.mocked(backend.sendHttpRequest).mockImplementation(async () => {
      backend.state.globals = { ...backend.state.globals, token: 'from-login' };
      return { ...httpResponse(200, { ok: true }), globalVariableUpdates: { token: 'from-login' } };
    });
    const grpcSent: GrpcRequest[] = [];
    vi.mocked(backend.sendGrpcRequest).mockImplementationOnce(async (req: GrpcRequest) => {
      grpcSent.push(req);
      return { status: 'OK', grpcCode: 'OK', grpcMessage: '', messages: [], headers: [], trailers: [], duration: 1, error: '', timestamp: Date.now(), preRequestResult: { tests: [] }, testResult: { tests: [] } } as GrpcResponse;
    });
    await app.startCollectionRunner('Templates', [login, grpc], { parallel: false });
    vi.mocked(backend.sendHttpRequest).mockReset();
    expect(grpcSent[0]?.message).toBe('{"token":"from-login"}');
  });

  for (const autosave of [true, false]) {
    it(`keeps source edits when duplicating before the persist debounce with autosave ${autosave}`, async () => {
      const app = await appWithRequest('https://source.example.test');
      const sourceId = app.activeRequestId;
      app.autosave = autosave;
      app.url = 'https://edited.example.test';
      app.scheduleActiveRequestPersist();
      await app.duplicateRequest(sourceId);
      const copyId = app.activeRequestId;
      expect(app.url).toBe('https://edited.example.test');
      await app.switchRequest(sourceId);
      expect(app.url).toBe('https://edited.example.test');
      expect(app.requests.find((req: SavedRequest) => req.id === copyId)?.url).toBe('https://edited.example.test');
      const storedSource = backend.state.savedStores.at(-1)?.requests.find(req => req.id === sourceId);
      expect(storedSource?.url).toBe(autosave ? 'https://edited.example.test' : 'https://source.example.test');
      expect(app.isRequestDirty(sourceId)).toBe(!autosave);
    });
  }

  for (const parallel of [false, true]) {
    it(`keeps runner script scopes and updates owned by their original environment with parallel ${parallel}`, async () => {
      const app = await appWithRequest('{{host}}/{{token}}/{{counter}}');
      const workspaceId = app.activeWorkspaceId;
      app.environments = [
        { id: 'dev', workspaceId, name: 'Dev', values: [row('host', 'https://dev.test'), row('old', 'remove-me')] },
        { id: 'prod', workspaceId, name: 'Prod', values: [row('host', 'https://prod.test'), row('keep', 'prod-only')] },
      ];
      app.activeEnvironmentId = 'dev';
      app.globalVariables = [row('counter', '0'), row('oldGlobal', 'remove-me')];
      const saved = app.requests.find((req: SavedRequest) => req.id === app.activeRequestId)!;
      const sent: HttpRequest[] = [];
      vi.mocked(backend.sendHttpRequest).mockImplementation(async (req: HttpRequest) => {
        sent.push(req);
        if (sent.length === 1) {
          await app.selectEnvironment('prod');
          app.globalVariables = [...app.globalVariables, row('unrelated', 'edited-elsewhere')];
          backend.state.globals = { counter: '999', foreign: 'other-request' };
          return {
            ...httpResponse(200, {}), environmentUpdates: { token: 'dev-token' }, environmentRemoved: ['old'],
            globalVariableUpdates: { counter: '1' }, globalVariablesRemoved: ['oldGlobal'],
          };
        }
        return httpResponse(200, {});
      });
      try {
        await app.startCollectionRunner('Scopes', [saved], { iterations: 2, parallel, concurrency: 1 });
      } finally {
        vi.mocked(backend.sendHttpRequest).mockReset();
      }
      expect(sent[0]).toMatchObject({ scriptEnvironment: { host: 'https://dev.test', old: 'remove-me' }, scriptVariables: { counter: '0', oldGlobal: 'remove-me' } });
      expect(sent[1]).toMatchObject({
        templateValues: { host: 'https://dev.test', token: 'dev-token', counter: '1' },
        scriptEnvironment: { host: 'https://dev.test', token: 'dev-token' }, scriptVariables: { counter: '1' },
      });
      expect(sent[1].scriptEnvironment).not.toHaveProperty('old');
      expect(sent[1].scriptVariables).not.toHaveProperty('foreign');
      expect(app.activeEnvironmentId).toBe('prod');
      expect(app.activeEnvironmentValues()).toEqual({ host: 'https://prod.test', keep: 'prod-only' });
      expect(app.environmentValuesFor('dev')).toEqual({ host: 'https://dev.test', token: 'dev-token' });
      expect(app.globalVariableValues()).toEqual({ counter: '1', unrelated: 'edited-elsewhere' });
      const persisted = backend.state.savedStores.at(-1)!;
      expect(persisted.environments.find(env => env.id === 'dev')?.values).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'token', value: 'dev-token' })]));
      expect(persisted.environments.find(env => env.id === 'prod')?.values.some(value => value.key === 'token')).toBe(false);
    });
  }

  it('keeps runner iteration data separate from the script environment snapshot', async () => {
    const app = await appWithRequest('https://example.test/{{name}}');
    app.environments = [{ id: 'env', workspaceId: app.activeWorkspaceId, name: 'Env', values: [row('name', 'environment')] }];
    app.activeEnvironmentId = 'env';
    const saved = app.requests.find((req: SavedRequest) => req.id === app.activeRequestId)!;
    let sent: HttpRequest | undefined;
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async (req: HttpRequest) => {
      sent = req;
      return httpResponse(200, {});
    });
    await app.startCollectionRunner('Iteration data', [saved], { dataRows: [{ name: 'iteration' }] });
    expect(sent).toMatchObject({
      scriptEnvironment: { name: 'environment' }, iterationData: { name: 'iteration' }, templateValues: { name: 'iteration' },
    });
  });

  it('applies completed gRPC script changes to the original environment after selection changes', async () => {
    const app = await appWithRequest('grpc.example.test:443');
    app.requestType = 'grpc';
    app.grpcMethod = 'greeter.Greeter/Hello';
    app.grpcServiceDefinition = { source: '', services: [], methods: [] };
    app.environments = [
      { id: 'dev', workspaceId: app.activeWorkspaceId, name: 'Dev', values: [row('host', 'dev')] },
      { id: 'prod', workspaceId: app.activeWorkspaceId, name: 'Prod', values: [row('host', 'prod')] },
    ];
    app.activeEnvironmentId = 'dev';
    app.globalVariables = [row('before', 'captured')];
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(grpcFeature));
    let finish!: (response: GrpcResponse) => void;
    vi.mocked(backend.sendGrpcRequest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const sending = app.invokeGrpc();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await app.selectEnvironment('prod');
    finish({
      status: 'OK', grpcCode: 'OK', grpcMessage: '', messages: [], headers: [], trailers: [], body: '', size: 0,
      duration: 1, preRequestResult: { tests: [] }, testResult: { tests: [] }, method: {} as never,
      environmentUpdates: { token: 'dev-token' }, globalVariableUpdates: { after: 'written' }, globalVariablesRemoved: ['before'],
    });
    await sending;
    expect(app.environmentValuesFor('dev')).toEqual({ host: 'dev', token: 'dev-token' });
    expect(app.activeEnvironmentValues()).toEqual({ host: 'prod' });
    expect(app.globalVariableValues()).toEqual({ after: 'written' });
  });

  it('records a skipped gRPC call as skipped and applies its pre-request variable changes', async () => {
    const app = await appWithRequest('grpc.example.test:443');
    app.requestType = 'grpc';
    app.grpcMethod = 'greeter.Greeter/Hello';
    app.grpcServiceDefinition = { source: '', services: [], methods: [] };
    app.environments = [{ id: 'dev', workspaceId: app.activeWorkspaceId, name: 'Dev', values: [] }];
    app.activeEnvironmentId = 'dev';
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(grpcFeature));
    const response = {
      status: '', grpcCode: '', grpcMessage: '', messages: [], headers: [], trailers: [], body: '', size: 0,
      duration: 0, preRequestResult: { tests: [] }, testResult: { tests: [] }, method: {} as never,
      skipped: true, skipReason: 'Skipped by pre-request script', environmentUpdates: { checked: 'true' },
    };
    vi.mocked(backend.sendGrpcRequest).mockResolvedValueOnce(response);
    await app.invokeGrpc();
    expect(app.grpcResponse).toMatchObject({ skipped: true, skipReason: 'Skipped by pre-request script' });
    expect(app.requestHistory[0]).toMatchObject({ status: 'SKIPPED', statusCode: 0 });
    expect(app.environmentValuesFor('dev')).toEqual({ checked: 'true' });
    expect(app.runnerResultFromGrpcResponse(app.snapshotActiveRequest(), response, 'run', 1)).toMatchObject({ status: 'skipped', error: '' });
  });
});
