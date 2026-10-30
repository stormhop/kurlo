import type { api, model } from '../../wailsjs/go/models';

type Wire<T> = T extends (infer U)[]
  ? Wire<U>[]
  : T extends object
    ? { [K in keyof T as K extends 'convertValues' ? never : K]: Wire<T[K]> }
    : T;

export type AppInfo = Wire<model.AppInfo>;
export type AuthConfig = Wire<model.AuthConfig>;
export type ConnectionInfo = Wire<model.ConnectionInfo>;
export type CookieJarResult = Wire<model.CookieJarResult>;
export type CookieSyncConfig = Wire<model.CookieSyncConfig>;
export type CookieSyncLog = Wire<model.CookieSyncLog>;
export type CookieSyncPairRequest = Wire<model.CookieSyncPairRequest>;
export type CookieSyncStatus = Wire<model.CookieSyncStatus>;
export type GrpcMessage = Wire<model.GrpcMessage>;
export type GrpcMethodInfo = Wire<model.GrpcMethodInfo>;
export type GrpcRequest = Wire<model.GrpcRequest>;
export type GrpcResponse = Wire<model.GrpcResponse>;
export type GrpcServiceDefinition = Wire<model.GrpcServiceDefinition>;
export type HttpRequest = Wire<model.HttpRequest>;
export type HttpResponse = Wire<model.HttpResponse>;
export type KeyValue = Wire<model.KeyValue>;
export type LoadDataPreview = Wire<model.LoadDataPreview>;
export type K6ExportResult = Wire<model.K6ExportResult>;
export type K6ExportWarning = Wire<model.K6ExportWarning>;
export type K6ExportStep = Wire<model.K6ExportStep>;
export type K6Info = Wire<model.K6Info>;
export type LoadRunProgress = Wire<model.LoadRunProgress>;
export type LoadRunResult = Wire<model.LoadRunResult>;
export type LoadRunState = Wire<model.LoadRunState>;
export type LoadRunStep = Wire<model.LoadRunStep>;
export type LoadRunThreshold = Wire<model.LoadRunThreshold>;
export type LoadCheck = Wire<model.LoadCheck>;
export type LoadDataSource = Wire<model.LoadDataSource>;
export type LoadExecutor = Wire<model.LoadExecutor>;
export type LoadExtract = Wire<model.LoadExtract>;
export type LoadScenario = Wire<model.LoadScenario>;
export type LoadSettings = Wire<model.LoadSettings>;
export type LoadStage = Wire<model.LoadStage>;
export type LoadStep = Wire<model.LoadStep>;
export type LoadTest = Wire<model.LoadTest>;
export type LoadTestRequest = Wire<model.LoadTestRequest>;
export type LoadThreshold = Wire<model.LoadThreshold>;
export type MockRoute = Wire<model.MockRoute>;
export type MockServerConfig = Wire<model.MockServerConfig>;
export type MockServerStatus = Wire<model.MockServerStatus>;
export type MockRequestLog = Wire<model.MockRequestLog>;
export type AiRequest = Wire<model.AiRequest>;
export type AiResponse = Wire<model.AiResponse>;
export type AiStep = Wire<model.AiStep>;
export type AiBlock = Wire<model.AiBlock>;
export type AiMessage = Wire<model.AiMessage>;
export type AiUsage = Wire<model.AiUsage>;
export type AiToolInfo = Wire<model.AiToolInfo>;
export type McpResponse = Wire<model.McpResponse>;
export type McpTool = Wire<model.McpTool>;
export type McpResource = Wire<model.McpResource>;
export type McpPrompt = Wire<model.McpPrompt>;
export type McpContent = Wire<model.McpContent>;
export type McpNotification = Wire<model.McpNotification>;
export type OAuth2TokenResponse = Wire<model.OAuth2TokenResponse>;
export type ScriptResult = Wire<model.ScriptResult>;
export type SentRequest = Wire<model.SentRequest>;
export type SocketIOEmitMessage = Wire<model.SocketIOEmitMessage>;
export type SocketIOEmitResult = Wire<model.SocketIOEmitResult>;
export type TestResult = Wire<model.TestResult>;
export type TimelineEvent = Wire<model.TimelineEvent>;
export type UpdateCheckResult = Wire<model.UpdateCheckResult>;
export type UpdateInfo = Wire<model.UpdateInfo>;
export type WebSocketSendMessage = Wire<model.WebSocketSendMessage>;
export type WebSocketSendResult = Wire<model.WebSocketSendResult>;

