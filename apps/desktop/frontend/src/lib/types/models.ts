import type { CookieJarEntry, KeyValue, ResponseTimings, ScriptResult } from '../backend';

export type { CookieJarEntry, KeyValue, ResponseTimings, ScriptResult };

export type RequestType = 'http' | 'graphql' | 'ws' | 'socketio' | 'grpc' | 'mcp' | 'ai';
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'SSE';

export type SSEStatus = 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'error';
export type WebSocketStatus = 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'error';
export type SocketIOStatus = 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'disconnected' | 'error';
export type SocketIOClientVersion = 'v2' | 'v3';
export type SIOArgEncoding = 'base64' | 'hex';
export type SIOArg = {
  id: string;
  content: string;
  bodyType: RawBodyType | 'binary';
  encoding: SIOArgEncoding;
};

export type SocketIOHandshake = {
  url: string;
  method: string;
  statusCode?: number;
  statusText?: string;
  requestHeaders?: { key: string; value: string }[];
  responseHeaders?: { key: string; value: string }[];
};

export type WebSocketHandshake = {
  url: string;
  method: string;
  statusCode?: number;
  statusText?: string;
  protocol?: string;
  requestHeaders?: { key: string; value: string }[];
  responseHeaders?: { key: string; value: string }[];
};

export type SocketIOMessageEntry = {
  id: string;
  direction: 'incoming' | 'outgoing' | 'system';
  eventName: string;
  args: string[];
  namespace: string;
  timestamp: number;
  isSystem: boolean;
  isError: boolean;
  message?: string;
  expanded?: boolean;
  handshake?: SocketIOHandshake;
  details?: Record<string, string | number | boolean | undefined>;
};

export type SocketIOSession = {
  status: SocketIOStatus;
  connectedUrl: string;
  namespace: string;
  connectedAt: number;
  messages: SocketIOMessageEntry[];
  clearedMessages: SocketIOMessageEntry[];
  headers: { key: string; value: string }[];
  error: string;
};

export type SSEEventEntry = {
  id: string;
  event: string;
  data: string;
  timestamp: number;
  entryId?: number;
  isSystem?: boolean;
  isError?: boolean;
  message?: string;
  expanded?: boolean;
};

export type SSESession = {
  status: SSEStatus;
  connectedUrl: string;
  statusText: string;
  statusCode: number;
  connectedAt: number;
  duration: number;
  timings?: ResponseTimings | null;
  events: SSEEventEntry[];
  clearedEvents: SSEEventEntry[];
  headers: KeyValue[];
  error: string;
};
export type WebSocketMessageType = 'text' | 'binary' | 'ping' | 'pong' | 'close' | 'error' | 'connected' | 'reconnecting' | 'disconnected';
export type WebSocketMessageEntry = {
  id: string;
  direction: 'incoming' | 'outgoing' | 'system';
  type: WebSocketMessageType;
  data: string;
  encoding?: 'plain' | 'base64' | '';
  size: number;
  code?: number;
  timestamp: number;
  isSystem?: boolean;
  isError?: boolean;
  message?: string;
  expanded?: boolean;
  handshake?: WebSocketHandshake;
};
export type WebSocketSession = {
  status: WebSocketStatus;
  connectedUrl: string;
  statusText: string;
  connectedAt: number;
  messages: WebSocketMessageEntry[];
  clearedMessages: WebSocketMessageEntry[];
  headers: KeyValue[];
  protocol: string;
  error: string;
};
export type BodyType = 'none' | 'json' | 'text' | 'xml' | 'html' | 'form' | 'urlencoded' | 'binary' | 'graphql';
export type BodyMode = 'none' | 'form' | 'urlencoded' | 'raw' | 'binary' | 'graphql';
export type RawBodyType = 'text' | 'json' | 'html' | 'xml';
export type HttpVersion = 'auto' | '1.1' | '2';
export type RequestTab = 'docs' | 'params' | 'query' | 'auth' | 'headers' | 'metadata' | 'body' | 'schema' | 'service' | 'events' | 'scripts' | 'settings' | 'examples' | 'tools';
export type ScriptTab = 'pre-request' | 'tests';
export type ResponseTab = 'body' | 'preview' | 'headers' | 'test-results' | 'timeline' | 'diff';
export type GrpcResponseTab = 'messages' | 'metadata' | 'trailers' | 'scripts';
export type AuthType = 'inherit' | 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2' | 'aws' | 'digest';
export type SidebarView = 'collections' | 'environments' | 'history';
export type ShortcutId =
  | 'close-tab' | 'force-close-tab' | 'next-tab' | 'previous-tab'
  | 'tab-1' | 'tab-2' | 'tab-3' | 'tab-4' | 'tab-5' | 'tab-6' | 'tab-7' | 'tab-8' | 'last-tab'
  | 'reopen-tab' | 'new-request' | 'request-url' | 'send-request'
  | 'search-sidebar' | 'duplicate-item' | 'rename-item' | 'copy-item' | 'paste-item' | 'delete-item'
  | 'next-item' | 'previous-item' | 'expand-item' | 'collapse-item' | 'expand-all' | 'collapse-all'
  | 'settings' | 'shortcut-help' | 'search' | 'toggle-left-sidebar' | 'toggle-right-sidebar'
  | 'zoom-in' | 'zoom-out' | 'zoom-reset'
  | 'save-request';

