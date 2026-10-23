import { cancelQuit, confirmQuit } from '../../backend';
import type { HttpResponse } from '../../backend';
import { DEFAULT_COLLECTION } from '../../constants';
import { addCollectionFolderPath } from '../../collections';
import {
  DEFAULT_GRAPHQL_QUERY,
  DEFAULT_GRAPHQL_VARIABLES,
  parseGraphQLPayload,
} from '../../graphql';
import { makeCollection } from '../../normalizers';
import { requestMatchesSidebarQuery } from './collections';
import { AI_DEFAULT_PRESET, aiDefaultAuthFor, type AiTurn } from './ai';
import { defaultBodyContentFor, requestBodyDefaultsFor } from '../../requestBodyDefaults';
import type { DialogOption } from '../../types/dialog';
import type {
  AuthType,
  BodyType,
  Collection,
  CollectionGroup,
  FolderGroup,
  GrpcResponse,
  GrpcResponseTab,
  Method,
  RawBodyType,
  RequestTab,
  ResponseTab,
  RequestType,
  SavedRequest,
} from '../../types/models';
import { newRequestId, requestTabLabel } from '../../utils';
import type { TopView } from '../ui';

type RequestCrudHost = {
  unsavedRequestSnapshots: Map<string, SavedRequest>;
  activeRequest: SavedRequest | undefined;
  activeRequestId: string;
  activeWorkspaceId: string;
  apiKeyIn: 'header' | 'query';
  applyingSavedRequest: boolean;
  authType: AuthType;
  autosave: boolean;
  bodyContent: string;
  bodyType: BodyType;
  collectionGroups: CollectionGroup[];
  collections: Collection[];
  copiedRequestItem: SavedRequest | null;
  dirtyRequestIdList: string[];
  dirtyRequestIds: Set<string>;
  draftRequestIds: Set<string>;
  graphqlOperationName: string;
  graphqlQuery: string;
  graphqlSchema: string;
  graphqlSchemaError: string;
  graphqlSchemaStatus: string;
  graphqlVariables: string;
  grpcResponseTabs: Map<string, GrpcResponseTab>;
  grpcResponses: Map<string, GrpcResponse>;
  lastClosedRequestIds: string[];
  method: Method;
  openRequestIds: string[];
  openRequestMenuId: string;
  rawBodyType: RawBodyType;
  renamingRequestId: string;
  requestError: string;
  requestName: string;
  requestNameAuto: boolean;
  requestTab: RequestTab;
  requestType: RequestType;
  requests: SavedRequest[];
  requestsById: Map<string, SavedRequest>;
  responseTabs: Map<string, ResponseTab>;
  savedRequestSnapshots: Map<string, SavedRequest>;
  sidebarSearch: string;
  responses: Map<string, HttpResponse>;
  topView: TopView;
  quitReviewInProgress: boolean;
  url: string;
  workspaces: Array<{ id: string }>;
  activeCollectionId: () => string;
  applySavedRequest: (request: SavedRequest) => void;
  blankSavedRequest: (collectionId?: string, requestType?: RequestType) => SavedRequest;
  closeCollectionRunnerTab: () => void;
  closeCollectionSettingsTab: () => void;
  closeFloatingMenus: () => void;
  closeGitTab: () => void;
  closeHistoryDetail: () => void;
  closeActiveRequestTab: (force?: boolean) => Promise<void>;
  closeRequestTab: (id: string, force?: boolean) => Promise<void>;
  collectionNameById: (collectionId: string) => string;
  currentRequestName: () => string;
  defaultCollectionForWorkspace: (workspaceId?: string) => Collection | undefined;
  discardDraftRequest: (id: string) => void;
  discardRequestChanges: (id: string) => Promise<void | boolean>;
  disposeRealtimeSession: (id: string) => void;
  graphQLBodyContentForStore: () => string;
  guardWorkspaceWritable: (action?: string) => boolean;
  hasUnsavedRequestChanges: () => boolean;
  isRequestDirty: (id: string) => boolean;
  isRequestType: (value: unknown) => value is RequestType;
  normalizeRequestTypeValue: (value: unknown, url?: string) => RequestType;
  normalizeSavedRequestCtx: (input: Partial<SavedRequest>) => SavedRequest;
  openConfirmDialog: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  openDraftRequests: () => SavedRequest[];
  openPromptDialog: (title: string, initialValue?: string, message?: string) => Promise<string | null>;
  openSaveChangesDialog: (name: string) => Promise<'save' | 'discard' | 'cancel'>;
  openSelectDialog: (title: string, message: string, options: DialogOption[], confirmLabel?: string, cancelLabel?: string) => Promise<string | false | null>;
  openWorkspaceDiagnostic: (diagnostics?: SavedRequest['workspaceDiagnostics']) => void;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  persistRequestStore: (requests?: SavedRequest[], activeId?: string, openIds?: string[]) => Promise<boolean>;
  removeDirtyRequest: (id: string) => void;
  requestForEditing: (id: string) => SavedRequest | undefined;
  requestHasContent: (req: SavedRequest) => boolean;
  requestTypeEditable: boolean;
  mcpMethod: string;
  aiProvider: string;
  bearerToken: string;
  apiKeyName: string;
  apiKeyValue: string;
  aiConversations: Map<string, AiTurn[]>;
  requestsForDisplay: () => SavedRequest[];
  savedRequestIsRealtime: (req: Pick<SavedRequest, 'requestType' | 'url'>) => boolean;
  savedRequestSnapshot: (req: SavedRequest) => SavedRequest;
  saveActiveRequest: () => Promise<void>;
  saveDraftToCollection: (draftId: string, cancelLabel?: string) => Promise<string | false | null | boolean>;
  saveRequestById: (id: string) => Promise<boolean>;
  setActiveResponse: (response: null, requestId?: string) => void;
  scheduleActiveRequestPersist: () => void;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  sseDisconnect: () => Promise<void>;
  switchRequest: (id: string) => Promise<void>;
  updateRequestDirtyState: (id: string, req?: SavedRequest) => void;
  visibleSidebarRequests: () => SavedRequest[];
  webSocketDisconnect: () => Promise<void>;
  socketIODisconnect: () => Promise<void>;
  workspaceIdForCollection: (collectionId: string) => string;
};

