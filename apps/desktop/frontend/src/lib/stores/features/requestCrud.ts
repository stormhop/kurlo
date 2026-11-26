import { cancelQuit, confirmQuit, loadRequestExamples } from '../../backend';
import { normalizeRequestExamples, requestExamplesPending } from '../../examples';
import type { HttpResponse, McpResponse } from '../../backend';
import type { ResponseFormatChoice } from '../../responseFormat';
import { DEFAULT_COLLECTION, MAX_FOLDER_REQUESTS, clampName } from '../../constants';
import { addCollectionFolderPath } from '../../collections';
import {
  DEFAULT_GRAPHQL_QUERY,
  DEFAULT_GRAPHQL_VARIABLES,
  parseGraphQLPayload,
} from '../../graphql';
import { resolveFormRequestTab } from '../../requestTabPreferences';
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
  Workspace,
} from '../../types/models';
import { newRequestId, requestTabLabel } from '../../utils';
import { requestDiffersFromSavedSnapshot } from '../../manualSave';
import type { TopView } from '../ui';

export type DraftTarget = { collectionId: string; folderPath: string[] };

type RequestCrudHost = {
  requestFiles: import('../requestFiles.svelte').RequestFiles;
  ensureRequestExamples: (ids: string[]) => Promise<void>;
  draftTargets: Map<string, DraftTarget>;
  draftBaselines: Map<string, SavedRequest>;
  trashRequest: (request: import('../../types/models').SavedRequest, workspaceId: string) => void;
  trashRequests: (requests: import('../../types/models').SavedRequest[], workspaceId: string) => void;
  starredRequestIds: Set<string>;
  reviewWorkspaceEditsBeforeQuit: () => Promise<boolean>;
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
  mcpResponses: Map<string, McpResponse>;
  lastClosedRequestIds: string[];
  method: Method;
  openRequestIds: string[];
  openRequestTab: (id: string) => void;
  keepRequestTab: (id: string) => void;
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
  responseFormats: Map<string, ResponseFormatChoice>;
  savedRequestSnapshots: Map<string, SavedRequest>;
  sidebarSearch: string;
  responses: Map<string, HttpResponse>;
  previousResponses: Map<string, HttpResponse>;
  forgetRequestResponses: (ids: string[]) => void;
  topView: TopView;
  quitReviewInProgress: boolean;
  url: string;
  workspaces: Workspace[];
  activeCollectionId: () => string;
  applySavedRequest: (request: SavedRequest) => void;
  blankSavedRequest: (collectionId?: string, requestType?: RequestType) => SavedRequest;
  closeCollectionRunnerTab: () => void;
  closeCollectionSettingsTab: () => void;
  closeLoadTestTab: () => Promise<void>;
  closeAgentTab: () => void;
  closeFloatingMenus: () => void;
  closeGitTab: () => void;
  closeMockServerTab: () => void;
  closeHistoryDetail: () => void;
  closeActiveRequestTab: (force?: boolean) => Promise<void>;
  closeRequestTab: (id: string, force?: boolean) => Promise<void>;
  closeRequestTabs: (ids: string[]) => Promise<void>;
  collectionNameById: (collectionId: string) => string;
  currentRequestName: () => string;
  defaultCollectionForWorkspace: (workspaceId?: string) => Collection | undefined;
  discardDraftRequest: (id: string) => void;
  openNewDraft: (request: SavedRequest, target?: DraftTarget) => Promise<void>;
  draftTarget: (draftId: string) => DraftTarget | undefined;
  draftWasEdited: (draft: SavedRequest) => boolean;
  forgetDraft: (draftId: string) => void;
  settleDraft: (draftId: string) => Promise<'saved' | 'discarded' | 'cancelled'>;
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
  openAlertDialog: (title: string, message: string) => Promise<void>;
  openDraftRequests: () => SavedRequest[];
  openPromptDialog: (title: string, initialValue?: string, message?: string) => Promise<string | null>;
  openNameDialog: (title: string, initialValue?: string, message?: string) => Promise<string | null>;
  openSaveChangesDialog: (name: string) => Promise<'save' | 'discard' | 'cancel'>;
  openSelectDialog: (title: string, message: string, options: DialogOption[], confirmLabel?: string, cancelLabel?: string) => Promise<string | false | null>;
  openWorkspaceDiagnostic: (diagnostics?: SavedRequest['workspaceDiagnostics']) => void;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  persistRequestStore: (requests?: SavedRequest[], activeId?: string, openIds?: string[], workspaces?: Workspace[], collections?: Collection[]) => Promise<boolean>;
  persistRequestStoreView: (activeId?: string, openIds?: string[], workspaceId?: string) => Promise<boolean>;
  removeDirtyRequest: (id: string) => void;
  requestForEditing: (id: string) => SavedRequest | undefined;
  requestHasContent: (req: SavedRequest) => boolean;
  requestTypeEditable: boolean;
  requestIsRunning: (id: string) => boolean;
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

async function refuseFolderOverflow(host: RequestCrudHost, additions: SavedRequest[]): Promise<boolean> {
  const incoming = new Map<string, { collectionId: string; folderPath: string[]; count: number }>();
  for (const req of additions) {
    const folderPath = req.folderPath ?? [];
    if (req.isDraft || !folderPath.length) continue;
    const key = JSON.stringify([req.collectionId, folderPath]);
    const entry = incoming.get(key) ?? { collectionId: req.collectionId, folderPath, count: 0 };
    entry.count++;
    incoming.set(key, entry);
  }
  for (const { collectionId, folderPath, count } of incoming.values()) {
    const key = JSON.stringify([collectionId, folderPath]);
    const present = host.requests.filter(req => !req.isDraft && JSON.stringify([req.collectionId, req.folderPath ?? []]) === key).length;
    if (present + count > MAX_FOLDER_REQUESTS) {
      await host.openAlertDialog('Folder limit', `A folder can contain up to ${MAX_FOLDER_REQUESTS} requests.`);
      return true;
    }
  }
  return false;
}

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
    return !!host.activeRequest && !host.requestIsRunning(host.activeRequestId);
  },

  get pinnedRequests(): SavedRequest[] {
    const host = this as unknown as RequestCrudHost;
    host.dirtyRequestIdList;
    const starred = host.starredRequestIds;
    if (!starred.size) return [];
    const collectionIds = new Set(host.collections.filter(collection => collection.workspaceId === host.activeWorkspaceId).map(collection => collection.id));
    const query = host.sidebarSearch.trim().toLowerCase();
    return host.requests.filter(request => starred.has(request.id) && !request.isDraft && collectionIds.has(request.collectionId) && requestMatchesSidebarQuery(request, query));
  },

  requestsForDisplay(this: RequestCrudHost): SavedRequest[] {
    this.dirtyRequestIdList;
    const unsaved = this.unsavedRequestSnapshots;
    if (!unsaved.size) return this.requests.slice();
    return this.requests.map(request => unsaved.get(request.id) ?? request);
  },

  isRequestType(this: RequestCrudHost, value: unknown): value is RequestType {
    return value === 'kafka' || value === 'http' || value === 'graphql' || value === 'ws' || value === 'socketio' || value === 'grpc' || value === 'mcp' || value === 'ai';
  },

  normalizeRequestTypeValue(this: RequestCrudHost, value: unknown, url = ''): RequestType {
    if (value === 'kafka') return 'kafka';
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
    return this.savedRequestIsRealtime(req) || type === 'ai' || type === 'mcp' || (type === 'http' && req.method === 'SSE');
  },

  savedRequestIsGraphQL(this: RequestCrudHost, req: Pick<SavedRequest, 'requestType' | 'url' | 'bodyType'>) {
    return this.normalizeRequestTypeValue(req.requestType, req.url) === 'graphql' || req.bodyType === 'graphql';
  },

  requestTypeLabel(this: RequestCrudHost, type: RequestType = this.requestType) {
    if (type === 'kafka') return 'Kafka';
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
    } else if (this.requestType === 'kafka') {
      if (this.method === 'SSE') void this.sseDisconnect();
      if (previousType === 'ws') void this.webSocketDisconnect();
      if (previousType === 'socketio') void this.socketIODisconnect();
      this.method = 'POST';
      this.requestTab = 'body';
      this.bodyType = 'text';
      this.rawBodyType = 'text';
      if (wasGraphQL) this.bodyContent = '';
      if (!['none', 'inherit', 'basic', 'bearer', 'oauth2', 'aws'].includes(this.authType)) this.authType = 'none';
    } else if (this.requestType === 'grpc') {
      if (this.method === 'SSE') void this.sseDisconnect();
      if (previousType === 'ws') void this.webSocketDisconnect();
      if (previousType === 'socketio') void this.socketIODisconnect();
      this.method = 'POST';
      this.requestTab = ['docs', 'body', 'auth', 'metadata', 'service', 'scripts', 'settings'].includes(this.requestTab) ? this.requestTab : 'body';
      this.bodyType = 'json';
      this.rawBodyType = 'json';
      if (!['none', 'inherit', 'apikey', 'basic', 'bearer', 'jwt', 'oauth2'].includes(this.authType)) this.authType = 'none';
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
    this.requestTab = resolveFormRequestTab(this.requestType, this.method, blank ? undefined : this.requestTab);
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
    if (!this.autosave && resolved) {
      await this.openNewDraft(this.blankSavedRequest(resolved, selectedType), { collectionId: resolved, folderPath: [] });
      return;
    }
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
    await this.openNewDraft(this.blankSavedRequest('', selectedType));
  },

  async openNewDraft(this: RequestCrudHost, request: SavedRequest, target?: DraftTarget) {
    const next: SavedRequest = { ...request, isDraft: true, collectionId: '', collection: '' };
    if (target) this.draftTargets.set(next.id, target);
    this.draftBaselines.set(next.id, next);
    this.requests = [...this.requests, next];
    this.draftRequestIds = new Set([...this.draftRequestIds, next.id]);
    this.openRequestIds = [...new Set([...this.openRequestIds, next.id])];
    this.applySavedRequest(next);
    this.topView = 'request';
    await this.persistRequestStore(this.requests, next.id, this.openRequestIds);
  },

  draftTarget(this: RequestCrudHost, draftId: string) {
    const target = this.draftTargets.get(draftId);
    return target && this.collections.some(collection => collection.id === target.collectionId && !collection.isInvalid) ? target : undefined;
  },

  draftWasEdited(this: RequestCrudHost, draft: SavedRequest) {
    const baseline = this.draftBaselines.get(draft.id);
    return baseline ? requestDiffersFromSavedSnapshot(draft, baseline) : this.requestHasContent(draft);
  },

  forgetDraft(this: RequestCrudHost, draftId: string) {
    this.draftTargets.delete(draftId);
    this.draftBaselines.delete(draftId);
  },

  async settleDraft(this: RequestCrudHost, draftId: string): Promise<'saved' | 'discarded' | 'cancelled'> {
    const draft = this.requestsById.get(draftId);
    if (!draft || !this.draftWasEdited(draft)) return 'discarded';
    if (this.draftTarget(draftId)) {
      const choice = await this.openSaveChangesDialog(requestTabLabel(draft));
      if (choice === 'cancel') return 'cancelled';
      if (choice === 'discard') return 'discarded';
    }
    const saved = await this.saveDraftToCollection(draftId);
    if (saved === null) return 'cancelled';
    return saved ? 'saved' : 'discarded';
  },

  async saveDraftToCollection(this: RequestCrudHost, draftId: string, cancelLabel = 'Discard') {
    if (!this.guardWorkspaceWritable('Saving drafts')) return null;
    const draft = this.requestsById.get(draftId);
    const target = this.draftTarget(draftId);
    if (!draft) return false;
    let collectionId = target?.collectionId;
    let folderPath = target?.folderPath;
    let createdCollection: Collection | undefined;
    const wsCols = this.collections.filter(c => c.workspaceId === (this.activeWorkspaceId || this.workspaces[0]?.id));
    if (!target && !wsCols.length) {
      const wsId = this.activeWorkspaceId || this.workspaces[0]?.id;
      if (!wsId) return false;
      createdCollection = makeCollection(wsId, DEFAULT_COLLECTION);
      wsCols.push(createdCollection);
    }
    if (!collectionId) {
      const selectedId = await this.openSelectDialog('Save request', `Choose a collection to save "${requestTabLabel(draft)}" into:`, wsCols.map(c => ({ value: c.id, label: c.name })), 'Save', cancelLabel);
      if (!selectedId) return selectedId;
      collectionId = selectedId;
      folderPath = undefined;
    }
    const collection = this.collections.find(candidate => candidate.id === collectionId) ?? createdCollection;
    const current = this.requestsById.get(draftId);
    if (!collection || !current) return null;
    const destination = { isDraft: false, collectionId, collection: collection.name, ...(folderPath ? { folderPath } : {}) };
    const saved = { ...current, ...destination };
    const nextCollections = createdCollection ? [...this.collections, createdCollection] : this.collections;
    const nextRequests = this.requests.map(request => request.id === draftId ? saved : request);
    const written = await this.persistRequestStore(nextRequests, this.activeRequestId, this.openRequestIds, this.workspaces, nextCollections);
    if (createdCollection && !this.collections.some(candidate => candidate.id === createdCollection.id)) {
      this.collections = [...this.collections, createdCollection];
    }
    if (!written) {
      this.draftTargets.set(draftId, { collectionId, folderPath: folderPath ?? [] });
      return null;
    }
    this.requests = this.requests.map(request => request.id === draftId ? { ...request, ...destination } : request);
    this.draftRequestIds = new Set([...this.draftRequestIds].filter(id => id !== draftId));
    this.forgetDraft(draftId);
    this.savedRequestSnapshots.set(draftId, this.savedRequestSnapshot(saved));
    return true;
  },

  discardDraftRequest(this: RequestCrudHost, id: string) {
    this.forgetDraft(id);
    this.requests = this.requests.filter(r => r.id !== id);
    this.forgetRequestResponses([id]);
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
    return this.openDraftRequests().some(req => this.draftWasEdited(req));
  },

  hasUnsavedRequestChanges(this: RequestCrudHost) {
    if (!this.autosave && this.activeRequestId && !this.applyingSavedRequest) {
      this.updateRequestDirtyState(this.activeRequestId, this.snapshotActiveRequest({ forPersistence: true }));
    }
    return Boolean(this.requestFiles?.dirtyIds.length) || (!this.autosave && this.dirtyRequestIds.size > 0);
  },

  async reviewDraftsBeforeQuit(this: RequestCrudHost) {
    if (this.quitReviewInProgress) return;
    this.quitReviewInProgress = true;
    try {
      if (this.requestFiles && !await this.requestFiles.review()) {
        await cancelQuit();
        return;
      }
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
      if (!(await this.reviewWorkspaceEditsBeforeQuit())) {
        await cancelQuit();
        return;
      }
      for (const draftId of this.openDraftRequests().map(req => req.id)) {
        const draft = this.requestsById.get(draftId);
        if (!draft?.isDraft) continue;
        this.openRequestIds = [...new Set([...this.openRequestIds, draftId])];
        this.applySavedRequest(draft);
        this.topView = 'request';
        const outcome = await this.settleDraft(draftId);
        if (outcome === 'cancelled') {
          await cancelQuit();
          return;
        }
        if (outcome === 'discarded') this.discardDraftRequest(draftId);
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
    this.openRequestTab(id);
    this.activeWorkspaceId = this.workspaceIdForCollection(next.collectionId);
    this.applySavedRequest(next);
    this.topView = 'request';
    await this.persistRequestStoreView(id, this.openRequestIds);
  },

  async closeRequestTab(this: RequestCrudHost, id: string, force = false) {
    const file = this.requestFiles?.entries.get(id);
    if (file) {
      if (file.saving) await file.save();
      if (!force && !await this.requestFiles.review([id])) return;
      this.requestFiles.entries.delete(id);
    }
    const closeTarget = this.requestForEditing(id);
    const isDraft = closeTarget?.isDraft || this.draftRequestIds.has(id);
    if (!isDraft && !force && !this.autosave && id === this.activeRequestId) {
      const current = this.snapshotActiveRequest({ forPersistence: true });
      this.updateRequestDirtyState(id, current);
    }
    let handledDirtyClose = false;
    let pendingPersist: Promise<void> | null = null;
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
      this.forgetDraft(id);
      this.requests = this.requests.filter(r => r.id !== id);
      this.forgetRequestResponses([id]);
      this.draftRequestIds = new Set([...this.draftRequestIds].filter(did => did !== id));
    } else if (isDraft) {
      if (id === this.activeRequestId) await this.persistActiveRequestNow();
      const outcome = await this.settleDraft(id);
      if (outcome === 'cancelled') return;
      if (outcome === 'saved') {
        await this.closeRequestTab(id, true);
        return;
      }
      this.forgetDraft(id);
      this.requests = this.requests.filter(r => r.id !== id);
      this.forgetRequestResponses([id]);
      this.draftRequestIds = new Set([...this.draftRequestIds].filter(did => did !== id));
    } else if (force && !this.autosave) {
      await this.discardRequestChanges(id);
    } else if (!handledDirtyClose) {
      pendingPersist = this.persistActiveRequestNow();
    }
    const idx = this.openRequestIds.indexOf(id);
    if (idx >= 0 && !isDraft) this.lastClosedRequestIds = [id, ...this.lastClosedRequestIds.filter(i => i !== id)].slice(0, 12);
    const nextOpenIds = this.openRequestIds.filter(oid => oid !== id);
    this.openRequestIds = nextOpenIds;
    this.keepRequestTab(id);
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
    if (pendingPersist) await pendingPersist;
    if (isDraft) await this.persistRequestStore(this.requests, this.activeRequestId, nextOpenIds);
    else await this.persistRequestStoreView(this.activeRequestId, nextOpenIds);
  },

  async closeRequestTabs(this: RequestCrudHost, ids: string[]) {
    for (const id of ids) {
      if (!this.openRequestIds.includes(id)) continue;
      await this.closeRequestTab(id);
      if (this.openRequestIds.includes(id)) return;
    }
  },

  async closeOtherRequestTabs(this: RequestCrudHost) {
    if (!this.activeRequestId) return;
    await this.closeRequestTabs(this.openRequestIds.filter(id => id !== this.activeRequestId));
  },

  async closeAllRequestTabs(this: RequestCrudHost) {
    await this.closeRequestTabs([...this.openRequestIds]);
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
    } else if (this.topView === 'loadtest') {
      await this.closeLoadTestTab();
    } else if (this.topView === 'git') {
      this.closeGitTab();
    } else if (this.topView === 'history') {
      this.closeHistoryDetail();
    } else if (this.topView === 'agent') {
      this.closeAgentTab();
    } else if (this.topView === 'mock') {
      this.closeMockServerTab();
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
      for (const f of g.folders) {
        if (f.collapsed && !forceExpanded) continue;
        addFolderRequests(f);
      }
      visible.push(...g.rootRequests);
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
        ? clampName(nextName)
        : await this.openNameDialog('Rename request', requestTabLabel(promptReq));
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
        const renamed = (req: SavedRequest) => ({ ...req, name, nameAuto: false });
        const saved = this.savedRequestSnapshots.get(id);
        if (saved) this.savedRequestSnapshots = new Map(this.savedRequestSnapshots).set(id, renamed(saved));
        const unsaved = this.unsavedRequestSnapshots.get(id);
        if (unsaved) this.unsavedRequestSnapshots = new Map(this.unsavedRequestSnapshots).set(id, renamed(unsaved));
        this.requests = this.requests.map(r => r.id === id ? renamed(r) : r);
        await this.persistRequestStore();
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
    await this.persistActiveRequestNow();
    await this.ensureRequestExamples([id]);
    const req = id === this.activeRequestId
      ? this.snapshotActiveRequest({ forPersistence: true })
      : this.requestForEditing(id) ?? this.requestsById.get(id);
    if (!req) return;
    const copy = this.normalizeSavedRequestCtx({ ...req, id: newRequestId(), filesystemName: undefined, openapi: undefined, name: `${requestTabLabel(req)} Copy`, nameAuto: false });
    if (await refuseFolderOverflow(this, [copy])) return;
    this.requests = [...this.requests, copy];
    this.openRequestIds = [...new Set([...this.openRequestIds, copy.id])];
    this.openRequestMenuId = '';
    this.activeWorkspaceId = this.workspaceIdForCollection(copy.collectionId);
    this.applySavedRequest(copy);
    this.topView = 'request';
    await this.persistRequestStore(this.requests, copy.id, this.openRequestIds);
  },

  forgetRequestResponses(this: RequestCrudHost, ids: string[]) {
    for (const id of ids) this.requestFiles?.entries.delete(id);
    const gone = new Set(ids);
    if (!gone.size) return;
    const keep = <V>(map: Map<string, V>) => [...map.keys()].some(id => gone.has(id)) ? new Map([...map].filter(([id]) => !gone.has(id))) : map;
    this.responses = keep(this.responses);
    this.previousResponses = keep(this.previousResponses);
    this.responseTabs = keep(this.responseTabs);
    this.responseFormats = keep(this.responseFormats);
    this.grpcResponses = keep(this.grpcResponses);
    this.mcpResponses = keep(this.mcpResponses);
    this.grpcResponseTabs = keep(this.grpcResponseTabs);
    this.aiConversations = keep(this.aiConversations);
  },

  async deleteRequest(this: RequestCrudHost, id: string) {
    if (!this.guardWorkspaceWritable('Deleting requests')) return;
    const req = this.requestsById.get(id);
    if (!req) return;
    this.openRequestMenuId = '';
    const confirmed = await this.openConfirmDialog('Delete request', `Delete "${requestTabLabel(req)}"? You can restore it from Recently deleted until you quit Kurlo.`);
    if (!confirmed) return;
    await requestCrudFeature.removeRequests.call(this, [req]);
  },

  async deleteRequests(this: RequestCrudHost, ids: string[]) {
    const reqs = [...new Set(ids)].flatMap(id => this.requestsById.get(id) ?? []).filter(req => !req.isInvalid);
    if (reqs.length <= 1) {
      if (reqs.length) await requestCrudFeature.deleteRequest.call(this, reqs[0].id);
      return;
    }
    if (!this.guardWorkspaceWritable('Deleting requests')) return;
    this.openRequestMenuId = '';
    const confirmed = await this.openConfirmDialog('Delete requests', `Delete ${reqs.length} requests? You can restore them from Recently deleted until you quit Kurlo.`, `Delete ${reqs.length}`);
    if (!confirmed) return;
    await requestCrudFeature.removeRequests.call(this, reqs);
  },

  async removeRequests(this: RequestCrudHost, reqs: SavedRequest[]) {
    const ids = reqs.map(req => req.id);
    if (this.requestFiles && !await this.requestFiles.review(ids)) return;
    const current = reqs.flatMap(req => this.requestsById.get(req.id) ?? []);
    if (!current.length) return;
    const byWorkspace = new Map<string, SavedRequest[]>();
    for (const req of current) {
      const workspaceId = this.workspaceIdForCollection(req.collectionId);
      byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), req]);
    }
    for (const [workspaceId, group] of byWorkspace) this.trashRequests(group, workspaceId);
    const gone = new Set(current.map(req => req.id));
    for (const id of gone) this.removeDirtyRequest(id);
    const folders = current.filter(req => (req.folderPath ?? []).length);
    if (folders.length) {
      this.collections = this.collections.map(collection => folders.reduce(
        (next, req) => req.collectionId === collection.id ? addCollectionFolderPath(next, req.folderPath) : next,
        collection,
      ));
    }
    this.requests = this.requests.filter(r => !gone.has(r.id));
    this.openRequestIds = this.openRequestIds.filter(oid => !gone.has(oid));
    for (const id of gone) this.disposeRealtimeSession(id);
    this.forgetRequestResponses([...gone]);
    if (gone.has(this.activeRequestId)) {
      const removedActive = this.activeRequestId;
      const next = this.requests.find(r => this.openRequestIds.includes(r.id)) ?? this.requests[0];
      if (next) {
        this.openRequestIds = [...new Set([...this.openRequestIds, next.id])];
        this.activeWorkspaceId = this.workspaceIdForCollection(next.collectionId);
        this.applySavedRequest(next);
        this.topView = 'request';
      } else {
        this.activeRequestId = '';
        this.setActiveResponse(null, removedActive);
        this.requestError = '';
        this.topView = 'overview';
      }
    }
    await this.persistRequestStore();
  },

  async duplicateRequests(this: RequestCrudHost, ids: string[]) {
    const unique = [...new Set(ids)].filter(id => this.requestsById.has(id));
    if (unique.length <= 1) {
      if (unique.length) await requestCrudFeature.duplicateRequest.call(this, unique[0]);
      return;
    }
    if (!this.guardWorkspaceWritable('Duplicating requests')) return;
    await this.persistActiveRequestNow();
    await this.ensureRequestExamples(unique);
    const copies = unique.flatMap(id => {
      const req = id === this.activeRequestId
        ? this.snapshotActiveRequest({ forPersistence: true })
        : this.requestForEditing(id) ?? this.requestsById.get(id);
      if (!req || req.isInvalid) return [];
      return [this.normalizeSavedRequestCtx({ ...req, id: newRequestId(), filesystemName: undefined, openapi: undefined, name: `${requestTabLabel(req)} Copy`, nameAuto: false })];
    });
    if (!copies.length || await refuseFolderOverflow(this, copies)) return;
    this.openRequestMenuId = '';
    this.requests = [...this.requests, ...copies];
    await this.persistRequestStore();
    return copies.map(copy => copy.id);
  },

  async setRequestsStarred(this: RequestCrudHost, ids: string[], starred: boolean) {
    if (!this.guardWorkspaceWritable('Updating requests')) return;
    const eligible = ids.filter(id => {
      const req = this.requestsById.get(id);
      return req && !req.isDraft && !req.isInvalid;
    });
    const next = new Set(this.starredRequestIds);
    for (const id of eligible) {
      if (starred) next.add(id);
      else next.delete(id);
    }
    if (next.size === this.starredRequestIds.size && eligible.every(id => this.starredRequestIds.has(id) === starred)) return;
    this.starredRequestIds = next;
    this.openRequestMenuId = '';
    await this.persistRequestStore();
  },

  async toggleRequestPinned(this: RequestCrudHost, id: string) {
    if (!this.guardWorkspaceWritable('Updating requests')) return;
    const req = this.requestsById.get(id);
    if (!req || req.isDraft) return;
    const next = new Set(this.starredRequestIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.starredRequestIds = next;
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
    let source = this.copiedRequestItem;
    if (requestExamplesPending(source)) {
      const loaded = await loadRequestExamples([source.id]);
      if (Object.prototype.hasOwnProperty.call(loaded, source.id)) {
        source = { ...source, examples: normalizeRequestExamples(loaded[source.id], source.id) ?? [] };
        delete source.exampleCount;
      }
    }
    const colId = this.activeCollectionId() || source.collectionId;
    const copy = this.normalizeSavedRequestCtx({ ...source, id: newRequestId(), filesystemName: undefined, collectionId: colId, collection: this.collectionNameById(colId), name: `${requestTabLabel(source)} Copy`, nameAuto: false });
    if (await refuseFolderOverflow(this, [copy])) return;
    this.requests = [...this.requests, copy];
    this.openRequestIds = [...new Set([...this.openRequestIds, copy.id])];
    this.applySavedRequest(copy);
    this.topView = 'request';
    await this.persistRequestStore(this.requests, copy.id, this.openRequestIds);
  },
};