export type CollectionTextFile = Wire<api.CollectionTextFile>;
export type CollectionTextFilesResult = Wire<api.CollectionTextFilesResult>;
export type DefaultWorkspaceLocationResult = Wire<api.DefaultWorkspaceLocationResult>;
export type DownloadResult = Wire<api.DownloadResult>;
export type GitAuthConfigResult = Wire<api.GitAuthConfigResult>;
export type GitBranchEntry = Wire<api.GitBranchEntry>;
export type GitBranchListResult = Wire<api.GitBranchListResult>;
export type GitCommitEntry = Wire<api.GitCommitEntry>;
export type GitConflictFileResult = Wire<api.GitConflictFileResult>;
export type GitDiffResult = Wire<api.GitDiffResult>;
export type GitFileStatus = Wire<api.GitFileStatus>;
export type GitLogResult = Wire<api.GitLogResult>;
export type GitOperationResult = Wire<api.GitOperationResult>;
export type GitPullSummary = Wire<api.GitPullSummary>;
export type GitStashEntry = Wire<api.GitStashEntry>;
export type GitTokenInfoResult = Wire<api.GitTokenInfoResult>;
export type GitWorkspaceStatus = Wire<api.GitWorkspaceStatus>;
export type SaveRequestStoreResult = Wire<api.SaveRequestStoreResult>;
export type WorkspaceDiagnostic = Wire<api.WorkspaceDiagnostic>;
export type WorkspaceOpenResult = Wire<api.WorkspaceOpenResult>;
export type WorkspaceSecretRef = Wire<api.WorkspaceSecretRef>;
export type WorkspaceYAMLFileResult = Wire<api.WorkspaceYAMLFileResult>;
export type HistoryResponseResult = Wire<api.HistoryResponseResult>;

export type CookieJarEntry = Wire<model.Cookie>;
export type ResponseTimings = Wire<model.ResponseTime>;

export type OAuth2DevicePrompt = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};

export type GrpcHeadersEvent = {
  requestId: string;
  headers: KeyValue[];
  method: GrpcMethodInfo;
  duration: number;
  timestamp: number;
};

export type GrpcMessageEvent = {
  requestId: string;
  message: GrpcMessage;
  size: number;
  duration: number;
  timestamp: number;
};

export type GrpcTrailersEvent = {
  requestId: string;
  grpcCode: string;
  grpcMessage: string;
  status: string;
  trailers: KeyValue[];
  error?: string;
  duration: number;
  timestamp: number;
};

export type GrpcDoneEvent = {
  requestId: string;
  response: GrpcResponse;
  timestamp: number;
};

export type RuntimeBridge = {
  EventsOn?: <T = unknown>(eventName: string, callback: (payload: T) => void) => () => void;
  BrowserOpenURL?: (url: string) => void;
  WindowMinimise?: () => void | Promise<void>;
  WindowToggleMaximise?: () => void | Promise<void>;
  WindowIsMaximised?: () => boolean | Promise<boolean>;
  WindowSetLightTheme?: () => void | Promise<void>;
  WindowSetDarkTheme?: () => void | Promise<void>;
  WindowSetBackgroundColour?: (r: number, g: number, b: number, a: number) => void | Promise<void>;
  Quit?: () => void | Promise<void>;
};

type AppBindings = typeof import('../../wailsjs/go/api/App');

