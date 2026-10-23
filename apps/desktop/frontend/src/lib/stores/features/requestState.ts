import { sseDisconnect, socketIODisconnect, webSocketDisconnect } from '../../backend';
import type { HttpResponse } from '../../backend';
import { normalizeRequestSettingsOverrides } from '../../collectionDefaults';
import {
  DEFAULT_GRAPHQL_QUERY,
  DEFAULT_GRAPHQL_VARIABLES,
} from '../../graphql';
import { cloneRequestExample } from '../../examples';
import { AI_DEFAULT_PRESET, aiDefaultAuthFor } from './ai';
import { filesystemNameFromName, normalizeSavedRequest, normalizeSioArgs } from '../../normalizers';
import { pathParamsFromUrl } from '../../pathParams';
import {
  defaultBodyContentFor,
  defaultSocketIOArgs,
  requestBodyDefaultsFor,
} from '../../requestBodyDefaults';
import type {
  AuthState,
  AuthType,
  BodyType,
  Collection,
  GrpcResponse,
  GrpcResponseTab,
  KVRow,
  Method,
  OAuth2GrantType,
  OAuth2ClientAuth,
  RawBodyType,
  RequestExample,
  RequestSettings,
  RequestSettingsOverrides,
  RequestTab,
  RequestType,
  ResponseTab,
  SIOArg,
  SSESession,
  SavedRequest,
  SocketIOSession,
  WebSocketSession,
} from '../../types/models';
import {
  cloneRowsForStore,
  emptyAuthState,
  inheritAuthState,
  newRequestId,
  restoreRows,
  rowHasContent,
} from '../../utils';

