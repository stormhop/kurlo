import { describe, expect, it, vi } from 'vitest';
import type { CookieJarEntry, HttpRequest, HttpResponse, SaveRequestStoreResult } from '../lib/backend';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from '../lib/constants';
import { buildOpenCollectionFiles, openCollectionBundleFromFiles } from '../lib/opencollection';
import { buildOpenApiDocument } from '../lib/openapi';
import { buildPostmanCollection, postmanRequestsFromItems } from '../lib/postman';
import { parseRunnerDataFile, type RunnerDataRow } from '../lib/runnerData';
import type { CollectionRunRecord } from '../lib/collectionRuns';
import { DEFAULT_RUNNER_CONCURRENCY } from '../lib/concurrency';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import { makeWorkspace, normalizeSavedRequest } from '../lib/normalizers';
import type {
  BodyType,
  Collection,
  CollectionRunnerResult,
  Environment,
  GrpcResponse,
  GrpcResponseTab,
  KVRow,
  Method,
  OAuth2GrantType,
  RawBodyType,
  RequestExample,
  RequestHistoryEntry,
  RequestSettings,
  RequestSettingsOverrides,
  RequestStore,
  RequestTab,
  RequestType,
  ResponseTab,
  SavedRequest,
  ScriptEngine,
  SidebarView,
  SIOArg,
  Workspace,
} from '../lib/types/models';
import type { TopView } from '../lib/stores/ui';
import { authFeature } from '../lib/stores/features/auth';
import { collectionDefaultsFeature } from '../lib/stores/features/collectionDefaults';
import { collectionFeature } from '../lib/stores/features/collections';
import { collectionRunnerDerivedFeature } from '../lib/stores/features/collectionRunnerDerived';
import { collectionRunnerFeature } from '../lib/stores/features/collectionRunner';
import { importExportFeature } from '../lib/stores/features/importExport';
import { normalizeRequestExample } from '../lib/examples';
import { environmentFeature } from '../lib/stores/features/environments';
import { folderFeature } from '../lib/stores/features/folders';
import { graphqlFeature } from '../lib/stores/features/graphql';
import { globalsFeature } from '../lib/stores/features/globals';
import { buildGraphQLRequestBody } from '../lib/graphql';
import { historyFeature } from '../lib/stores/features/history';
import { requestBodyFeature } from '../lib/stores/features/requestBody';
import { requestCrudFeature } from '../lib/stores/features/requestCrud';
import { requestDirtyFeature } from '../lib/stores/features/requestDirty';
import { requestExecutionFeature } from '../lib/stores/features/requestExecution';
import { requestHeadersFeature } from '../lib/stores/features/requestHeaders';
import { requestPersistenceFeature } from '../lib/stores/features/requestPersistence';
import { requestSerializationFeature } from '../lib/stores/features/requestSerialization';
import { requestStateFeature } from '../lib/stores/features/requestState';
import { responseFeature } from '../lib/stores/features/response';
import { scriptsFeature } from '../lib/stores/features/scripts';
import { socketioFormFeature } from '../lib/stores/features/socketioForm';
import { workspaceFeature } from '../lib/stores/features/workspace';

