import { grpcDiscover, openDirectoryDialog, openFileDialog, sendGrpcRequest } from '../../backend';
import { emptyHttpResponse, emptyScriptResult } from '../../wire';
import type { GrpcRequest, HttpResponse } from '../../backend';
import { DEFAULT_GRPC_MESSAGE } from '../../requestBodyDefaults';
import type {
  AuthType,
  BodyType,
  GrpcDoneEvent,
  GrpcHeadersEvent,
  GrpcMessage,
  GrpcMessageEvent,
  GrpcMethodInfo,
  GrpcResponse,
  GrpcResponseTab,
  GrpcServiceDefinition,
  GrpcTrailersEvent,
  RequestTab,
  RequestType,
  RawBodyType,
  SavedRequest,
} from '../../types/models';
import { newRequestId } from '../../utils';

const REQUEST_CANCELED_ERROR = 'Request canceled';

type GrpcHost = {
  activeRequestId: string;
  authType: AuthType;
  bearerToken: string;
  beautifiedBody: boolean;
  bodyContent: string;
  bodyType: BodyType;
  grpcMethod: string;
  grpcProtoFileName: string;
  grpcProtoFilePath: string;
  grpcProtoImportPaths: string[];
  grpcResponse: GrpcResponse | null;
  grpcResponseTab: GrpcResponseTab;
  grpcResponseTabs: Map<string, GrpcResponseTab>;
  grpcResponses: Map<string, GrpcResponse>;
  grpcServiceDefinition: GrpcServiceDefinition;
  grpcServiceError: string;
  grpcServiceLoading: boolean;
  grpcServiceOperationToken: number;
  grpcServiceStatus: string;
  grpcUseReflection: boolean;
  loading: boolean;
  rawBodyType: RawBodyType;
  requestError: string;
  requestTab: RequestTab;
  requestType: RequestType;
  responseSearch: string;
  responseSearchIndex: number;
  url: string;
  activeEnvironmentValues: () => Record<string, string>;
  activeSecretEnvironmentKeys: () => string[];
  activeSecretEnvironmentValues: () => string[];
  cancelActiveRequest: () => Promise<void>;
  discoverGrpcServices: () => Promise<void>;
  emptyGrpcResponse: () => GrpcResponse;
  environmentValuesForRequest: (req: Pick<SavedRequest, 'collectionId'>, envValues?: Record<string, string>) => Record<string, string>;
  applyGrpcDoneEvent: (payload: GrpcDoneEvent) => void;
  applyGrpcHeadersEvent: (payload: GrpcHeadersEvent) => void;
  applyGrpcMessageEvent: (payload: GrpcMessageEvent) => void;
  applyGrpcTrailersEvent: (payload: GrpcTrailersEvent) => void;
  grpcBodyFromMessages: (messages: GrpcMessage[]) => string;
  grpcEmptyMethodInfo: (fullName?: string) => GrpcMethodInfo;
  grpcExampleMessageForMethod: (fullName?: string) => string;
  grpcMethodIsReflection: (fullName: string) => boolean;
  grpcSelectableMethods: () => GrpcMethodInfo[];
  grpcSelectedMethodInfo: () => GrpcMethodInfo;
  ensureActiveGrpcResponse: (requestId: string) => GrpcResponse | null;
  guardWorkspaceWritable: (action?: string) => boolean;
  markRequestLoading: (requestId: string, loading: boolean) => void;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  recordRequestHistory: (httpResponse: HttpResponse, requestSnapshot?: SavedRequest) => Promise<void>;
  requestIsActive: (requestId: string) => boolean;
  savedRequestToRunnableGrpcRequest: (req: SavedRequest, envValues?: Record<string, string>, secretValues?: string[], secretKeys?: string[], requestId?: string) => GrpcRequest;
  setActiveGrpcResponse: (response: GrpcResponse | null, requestId?: string) => void;
  setActiveGrpcResponseTab: (tab: GrpcResponseTab, requestId?: string) => void;
  setActiveResponse: (response: HttpResponse | null, requestId?: string) => void;
  setGrpcProtoFilePath: (path: string, options?: { discover?: boolean }) => void;
  scheduleActiveRequestPersist: () => void;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  syncActiveEnvironmentFromBackend: () => Promise<void>;
  syncBackendEnvironment: () => Promise<void>;
  applyCollectionVariableUpdates: (
    req: Pick<SavedRequest, 'collectionId'>,
    updates: Record<string, string> | undefined,
    removed: string[] | undefined,
  ) => Promise<boolean>;
};

