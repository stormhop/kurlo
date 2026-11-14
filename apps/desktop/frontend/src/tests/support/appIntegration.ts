import { vi, expect } from 'vitest';
import { type RequestStore, type GrpcResponse, type KVRow, type Workspace, type Collection, type Environment, type SavedRequest, type RequestHistoryEntry, type ResponseTab, type GrpcResponseTab, type SidebarView, type RequestSettings, type RequestSettingsOverrides, type RequestType, type Method, type RequestTab, type OAuth2GrantType, type BodyType, type RawBodyType, type ScriptEngine, type RequestExample, type SIOArg, type CollectionRunnerResult } from '../../lib/types/models';
import { type HttpRequest, type HttpResponse, type SaveRequestStoreResult, type OAuth2TokenResponse, type CookieJarEntry } from '../../lib/backend';
import { mkRow, DEFAULT_REQUEST_SETTINGS } from '../../lib/constants';
import { type TrashEntry, trashFeature } from '../../lib/stores/features/trash';
import { type TopView } from '../../lib/stores/ui';
import { oauth1FieldsFromAuth, jwtFieldsFromAuth } from '../../lib/utils';
import { type RunnerDataRow } from '../../lib/runnerData';
import { DEFAULT_RUNNER_CONCURRENCY } from '../../lib/concurrency';
import { type CollectionRunRecord } from '../../lib/collectionRuns';
import { makeWorkspace } from '../../lib/normalizers';
import { environmentFeature } from '../../lib/stores/features/environments';
import { buildGraphQLRequestBody } from '../../lib/graphql';
import { workspaceFeature } from '../../lib/stores/features/workspace';
import { globalsFeature } from '../../lib/stores/features/globals';
import { collectionFeature } from '../../lib/stores/features/collections';
import { folderFeature } from '../../lib/stores/features/folders';
import { collectionDefaultsFeature } from '../../lib/stores/features/collectionDefaults';
import { requestDirtyFeature } from '../../lib/stores/features/requestDirty';
import { requestPersistenceFeature } from '../../lib/stores/features/requestPersistence';
import { requestStateFeature } from '../../lib/stores/features/requestState';
import { requestCrudFeature } from '../../lib/stores/features/requestCrud';
import { examplesFeature } from '../../lib/stores/features/examples';
import { requestSerializationFeature } from '../../lib/stores/features/requestSerialization';
import { requestHeadersFeature } from '../../lib/stores/features/requestHeaders';
import { requestBodyFeature } from '../../lib/stores/features/requestBody';
import { graphqlFeature } from '../../lib/stores/features/graphql';
import { responseFeature } from '../../lib/stores/features/response';
import { requestExecutionFeature } from '../../lib/stores/features/requestExecution';
import { historyFeature } from '../../lib/stores/features/history';
import { collectionRunnerDerivedFeature } from '../../lib/stores/features/collectionRunnerDerived';
import { collectionRunnerFeature } from '../../lib/stores/features/collectionRunner';
import { authFeature } from '../../lib/stores/features/auth';
import { scriptsFeature } from '../../lib/stores/features/scripts';
import { socketioFormFeature } from '../../lib/stores/features/socketioForm';
import { importExportFeature } from '../../lib/stores/features/importExport';
import { openApiSyncFeature } from '../../lib/stores/features/openapiSync';

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
    saveRequestStoreDelta: vi.fn(async (): Promise<SaveRequestStoreResult> => ({ ok: false, error: '', needFull: true })),
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
        return { ...response(200, { ok: true, token: 'server-token' }, [{ name: 'status', passed: true }]), environmentUpdates: { sessionId: 'session-from-login' } };
      }
      if (req.url.endsWith('/graphql')) {
        expect(req.method).toBe('POST');
        expect(req.bodyType).toBe('graphql');
        const payload = JSON.parse(req.body);
        expect(payload.query).toContain('viewer');
        state.environment.viewerId = 'viewer-1';
        return { ...response(200, { data: { viewer: { id: 'viewer-1' } } }, [{ name: 'viewer', passed: true }]), environmentUpdates: { viewerId: 'viewer-1' } };
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
    refreshOAuth2Token: vi.fn(async (): Promise<OAuth2TokenResponse | null> => null),
    fetchOAuth2Token: vi.fn(async (): Promise<OAuth2TokenResponse | null> => null),
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
    readOpenApiBaseSpec: vi.fn(),
    writeOpenApiBaseSpec: vi.fn(async () => ''),
    deleteOpenApiBaseSpec: vi.fn(async () => ''),
  };
});

vi.mock('../../lib/backend', () => backend);

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
  environmentBaselines = new Map<string, Environment>();
  globalsBaseline: KVRow[] | null = null;
  globalsSaveState: 'idle' | 'dirty' | 'saving' | 'saved' = 'idle';
  globalsPersistTimer: ReturnType<typeof setTimeout> | null = null;
  globalsSavedTimer: ReturnType<typeof setTimeout> | null = null;
  workspaceReadmeDrafts: Record<string, string> = {};
  requests: SavedRequest[] = [];
  get requestsById() { return new Map(this.requests.map(request => [request.id, request])); }
  requestHistory: RequestHistoryEntry[] = [];
  workspaceCookies: Record<string, CookieJarEntry[]> = {};
  cookies: CookieJarEntry[] = [];
  openRequestIds: string[] = [];
  lastClosedRequestIds: string[] = [];
  folderCollapseState: Record<string, boolean> = {};
  starredRequestIds = new Set<string>();
  historyDayCollapseState: Record<string, boolean> = {};
  dirtyRequestIds = new Set<string>();
  dirtyRequestIdList: string[] = [];
  draftRequestIds = new Set<string>();
  draftTargets = new Map<string, { collectionId: string; folderPath: string[] }>();
  draftBaselines = new Map<string, SavedRequest>();
  unsavedRequestSnapshots = new Map<string, SavedRequest>();
  savedRequestSnapshots = new Map<string, SavedRequest>();
  responses = new Map<string, HttpResponse>();
  previousResponses = new Map<string, HttpResponse>();
  responseTabs = new Map<string, ResponseTab>();
  grpcResponses = new Map<string, GrpcResponse>();
  mcpResponse = null;
  mcpResponses = new Map();
  grpcResponseTabs = new Map<string, GrpcResponseTab>();
  aiConversations = new Map<string, unknown[]>();
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
  trash: TrashEntry[] = [];
  undoEntryId = '';
  assertions = [];
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
  requestVars: KVRow[] = [];
  postResponseVars: KVRow[] = [];
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
  oauth1 = oauth1FieldsFromAuth({});
  jwt = jwtFieldsFromAuth({});
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
  requestExamplesLoaded = true;
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

  get sidebarRequests() {
    return this.requests;
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
  promoteRequestToSSE() { return Promise.resolve(true); }
  noteSuccessfulSend() {}
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
  openNameDialog(title: string, initialValue = '') { return this.openPromptDialog(title, initialValue); }
  toggles: boolean[] = [];
  openPromptWithToggleDialog() {
    const value = this.prompts.shift() ?? '';
    const checked = this.toggles.shift() ?? false;
    return Promise.resolve(value ? { value, checked, checks: [false, checked] } : null);
  }
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
  examplesFeature,
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
  trashFeature,
  openApiSyncFeature,
);

async function settleMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

export { backend, TestApp, settleMicrotasks, row, httpResponse };