const backend = vi.hoisted(() => {
  const state = {
    environment: {} as Record<string, string>,
    globals: {} as Record<string, string>,
    savedStores: [] as RequestStore[],
    sentHttpRequests: [] as HttpRequest[],
    savedFiles: [] as Array<{ name: string; content: string }>,
  };
  const response = (statusCode: number, body: unknown, tests: Array<{ name: string; passed: boolean; error?: string }> = []): HttpResponse => ({
    statusCode,
    status: `${statusCode} ${statusCode >= 400 ? 'Error' : 'OK'}`,
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true, isFile: false, fileName: '' }],
    body: JSON.stringify(body),
    duration: 12,
    size: JSON.stringify(body).length,
    error: '',
    preRequestResult: { tests: [] },
    testResult: { tests },
  });
  return {
    state,
    saveRequestStore: vi.fn(async (payload: string): Promise<SaveRequestStoreResult> => {
      state.savedStores.push(JSON.parse(payload) as RequestStore);
      return { ok: true, error: '' };
    }),
    loadRequestStore: vi.fn(async () => JSON.stringify(state.savedStores.at(-1) ?? {})),
    setEnvironment: vi.fn(async (values: Record<string, string>) => {
      state.environment = { ...values };
    }),
    getEnvironment: vi.fn(async () => ({ ...state.environment })),
    getGlobalVariables: vi.fn(async () => ({ ...state.globals })),
    setGlobalVariables: vi.fn(async (values: Record<string, string>) => {
      state.globals = { ...values };
    }),
    sendHttpRequest: vi.fn(async (sent: HttpRequest): Promise<HttpResponse> => {
      state.sentHttpRequests.push(sent);
      const req = materializeTemplates(sent);
      if (req.url.endsWith('/login')) {
        expect(req.method).toBe('POST');
        expect(req.params).toEqual(expect.arrayContaining([
          expect.objectContaining({ key: 'api_key', value: 'raw-token' }),
          expect.objectContaining({ key: 'dryRun', value: 'true' }),
        ]));
        expect(req.headers).toEqual(expect.arrayContaining([
          expect.objectContaining({ key: 'Authorization', value: 'Bearer raw-token' }),
        ]));
        expect(req.body).toContain('"username":"ada"');
        state.environment.sessionId = 'session-from-login';
        return response(200, { ok: true, token: 'server-token' }, [{ name: 'status', passed: true }]);
      }
      if (req.url.endsWith('/graphql')) {
        expect(req.method).toBe('POST');
        expect(req.bodyType).toBe('graphql');
        const payload = JSON.parse(req.body);
        expect(payload.query).toContain('viewer');
        state.environment.viewerId = 'viewer-1';
        return response(200, { data: { viewer: { id: 'viewer-1' } } }, [{ name: 'viewer', passed: true }]);
      }
      return response(404, { error: `Unhandled ${req.method} ${req.url}` }, [{ name: 'handled', passed: false, error: 'No mock route' }]);
    }),
    sendHttpRequestToFile: vi.fn(async (req: HttpRequest) => ({ response: await backend.sendHttpRequest(req), savedPath: '/tmp/kurlo-response.json' })),
    sendGrpcRequest: vi.fn(async (): Promise<GrpcResponse> => ({
      status: 'OK',
      grpcCode: 'OK',
      grpcMessage: '',
      messages: ['{}'],
      headers: [],
      trailers: [],
      duration: 5,
      error: '',
      timestamp: Date.now(),
      preRequestResult: { tests: [] },
      testResult: { tests: [{ name: 'grpc ok', passed: true }] },
    })),
    cancelHttpRequest: vi.fn(async () => undefined),
    cancelQuit: vi.fn(async () => undefined),
    confirmQuit: vi.fn(async () => undefined),
    sseDisconnect: vi.fn(async () => undefined),
    webSocketDisconnect: vi.fn(async () => undefined),
    socketIODisconnect: vi.fn(async () => undefined),
    openFileDialog: vi.fn(async () => ''),
    readTextFile: vi.fn(async () => ''),
    saveFileDialog: vi.fn(async (name: string, content: string) => {
      state.savedFiles.push({ name, content });
      return true;
    }),
    getEnvironmentState: () => state.environment,
  };
});

vi.mock('../lib/backend', () => backend);

function applyFeatures(target: object, ...features: object[]) {
  for (const feature of features) Object.defineProperties(target, Object.getOwnPropertyDescriptors(feature));
}

function row(key: string, value: string, extra: Partial<KVRow> = {}): KVRow {
  return { ...mkRow(), key, value, ...extra };
}

function httpResponse(statusCode: number, body: unknown): HttpResponse {
  const text = JSON.stringify(body);
  return {
    statusCode,
    status: `${statusCode} ${statusCode >= 400 ? 'Error' : 'OK'}`,
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true, isFile: false, fileName: '' }],
    body: text,
    duration: 12,
    size: text.length,
    error: '',
    preRequestResult: { tests: [] },
    testResult: { tests: [] },
  };
}

