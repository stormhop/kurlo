import { cancelHttpRequest, sendHttpRequest, sendHttpRequestToFile } from '../../backend';
import type { HttpRequest, HttpResponse } from '../../backend';
import type {
  AuthType,
  GrpcResponse,
  Method,
  RequestTab,
  RequestType,
  ResponseTab,
  SavedRequest,
} from '../../types/models';
import { newRequestId } from '../../utils';
import type { RunnableHttpOptions } from './requestSerialization';

const REQUEST_CANCELED_ERROR = 'Request canceled';
const sendGenerations = new Map<string, number>();

function nextSendGeneration(requestId: string) {
  const generation = (sendGenerations.get(requestId) ?? 0) + 1;
  sendGenerations.set(requestId, generation);
  return generation;
}

function downloadFilenameFromUrl(url: string): string {
  const path = url.split('#')[0].split('?')[0].replace(/\/+$/, '');
  const segment = (path.split('/').pop() ?? '').trim();
  return segment.includes('{{') ? '' : segment;
}

type RequestExecutionHost = {
  activeRequestId: string;
  authType: AuthType;
  bearerToken: string;
  disableCookieJar: boolean;
  grpcResponse: GrpcResponse | null;
  inFlightRequestIds: Set<string>;
  loading: boolean;
  method: Method;
  requestError: string;
  requestTab: RequestTab;
  requestType: RequestType;
  savedResponse: boolean;
  responseBodyPage: number;
  responseSearch: string;
  responseSearchIndex: number;
  socketIOConnected: boolean;
  socketIOConnecting: boolean;
  url: string;
  webSocketConnected: boolean;
  webSocketConnecting: boolean;
  activeEnvironmentValues: () => Record<string, string>;
  activeSecretEnvironmentKeys: () => string[];
  activeSecretEnvironmentValues: () => string[];
  buildRequest: (envValues?: Record<string, string>, secretEnvironmentValues?: string[], requestId?: string) => HttpRequest;
  cancelActiveRequest: () => Promise<void>;
  clearTransientSSESession: (id?: string) => void;
  ensureValidOAuth2Token: () => Promise<void>;
  graphQLPayloadError: () => string;
  guardWorkspaceWritable: (action?: string) => boolean;
  headerValidationErrorForRequest: (req: SavedRequest, envValues?: Record<string, string>) => string;
  invokeGrpc: () => Promise<void>;
  sendMcpCall: () => Promise<void>;
  sendAiPrompt: (followUp?: string) => Promise<void>;
  isEventStreamResponse: (response: HttpResponse | null) => boolean;
  markRequestLoading: (requestId: string, loading: boolean) => void;
  activeEnvironmentId: string;
  applyEnvironmentChangesFromResponse: (resp: HttpResponse, environmentId: string) => Promise<void>;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  promoteActiveRequestToSSE: () => void;
  noteSuccessfulSend: () => void;
  recordRequestHistory: (httpResponse: HttpResponse, requestSnapshot?: SavedRequest) => Promise<void>;
  refreshCookieJar: (silent?: boolean, persistAfterRefresh?: boolean) => Promise<void>;
  requestIsActive: (requestId: string) => boolean;
  savedRequestToRunnableHttpRequest: (
    req: SavedRequest,
    envValues?: Record<string, string>,
    secretValues?: string[],
    secretKeys?: string[],
    requestId?: string,
    options?: RunnableHttpOptions,
  ) => HttpRequest;
  send: (opts?: { downloadName?: string }) => Promise<void>;
  setActiveGrpcResponse: (response: GrpcResponse | null, requestId?: string) => void;
  setActiveResponse: (response: HttpResponse | null, requestId?: string) => void;
  setActiveResponseTab: (tab: ResponseTab, requestId?: string) => void;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  socketIOConnect: () => Promise<void>;
  socketIODisconnect: () => Promise<void>;
  sseConnect: (options?: { persistBeforeConnect?: boolean }) => Promise<void>;
  sseDisconnect: () => Promise<void>;
  sseSessionIsActive: () => boolean;
  syncActiveEnvironmentFromBackend: () => Promise<void>;
  syncBackendEnvironment: () => Promise<void>;
  syncBackendGlobals: () => Promise<void>;
  syncGlobalsFromBackend: () => Promise<boolean>;
  webSocketConnect: () => Promise<void>;
  webSocketDisconnect: () => Promise<void>;
};