type WireFn<F> = F extends (...args: infer A) => Promise<infer R>
  ? (...args: { [I in keyof A]: Wire<A[I]> }) => Promise<Wire<R>>
  : never;

export type AppBridge = { [K in keyof AppBindings]?: WireFn<AppBindings[K]> };

declare global {
  interface Window {
    runtime?: RuntimeBridge;
    go?: { api?: { App?: AppBridge } };
  }
}

export function emptyResponseTimings(): ResponseTimings {
  return {
    total: 0, prepare: 0, socketInitialization: 0, dnsLookup: 0,
    tcpHandshake: 0, tlsHandshake: 0, waitingTTFB: 0, download: 0, process: 0,
  };
}

export function emptyScriptResult(): ScriptResult {
  return { tests: [], logs: [], error: '' };
}

export function emptyConnectionInfo(): ConnectionInfo {
  return { reused: false, wasIdle: false };
}

export function emptyHttpRequest(): HttpRequest {
  return {
    requestId: '', workspaceId: '', method: '', url: '',
    params: [], pathParams: [], headers: [], auth: emptyAuthConfig(),
    bodyType: '', body: '', bodyFilePath: '', formData: [],
    preRequestScript: '', testScript: '', scriptEngine: '',
    followRedirects: false, timeoutMs: 0, name: '',
    scriptTimeoutMs: 0, allowSendRequest: false,
    httpVersion: '', enableSSLVerification: false,
    followOriginalMethod: false, followAuthorizationHeader: false,
    removeRefererHeader: false, encodeUrlAutomatically: false,
    disableCookieJar: false, maxRedirects: 0,
    secretEnvironmentKeys: [], secretEnvironmentValues: [], collectionVariables: {},
    proxyUrl: '', proxyMode: '', proxyBypass: '',
    clientCertPath: '', clientKeyPath: '', clientKeyPassword: '',
    browserEmulation: false, browserOrigin: '', browserWithCredentials: false,
    browserEnforceCORS: false, browserEnforceCSP: false, browserCSP: '',
    wsHandshakeTimeoutMs: 0, wsReconnectAttempts: 0, wsReconnectIntervalMs: 0,
    wsMaxMessageSizeMb: 0, wsKeepAliveIntervalMs: 0,
    sioClientVersion: '', sioPath: '', sioNamespace: '', sioListenEvents: [],
    sseDisableReconnect: false, sseReconnectIntervalMs: 0,
    mcpProtocolVersion: '', mcpMethod: '', mcpName: '', mcpArguments: '',
    mcpCursor: '', mcpInputResponses: '', mcpRequestState: '',
    mcpInputSchema: '', mcpOutputSchema: '',
  };
}

export function emptyHttpResponse(): HttpResponse {
  return {
    statusCode: 0, status: '', headers: [], body: '', duration: 0,
    timings: emptyResponseTimings(), size: 0,
    preRequestResult: emptyScriptResult(), testResult: emptyScriptResult(),
    connection: emptyConnectionInfo(),
  };
}

export function emptyAuthConfig(): AuthConfig {
  return {
    type: 'none',
    token: '',
    username: '',
    password: '',
    keyName: '',
    keyValue: '',
    keyIn: 'header',
    oauth2GrantType: '',
    oauth2TokenURL: '',
    oauth2AuthURL: '',
    oauth2DeviceAuthURL: '',
    oauth2RedirectURL: '',
    oauth2ClientID: '',
    oauth2Secret: '',
    oauth2Scope: '',
    oauth2Audience: '',
    oauth2UsePKCE: false,
    oauth2RefreshToken: '',
    oauth2InsecureSkipVerify: false,
    oauth2Username: '',
    oauth2Password: '',
    oauth2ClientAuth: '',
    oauth2AssertionAlgorithm: '',
    oauth2AssertionPrivateKey: '',
    oauth2AssertionKeyID: '',
    oauth2AssertionAudience: '',
    awsAccessKey: '',
    awsSecretKey: '',
    awsSessionToken: '',
    awsRegion: '',
    awsService: '',
    oauth1ConsumerKey: '',
    oauth1ConsumerSecret: '',
    oauth1Token: '',
    oauth1TokenSecret: '',
    oauth1SignatureMethod: '',
    oauth1PrivateKey: '',
    oauth1Realm: '',
    oauth1Callback: '',
    oauth1Verifier: '',
    oauth1Timestamp: '',
    oauth1Nonce: '',
    oauth1Version: '',
    oauth1AddTo: '',
    oauth1IncludeBodyHash: false,
    oauth1AddEmptyParams: false,
  };
}