class TestApp {
  prompts: string[] = [];
  selects: string[] = [];
  activeWorkspaceId = '';
  activeEnvironmentId = '';
  activeRequestId = '';
  workspaces: Workspace[] = [];
  collections: Collection[] = [];
  environments: Environment[] = [];
  globalVariables: KVRow[] = [];
  requests: SavedRequest[] = [];
  get requestsById() { return new Map(this.requests.map(request => [request.id, request])); }
  requestHistory: RequestHistoryEntry[] = [];
  workspaceCookies: Record<string, CookieJarEntry[]> = {};
  cookies: CookieJarEntry[] = [];
  openRequestIds: string[] = [];
  lastClosedRequestIds: string[] = [];
  folderCollapseState: Record<string, boolean> = {};
  historyDayCollapseState: Record<string, boolean> = {};
  dirtyRequestIds = new Set<string>();
  dirtyRequestIdList: string[] = [];
  draftRequestIds = new Set<string>();
  unsavedRequestSnapshots = new Map<string, SavedRequest>();
  savedRequestSnapshots = new Map<string, SavedRequest>();
  responses = new Map<string, HttpResponse>();
  previousResponses = new Map<string, HttpResponse>();
  responseTabs = new Map<string, ResponseTab>();
  grpcResponses = new Map<string, GrpcResponse>();
  grpcResponseTabs = new Map<string, GrpcResponseTab>();
  sseSessions = new Map();
  webSocketSessions = new Map();
  socketIOSessions = new Map();
  inFlightRequestIds = new Set<string>();
  requestStoreLoaded = true;
  requestStorePersistEpoch = 0;
  requestStorePersistQueue: Promise<unknown> = Promise.resolve();
  requestStorePersistTimer: ReturnType<typeof setTimeout> | null = null;
  persistTimer: ReturnType<typeof setTimeout> | null = null;
  dirtyRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
  workspacePersistTimer: ReturnType<typeof setTimeout> | null = null;
  saveStatusTimer: ReturnType<typeof setTimeout> | null = null;
  saveStatus = 'idle';
  autosave = true;
  applyingSavedRequest = false;
  externalWorkspaceChangePending = false;
  workspaceBlocked = false;
  collectionImportToast = '';
  topView: TopView = 'overview';
  collectionImportSource = 'postman';
  collectionImportSummary = '';
  _postmanImportInput: { click: () => void } | undefined = undefined;
  alerts: Array<{ title: string; message: string }> = [];
  sidebarView: SidebarView = 'collections';
  openRequestMenuId = '';
  openCollectionMenuId = '';
  openHistoryMenuId = '';
  historyHeaderMenuOpen = false;
  workspaceMenuOpen = false;
  environmentMenuOpen = false;
  environmentToast = '';
  environmentToastTimer: ReturnType<typeof setTimeout> | null = null;
  environmentSaveState: 'idle' | 'dirty' | 'saving' | 'saved' = 'idle';
  environmentPersistTimer: ReturnType<typeof setTimeout> | null = null;
  environmentSavedTimer: ReturnType<typeof setTimeout> | null = null;
  collectionSettingsTab = 'overview';
  collectionSettingsSaveState: 'idle' | 'saving' | 'saved' = 'idle';
  collectionSettingsSavedTimer: ReturnType<typeof setTimeout> | null = null;
  activeCollectionSettingsId = '';
  renamingRequestId = '';
  copiedRequestItem: SavedRequest | null = null;
  quitReviewInProgress = false;
  sidebarSearch = '';
  workspaceDiagnostics = [];
  requestSettings: RequestSettings = { ...DEFAULT_REQUEST_SETTINGS };
  requestSettingsOverrides: RequestSettingsOverrides = {};
  requestType: RequestType = 'http';
  requestName = '';
  requestNameAuto = true;
  method: Method = 'GET';
  url = '';
  requestTab: RequestTab = 'params';
  params: KVRow[] = [];
  reqHeaders: KVRow[] = [];
  formRows: KVRow[] = [];
  authType = 'none' as const;
  bearerToken = '';
  basicUser = '';
  basicPass = '';
  apiKeyName = '';
  apiKeyValue = '';
  apiKeyIn: 'header' | 'query' = 'header';
  oauth2GrantType: OAuth2GrantType = 'client_credentials';
  oauth2AuthURL = '';
  oauth2TokenURL = '';
  oauth2ClientID = '';
  oauth2Secret = '';
  oauth2Scope = '';
  oauth2Token = '';
  oauth2RefreshToken = '';
  oauth2TokenExpiry = 0;
  oauth2UsePKCE = true;
  awsAccessKey = '';
  awsSecretKey = '';
  awsRegion = '';
  awsService = '';
  bodyType: BodyType = 'none';
  rawBodyType: RawBodyType = 'json';
  bodyContent = '';
  bodyFilePath = '';
  bodyFileName = '';
  graphqlQuery = '';
  graphqlVariables = '{}';
  graphqlOperationName = '';
  graphqlSchema = '';
  graphqlSchemaStatus = '';
  graphqlSchemaError = '';
  grpcMethod = '';
  grpcMetadata: KVRow[] = [];
  grpcUseReflection = true;
  grpcProtoFilePath = '';
  grpcProtoFileName = '';
  grpcProtoImportPaths: string[] = [];
  preRequestScript = '';
  testScript = '';
  preRequestScriptJs = '';
  testScriptJs = '';
  scriptEngine: ScriptEngine = 'js';
  requestNotes = '';
  requestExamples: RequestExample[] = [];
  diffBaselineExampleIds = new Map<string, string>();
  selectedExampleId = '';
  response: HttpResponse | null = null;
  responseTab: ResponseTab = 'body';
  responseBodyPage = 0;
  responseSearch = '';
  responseSearchIndex = 0;
  responseSearchOpen = false;
  responseSearchTotal = 0;
  responseSearchCounting = false;
  copiedBody = false;
  savedResponse = false;
  _responseSearchCountKey = '';
  _responseSearchCountSource = '';
  _responseSearchCountTimer: number | undefined = undefined;
  _responseSearchCountToken = 0;
  grpcResponse: GrpcResponse | null = null;
  grpcResponseTab: GrpcResponseTab = 'messages';
  requestError = '';
  loading = false;
  sioEvents: KVRow[] = [];
  sioEventName = '';
  sioArgs: SIOArg[] = [];
  sioSelectedArgId = '1';
  sioAck = false;
  collectionRunnerOpen = false;
  collectionRunnerCollectionId = '';
  collectionRunnerSelectedRequestIds = new Set<string>();
  collectionRunnerDelayMs = 0;
  collectionRunnerIncludeTags = '';
  collectionRunnerExcludeTags = '';
  collectionRunnerIterations = 1;
  collectionRunnerDataFileName = '';
  collectionRunnerDataRows: RunnerDataRow[] = [];
  collectionRunnerDataError = '';
  collectionRunnerParallel = false;
  collectionRunnerConcurrency = DEFAULT_RUNNER_CONCURRENCY;
  collectionRunnerTitle = '';
  collectionRunnerRunning = false;
  collectionRunnerResults: CollectionRunnerResult[] = [];
  collectionLastRuns: Record<string, CollectionRunRecord> = {};
  collectionRunnerShowingLastRun = false;
  collectionRunnerStartedAt = 0;
  collectionRunnerFinishedAt = 0;
  collectionRunnerCancelRequested = false;
  collectionRunnerActiveRequestId = '';
  collectionRunnerActiveRequestIds = new Set<string>();