export const requestExecutionFeature = {
  buildRequest(
    this: RequestExecutionHost,
    envValues = this.activeEnvironmentValues(),
    secretEnvironmentValues = this.activeSecretEnvironmentValues(),
    requestId = this.activeRequestId,
  ) {
    const snapshot = this.snapshotActiveRequest();
    return this.savedRequestToRunnableHttpRequest(snapshot, envValues, secretEnvironmentValues, this.activeSecretEnvironmentKeys(), requestId);
  },

  async runActiveRequest(this: RequestExecutionHost) {
    if (!this.guardWorkspaceWritable('Sending requests')) return;
    if (this.requestType === 'ws') {
      if (this.webSocketConnected || this.webSocketConnecting) await this.webSocketDisconnect();
      else await this.webSocketConnect();
      return;
    }
    if (this.requestType === 'socketio') {
      if (this.socketIOConnected || this.socketIOConnecting) await this.socketIODisconnect();
      else await this.socketIOConnect();
      return;
    }
    if (this.requestType === 'grpc') {
      await this.invokeGrpc();
      return;
    }
    if (this.requestType === 'mcp') {
      await this.sendMcpCall();
      return;
    }
    if (this.requestType === 'ai') {
      await this.sendAiPrompt();
      return;
    }
    if (this.requestType === 'http' && (this.method === 'SSE' || this.sseSessionIsActive())) {
      if (this.sseSessionIsActive()) await this.sseDisconnect();
      else await this.sseConnect();
      return;
    }
    await this.send();
  },

  async runActiveRequestAndDownload(this: RequestExecutionHost) {
    if (this.requestType !== 'http' || this.method === 'SSE' || this.sseSessionIsActive()) return;
    await this.send({ downloadName: downloadFilenameFromUrl(this.url) });
  },

  async send(this: RequestExecutionHost, opts?: { downloadName?: string }) {
    if (!this.guardWorkspaceWritable('Sending requests')) return;
    if (this.loading) {
      await this.cancelActiveRequest();
      return;
    }
    if (!this.url.trim()) return;
    if (this.authType === 'bearer' && !this.bearerToken.trim()) {
      this.requestError = 'Bearer token is empty — add a token in the Auth tab or change the auth type';
      return;
    }
    if (this.requestType === 'graphql') {
      const graphQLError = this.graphQLPayloadError();
      if (graphQLError) {
        this.requestError = graphQLError;
        this.setActiveResponse(null);
        return;
      }
    }
    const requestId = this.activeRequestId || newRequestId();
    const generation = nextSendGeneration(requestId);
    const isCurrent = () => sendGenerations.get(requestId) === generation;
    this.markRequestLoading(requestId, true);
    this.requestError = '';
    try {
      await this.ensureValidOAuth2Token();
      if (!isCurrent()) return;
      const requestSnapshot = this.snapshotActiveRequest();
      const sentEnvironmentId = this.activeEnvironmentId;
      const envValues = this.activeEnvironmentValues();
      const secretValues = this.activeSecretEnvironmentValues();
      const secretKeys = this.activeSecretEnvironmentKeys();
      const headerError = this.headerValidationErrorForRequest(requestSnapshot, envValues);
      if (headerError) {
        this.requestError = headerError;
        this.setActiveResponse(null);
        this.requestTab = 'headers';
        return;
      }
      this.clearTransientSSESession(requestId);
      await this.persistActiveRequestNow();
      try { await this.syncBackendEnvironment(); } catch {  }
      try { await this.syncBackendGlobals(); } catch {}
      const serialized = this.savedRequestToRunnableHttpRequest(requestSnapshot, envValues, secretValues, secretKeys, requestId, { deferTemplates: true });
      let resp: HttpResponse;
      let downloadedPath = '';
      if (opts?.downloadName !== undefined) {
        const result = await sendHttpRequestToFile(serialized, opts.downloadName);
        resp = result.response;
        downloadedPath = result.savedPath;
      } else {
        resp = await sendHttpRequest(serialized);
      }
      try { await this.applyEnvironmentChangesFromResponse(resp, sentEnvironmentId); } catch {}
      try { await this.syncGlobalsFromBackend(); } catch {}
      if (!isCurrent()) return;
      if (requestSnapshot.method === 'GET' && this.isEventStreamResponse(resp)) {
        if (this.requestIsActive(requestId)) {
          this.setActiveResponse(null, requestId);
          this.setActiveResponseTab('body', requestId);
          this.responseSearch = '';
          this.responseSearchIndex = 0;
          this.promoteActiveRequestToSSE();
          await this.sseConnect({ persistBeforeConnect: false });
        }
        return;
      }
      if (resp.error && !resp.statusCode) {
        if (this.requestIsActive(requestId)) this.requestError = resp.error;
        if (resp.error !== REQUEST_CANCELED_ERROR) await this.recordRequestHistory(resp, requestSnapshot);
        return;
      }
      if (this.requestIsActive(requestId)) {
        this.setActiveResponse(resp, requestId);
        this.responseBodyPage = 0;
        this.responseSearchIndex = 0;
        const defaultTab = resp.testResult?.tests?.length
          ? 'test-results'
          : (resp.previewImageBase64 ? 'preview' : 'body');
        this.setActiveResponseTab(defaultTab, requestId);
      }
      if (downloadedPath && this.requestIsActive(requestId)) {
        this.savedResponse = true;
        setTimeout(() => (this.savedResponse = false), 1600);
      }
      await this.recordRequestHistory(resp, requestSnapshot);
      if (resp.statusCode && !resp.error) this.noteSuccessfulSend();
    } catch (e) {
      if (isCurrent() && this.requestIsActive(requestId)) this.requestError = String(e);
    }
    finally {
      if (isCurrent()) this.markRequestLoading(requestId, false);
      if (!this.disableCookieJar) void this.refreshCookieJar(true, true);
    }
  },

  async cancelActiveRequest(this: RequestExecutionHost) {
    const requestId = this.activeRequestId;
    if (!requestId || !this.inFlightRequestIds.has(requestId)) return;
    nextSendGeneration(requestId);
    await cancelHttpRequest(requestId);
    this.markRequestLoading(requestId, false);
    if (this.requestIsActive(requestId)) {
      if (this.requestType === 'grpc' && this.grpcResponse) {
        this.setActiveGrpcResponse({
          ...this.grpcResponse,
          grpcCode: this.grpcResponse.grpcCode && this.grpcResponse.grpcCode !== 'STREAMING' ? this.grpcResponse.grpcCode : 'CANCELLED',
          status: 'CANCELLED',
          error: REQUEST_CANCELED_ERROR,
          grpcMessage: 'Cancelled on client',
          timestamp: Date.now(),
        }, requestId);
        this.requestError = '';
        return;
      }
      this.requestError = REQUEST_CANCELED_ERROR;
      this.setActiveResponse(null, requestId);
      this.setActiveGrpcResponse(null, requestId);
    }
  },
};