type RequestStateHost = {
  activeRequestId: string;
  activeWorkspaceId: string;
  apiKeyIn: 'header' | 'query';
  apiKeyName: string;
  apiKeyValue: string;
  applyingSavedRequest: boolean;
  authType: AuthType;
  awsAccessKey: string;
  awsRegion: string;
  awsSecretKey: string;
  awsSessionToken: string;
  awsService: string;
  basicPass: string;
  basicUser: string;
  bearerToken: string;
  bodyContent: string;
  bodyFileName: string;
  bodyFilePath: string;
  bodyType: BodyType;
  collections: Collection[];
  formRows: KVRow[];
  graphqlOperationName: string;
  graphqlQuery: string;
  graphqlSchema: string;
  graphqlSchemaError: string;
  graphqlSchemaLoading: boolean;
  graphqlSchemaOperationToken: number;
  graphqlSchemaStatus: string;
  graphqlVariables: string;
  grpcMetadata: KVRow[];
  grpcMethod: string;
  mcpMethod: string;
  mcpName: string;
  mcpArguments: string;
  mcpProtocolVersion: string;
  aiProvider: string;
  aiModel: string;
  aiSystem: string;
  aiPrompt: string;
  aiTemperature: string;
  aiTopP: string;
  aiMaxTokens: string;
  aiMaxSteps: string;
  aiIdleTimeoutSec: string;
  aiThinking: string;
  aiStream: boolean;
  aiToolRequestIds: string[];
  grpcProtoFileName: string;
  grpcProtoFilePath: string;
  grpcProtoImportPaths: string[];
  grpcResponse: GrpcResponse | null;
  grpcResponseTab: GrpcResponseTab;
  grpcResponseTabs: Map<string, GrpcResponseTab>;
  grpcResponses: Map<string, GrpcResponse>;
  grpcServiceLoading: boolean;
  grpcServiceOperationToken: number;
  grpcUseReflection: boolean;
  inFlightRequestIds: Set<string>;
  method: Method;
  oauth2ClientID: string;
  oauth2GrantType: OAuth2GrantType;
  oauth2AuthURL: string;
  oauth2DeviceAuthURL: string;
  oauth2Scope: string;
  oauth2Audience: string;
  oauth2Secret: string;
  oauth2Token: string;
  oauth2TokenURL: string;
  oauth2RefreshToken: string;
  oauth2TokenExpiry: number;
  oauth2UsePKCE: boolean;
  oauth2Username: string;
  oauth2Password: string;
  oauth2ClientAuth: OAuth2ClientAuth;
  oauth2AssertionAlgorithm: string;
  oauth2AssertionPrivateKey: string;
  oauth2AssertionKeyID: string;
  oauth2AssertionAudience: string;
  params: KVRow[];
  pathParams: KVRow[];
  preRequestScript: string;
  preRequestScriptJs: string;
  rawBodyType: RawBodyType;
  reqHeaders: KVRow[];
  requestError: string;
  requestName: string;
  requestNameAuto: boolean;
  requestNotes: string;
  requestExamples: RequestExample[];
  selectedExampleId: string;
  requestSettingsOverrides: RequestSettingsOverrides;
  requestTab: RequestTab;
  requestType: RequestType;
  requests: SavedRequest[];
  requestsById: Map<string, SavedRequest>;
  response: HttpResponse | null;
  responseBodyPage: number;
  responseSearchIndex: number;
  responseTab: ResponseTab;
  responseTabs: Map<string, ResponseTab>;
  responses: Map<string, HttpResponse>;
  sioAck: boolean;
  sioArgs: SIOArg[];
  sioEventName: string;
  sioEvents: KVRow[];
  sioSelectedArgId: string;
  socketIOSessions: Map<string, SocketIOSession>;
  sseSessions: Map<string, SSESession>;
  testScript: string;
  testScriptJs: string;
  topView: string;
  url: string;
  webSocketSessions: Map<string, WebSocketSession>;
  activeCollectionId: () => string;
  authForPersistence: (auth: AuthState) => AuthState;
  authStateHasData: (auth: AuthState, type?: AuthType) => boolean;
  collectionNameById: (id: string) => string;
  currentAuthState: () => AuthState;
  currentRequestSettings: () => RequestSettings;
  currentRequestSettingsOverrides: () => RequestSettingsOverrides;
  defaultCollectionForWorkspace: (workspaceId?: string) => Collection | undefined;
  graphQLBodyContentForStore: () => string;
  graphQLPayloadFromRequest: (req: Pick<SavedRequest, 'bodyContent'>) => { query: string; variables: string; operationName: string };
  graphQLPayloadHasContent: (bodyContent: string) => boolean;
  normalizeRequestTypeValue: (value: unknown, url?: string) => RequestType;
  restoreSioEventRows: (rows: KVRow[] | undefined) => KVRow[];
  savedRequestIsWebSocket: (req: Pick<SavedRequest, 'requestType' | 'url'>) => boolean;
  snapshotRequestName: () => string;
  applyRequestSettings: (settings: Partial<RequestSettings>) => void;
};