  constructor() {
    const workspace = makeWorkspace('Local Workspace');
    this.workspaces = [workspace];
    this.activeWorkspaceId = workspace.id;
    this.applyRequestSettings(DEFAULT_REQUEST_SETTINGS);
  }

  get activeEnvironment() {
    return this.environments.find(environment => environment.id === this.activeEnvironmentId);
  }

  get activeWorkspaceEnvironments() {
    return this.environments.filter(environment => environment.workspaceId === this.activeWorkspaceId);
  }

  get activeWorkspace() {
    return this.workspaces.find(workspace => workspace.id === this.activeWorkspaceId);
  }

  get collectionGroups() {
    return this.buildCollectionGroups();
  }

  currentRequestSettings(): RequestSettings {
    const out = {} as RequestSettings;
    for (const key of Object.keys(DEFAULT_REQUEST_SETTINGS) as Array<keyof RequestSettings>) {
      out[key] = (this.requestSettings[key] ?? DEFAULT_REQUEST_SETTINGS[key]) as never;
    }
    return out;
  }

  applyRequestSettings(settings: Partial<RequestSettings>) {
    this.requestSettings = { ...DEFAULT_REQUEST_SETTINGS, ...settings };
    Object.assign(this, this.requestSettings);
  }

  guardWorkspaceWritable() { return true; }
  guardWorkspaceListWritable() { return true; }
  workspaceIsBlocked() { return false; }
  showWorkspaceBlockedToast() {}
  showExternalWorkspacePendingToast() {}
  refreshPendingExternalWorkspaceChangeIfClean() { return Promise.resolve(false); }
  scheduleGitStatusRefreshAfterPersist() {}
  persistWorkspaceNow() { return Promise.resolve(); }
  captureActiveWorkspaceCookies() { return Promise.resolve(); }
  restoreWorkspaceCookieJar() { return Promise.resolve(); }
  closeFloatingMenus() {}
  closeGitTab() {}
  disposeRealtimeSession() {}
  sseSessionIsActive() { return false; }
  sseConnect() { return Promise.resolve(); }
  sseDisconnect() { return Promise.resolve(); }
  clearTransientSSESession() {}
  promoteActiveRequestToSSE() {}
  webSocketDisconnect() { return Promise.resolve(); }
  socketIODisconnect() { return Promise.resolve(); }
  ensureValidOAuth2Token() { return Promise.resolve(); }
  invokeGrpc() { return Promise.resolve(); }
  refreshCookieJar() { return Promise.resolve(); }
  openWorkspaceDiagnostic() {}
  diagnosticsForCollection() { return []; }
  diagnosticsForRequest() { return []; }
  workspaceDiagnosticKey(diagnostic: { path?: string }) { return diagnostic.path ?? 'diagnostic'; }
  openPromptDialog(_title: string, initialValue = '') { return Promise.resolve(this.prompts.shift() ?? initialValue); }
  openSelectDialog(_title: string, _message: string, options: Array<{ value: string }>) {
    return Promise.resolve(this.selects.shift() ?? options[0]?.value ?? null);
  }
  openConfirmDialog() { return Promise.resolve(true); }
  openAlertDialog(title: string, message: string) {
    this.alerts.push({ title, message });
    return Promise.resolve();
  }
  isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  defaultWorkspaceParentForDialogs() { return Promise.resolve(''); }
  openSaveChangesDialog() { return Promise.resolve<'save'>('save'); }
  isEventStreamResponse() { return false; }
  setActiveGrpcResponse(response: GrpcResponse | null, requestId = this.activeRequestId) {
    this.grpcResponse = response;
    if (!requestId) return;
    const next = new Map(this.grpcResponses);
    if (response) next.set(requestId, response);
    else next.delete(requestId);
    this.grpcResponses = next;
  }
  saveTextFile(name: string, content: string) {
    backend.state.savedFiles.push({ name, content });
    return Promise.resolve(true);
  }
}