export const grpcFeature = {
  buildGrpcRequest(this: GrpcHost, envValues = this.activeEnvironmentValues(), secretEnvironmentValues = this.activeSecretEnvironmentValues(), requestId = this.activeRequestId) {
    const snapshot = this.snapshotActiveRequest();
    return this.savedRequestToRunnableGrpcRequest(snapshot, envValues, secretEnvironmentValues, this.activeSecretEnvironmentKeys(), requestId);
  },

  async importGrpcProtoFile(this: GrpcHost) {
    if (this.grpcServiceLoading) return;
    const path = await openFileDialog('Choose .proto file');
    if (!path) return;
    this.setGrpcProtoFilePath(path, { discover: false });
    this.grpcUseReflection = false;
    this.grpcServiceStatus = `Selected ${this.grpcProtoFileName}`;
    this.grpcServiceError = '';
    this.scheduleActiveRequestPersist();
    await this.discoverGrpcServices();
  },

  setGrpcProtoFilePath(this: GrpcHost, path: string, options: { discover?: boolean } = {}) {
    const nextPath = path.trim();
    this.grpcProtoFilePath = nextPath;
    this.grpcProtoFileName = nextPath ? (nextPath.split(/[\\/]/).pop() ?? nextPath) : '';
    if (nextPath) this.grpcUseReflection = false;
    this.grpcServiceError = '';
    if (!nextPath) {
      this.grpcServiceStatus = '';
      this.grpcServiceDefinition = { source: '', services: [], methods: [] };
    } else {
      this.grpcServiceStatus = `Selected ${this.grpcProtoFileName}`;
    }
    this.scheduleActiveRequestPersist();
    if (options.discover && nextPath) void this.discoverGrpcServices();
  },

  async addGrpcProtoImportPath(this: GrpcHost) {
    if (this.grpcServiceLoading) return;
    const path = await openDirectoryDialog('Add .proto import path');
    if (!path || this.grpcProtoImportPaths.includes(path)) return;
    this.grpcProtoImportPaths = [...this.grpcProtoImportPaths, path];
    this.grpcServiceStatus = `Added import path ${path.split('/').pop() ?? path}`;
    this.grpcServiceError = '';
    this.scheduleActiveRequestPersist();
    if (this.grpcProtoFilePath.trim()) await this.discoverGrpcServices();
  },

  async removeGrpcProtoImportPath(this: GrpcHost, index: number) {
    if (index < 0 || index >= this.grpcProtoImportPaths.length) return;
    this.grpcProtoImportPaths = this.grpcProtoImportPaths.filter((_, i) => i !== index);
    this.scheduleActiveRequestPersist();
    if (this.grpcProtoFilePath.trim()) await this.discoverGrpcServices();
  },

  clearGrpcProtoFile(this: GrpcHost) {
    this.grpcProtoFilePath = '';
    this.grpcProtoFileName = '';
    this.grpcProtoImportPaths = [];
    this.grpcServiceDefinition = { source: '', services: [], methods: [] };
    this.grpcServiceStatus = '';
    this.grpcServiceError = '';
    this.scheduleActiveRequestPersist();
  },

  grpcSelectableMethods(this: GrpcHost): GrpcMethodInfo[] {
    return (this.grpcServiceDefinition.methods ?? []).filter(method => !this.grpcMethodIsReflection(method.fullName));
  },

  grpcMethodIsReflection(this: GrpcHost, fullName: string) {
    return /^grpc\.reflection\.v1(alpha)?\.ServerReflection\/ServerReflectionInfo$/i.test(fullName.trim());
  },

  grpcMethodLabel(this: GrpcHost, fullName = this.grpcMethod) {
    const method = (fullName || '').trim();
    if (!method) return '';
    const selected = this.grpcServiceDefinition.methods.find(item => item.fullName === method);
    const value = selected?.fullName || method;
    const [service = '', name = ''] = value.split('/');
    const serviceName = (selected?.service || service).split('.').filter(Boolean).pop() || service;
    return name ? `${serviceName} / ${name}` : value;
  },

  selectGrpcMethod(this: GrpcHost, fullName: string) {
    this.grpcMethod = fullName;
    this.requestError = '';
    this.scheduleActiveRequestPersist();
  },

  grpcExampleMessageForMethod(this: GrpcHost, fullName = this.grpcMethod) {
    const method = this.grpcServiceDefinition.methods.find(item => item.fullName === fullName);
    const example = method?.exampleMessage?.trim();
    if (example) return example;
    if (/grpc\.health\.v1\.Health\/Check/i.test(fullName) || /HealthCheckRequest$/i.test(method?.requestType ?? '')) {
      return '{\n  "service": ""\n}';
    }
    return DEFAULT_GRPC_MESSAGE;
  },

  useGrpcExampleMessage(this: GrpcHost) {
    this.bodyType = 'json';
    this.rawBodyType = 'json';
    this.bodyContent = this.grpcExampleMessageForMethod();
    this.beautifiedBody = false;
    this.scheduleActiveRequestPersist();
  },

  grpcEmptyMethodInfo(this: GrpcHost, fullName = this.grpcMethod): GrpcMethodInfo {
    const [service = '', name = ''] = fullName.split('/');
    return {
      fullName,
      service,
      name,
      requestType: '',
      responseType: '',
      exampleMessage: '',
      clientStreaming: false,
      serverStreaming: false,
    };
  },

  grpcSelectedMethodInfo(this: GrpcHost): GrpcMethodInfo {
    return this.grpcServiceDefinition.methods.find(method => method.fullName === this.grpcMethod)
      ?? this.grpcEmptyMethodInfo();
  },

  setActiveGrpcResponse(this: GrpcHost, response: GrpcResponse | null, requestId = this.activeRequestId) {
    this.grpcResponse = response;
    if (!requestId) return;
    const next = new Map(this.grpcResponses);
    if (response) next.set(requestId, response);
    else next.delete(requestId);
    this.grpcResponses = next;
  },

  setActiveGrpcResponseTab(this: GrpcHost, tab: GrpcResponseTab, requestId = this.activeRequestId) {
    this.grpcResponseTab = tab;
    if (!requestId) return;
    const next = new Map(this.grpcResponseTabs);
    next.set(requestId, tab);
    this.grpcResponseTabs = next;
  },

  emptyGrpcResponse(this: GrpcHost): GrpcResponse {
    return {
      grpcCode: 'STREAMING',
      grpcMessage: '',
      status: 'STREAMING',
      headers: [],
      trailers: [],
      messages: [],
      body: '',
      duration: 0,
      size: 0,
      timestamp: Date.now(),
      error: '',
      method: this.grpcSelectedMethodInfo(),
      preRequestResult: { tests: [] },
      testResult: { tests: [] },
    };
  },

  grpcBodyFromMessages(this: GrpcHost, messages: GrpcMessage[]) {
    const incoming = messages.filter(message => message.direction !== 'outgoing');
    if (!incoming.length) return '';
    if (incoming.length === 1) return incoming[0].body;
    return `[\n${incoming.map(message => message.body).join(',\n')}\n]`;
  },

  ensureActiveGrpcResponse(this: GrpcHost, requestId: string): GrpcResponse | null {
    if (!this.requestIsActive(requestId)) return null;
    if (this.grpcResponse) return this.grpcResponse;
    const response = this.emptyGrpcResponse();
    this.setActiveGrpcResponse(response, requestId);
    this.setActiveGrpcResponseTab('messages', requestId);
    return response;
  },

  applyGrpcHeadersEvent(this: GrpcHost, payload: GrpcHeadersEvent) {
    const existing = this.ensureActiveGrpcResponse(payload.requestId);
    if (!existing) return;
    this.setActiveGrpcResponse({
      ...existing,
      headers: payload.headers ?? [],
      method: payload.method?.fullName ? payload.method : existing.method,
      duration: payload.duration ?? existing.duration,
    }, payload.requestId);
  },

  applyGrpcMessageEvent(this: GrpcHost, payload: GrpcMessageEvent) {
    const existing = this.ensureActiveGrpcResponse(payload.requestId);
    if (!existing) return;
    const messages = existing.messages.some(message => message.index === payload.message.index)
      ? existing.messages
      : [...existing.messages, payload.message];
    this.setActiveGrpcResponse({
      ...existing,
      grpcCode: existing.grpcCode || 'STREAMING',
      status: existing.status || 'STREAMING',
      messages,
      body: this.grpcBodyFromMessages(messages),
      size: payload.size ?? messages.reduce((sum, message) => sum + message.size, 0),
      duration: payload.duration ?? existing.duration,
      timestamp: payload.timestamp ?? existing.timestamp,
    }, payload.requestId);
    if (this.grpcResponseTab !== 'messages' && !existing.testResult?.tests?.length) this.setActiveGrpcResponseTab('messages', payload.requestId);
  },

  applyGrpcTrailersEvent(this: GrpcHost, payload: GrpcTrailersEvent) {
    const existing = this.ensureActiveGrpcResponse(payload.requestId);
    if (!existing) return;
    this.setActiveGrpcResponse({
      ...existing,
      grpcCode: payload.grpcCode || existing.grpcCode,
      grpcMessage: payload.grpcMessage ?? existing.grpcMessage,
      status: payload.status || existing.status,
      trailers: payload.trailers ?? [],
      error: payload.error ?? existing.error,
      duration: payload.duration ?? existing.duration,
      timestamp: payload.timestamp ?? existing.timestamp,
    }, payload.requestId);
  },

  applyGrpcDoneEvent(this: GrpcHost, payload: GrpcDoneEvent) {
    if (!this.requestIsActive(payload.requestId)) return;
    const response = payload.response;
    const messages = response.messages ?? [];
    this.requestError = '';
    this.setActiveGrpcResponse({
      ...response,
      headers: response.headers ?? [],
      trailers: response.trailers ?? [],
      messages,
      body: response.body || this.grpcBodyFromMessages(messages),
      timestamp: response.timestamp || payload.timestamp,
      method: response.method?.fullName ? response.method : this.grpcSelectedMethodInfo(),
      preRequestResult: response.preRequestResult ?? { tests: [] },
      testResult: response.testResult ?? { tests: [] },
    }, payload.requestId);
    this.setActiveGrpcResponseTab(response.testResult?.tests?.length ? 'scripts' : 'messages', payload.requestId);
  },

  async discoverGrpcServices(this: GrpcHost) {
    if (this.requestType !== 'grpc' || this.grpcServiceLoading) return;
    if (!this.grpcUseReflection && !this.grpcProtoFilePath.trim()) {
      this.grpcServiceError = 'Choose a .proto file or enable server reflection.';
      return;
    }
    if (this.grpcUseReflection && !this.url.trim() && !this.grpcProtoFilePath.trim()) {
      this.grpcServiceError = 'Enter a gRPC target or choose a .proto file.';
      return;
    }
    const ownerId = this.activeRequestId;
    const operationToken = ++this.grpcServiceOperationToken;
    const stillOwned = () => this.activeRequestId === ownerId && this.grpcServiceOperationToken === operationToken;
    const requestId = `grpc-discover-${this.activeRequestId || newRequestId()}-${Date.now()}`;
    const snapshot = this.snapshotActiveRequest();
    const envValues = this.environmentValuesForRequest(snapshot);
    const secretValues = this.activeSecretEnvironmentValues();
    const secretKeys = this.activeSecretEnvironmentKeys();
    this.grpcServiceLoading = true;
    this.grpcServiceError = '';
    this.grpcServiceStatus = '';
    try {
      try { await this.syncBackendEnvironment(); } catch {}
      if (!stillOwned()) return;
      const result = await grpcDiscover(this.savedRequestToRunnableGrpcRequest(snapshot, envValues, secretValues, secretKeys, requestId));
      if (!stillOwned()) return;
      if (result.error) {
        this.grpcServiceError = result.error;
        return;
      }
      this.grpcServiceDefinition = {
        source: result.source,
        services: result.services ?? [],
        methods: result.methods ?? [],
      };
      const selectableMethods = this.grpcSelectableMethods();
      this.grpcServiceStatus = `${selectableMethods.length} method${selectableMethods.length === 1 ? '' : 's'} loaded`;
      if ((!this.grpcMethod || this.grpcMethodIsReflection(this.grpcMethod)) && selectableMethods.length === 1) {
        this.grpcMethod = selectableMethods[0].fullName;
        this.scheduleActiveRequestPersist();
      }
    } catch (error) {
      if (stillOwned()) this.grpcServiceError = error instanceof Error ? error.message : String(error);
    } finally {
      if (stillOwned()) this.grpcServiceLoading = false;
    }
  },

  async invokeGrpc(this: GrpcHost) {
    if (!this.guardWorkspaceWritable('Sending requests')) return;
    if (this.loading) {
      await this.cancelActiveRequest();
      return;
    }
    if (!this.url.trim()) return;
    if (!this.grpcMethod.trim()) {
      this.requestError = 'Select a gRPC method next to the target before invoking the request';
      this.setActiveGrpcResponse(null);
      this.requestTab = 'service';
      return;
    }
    if (this.authType === 'bearer' && !this.bearerToken.trim()) {
      this.requestError = 'Bearer token is empty — add a token in the Auth tab or change the auth type';
      return;
    }
    const requestSnapshot = this.snapshotActiveRequest();
    const envValues = this.activeEnvironmentValues();
    const secretValues = this.activeSecretEnvironmentValues();
    const secretKeys = this.activeSecretEnvironmentKeys();
    const requestId = this.activeRequestId || newRequestId();
    this.markRequestLoading(requestId, true);
    this.requestError = '';
    this.setActiveResponse(null, requestId);
    this.setActiveGrpcResponse(this.emptyGrpcResponse(), requestId);
    this.setActiveGrpcResponseTab('messages', requestId);
    this.responseSearch = '';
    this.responseSearchIndex = 0;
    try {
      await this.persistActiveRequestNow();
      try { await this.syncBackendEnvironment(); } catch {}
      const resp = await sendGrpcRequest(this.savedRequestToRunnableGrpcRequest(requestSnapshot, envValues, secretValues, secretKeys, requestId));
      try { await this.syncActiveEnvironmentFromBackend(); } catch {}
      try { await this.applyCollectionVariableUpdates(requestSnapshot, resp.collectionVariableUpdates, resp.collectionVariablesRemoved); } catch {}
      if (resp.error && !resp.grpcCode && !(resp.messages ?? []).length) {
        if (this.requestIsActive(requestId)) this.requestError = resp.error;
        if (resp.error !== REQUEST_CANCELED_ERROR) {
          await this.recordRequestHistory({
            ...emptyHttpResponse(),
            statusCode: 0,
            status: 'gRPC',
            error: resp.error,
            headers: resp.headers ?? [],
            body: resp.body ?? '',
            duration: resp.duration ?? 0,
            size: resp.size ?? 0,
            preRequestResult: resp.preRequestResult ?? emptyScriptResult(),
            testResult: resp.testResult ?? emptyScriptResult(),
          }, requestSnapshot);
        }
        return;
      }
      if (this.requestIsActive(requestId)) {
        this.requestError = '';
        this.setActiveGrpcResponse({
          ...resp,
          body: resp.body || this.grpcBodyFromMessages(resp.messages ?? []),
          timestamp: resp.timestamp || Date.now(),
          method: resp.method?.fullName ? resp.method : this.grpcSelectedMethodInfo(),
          preRequestResult: resp.preRequestResult ?? emptyScriptResult(),
          testResult: resp.testResult ?? emptyScriptResult(),
        }, requestId);
        this.setActiveGrpcResponseTab(resp.testResult?.tests?.length ? 'scripts' : 'messages', requestId);
      }
      await this.recordRequestHistory({
        ...emptyHttpResponse(),
        statusCode: resp.grpcCode === 'OK' ? 200 : 0,
        status: resp.grpcCode || 'gRPC',
        headers: resp.headers ?? [],
        body: resp.body ?? '',
        duration: resp.duration ?? 0,
        size: resp.size ?? 0,
        preRequestResult: resp.preRequestResult ?? emptyScriptResult(),
        testResult: resp.testResult ?? emptyScriptResult(),
      }, requestSnapshot);
    } catch (e) {
      if (this.requestIsActive(requestId)) this.requestError = String(e);
    } finally {
      this.markRequestLoading(requestId, false);
    }
  },

  initGrpcListeners(this: GrpcHost) {
    const runtime = window.runtime;
    if (!runtime?.EventsOn) return;

    runtime.EventsOn('grpc:headers', (payload: GrpcHeadersEvent) => {
      this.applyGrpcHeadersEvent(payload);
    });

    runtime.EventsOn('grpc:message', (payload: GrpcMessageEvent) => {
      this.applyGrpcMessageEvent(payload);
    });

    runtime.EventsOn('grpc:trailers', (payload: GrpcTrailersEvent) => {
      this.applyGrpcTrailersEvent(payload);
    });

    runtime.EventsOn('grpc:done', (payload: GrpcDoneEvent) => {
      this.applyGrpcDoneEvent(payload);
    });
  },
};