export const requestStateFeature = {
  requestEditSignal(this: RequestStateHost): string {
    void this.bodyContent; void this.graphqlSchema; void this.graphqlQuery;
    void this.graphqlVariables; void this.preRequestScript; void this.testScript; void this.preRequestScriptJs; void this.testScriptJs;
    void this.requestNotes; void this.url; void this.requestName;
    return JSON.stringify({
      id: this.activeRequestId, requestType: this.requestType,
      requestNameAuto: this.requestNameAuto, method: this.method,
      params: this.params, pathParams: this.pathParams, reqHeaders: this.reqHeaders,
	      auth: this.currentAuthState(),
	      bodyType: this.bodyType, rawBodyType: this.rawBodyType,
	      bodyFilePath: this.bodyFilePath, bodyFileName: this.bodyFileName, formRows: this.formRows,
	      settings: this.currentRequestSettings(),
	      settingsOverrides: this.currentRequestSettingsOverrides(),
	      sioEvents: this.sioEvents, sioEventName: this.sioEventName,
      sioArgs: this.sioArgs, sioAck: this.sioAck,
      grpcMethod: this.grpcMethod, grpcMetadata: this.grpcMetadata,
      grpcUseReflection: this.grpcUseReflection, grpcProtoFilePath: this.grpcProtoFilePath,
      grpcProtoFileName: this.grpcProtoFileName, grpcProtoImportPaths: this.grpcProtoImportPaths,
      mcpMethod: this.mcpMethod, mcpName: this.mcpName,
      mcpArguments: this.mcpArguments, mcpProtocolVersion: this.mcpProtocolVersion,
      aiProvider: this.aiProvider, aiModel: this.aiModel, aiSystem: this.aiSystem, aiPrompt: this.aiPrompt,
      aiTemperature: this.aiTemperature, aiTopP: this.aiTopP, aiMaxTokens: this.aiMaxTokens, aiMaxSteps: this.aiMaxSteps, aiIdleTimeoutSec: this.aiIdleTimeoutSec,
      aiThinking: this.aiThinking, aiStream: this.aiStream, aiToolRequestIds: this.aiToolRequestIds,
      graphqlOperationName: this.graphqlOperationName,
      examples: this.requestExamples.map(
        example => `${example.id}:${example.name}:${example.response.statusCode}:${example.response.body.length}:${example.notes ?? ''}`,
      ),
    });
  },

  markRequestLoading(this: RequestStateHost, requestId: string, loading: boolean) {
    if (!requestId) return;
    const next = new Set(this.inFlightRequestIds);
    if (loading) next.add(requestId);
    else next.delete(requestId);
    this.inFlightRequestIds = next;
  },

  requestIsActive(this: RequestStateHost, requestId: string) {
    return requestId === this.activeRequestId && this.topView === 'request';
  },

  blankSavedRequest(this: RequestStateHost, collectionId = this.activeCollectionId(), requestType: RequestType = 'http'): SavedRequest {
    const resolved = collectionId || this.defaultCollectionForWorkspace()?.id || '';
    const normalizedType = this.normalizeRequestTypeValue(requestType);
    const isRealtime = normalizedType === 'ws' || normalizedType === 'socketio';
    const isGraphQL = normalizedType === 'graphql';
    const isGrpc = normalizedType === 'grpc';
    const isMcp = normalizedType === 'mcp';
    const isAi = normalizedType === 'ai';
    const bodyDefaults = requestBodyDefaultsFor(normalizedType);
    const settings = this.currentRequestSettings();
    const id = newRequestId();
    const aiAuth = aiDefaultAuthFor();
    return { id, name: 'New Request', filesystemName: filesystemNameFromName('New Request', id), nameAuto: true, requestType: normalizedType, isPinned: false, collectionId: resolved, collection: this.collectionNameById(resolved), folderPath: [], method: isGraphQL || isGrpc || isMcp || isAi ? 'POST' : 'GET', url: isAi ? AI_DEFAULT_PRESET.url : '', requestTab: isMcp || isGrpc || isAi ? 'body' : isRealtime ? 'body' : isGraphQL ? 'query' : 'params', params: [], pathParams: [], headers: [], auth: isAi ? { ...emptyAuthState(), ...aiAuth } : resolved ? inheritAuthState() : emptyAuthState(), bodyType: bodyDefaults.bodyType, rawBodyType: bodyDefaults.rawBodyType, bodyContent: bodyDefaults.bodyContent, bodyFilePath: bodyDefaults.bodyFilePath, bodyFileName: bodyDefaults.bodyFileName, formRows: bodyDefaults.formRows, graphqlSchema: '', preRequestScript: '', testScript: '', preRequestScriptJs: '', testScriptJs: '', requestNotes: '', settings, settingsOverrides: {}, sioEvents: [], sioEventName: '', sioArgs: defaultSocketIOArgs(), sioAck: false, grpcMethod: '', mcpMethod: isMcp ? 'tools/list' : '', mcpName: '', mcpArguments: '', mcpProtocolVersion: '', aiProvider: isAi ? AI_DEFAULT_PRESET.provider : '', aiModel: '', aiSystem: '', aiPrompt: '', aiTemperature: '', aiTopP: '', aiMaxTokens: '', aiMaxSteps: '', aiIdleTimeoutSec: '', aiThinking: '', aiStream: true, aiToolRequestIds: [], grpcMetadata: [], grpcUseReflection: settings.grpcUseReflection, grpcProtoFilePath: '', grpcProtoFileName: '', grpcProtoImportPaths: [] };
  },

  snapshotActiveRequest(this: RequestStateHost, options: { forPersistence?: boolean } = {}): SavedRequest {
    const existing = this.requestsById.get(this.activeRequestId);
    const collectionId = existing?.isDraft ? '' : existing?.collectionId || this.activeCollectionId();
    const normalizedType = this.normalizeRequestTypeValue(this.requestType, this.url);
    const isGraphQL = normalizedType === 'graphql';
    const isGrpc = normalizedType === 'grpc';
    const auth = this.currentAuthState();
    const id = this.activeRequestId || newRequestId();
    return {
      id,
      name: this.snapshotRequestName(),
      filesystemName: existing?.filesystemName || filesystemNameFromName(this.snapshotRequestName(), id),
      nameAuto: this.requestNameAuto,
      requestType: normalizedType,
      isDraft: existing?.isDraft ?? false,
      isPinned: existing?.isPinned ?? false,
      collectionId,
      collection: collectionId ? this.collectionNameById(collectionId) : '',
      folderPath: [...(existing?.folderPath ?? [])], method: isGraphQL || isGrpc ? 'POST' : this.method, url: this.url,
      requestTab: this.requestTab, params: cloneRowsForStore(this.params), pathParams: cloneRowsForStore(this.pathParams), headers: cloneRowsForStore(this.reqHeaders),
      auth: options.forPersistence ? this.authForPersistence(auth) : auth,
      bodyType: isGraphQL ? 'graphql' : this.bodyType, rawBodyType: isGraphQL ? 'json' : this.rawBodyType, bodyContent: isGraphQL ? this.graphQLBodyContentForStore() : this.bodyContent,
      bodyFilePath: this.bodyFilePath, bodyFileName: this.bodyFileName,
      formRows: cloneRowsForStore(this.formRows), graphqlSchema: isGraphQL ? this.graphqlSchema : '',
      preRequestScript: this.preRequestScript, testScript: this.testScript,
      preRequestScriptJs: this.preRequestScriptJs, testScriptJs: this.testScriptJs,
      requestNotes: this.requestNotes,
      ...(this.requestExamples.length ? { examples: this.requestExamples.map(cloneRequestExample) } : {}),
      settings: this.currentRequestSettings(),
      settingsOverrides: this.currentRequestSettingsOverrides(),
      sioEvents: cloneRowsForStore(this.sioEvents),
      sioEventName: this.sioEventName,
      sioArgs: this.sioArgs.map(a => ({ ...a })),
      sioAck: this.sioAck,
      grpcMethod: this.grpcMethod,
      mcpMethod: this.mcpMethod,
      mcpName: this.mcpName,
      mcpArguments: this.mcpArguments,
      mcpProtocolVersion: this.mcpProtocolVersion,
      aiProvider: this.aiProvider,
      aiModel: this.aiModel,
      aiSystem: this.aiSystem,
      aiPrompt: this.aiPrompt,
      aiTemperature: this.aiTemperature,
      aiTopP: this.aiTopP,
      aiMaxTokens: this.aiMaxTokens,
      aiMaxSteps: this.aiMaxSteps,
      aiIdleTimeoutSec: this.aiIdleTimeoutSec,
      aiThinking: this.aiThinking,
      aiStream: this.aiStream,
      aiToolRequestIds: [...(this.aiToolRequestIds ?? [])],
      grpcMetadata: cloneRowsForStore(this.grpcMetadata),
      grpcUseReflection: this.grpcUseReflection,
      grpcProtoFilePath: this.grpcProtoFilePath,
      grpcProtoFileName: this.grpcProtoFileName,
      grpcProtoImportPaths: [...this.grpcProtoImportPaths],
    };
  },

  currentRequestName(this: RequestStateHost) {
    if (!this.requestNameAuto) return this.requestName.trim() || 'New Request';
    return 'New Request';
  },

  snapshotRequestName(this: RequestStateHost) {
    if (!this.requestNameAuto) return this.requestName.trim() || 'New Request';
    return 'New Request';
  },

  requestHasContent(this: RequestStateHost, req: SavedRequest) {
    const hasName = req.name && req.name !== 'New Request';
    const hasUrl = req.url.trim();
    const requestType = this.normalizeRequestTypeValue(req.requestType, req.url);
    const hasBodyContent = req.bodyContent.trim() || req.bodyFilePath || req.bodyFileName || req.formRows.some(rowHasContent);
    const hasSharedContent =
      req.params.some(rowHasContent) || (req.pathParams ?? []).some(r => r.value.trim()) || req.headers.some(rowHasContent) ||
      this.authStateHasData(req.auth, req.auth.type) || req.preRequestScript.trim() || req.testScript.trim() ||
      req.requestNotes.trim();
    if (requestType === 'ws') {
      return Boolean(hasName || hasUrl || hasBodyContent || hasSharedContent);
    }
    if (requestType === 'socketio') {
      const hasSocketIOContent =
        (req.sioEvents ?? []).some(rowHasContent) ||
        Boolean(req.sioEventName?.trim()) ||
        Boolean((req.sioArgs ?? []).some(arg => arg.content.trim())) ||
        Boolean(req.sioAck);
      return Boolean(hasName || hasUrl || hasBodyContent || hasSharedContent || hasSocketIOContent);
    }
    if (requestType === 'mcp') {
      const hasMcpContent =
        Boolean(req.mcpName?.trim()) ||
        Boolean(req.mcpArguments?.trim()) ||
        Boolean(req.mcpMethod?.trim() && req.mcpMethod !== 'tools/list');
      return Boolean(hasName || hasUrl || hasSharedContent || hasMcpContent);
    }
    if (requestType === 'ai') {
      const hasAiContent =
        Boolean(req.aiPrompt?.trim()) ||
        Boolean(req.aiSystem?.trim()) ||
        Boolean(req.aiModel?.trim()) ||
        Boolean((req.aiToolRequestIds ?? []).length);
      return Boolean(hasName || hasSharedContent || hasAiContent);
    }
    if (requestType === 'grpc') {
      const hasGrpcContent =
        Boolean(req.grpcMethod?.trim()) ||
        Boolean((req.grpcMetadata ?? []).some(rowHasContent)) ||
        Boolean(req.grpcProtoFilePath?.trim()) ||
        Boolean(req.grpcUseReflection === false);
      return Boolean(hasName || hasUrl || hasBodyContent || hasSharedContent || hasGrpcContent);
    }
    if (requestType === 'graphql') {
      return Boolean(hasName || hasUrl || this.graphQLPayloadHasContent(req.bodyContent) || req.graphqlSchema?.trim() || hasSharedContent);
    }
    return Boolean(
      hasName || req.method !== 'GET' || hasUrl ||
      req.bodyType !== 'none' || hasBodyContent || hasSharedContent
    );
  },

  applySavedRequest(this: RequestStateHost, req: SavedRequest) {
    this.applyingSavedRequest = true; this.activeRequestId = req.id;
    this.graphqlSchemaOperationToken += 1; this.graphqlSchemaLoading = false;
    this.grpcServiceOperationToken += 1; this.grpcServiceLoading = false;
    this.requestType = this.normalizeRequestTypeValue(req.requestType, req.url);
    this.requestNameAuto = req.nameAuto ?? (!req.name || req.name === 'New Request');
    this.requestName = this.requestNameAuto ? '' : req.name;
    this.method = this.requestType === 'graphql' || this.requestType === 'grpc' ? 'POST' : req.method; this.url = req.url; this.requestTab = req.requestTab ?? (this.requestType === 'graphql' ? 'query' : this.requestType === 'grpc' ? 'body' : 'params');
    if (this.requestType === 'graphql' && !['docs', 'query', 'auth', 'headers', 'schema', 'scripts'].includes(this.requestTab)) this.requestTab = 'query';
    if (this.requestType === 'ws' && !['docs', 'body', 'params', 'headers', 'settings'].includes(this.requestTab)) this.requestTab = 'body';
    if (this.requestType === 'socketio' && !['docs', 'body', 'events', 'params', 'headers', 'settings'].includes(this.requestTab)) this.requestTab = 'body';
    if (this.requestType === 'grpc' && !['docs', 'body', 'auth', 'metadata', 'service', 'scripts', 'settings'].includes(this.requestTab)) this.requestTab = 'body';
    if (this.requestType === 'ai' && !['docs', 'body', 'auth', 'headers', 'tools', 'scripts', 'settings'].includes(this.requestTab)) this.requestTab = 'body';
    this.sioEvents = this.restoreSioEventRows(req.sioEvents ?? []);
    this.sioEventName = req.sioEventName ?? '';
    this.sioArgs = normalizeSioArgs(req.sioArgs);
    this.sioSelectedArgId = this.sioArgs[0]?.id ?? '1';
    this.sioAck = req.sioAck ?? false;
    this.grpcMethod = req.grpcMethod ?? '';
    this.mcpMethod = req.mcpMethod || (this.requestType === 'mcp' ? 'tools/list' : '');
    this.mcpName = req.mcpName ?? '';
    this.mcpArguments = req.mcpArguments ?? '';
    this.mcpProtocolVersion = req.mcpProtocolVersion ?? '';
    this.aiProvider = req.aiProvider || (this.requestType === 'ai' ? 'openai' : '');
    this.aiModel = req.aiModel ?? '';
    this.aiSystem = req.aiSystem ?? '';
    this.aiPrompt = req.aiPrompt ?? '';
    this.aiTemperature = req.aiTemperature ?? '';
    this.aiTopP = req.aiTopP ?? '';
    this.aiMaxTokens = req.aiMaxTokens ?? '';
    this.aiMaxSteps = req.aiMaxSteps ?? '';
    this.aiIdleTimeoutSec = req.aiIdleTimeoutSec ?? '';
    this.aiThinking = req.aiThinking ?? '';
    this.aiStream = req.aiStream ?? true;
    this.aiToolRequestIds = [...(req.aiToolRequestIds ?? [])];
    this.grpcMetadata = restoreRows(req.grpcMetadata ?? []);
    this.grpcUseReflection = req.settings.grpcUseReflection ?? req.grpcUseReflection ?? true;
    this.grpcProtoFilePath = req.grpcProtoFilePath ?? '';
    this.grpcProtoFileName = req.grpcProtoFileName ?? '';
    this.grpcProtoImportPaths = [...(req.grpcProtoImportPaths ?? [])];
    this.params = restoreRows(req.params); this.pathParams = pathParamsFromUrl(req.url, restoreRows(req.pathParams)); this.reqHeaders = restoreRows(req.headers); this.formRows = restoreRows(req.formRows);
    this.authType = req.auth.type; this.bearerToken = req.auth.bearerToken; this.basicUser = req.auth.basicUser; this.basicPass = req.auth.basicPass;
    this.apiKeyName = req.auth.apiKeyName; this.apiKeyValue = req.auth.apiKeyValue; this.apiKeyIn = req.auth.apiKeyIn;
    this.oauth2TokenURL = req.auth.oauth2TokenURL; this.oauth2ClientID = req.auth.oauth2ClientID; this.oauth2Secret = req.auth.oauth2Secret;
    this.oauth2Scope = req.auth.oauth2Scope; this.oauth2Token = req.auth.oauth2Token;
    this.oauth2GrantType = req.auth.oauth2GrantType ?? 'client_credentials'; this.oauth2AuthURL = req.auth.oauth2AuthURL ?? '';
    this.oauth2DeviceAuthURL = req.auth.oauth2DeviceAuthURL ?? ''; this.oauth2Audience = req.auth.oauth2Audience ?? '';
    this.oauth2RefreshToken = req.auth.oauth2RefreshToken ?? ''; this.oauth2TokenExpiry = req.auth.oauth2TokenExpiry ?? 0; this.oauth2UsePKCE = req.auth.oauth2UsePKCE ?? true;
    this.oauth2Username = req.auth.oauth2Username ?? ''; this.oauth2Password = req.auth.oauth2Password ?? '';
    this.oauth2ClientAuth = req.auth.oauth2ClientAuth ?? 'basic';
    this.oauth2AssertionAlgorithm = req.auth.oauth2AssertionAlgorithm ?? ''; this.oauth2AssertionPrivateKey = req.auth.oauth2AssertionPrivateKey ?? '';
    this.oauth2AssertionKeyID = req.auth.oauth2AssertionKeyID ?? ''; this.oauth2AssertionAudience = req.auth.oauth2AssertionAudience ?? '';
    this.awsAccessKey = req.auth.awsAccessKey; this.awsSecretKey = req.auth.awsSecretKey; this.awsSessionToken = req.auth.awsSessionToken ?? ''; this.awsRegion = req.auth.awsRegion; this.awsService = req.auth.awsService;
    if (this.requestType === 'grpc' && !['none', 'apikey', 'basic', 'bearer', 'oauth2'].includes(this.authType)) this.authType = 'none';
    if (this.requestType === 'grpc') this.apiKeyIn = 'header';
    if (this.requestType === 'graphql') {
      const graphql = this.graphQLPayloadFromRequest(req);
      this.bodyType = 'graphql'; this.rawBodyType = 'json'; this.bodyContent = req.bodyContent || defaultBodyContentFor('graphql');
      this.graphqlQuery = graphql.query; this.graphqlVariables = graphql.variables; this.graphqlOperationName = graphql.operationName;
      this.graphqlSchema = req.graphqlSchema ?? '';
      this.graphqlSchemaStatus = ''; this.graphqlSchemaError = '';
    } else if (this.requestType === 'grpc') {
      this.bodyType = 'json'; this.rawBodyType = 'json'; this.bodyContent = req.bodyContent || defaultBodyContentFor('grpc');
      this.graphqlQuery = DEFAULT_GRAPHQL_QUERY; this.graphqlVariables = DEFAULT_GRAPHQL_VARIABLES;
      this.graphqlOperationName = ''; this.graphqlSchema = '';
      this.graphqlSchemaStatus = ''; this.graphqlSchemaError = '';
    } else {
      this.bodyType = req.bodyType; this.rawBodyType = req.rawBodyType; this.bodyContent = req.bodyContent;
      this.graphqlQuery = DEFAULT_GRAPHQL_QUERY; this.graphqlVariables = DEFAULT_GRAPHQL_VARIABLES;
      this.graphqlOperationName = ''; this.graphqlSchema = '';
      this.graphqlSchemaStatus = ''; this.graphqlSchemaError = '';
    }
    this.bodyFilePath = req.bodyFilePath; this.bodyFileName = req.bodyFileName;
    this.preRequestScript = req.preRequestScript; this.testScript = req.testScript;
    this.preRequestScriptJs = req.preRequestScriptJs ?? ''; this.testScriptJs = req.testScriptJs ?? '';
    this.requestNotes = req.requestNotes ?? '';
    this.requestExamples = (req.examples ?? []).map(cloneRequestExample);
    this.selectedExampleId = this.requestExamples[0]?.id ?? '';
    this.applyRequestSettings(req.settings);
    this.requestSettingsOverrides = normalizeRequestSettingsOverrides(req.settingsOverrides, req.settings, this.collections.find(collection => collection.id === req.collectionId)?.defaults?.settings);
    this.response = this.requestType !== 'grpc' ? (this.responses.get(req.id) ?? null) : null;
    this.responseTab = this.requestType !== 'grpc' ? (this.responseTabs.get(req.id) ?? 'body') : 'body';
    this.responseBodyPage = 0;
    this.responseSearchIndex = 0;
    this.grpcResponse = this.requestType === 'grpc' ? (this.grpcResponses.get(req.id) ?? null) : null;
    this.grpcResponseTab = this.requestType === 'grpc' ? (this.grpcResponseTabs.get(req.id) ?? 'messages') : 'messages';
    this.requestError = '';
    if (req.method !== 'SSE' && this.sseSessions.has(req.id)) {
      void sseDisconnect(req.id);
    }
    if (!this.savedRequestIsWebSocket(req) && this.webSocketSessions.has(req.id)) {
      void webSocketDisconnect(req.id);
    }
    if (this.normalizeRequestTypeValue(req.requestType, req.url) !== 'socketio' && this.socketIOSessions.has(req.id)) {
      void socketIODisconnect(req.id);
    }
    queueMicrotask(() => { this.applyingSavedRequest = false; });
  },

  normalizeSavedRequestCtx(this: RequestStateHost, input: Partial<SavedRequest>): SavedRequest {
    return normalizeSavedRequest(input, this.collections, this.activeWorkspaceId);
  },
};