function materializeTemplates(req: HttpRequest): HttpRequest {
  if (!req.resolveTemplates) return req;
  const values = req.templateValues ?? {};
  const resolve = (value: string) => environmentFeature.resolveTemplate.call({} as never, value, values);
  const rows = <T extends { key: string; value: string }>(list: T[]) => list.map(row => ({ ...row, key: resolve(row.key), value: resolve(row.value) }));
  return {
    ...req,
    url: resolve(req.url),
    params: rows(req.params),
    headers: rows(req.headers),
    formData: rows(req.formData),
    auth: { ...req.auth, token: resolve(req.auth.token), username: resolve(req.auth.username), password: resolve(req.auth.password), keyName: resolve(req.auth.keyName), keyValue: resolve(req.auth.keyValue) },
    body: req.graphql
      ? buildGraphQLRequestBody({ query: resolve(req.graphql.query), variables: resolve(req.graphql.variables), operationName: resolve(req.graphql.operationName) })
      : resolve(req.body),
    resolveTemplates: false,
    templateValues: undefined,
    graphql: undefined,
  };
}

applyFeatures(
  TestApp.prototype,
  workspaceFeature,
  globalsFeature,
  collectionFeature,
  folderFeature,
  environmentFeature,
  collectionDefaultsFeature,
  requestDirtyFeature,
  requestPersistenceFeature,
  requestStateFeature,
  requestCrudFeature,
  requestSerializationFeature,
  requestHeadersFeature,
  requestBodyFeature,
  graphqlFeature,
  responseFeature,
  requestExecutionFeature,
  historyFeature,
  collectionRunnerDerivedFeature,
  collectionRunnerFeature,
  authFeature,
  scriptsFeature,
  socketioFormFeature,
  importExportFeature,
);

async function settleMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('full application e2e smoke', () => {
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
    app.activeTestScript = 'pm.test("status", () => pm.response.to.have.status(200));';
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
    expect(app.response?.statusCode).toBe(200);
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
      method: 'POST',
      bodyContent: '{"name":"Ada"}',
    });
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
      cancelActiveRequest: async () => undefined,
      clearTransientSSESession: () => undefined,
      ensureValidOAuth2Token: async () => undefined,
      graphQLPayloadError: () => '',
      guardWorkspaceWritable: () => true,
      headerValidationErrorForRequest: () => '',
      isEventStreamResponse: () => false,
      markRequestLoading: () => undefined,
      persistActiveRequestNow: async () => undefined,
      refreshCookieJar: async () => undefined,
      requestIsActive: (requestId: string) => requestId === 'req-retry',
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
    await settleMicrotasks();

    expect(activeResponse).toBe(previous);

    resolveRequest(next);
    await sendPromise;

    expect(activeResponse).toBe(next);
  });
});