export type ShortcutDefinition = { id: ShortcutId; group: string; label: string; defaultCombo: string };
export type KVRow = { id: number; enabled: boolean; key: string; value: string; description: string; isFile?: boolean; fileName?: string; contentType?: string; secret?: boolean };
export type PreviewHeader = { key: string; value: string; note: string; overridden?: boolean };
export type ResponseLine = { number: number; html: string; hasCurrentMatch?: boolean };
export type WorkspaceDiagnostic = import('../backend').WorkspaceDiagnostic;

export type Workspace = {
  id: string; name: string; filesystemName: string; description: string;
  workspaceDiagnostics?: WorkspaceDiagnostic[];
  isInvalid?: boolean;
};
export type OAuth2GrantType = 'client_credentials' | 'authorization_code' | 'password' | 'device_code';
export type OAuth2ClientAuth = 'basic' | 'body' | 'client_secret_jwt' | 'private_key_jwt';
export type AuthState = {
  type: AuthType; bearerToken: string; basicUser: string; basicPass: string;
  apiKeyName: string; apiKeyValue: string; apiKeyIn: 'header' | 'query';
  oauth2TokenURL: string; oauth2ClientID: string; oauth2Secret: string;
  oauth2Scope: string; oauth2Token: string;
  oauth2GrantType?: OAuth2GrantType; oauth2AuthURL?: string; oauth2DeviceAuthURL?: string;
  oauth2RefreshToken?: string; oauth2TokenExpiry?: number; oauth2UsePKCE?: boolean;
  oauth2Audience?: string;
  oauth2Username?: string; oauth2Password?: string;
  oauth2ClientAuth?: OAuth2ClientAuth;
  oauth2AssertionAlgorithm?: string; oauth2AssertionPrivateKey?: string;
  oauth2AssertionKeyID?: string; oauth2AssertionAudience?: string;
  awsAccessKey: string; awsSecretKey: string; awsSessionToken?: string; awsRegion: string; awsService: string;
};
export type CollectionDefaults = {
  headers: KVRow[];
  variables: KVRow[];
  auth: AuthState;
  preRequestScript: string;
  testScript: string;
  preRequestScriptJs: string;
  testScriptJs: string;
  settings: RequestSettings;
};
export type Collection = {
  id: string; workspaceId: string; name: string; filesystemName: string; description: string;
  collapsed: boolean;
  folderPaths?: string[][];
  defaults: CollectionDefaults;
  workspaceDiagnostics?: WorkspaceDiagnostic[];
  isInvalid?: boolean;
};
export type Environment = {
  id: string; workspaceId: string; name: string; filesystemName: string; values: KVRow[];
  protected?: boolean;
};
export type ScriptEngine = 'js' | 'tengo';
export type RequestSettings = {
  httpVersion: HttpVersion; enableSSLVerification: boolean; followRedirects: boolean;
  followOriginalMethod: boolean; followAuthorizationHeader: boolean; removeRefererHeader: boolean;
  encodeUrlAutomatically: boolean; disableCookieJar: boolean; maxRedirects: number; timeoutMs: number;
  scriptTimeoutMs: number; allowSendRequest: boolean;
  proxyUrl: string; clientCertPath: string; clientKeyPath: string; clientKeyPassword: string;
  browserEmulation: boolean; browserOrigin: string; browserWithCredentials: boolean;
  browserEnforceCORS: boolean; browserEnforceCSP: boolean; browserCSP: string;
  wsHandshakeTimeoutMs: number; wsReconnectAttempts: number; wsReconnectIntervalMs: number; wsMaxMessageSizeMb: number;
  wsKeepAliveIntervalMs: number;
  sseDisableReconnect: boolean; sseReconnectIntervalMs: number;
  sioClientVersion: SocketIOClientVersion; sioPath: string; sioNamespace: string;
  grpcUseTls: boolean; grpcUseReflection: boolean; grpcServerName: string; grpcIncludeDefaultValues: boolean; grpcMaxResponseMessageSizeMb: number;
};
export type RequestSettingsOverrides = Partial<Record<keyof RequestSettings, boolean>>;
export type ProxyMode = 'off' | 'on' | 'system';
export type ProxyProtocol = 'http' | 'https' | 'socks5';
export type ProxyAuth = { enabled: boolean; username: string; password: string };
export type ProxyConfig = {
  mode: ProxyMode;
  protocol: ProxyProtocol;
  hostname: string;
  port: number;
  auth: ProxyAuth;
  bypass: string;
};
export type RequestExampleSnapshot = {
  method: Method; url: string;
  params: KVRow[]; headers: KVRow[];
  bodyType: BodyType; bodyContent: string;
};
export type RequestExampleResponse = {
  statusCode: number; status: string;
  headers: KVRow[];
  body: string;
  bodyMediaType: string;
  durationMs?: number;
};
export type RequestExampleMatch = { pathTemplate: string; query?: Record<string, string> };
export type RequestExampleSource = 'captured' | 'manual' | 'openapi' | 'postman';
export type RequestExample = {
  id: string; requestId: string; name: string; filesystemName: string;
  source: RequestExampleSource;
  createdAt: number;
  notes?: string;
  snapshot: RequestExampleSnapshot;
  response: RequestExampleResponse;
  match: RequestExampleMatch;
};
export type SavedRequest = {
  id: string; name: string; filesystemName: string; nameAuto?: boolean; requestType?: RequestType; isDraft?: boolean; isPinned?: boolean; collectionId: string; collection: string;
  workspaceDiagnostics?: WorkspaceDiagnostic[];
  isInvalid?: boolean;
  folderPath: string[]; method: Method; url: string; requestTab: RequestTab;
  params: KVRow[]; pathParams?: KVRow[]; headers: KVRow[];
  auth: AuthState;
  bodyType: BodyType; rawBodyType: RawBodyType; bodyContent: string;
  bodyFilePath: string; bodyFileName: string; formRows: KVRow[];
  graphqlSchema?: string;
  preRequestScript: string; testScript: string; preRequestScriptJs?: string; testScriptJs?: string; requestNotes: string; settings: RequestSettings; settingsOverrides?: RequestSettingsOverrides;
  sioEvents?: KVRow[];
  sioEventName?: string;
  sioArgs?: SIOArg[];
  sioAck?: boolean;
  grpcMethod?: string;
  grpcMetadata?: KVRow[];
  grpcUseReflection?: boolean;
  grpcProtoFilePath?: string;
  grpcProtoFileName?: string;
  grpcProtoImportPaths?: string[];
  mcpMethod?: string;
  mcpName?: string;
  mcpArguments?: string;
  mcpProtocolVersion?: string;
  aiProvider?: string;
  aiModel?: string;
  aiSystem?: string;
  aiPrompt?: string;
  aiTemperature?: string;
  aiTopP?: string;
  aiMaxTokens?: string;
  aiMaxSteps?: string;
  aiIdleTimeoutSec?: string;
  aiThinking?: string;
  aiStream?: boolean;
  aiToolRequestIds?: string[];
  examples?: RequestExample[];
};