export const EMPTY_COOKIE_SYNC_PAIR_REQUEST: CookieSyncPairRequest = {
  id: '',
  browser: '',
  extensionId: '',
  code: '',
  requestedAt: 0,
  expiresAt: 0,
};

export const EMPTY_COOKIE_SYNC_STATUS: CookieSyncStatus = {
  enabled: false,
  running: false,
  port: 0,
  url: '',
  pairingCode: '',
  domains: [],
  paired: false,
  connected: false,
  browser: '',
  unreadable: [],
  lastContactAt: 0,
  lastSyncAt: 0,
  lastSyncCount: 0,
  syncedTotal: 0,
  pending: EMPTY_COOKIE_SYNC_PAIR_REQUEST,
  log: [],
};

export const EMPTY_MOCK_SERVER_STATUS: MockServerStatus = {
  running: false,
  port: 0,
  url: '',
  collectionId: '',
  collectionName: '',
  routeCount: 0,
};

export const EMPTY_GIT_STATUS: GitWorkspaceStatus = {
  isRepo: false,
  workspaceRoot: '',
  root: '',
  missingRoot: false,
  branch: '',
  head: '',
  upstream: '',
  upstreamGone: false,
  ahead: 0,
  behind: 0,
  pushCommitCount: 0,
  pushRemote: '',
  operation: '',
  clean: true,
  files: [],
  remotes: [],
  stashes: [],
  gitMissing: false,
  authRequired: false,
  authScheme: '',
  authHost: '',
  tokenRejected: false,
  error: '',
};

export const EMPTY_GIT_PULL_SUMMARY: GitPullSummary = { changed: 0, added: 0, updated: 0, deleted: 0, renamed: 0 };

export const EMPTY_WORKSPACE_OPEN_RESULT: WorkspaceOpenResult = {
  ok: false,
  root: '',
  payload: '',
  git: EMPTY_GIT_STATUS,
  missingSecrets: [],
  diagnostics: [],
  pullSummary: EMPTY_GIT_PULL_SUMMARY,
  targetExists: false,
  error: 'Wails bridge not available',
  output: '',
};

export const EMPTY_GIT_OPERATION_RESULT: GitOperationResult = {
  ok: false,
  git: EMPTY_GIT_STATUS,
  pullSummary: EMPTY_GIT_PULL_SUMMARY,
  error: 'Wails bridge not available',
  output: '',
  files: [],
  commitCount: 0,
};

export const EMPTY_GIT_BRANCH_LIST: GitBranchListResult = {
  ok: false,
  git: EMPTY_GIT_STATUS,
  current: '',
  localBranches: [],
  remoteBranches: [],
  error: 'Wails bridge not available',
  output: '',
};

export const EMPTY_GIT_CONFLICT_FILE: GitConflictFileResult = {
  ok: false,
  git: EMPTY_GIT_STATUS,
  path: '',
  content: '',
  oursContent: '',
  theirsContent: '',
  oursAvailable: false,
  theirsAvailable: false,
  binary: false,
  truncated: false,
  oursTruncated: false,
  theirsTruncated: false,
  error: 'Wails bridge not available',
  output: '',
};

export const EMPTY_GIT_LOG: GitLogResult = {
  ok: false,
  git: EMPTY_GIT_STATUS,
  commits: [],
  limit: 0,
  offset: 0,
  hasMore: false,
  error: 'Wails bridge not available',
  output: '',
};