describe('importing a spec from a URL', () => {
  const petstoreSpec = {
    openapi: '3.0.0',
    info: { title: 'Petstore API', version: '1.0.0' },
    servers: [{ url: 'https://api.petstore.test/v2' }],
    paths: {
      '/pets': {
        get: { summary: 'List pets', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' }, example: 10 }] },
        post: { summary: 'Create a pet' },
      },
      '/pets/{petId}': {
        get: { summary: 'Get a pet', parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }] },
      },
    },
  };

  function specResponse(body: string, contentType = 'application/json'): HttpResponse {
    return {
      statusCode: 200,
      status: '200 OK',
      headers: [{ key: 'Content-Type', value: contentType, enabled: true, isFile: false, fileName: '' }],
      body,
      duration: 8,
      size: body.length,
      error: '',
      preRequestResult: { tests: [] },
      testResult: { tests: [] },
    } as unknown as HttpResponse;
  }

  function newApp() {
    backend.state.savedStores = [];
    backend.state.sentHttpRequests = [];
    return new TestApp() as TestApp & Record<string, any>;
  }

  it('fetches the spec and builds a collection from it', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async (req: HttpRequest) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('https://api.petstore.test/openapi.json');
      expect(req.followRedirects).toBe(true);
      expect(req.disableCookieJar).toBe(true);
      return specResponse(JSON.stringify(petstoreSpec));
    });

    app.selects.push('openapi-url');
    app.prompts.push('api.petstore.test/openapi.json');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(1);
    expect(app.collections[0].name).toBe('Petstore API');
    expect(app.requests.map((req: SavedRequest) => `${req.method} ${req.url}`).sort()).toEqual([
      'GET {{baseUrl}}/pets',
      'GET {{baseUrl}}/pets/:petId',
      'POST {{baseUrl}}/pets',
    ]);
    expect(app.requests.every((req: SavedRequest) => req.collectionId === app.collections[0].id)).toBe(true);
    expect(app.collectionImportToast).toMatch(/Imported 3 requests/);

    const persisted = backend.state.savedStores.at(-1);
    expect(persisted?.collections?.[0]?.name).toBe('Petstore API');
    expect(persisted?.requests).toHaveLength(3);
  });

  it('accepts a YAML spec', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async () => specResponse(
      'openapi: 3.0.0\ninfo:\n  title: YAML API\npaths:\n  /ping:\n    get:\n      summary: Ping\n',
      'text/yaml',
    ));

    app.selects.push('openapi-url');
    app.prompts.push('https://api.example.test/spec.yaml');
    await app.openPostmanImport();

    expect(app.collections[0].name).toBe('YAML API');
    expect(app.requests).toHaveLength(1);
  });

  it('explains a link to the Swagger UI page instead of importing nothing', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async () => specResponse(
      '<!DOCTYPE html><html><head><title>Swagger UI</title></head><body></body></html>',
      'text/html; charset=utf-8',
    ));

    app.selects.push('openapi-url');
    app.prompts.push('https://api.example.test/swagger-ui/index.html');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(0);
    expect(app.alerts.at(-1)?.title).toBe('Import from URL failed');
    expect(app.alerts.at(-1)?.message).toMatch(/web page, not a spec/);
    expect(app.collectionImportToast).toBe('');
  });

  it('reports the status when the URL does not serve a spec', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async () => ({
      ...specResponse('Not Found'),
      statusCode: 404,
      status: '404 Not Found',
    }));

    app.selects.push('openapi-url');
    app.prompts.push('https://api.example.test/nope.json');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(0);
    expect(app.alerts.at(-1)?.message).toMatch(/404 Not Found/);
  });

  it('surfaces a network failure rather than swallowing it', async () => {
    const app = newApp();
    vi.mocked(backend.sendHttpRequest).mockImplementationOnce(async () => ({
      ...specResponse(''),
      statusCode: 0,
      status: '',
      error: 'dial tcp: no such host',
    }));

    app.selects.push('openapi-url');
    app.prompts.push('https://nowhere.invalid/openapi.json');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(0);
    expect(app.alerts.at(-1)?.message).toMatch(/no such host/);
  });

  it('does nothing when the URL prompt is dismissed', async () => {
    const app = newApp();
    app.selects.push('openapi-url');
    app.prompts.push('');
    await app.openPostmanImport();

    expect(app.collections).toHaveLength(0);
    expect(backend.state.sentHttpRequests).toHaveLength(0);
    expect(app.alerts).toHaveLength(0);
  });
});

describe('creating a request', () => {
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
      return httpResponse(200, { ok: true });
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
});