export type GrpcMethodInfo = {
  fullName: string;
  service: string;
  name: string;
  requestType: string;
  responseType: string;
  exampleMessage: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
};
export type GrpcServiceDefinition = {
  source: string;
  services: string[];
  methods: GrpcMethodInfo[];
  error?: string;
};
export type GrpcMessage = {
  index: number;
  direction?: 'incoming' | 'outgoing' | string;
  body: string;
  size: number;
  timestamp: number;
};
export type GrpcResponse = {
  grpcCode: string;
  grpcMessage: string;
  status: string;
  headers: KeyValue[];
  trailers: KeyValue[];
  messages: GrpcMessage[];
  body: string;
  duration: number;
  size: number;
  timestamp?: number;
  error?: string;
  method: GrpcMethodInfo;
  preRequestResult: ScriptResult;
  testResult: ScriptResult;
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
export type CollectionRunnerStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'skipped';
export type CollectionRunnerTestResult = { name: string; passed: boolean; error?: string };
export type CollectionRunnerResult = {
  runId: string; requestId: string; iteration: number; name: string; method: string; url: string; status: CollectionRunnerStatus;
  statusCode: number; duration: number; testsPassed: number; testsTotal: number; error: string; tests?: CollectionRunnerTestResult[];
};
export type RequestHistoryEntry = {
  id: string; request: SavedRequest; statusCode: number; status: string;
  sourceRequestId?: string;
  duration: number; createdAt: number;
  responseStored?: boolean;
  responseSize?: number;
  responseContentType?: string;
  responseTruncated?: boolean;
};
export type RequestStore = {
  version: number; activeId: string; activeWorkspaceId: string; activeEnvironmentId?: string;
  openIds: string[]; folderCollapsed?: Record<string, boolean>;
  workspaces: Workspace[]; collections: Collection[]; environments?: Environment[];
  requests: SavedRequest[]; history?: RequestHistoryEntry[]; globals?: KVRow[];
  workspaceCookies?: Record<string, CookieJarEntry[]>;
  collectionRuns?: Record<string, import('../collectionRuns').CollectionRunRecord>;
};
export type FolderGroup = {
  key: string; path: string[]; name: string; requests: SavedRequest[];
  children: FolderGroup[]; collapsed: boolean; requestCount: number;
};
export type CollectionGroup = { collection: Collection; requests: SavedRequest[]; rootRequests: SavedRequest[]; folders: FolderGroup[] };
export type HistoryDayGroup = { key: string; label: string; entries: RequestHistoryEntry[]; collapsed: boolean };
export type RenderedSnippetLine = { number: number; html: string };

export type PersistRequestStore = (
  nextRequests?: SavedRequest[],
  activeId?: string,
  nextOpenIds?: string[],
  nextWorkspaces?: Workspace[],
  nextCollections?: Collection[],
  workspaceId?: string,
  nextHistory?: RequestHistoryEntry[],
  nextEnvironments?: Environment[],
  nextActiveEnvId?: string,
) => Promise<boolean>;