export const requestCrudFeature = {
  get openRequests(): SavedRequest[] {
    const host = this as unknown as RequestCrudHost;
    return host.openRequestIds.map(id => host.requestsById.get(id)).filter((r): r is SavedRequest => Boolean(r));
  },

  get openRequestsForTabs(): SavedRequest[] {
    const host = this as unknown as RequestCrudHost;
    host.dirtyRequestIdList;
    return host.openRequestIds
      .map(id => host.requestForEditing(id) ?? host.requestsById.get(id))
      .filter((r): r is SavedRequest => Boolean(r));
  },

  get activeRequest(): SavedRequest | undefined {
    const host = this as unknown as RequestCrudHost;
    return host.requestsById.get(host.activeRequestId);
  },

  get activeRequestIsDirty(): boolean {
    const host = this as unknown as RequestCrudHost;
    return !host.autosave && host.topView === 'request' && (host.isRequestDirty(host.activeRequestId) || Boolean(host.activeRequest?.isDraft));
  },

  get activeRequestCanRevert(): boolean {
    const host = this as unknown as RequestCrudHost;
    return !host.autosave && host.topView === 'request' && host.isRequestDirty(host.activeRequestId) && !host.activeRequest?.isDraft;
  },

  get requestTypeEditable(): boolean {
    const host = this as unknown as RequestCrudHost;
    const active = host.activeRequest;
    if (!active) return false;
    return Boolean(active.isDraft) || !host.url.trim();
  },

  get pinnedRequests(): SavedRequest[] {
    const host = this as unknown as RequestCrudHost;
    host.dirtyRequestIdList;
    const collectionIds = new Set(host.collections.filter(collection => collection.workspaceId === host.activeWorkspaceId).map(collection => collection.id));
    const query = host.sidebarSearch.trim().toLowerCase();
    return host.requestsForDisplay().filter(request => !request.isDraft && request.isPinned && collectionIds.has(request.collectionId) && requestMatchesSidebarQuery(request, query));
  },

  requestsForDisplay(this: RequestCrudHost): SavedRequest[] {
    this.dirtyRequestIdList;
    const unsaved = this.unsavedRequestSnapshots;
    if (!unsaved.size) return this.requests.slice();
    return this.requests.map(request => unsaved.get(request.id) ?? request);
  },

  isRequestType(this: RequestCrudHost, value: unknown): value is RequestType {
    return value === 'http' || value === 'graphql' || value === 'ws' || value === 'socketio' || value === 'grpc' || value === 'mcp' || value === 'ai';
  },

  normalizeRequestTypeValue(this: RequestCrudHost, value: unknown, url = ''): RequestType {
    if (value === 'mcp') return 'mcp';
    if (value === 'ai') return 'ai';
    if (value === 'grpc') return 'grpc';
    if (value === 'socketio') return 'socketio';
    if (value === 'ws') return 'ws';
    if (value === 'graphql') return 'graphql';
    if (value === 'http') return 'http';
    return /^wss?:\/\//i.test(url) ? 'ws' : 'http';
  },

  savedRequestIsWebSocket(this: RequestCrudHost, req: Pick<SavedRequest, 'requestType' | 'url'>) {
    return this.normalizeRequestTypeValue(req.requestType, req.url) === 'ws';
  },

  savedRequestIsRealtime(this: RequestCrudHost, req: Pick<SavedRequest, 'requestType' | 'url'>) {
    const type = this.normalizeRequestTypeValue(req.requestType, req.url);
    return type === 'ws' || type === 'socketio';
  },

  savedRequestIsRunnerSkipped(this: RequestCrudHost, req: Pick<SavedRequest, 'requestType' | 'url' | 'method'>) {
    const type = this.normalizeRequestTypeValue(req.requestType, req.url);
    return this.savedRequestIsRealtime(req) || type === 'ai' || (type === 'http' && req.method === 'SSE');
  },

  savedRequestIsGraphQL(this: RequestCrudHost, req: Pick<SavedRequest, 'requestType' | 'url' | 'bodyType'>) {
    return this.normalizeRequestTypeValue(req.requestType, req.url) === 'graphql' || req.bodyType === 'graphql';
  },

  requestTypeLabel(this: RequestCrudHost, type: RequestType = this.requestType) {
    if (this.normalizeRequestTypeValue(type) === 'grpc') return 'gRPC';
    if (this.normalizeRequestTypeValue(type) === 'socketio') return 'Socket.IO';
    if (this.normalizeRequestTypeValue(type) === 'graphql') return 'GraphQL';
    return this.normalizeRequestTypeValue(type).toUpperCase();
  },

  requestHeaderName(this: RequestCrudHost) {
    return this.requestNameAuto ? this.currentRequestName() : this.requestName;
  },

  setRequestHeaderName(this: RequestCrudHost, value: string) {
    this.requestName = value;
    this.requestNameAuto = false;
    this.scheduleActiveRequestPersist();
  },

  commitRequestHeaderName(this: RequestCrudHost) {
    const trimmed = this.requestName.trim();
    if (!trimmed) {
      this.requestName = '';
      this.requestNameAuto = true;
      this.scheduleActiveRequestPersist();
      return;
    }
    this.requestName = trimmed;
    this.scheduleActiveRequestPersist();
  },

  selectRequestType(this: RequestCrudHost, type: RequestType) {
    if (!this.requestTypeEditable) return;
    const blank = !this.url.trim();
    const previousType = this.requestType;
    const wasGraphQL = previousType === 'graphql';
    const graphQLBody = wasGraphQL ? this.graphQLBodyContentForStore() : '';
    this.requestType = this.normalizeRequestTypeValue(type);
    if (this.requestType === 'graphql') {
      if (this.method === 'SSE') void this.sseDisconnect();
      if (previousType === 'ws') void this.webSocketDisconnect();
      if (previousType === 'socketio') void this.socketIODisconnect();
      this.method = 'POST';
      this.requestTab = 'query';
      this.bodyType = 'graphql';
      this.rawBodyType = 'json';
      if (previousType !== 'graphql') {
        const parsed = this.bodyContent.trim()
          ? parseGraphQLPayload(this.bodyContent)
          : { query: DEFAULT_GRAPHQL_QUERY, variables: DEFAULT_GRAPHQL_VARIABLES, operationName: '' };
        this.graphqlQuery = parsed.query;
        this.graphqlVariables = parsed.variables;
        this.graphqlOperationName = parsed.operationName;
        this.graphqlSchema = '';
        this.graphqlSchemaStatus = '';
        this.graphqlSchemaError = '';
      }
    } else if (this.requestType === 'ws') {
      const bodyDefaults = requestBodyDefaultsFor('ws');
      if (this.method === 'SSE') void this.sseDisconnect();
      if (previousType === 'socketio') void this.socketIODisconnect();
      this.method = 'GET';
      if (this.requestTab === 'auth' || this.requestTab === 'scripts' || this.requestTab === 'events' || this.requestTab === 'query' || this.requestTab === 'schema') this.requestTab = 'body';
      if (wasGraphQL) {
        this.bodyContent = graphQLBody;
        this.rawBodyType = 'json';
        this.bodyType = 'text';
      } else if (this.bodyType === 'none') {
        this.bodyType = bodyDefaults.bodyType;
        this.rawBodyType = bodyDefaults.rawBodyType;
        this.bodyContent = bodyDefaults.bodyContent;
      } else if (this.bodyType === 'graphql') this.bodyType = this.rawBodyType;
      if (/^https?:\/\//i.test(this.url)) this.url = this.url.replace(/^http/i, 'ws');
    } else if (this.requestType === 'socketio') {
      const bodyDefaults = requestBodyDefaultsFor('socketio');
      if (this.method === 'SSE') void this.sseDisconnect();
      if (previousType === 'ws') void this.webSocketDisconnect();
      this.method = 'GET';
      if (this.requestTab === 'auth' || this.requestTab === 'scripts' || this.requestTab === 'query' || this.requestTab === 'schema') this.requestTab = 'body';
      if (wasGraphQL) {
        this.bodyContent = graphQLBody;
        this.rawBodyType = 'json';
        this.bodyType = 'text';
      } else if (this.bodyType === 'none') {
        this.bodyType = bodyDefaults.bodyType;
        this.rawBodyType = bodyDefaults.rawBodyType;
        this.bodyContent = bodyDefaults.bodyContent;
      } else if (this.bodyType === 'graphql') this.bodyType = this.rawBodyType;
    } else if (this.requestType === 'grpc') {
      if (this.method === 'SSE') void this.sseDisconnect();
      if (previousType === 'ws') void this.webSocketDisconnect();
      if (previousType === 'socketio') void this.socketIODisconnect();
      this.method = 'POST';
      this.requestTab = ['docs', 'body', 'auth', 'metadata', 'service', 'scripts', 'settings'].includes(this.requestTab) ? this.requestTab : 'body';
      this.bodyType = 'json';
      this.rawBodyType = 'json';
      if (!['none', 'apikey', 'basic', 'bearer', 'oauth2'].includes(this.authType)) this.authType = 'none';
      this.apiKeyIn = 'header';
      if (wasGraphQL) this.bodyContent = defaultBodyContentFor('grpc');
      else if (!this.bodyContent.trim()) this.bodyContent = defaultBodyContentFor('grpc');
    } else if (this.requestType === 'mcp') {
      if (this.method === 'SSE') void this.sseDisconnect();
      if (previousType === 'ws') void this.webSocketDisconnect();
      if (previousType === 'socketio') void this.socketIODisconnect();
      if (/^wss?:\/\//i.test(this.url)) this.url = this.url.replace(/^ws/i, 'http');
      this.method = 'POST';
      this.requestTab = ['docs', 'body', 'auth', 'headers', 'scripts', 'settings', 'examples'].includes(this.requestTab) ? this.requestTab : 'body';
      this.bodyType = 'none';
      this.rawBodyType = 'json';
      this.bodyContent = '';
      if (!this.mcpMethod) this.mcpMethod = 'tools/list';
    } else if (this.requestType === 'ai') {
      if (this.method === 'SSE') void this.sseDisconnect();
      if (previousType === 'ws') void this.webSocketDisconnect();
      if (previousType === 'socketio') void this.socketIODisconnect();
      this.method = 'POST';
      this.requestTab = ['docs', 'body', 'auth', 'headers', 'tools', 'scripts', 'settings'].includes(this.requestTab) ? this.requestTab : 'body';
      this.bodyType = 'none';
      this.rawBodyType = 'json';
      this.bodyContent = '';
      if (!this.aiProvider) this.aiProvider = AI_DEFAULT_PRESET.provider;
      if (!/^https?:\/\//i.test(this.url.trim())) this.url = AI_DEFAULT_PRESET.url;
      if (this.authType === 'inherit' || this.authType === 'none') {
        const auth = aiDefaultAuthFor();
        this.authType = auth.type;
        this.bearerToken = auth.bearerToken;
      }
    } else {
      if (previousType === 'ws') void this.webSocketDisconnect();
      if (previousType === 'socketio') void this.socketIODisconnect();
      if (/^wss?:\/\//i.test(this.url)) this.url = this.url.replace(/^ws/i, 'http');
      if (wasGraphQL) {
        this.bodyContent = graphQLBody;
        this.bodyType = 'json';
        this.rawBodyType = 'json';
        if (this.requestTab === 'query' || this.requestTab === 'schema') this.requestTab = 'body';
      } else if (this.requestTab === 'body' && this.bodyType !== 'none') this.requestTab = 'params';
      if (this.requestTab === 'events' || this.requestTab === 'query' || this.requestTab === 'schema' || this.requestTab === 'tools') this.requestTab = 'params';
    }
    if (this.requestType !== 'graphql') {
      this.graphqlQuery = DEFAULT_GRAPHQL_QUERY;
      this.graphqlVariables = DEFAULT_GRAPHQL_VARIABLES;
      this.graphqlOperationName = '';
      this.graphqlSchema = '';
      this.graphqlSchemaStatus = '';
      this.graphqlSchemaError = '';
    }
    if (blank) this.requestTab = this.blankSavedRequest('', this.requestType).requestTab;
  },

  async createNewRequest(this: RequestCrudHost, collectionId?: string, requestType?: RequestType) {
    if (!this.guardWorkspaceWritable('Creating requests')) return;
    const resolvedCollectionId = typeof collectionId === 'string' ? collectionId : this.activeCollectionId();
    const selectedType = this.isRequestType(requestType) ? requestType : 'http';
    this.closeFloatingMenus();
    await this.persistActiveRequestNow();
    let resolved = resolvedCollectionId || this.defaultCollectionForWorkspace(this.activeWorkspaceId)?.id || '';
    if (!resolved) {
      const wsId = this.activeWorkspaceId || this.workspaces[0]?.id;
      if (wsId) {
        const col = makeCollection(wsId, DEFAULT_COLLECTION);
        this.collections = [...this.collections, col];
        resolved = col.id;
      }
    }
    const wsId = this.workspaceIdForCollection(resolved);
    if (wsId) this.activeWorkspaceId = wsId;
    const next = this.blankSavedRequest(resolved, selectedType);
    this.requests = [...this.requests, next];
    this.openRequestIds = [...new Set([...this.openRequestIds, next.id])];
    this.savedRequestSnapshots.set(next.id, this.savedRequestSnapshot(next));
    this.applySavedRequest(next);
    this.topView = 'request';
    await this.persistRequestStore(this.requests, next.id, this.openRequestIds);
  },

  async createDraftRequest(this: RequestCrudHost, requestType?: RequestType) {
    if (!this.guardWorkspaceWritable('Creating drafts')) return;
    const selectedType = this.isRequestType(requestType) ? requestType : 'http';
    this.closeFloatingMenus();
    await this.persistActiveRequestNow();
    const next: SavedRequest = { ...this.blankSavedRequest('', selectedType), isDraft: true, collectionId: '', collection: '' };
    this.requests = [...this.requests, next];
    this.draftRequestIds = new Set([...this.draftRequestIds, next.id]);
    this.openRequestIds = [...new Set([...this.openRequestIds, next.id])];
    this.applySavedRequest(next);
    this.topView = 'request';
    await this.persistRequestStore(this.requests, next.id, this.openRequestIds);
  },

  async saveDraftToCollection(this: RequestCrudHost, draftId: string, cancelLabel = 'Discard') {
    if (!this.guardWorkspaceWritable('Saving drafts')) return false;
    const draft = this.requestsById.get(draftId);
    const wsCols = this.collections.filter(c => c.workspaceId === (this.activeWorkspaceId || this.workspaces[0]?.id));
    if (!wsCols.length) {
      const wsId = this.activeWorkspaceId || this.workspaces[0]?.id;
      if (!wsId) return false;
      const col = makeCollection(wsId, DEFAULT_COLLECTION);
      this.collections = [...this.collections, col];
      wsCols.push(col);
    }
    const selectedId = await this.openSelectDialog('Save request', `Choose a collection to save "${draft ? requestTabLabel(draft) : 'this draft'}" into:`, wsCols.map(c => ({ value: c.id, label: c.name })), 'Save', cancelLabel);
    if (!selectedId) return selectedId;
    this.requests = this.requests.map(r => r.id === draftId ? { ...r, isDraft: false, collectionId: selectedId, collection: this.collectionNameById(selectedId) } : r);
    this.draftRequestIds = new Set([...this.draftRequestIds].filter(id => id !== draftId));
    const saved = this.requestsById.get(draftId);
    if (saved) this.savedRequestSnapshots.set(draftId, this.savedRequestSnapshot(saved));
    await this.persistRequestStore();
    return true;
  },

  discardDraftRequest(this: RequestCrudHost, id: string) {
    this.requests = this.requests.filter(r => r.id !== id);
    this.draftRequestIds = new Set([...this.draftRequestIds].filter(did => did !== id));
    this.openRequestIds = this.openRequestIds.filter(oid => oid !== id);
    if (id === this.activeRequestId) {
      const fallbackId = this.openRequestIds.at(-1) ?? '';
      const next = fallbackId ? this.requestsById.get(fallbackId) : undefined;
      if (next) {
        this.activeWorkspaceId = this.workspaceIdForCollection(next.collectionId);
        this.applySavedRequest(next);
        this.topView = 'request';
      } else {
        this.activeRequestId = '';
        this.topView = 'overview';
      }
    }
  },

  openDraftRequests(this: RequestCrudHost) {
    return this.openRequestIds.map(id => this.requestsById.get(id)).filter((r): r is SavedRequest => Boolean(r?.isDraft));
  },

  hasUnsavedDrafts(this: RequestCrudHost) {
    return this.openDraftRequests().some(req => this.requestHasContent(req));
  },

  hasUnsavedRequestChanges(this: RequestCrudHost) {
    if (!this.autosave && this.activeRequestId && !this.applyingSavedRequest) {
      this.updateRequestDirtyState(this.activeRequestId, this.snapshotActiveRequest({ forPersistence: true }));
    }
    return !this.autosave && this.dirtyRequestIds.size > 0;
  },

  async reviewDraftsBeforeQuit(this: RequestCrudHost) {
    if (this.quitReviewInProgress) return;
    this.quitReviewInProgress = true;
    try {
      await this.persistActiveRequestNow();
      if (!this.autosave) {
        for (const dirtyId of [...this.dirtyRequestIds]) {
          const req = this.requestForEditing(dirtyId);
          if (!req || req.isDraft) {
            this.removeDirtyRequest(dirtyId);
            continue;
          }
          const choice = await this.openSaveChangesDialog(requestTabLabel(req));
          if (choice === 'save') {
            if (!(await this.saveRequestById(dirtyId))) {
              await cancelQuit();
              return;
            }
          } else if (choice === 'discard') {
            await this.discardRequestChanges(dirtyId);
          } else {
            await cancelQuit();
            return;
          }
        }
      }
      for (const draftId of this.openDraftRequests().map(req => req.id)) {
        const draft = this.requestsById.get(draftId);
        if (!draft?.isDraft) continue;
        this.openRequestIds = [...new Set([...this.openRequestIds, draftId])];
        this.applySavedRequest(draft);
        this.topView = 'request';
        if (!this.requestHasContent(draft)) {
          this.discardDraftRequest(draftId);
          continue;
        }
        const saved = await this.saveDraftToCollection(draftId);
        if (saved === null) {
          await cancelQuit();
          return;
        }
        if (saved === false) this.discardDraftRequest(draftId);
      }
      if (!(await this.persistRequestStore())) {
        const quitAnyway = await this.openConfirmDialog(
          'Quit without saving?',
          'Kurlo could not save your latest changes. Quit anyway and lose them, or stay and fix the problem first.',
          'Quit without saving'
        );
        if (quitAnyway) await confirmQuit();
        else await cancelQuit();
        return;
      }
      await confirmQuit();
    } finally {
      this.quitReviewInProgress = false;
    }
  },

  async switchRequest(this: RequestCrudHost, id: string) {
    if (id === this.activeRequestId && this.topView === 'request') return;
    const diagnosticRequest = this.collectionGroups.flatMap(group => group.requests).find(req => req.id === id && req.workspaceDiagnostics?.length);
    if (diagnosticRequest?.workspaceDiagnostics?.length) {
      this.activeRequestId = id;
      this.openWorkspaceDiagnostic(diagnosticRequest.workspaceDiagnostics);
      return;
    }
    await this.persistActiveRequestNow();
    const next = this.requestForEditing(id);
    if (!next) return;
    this.openRequestIds = [...new Set([...this.openRequestIds, id])];
    this.activeWorkspaceId = this.workspaceIdForCollection(next.collectionId);
    this.applySavedRequest(next);
    this.topView = 'request';
    await this.persistRequestStore(this.requests, id, this.openRequestIds);
  },

  async closeRequestTab(this: RequestCrudHost, id: string, force = false) {
    const closeTarget = this.requestForEditing(id);
    const isDraft = closeTarget?.isDraft || this.draftRequestIds.has(id);
    if (!isDraft && !force && !this.autosave && id === this.activeRequestId) {
      const current = this.snapshotActiveRequest({ forPersistence: true });
      this.updateRequestDirtyState(id, current);
    }
    let handledDirtyClose = false;
    if (!isDraft && !force && !this.autosave && this.dirtyRequestIds.has(id)) {
      if (id === this.activeRequestId) await this.persistActiveRequestNow();
      const name = closeTarget ? requestTabLabel(closeTarget) : 'this request';
      const choice = await this.openSaveChangesDialog(name);
      if (choice === 'save') {
        const prevActive = this.activeRequestId;
        if (id !== this.activeRequestId) {
          const req = this.requestForEditing(id);
          if (req) this.applySavedRequest(req);
        }
        await this.saveActiveRequest();
        if (prevActive !== id) {
          const prev = this.requestForEditing(prevActive);
          if (prev) this.applySavedRequest(prev);
        }
      } else if (choice === 'discard') {
        await this.discardRequestChanges(id);
      } else {
        return;
      }
      handledDirtyClose = true;
    }
    if (isDraft && force) {
      this.requests = this.requests.filter(r => r.id !== id);
      this.draftRequestIds = new Set([...this.draftRequestIds].filter(did => did !== id));
    } else if (isDraft) {
      if (id === this.activeRequestId) await this.persistActiveRequestNow();
      const req = this.requestsById.get(id);
      const hasContent = Boolean(req && this.requestHasContent(req));
      if (hasContent) {
        const saved = await this.saveDraftToCollection(id);
        if (saved) {
          await this.closeRequestTab(id, true);
          return;
        }
        if (saved === null) return;
      }
      this.requests = this.requests.filter(r => r.id !== id);
      this.draftRequestIds = new Set([...this.draftRequestIds].filter(did => did !== id));
    } else if (force && !this.autosave) {
      await this.discardRequestChanges(id);
    } else if (!handledDirtyClose) {
      await this.persistActiveRequestNow();
    }
    const idx = this.openRequestIds.indexOf(id);
    if (idx >= 0 && !isDraft) this.lastClosedRequestIds = [id, ...this.lastClosedRequestIds.filter(i => i !== id)].slice(0, 12);
    const nextOpenIds = this.openRequestIds.filter(oid => oid !== id);
    this.openRequestIds = nextOpenIds;
    this.disposeRealtimeSession(id);
    if (id === this.activeRequestId) {
      const fallbackId = nextOpenIds[Math.max(0, idx - 1)] ?? nextOpenIds[0] ?? '';
      if (fallbackId) {
        const next = this.requestForEditing(fallbackId);
        if (next) {
          this.activeWorkspaceId = this.workspaceIdForCollection(next.collectionId);
          this.applySavedRequest(next);
          this.topView = 'request';
        }
      } else {
        this.activeRequestId = '';
        this.topView = 'overview';
      }
    }
    await this.persistRequestStore(this.requests, this.activeRequestId, nextOpenIds);
  },

  async closeActiveRequestTab(this: RequestCrudHost, force = false) {
    if (this.topView !== 'request' || !this.activeRequestId) return;
    await this.closeRequestTab(this.activeRequestId, force);
  },

  async closeActiveTab(this: RequestCrudHost, force = false) {
    if (this.topView === 'request') {
      await this.closeActiveRequestTab(force);
    } else if (this.topView === 'runner') {
      this.closeCollectionRunnerTab();
    } else if (this.topView === 'collection') {
      this.closeCollectionSettingsTab();
    } else if (this.topView === 'git') {
      this.closeGitTab();
    } else if (this.topView === 'history') {
      this.closeHistoryDetail();
    }
  },

  async switchOpenTabByOffset(this: RequestCrudHost, offset: number) {
    if (!this.openRequestIds.length) return;
    const cur = Math.max(0, this.openRequestIds.indexOf(this.activeRequestId));
    await this.switchRequest(this.openRequestIds[(cur + offset + this.openRequestIds.length) % this.openRequestIds.length]);
  },

  async switchOpenTabAt(this: RequestCrudHost, index: number) {
    const id = this.openRequestIds[index];
    if (id) await this.switchRequest(id);
  },

  async switchLastOpenTab(this: RequestCrudHost) {
    const id = this.openRequestIds.at(-1);
    if (id) await this.switchRequest(id);
  },

  async reopenLastClosedTab(this: RequestCrudHost) {
    const id = this.lastClosedRequestIds.find(i => this.requests.some(r => r.id === i));
    if (!id) return;
    this.lastClosedRequestIds = this.lastClosedRequestIds.filter(i => i !== id);
    this.openRequestIds = [...new Set([...this.openRequestIds, id])];
    await this.switchRequest(id);
  },

  visibleSidebarRequests(this: RequestCrudHost) {
    const visible: SavedRequest[] = [];
    const forceExpanded = Boolean(this.sidebarSearch.trim());
    const addFolderRequests = (folder: FolderGroup) => {
      for (const child of folder.children) {
        if (child.collapsed && !forceExpanded) continue;
        addFolderRequests(child);
      }
      visible.push(...folder.requests);
    };
    for (const g of this.collectionGroups) {
      if (g.collection.collapsed && !forceExpanded) continue;
      visible.push(...g.rootRequests);
      for (const f of g.folders) {
        if (f.collapsed && !forceExpanded) continue;
        addFolderRequests(f);
      }
    }
    return visible;
  },

  async switchSidebarItem(this: RequestCrudHost, offset: number) {
    const visible = this.visibleSidebarRequests();
    if (!visible.length) return;
    const cur = Math.max(0, visible.findIndex(r => r.id === this.activeRequestId));
    await this.switchRequest(visible[(cur + offset + visible.length) % visible.length].id);
  },

  async renameRequest(this: RequestCrudHost, id: string, nextName?: string) {
    if (!this.guardWorkspaceWritable('Renaming requests')) return;
    if (this.renamingRequestId) return;
    const promptReq = this.requestForEditing(id);
    if (!promptReq) return;
    this.renamingRequestId = id;
    this.openRequestMenuId = '';
    try {
      const name = typeof nextName === 'string'
        ? nextName.trim()
        : await this.openPromptDialog('Rename request', requestTabLabel(promptReq));
      if (!name) return;
      const stillExists = this.requests.some(r => r.id === id);
      if (!stillExists) {
        this.removeDirtyRequest(id);
        return;
      }
      if (id === this.activeRequestId) {
        this.requestName = name;
        this.requestNameAuto = false;
      }
      const current = id === this.activeRequestId ? this.snapshotActiveRequest({ forPersistence: true }) : this.requestForEditing(id);
      if (!current) return;
      const updated = { ...current, name, nameAuto: false };
      if (!this.autosave && !current.isDraft && !this.draftRequestIds.has(id)) {
        this.updateRequestDirtyState(id, updated);
        return;
      }
      this.requests = this.requests.map(r => r.id === id ? updated : r);
      await this.persistRequestStore();
      this.removeDirtyRequest(id);
    } finally {
      this.renamingRequestId = '';
    }
  },

  async duplicateRequest(this: RequestCrudHost, id: string) {
    if (!this.guardWorkspaceWritable('Duplicating requests')) return;
    const req = id === this.activeRequestId
      ? this.snapshotActiveRequest({ forPersistence: true })
      : this.requestForEditing(id) ?? this.requestsById.get(id);
    if (!req) return;
    const copy = this.normalizeSavedRequestCtx({ ...req, id: newRequestId(), filesystemName: undefined, name: `${requestTabLabel(req)} Copy`, nameAuto: false });
    this.requests = [...this.requests, copy];
    this.openRequestIds = [...new Set([...this.openRequestIds, copy.id])];
    this.openRequestMenuId = '';
    this.activeWorkspaceId = this.workspaceIdForCollection(copy.collectionId);
    this.applySavedRequest(copy);
    this.topView = 'request';
    await this.persistRequestStore(this.requests, copy.id, this.openRequestIds);
  },

  async deleteRequest(this: RequestCrudHost, id: string) {
    if (!this.guardWorkspaceWritable('Deleting requests')) return;
    const req = this.requestsById.get(id);
    if (!req) return;
    this.openRequestMenuId = '';
    const confirmed = await this.openConfirmDialog('Delete request', `Delete "${requestTabLabel(req)}" from local storage?`);
    if (!confirmed) return;
    this.removeDirtyRequest(id);
    if ((req.folderPath ?? []).length) {
      this.collections = this.collections.map(collection =>
        collection.id === req.collectionId ? addCollectionFolderPath(collection, req.folderPath) : collection
      );
    }
    this.requests = this.requests.filter(r => r.id !== id);
    this.openRequestIds = this.openRequestIds.filter(oid => oid !== id);
    this.disposeRealtimeSession(id);
    this.responses = new Map([...this.responses].filter(([requestId]) => requestId !== id));
    this.responseTabs = new Map([...this.responseTabs].filter(([requestId]) => requestId !== id));
    this.grpcResponses = new Map([...this.grpcResponses].filter(([requestId]) => requestId !== id));
    this.grpcResponseTabs = new Map([...this.grpcResponseTabs].filter(([requestId]) => requestId !== id));
    this.aiConversations = new Map([...this.aiConversations].filter(([requestId]) => requestId !== id));
    if (id === this.activeRequestId) {
      const next = this.requests.find(r => this.openRequestIds.includes(r.id)) ?? this.requests[0];
      if (next) {
        this.openRequestIds = [...new Set([...this.openRequestIds, next.id])];
        this.activeWorkspaceId = this.workspaceIdForCollection(next.collectionId);
        this.applySavedRequest(next);
        this.topView = 'request';
      } else {
        this.activeRequestId = '';
        this.setActiveResponse(null, id);
        this.requestError = '';
        this.topView = 'overview';
      }
    }
    await this.persistRequestStore();
  },

  async toggleRequestPinned(this: RequestCrudHost, id: string) {
    if (!this.guardWorkspaceWritable('Updating requests')) return;
    const req = this.requestsById.get(id);
    if (!req || req.isDraft) return;
    this.requests = this.requests.map(r => r.id === id ? { ...r, isPinned: !r.isPinned } : r);
    this.openRequestMenuId = '';
    await this.persistRequestStore();
  },

  copyActiveRequestItem(this: RequestCrudHost) {
    const cur = this.activeRequestId
      ? this.snapshotActiveRequest({ forPersistence: true })
      : undefined;
    if (cur) this.copiedRequestItem = this.normalizeSavedRequestCtx({ ...cur });
  },

  async pasteCopiedRequestItem(this: RequestCrudHost) {
    if (!this.guardWorkspaceWritable('Pasting requests')) return;
    if (!this.copiedRequestItem) return;
    await this.persistActiveRequestNow();
    const colId = this.activeCollectionId() || this.copiedRequestItem.collectionId;
    const copy = this.normalizeSavedRequestCtx({ ...this.copiedRequestItem, id: newRequestId(), filesystemName: undefined, collectionId: colId, collection: this.collectionNameById(colId), name: `${requestTabLabel(this.copiedRequestItem)} Copy`, nameAuto: false });
    this.requests = [...this.requests, copy];
    this.openRequestIds = [...new Set([...this.openRequestIds, copy.id])];
    this.applySavedRequest(copy);
    this.topView = 'request';
    await this.persistRequestStore(this.requests, copy.id, this.openRequestIds);
  },
};
