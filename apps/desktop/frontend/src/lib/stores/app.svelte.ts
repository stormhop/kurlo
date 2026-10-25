import {
  loadRequestStore, loadWorkspaceDiagnostics, storedHistoryResponseIds,
  openDirectoryDialog, saveFileDialog, defaultWorkspaceLocation, setDefaultWorkspaceLocation,
  gitStatus, gitCommitLogPage, gitListBranches,
  useLocalWorkspaceStore, createLocalWorkspaceRoot, saveWorkspaceSecrets,
  emptyLoadRunState,
} from '../backend';
import type { CookieJarEntry, CookieSyncStatus, GitBranchListResult, GitConflictFileResult, GitDiffResult, GitLogResult, GitWorkspaceStatus, HttpResponse, McpResponse, MockRequestLog, MockServerStatus, OAuth2DevicePrompt, WorkspaceDiagnostic, WorkspaceOpenResult, WorkspaceSecretRef, K6Info, LoadRunResult, LoadRunState } from '../backend';
import { EMPTY_COOKIE_SYNC_STATUS, EMPTY_MOCK_SERVER_STATUS } from '../wire';
import { DEFAULT_MOCK_PORT } from '../mockRoutes';
import type { SSEEventEntry, SSESession, WebSocketMessageEntry, WebSocketSession, SocketIOMessageEntry, SocketIOSession, SocketIOClientVersion } from '../types/models';
import { initialThemeState, type AppTheme, type ResolvedAppTheme } from '../theme';
import {
  DEFAULT_GRAPHQL_QUERY,
  DEFAULT_GRAPHQL_VARIABLES,
} from '../graphql';
import type { RunnerDataRow } from '../runnerData';
import { DEFAULT_RUNNER_CONCURRENCY } from '../concurrency';
import {
  makeWorkspace, makeCollection,
  normalizeWorkspace, normalizeCollection, normalizeEnvironment,
  normalizeSavedRequest, normalizeHistoryEntry, withStoredHistoryResponses,
} from '../normalizers';
import { defaultSocketIOArgs, requestBodyDefaultsFor } from '../requestBodyDefaults';
import {
  mkRow, DEFAULT_WORKSPACE, DEFAULT_COLLECTION,
  DEFAULT_PROXY_CONFIG,
} from '../constants';
import {
  safeFileName, downloadTextFile, clipboardCopy, restoreRows, requestSupportsCurl,
  oauth1FieldsFromAuth, type OAuth1Fields,
} from '../utils';
import type {
  Method, BodyType, RawBodyType, HttpVersion, RequestTab, ScriptTab, ResponseTab, GrpcResponseTab,
  AuthType, OAuth2GrantType, OAuth2ClientAuth, SidebarView, ShortcutId, KVRow,
  Workspace, Collection, Environment,
   RequestSettingsOverrides, ProxyConfig, SavedRequest, RequestHistoryEntry, RequestStore, ScriptEngine,
  CollectionGroup, HistoryDayGroup,
  CollectionRunnerResult, RenderedSnippetLine, RequestType, SIOArg, GrpcResponse, GrpcServiceDefinition,
  RequestExample,
} from '../types/models';
import type { VariableSuggestion } from '../variables';
import type { SettingsTab, SnippetLanguage, TopView } from './ui';
import type { AppDialogState } from '../types/dialog';
import { authFeature } from './features/auth';
import { cookieFeature } from './features/cookies';
import { cookieSyncFeature, DEFAULT_COOKIE_SYNC_PORT } from './features/cookieSync';
import { collectionDefaultsFeature } from './features/collectionDefaults';
import { collectionFeature } from './features/collections';
import { collectionRunnerFeature } from './features/collectionRunner';
import { collectionRunnerDerivedFeature } from './features/collectionRunnerDerived';
import { dataBackupFeature } from './features/dataBackup';
import { gitFeature, GIT_LOG_PAGE_SIZE, EMPTY_GIT_STATUS, EMPTY_GIT_DIFF, EMPTY_GIT_BRANCHES, EMPTY_GIT_CONFLICT_FILE, EMPTY_GIT_LOG, normalizeGitStatus, normalizeGitBranches, normalizeGitLog } from './features/git';
import type { GitAuthChoice, GitAuthRequest } from './features/git';
import { folderFeature } from './features/folders';
import { findReplaceFeature, type FindReplaceScope, type FindReplaceUndo } from './features/findReplace';
import { graphqlFeature } from './features/graphql';
import { grpcFeature } from './features/grpc';
import { mcpFeature } from './features/mcp';
import { aiFeature, type AiModelsProblem, type AiTurn } from './features/ai';
import { importExportFeature } from './features/importExport';
import { examplesFeature } from './features/examples';
import { requestBodyFeature } from './features/requestBody';
import { requestCrudFeature } from './features/requestCrud';
import { requestDirtyFeature } from './features/requestDirty';
import { requestExecutionFeature } from './features/requestExecution';
import { finishStarPrompt, loadStarPromptState, recordSuccessfulSend, starPromptDue } from '../starPrompt';
import { requestHeadersFeature } from './features/requestHeaders';
import { requestPersistenceFeature } from './features/requestPersistence';
import { requestSerializationFeature } from './features/requestSerialization';
import { requestStateFeature } from './features/requestState';
import { realtimeFeature } from './features/realtime';
import { responseFeature } from './features/response';
import { scriptsFeature } from './features/scripts';
import { snippetsFeature } from './features/snippets';
import { sseFeature } from './features/sse';
import { websocketFeature } from './features/websocket';
import { socketioFeature } from './features/socketio';
import { mkSioEventRow, socketioFormFeature } from './features/socketioForm';
import { mockServerFeature } from './features/mockServer';
import { dialogFeature } from './features/dialogs';
import { environmentFeature, readEnvironmentView, type EnvironmentView } from './features/environments';
import { globalsFeature, withTrailingRow as withTrailingGlobalRow } from './features/globals';
import { historyFeature } from './features/history';
import { normalizeCollectionRuns, type CollectionRunRecord } from '../collectionRuns';
import { menuFeature } from './features/menus';
import { loadTestFeature, type LoadTestTab } from './features/loadTests';
import { loadRunFeature } from './features/loadRuns';
import { preferencesFeature } from './features/preferences';
import { DEFAULT_STARTUP_VIEW, startupNeedsDraftRequest, startupTopView, type StartupView } from '../startupView';
import { readResponseLayout, readResponseLayoutChosen, uiShellFeature, type ResponseLayout } from './features/uiShell';
import { workspaceFeature } from './features/workspace';
import { workspaceDiagnosticsFeature } from './features/workspaceDiagnostics';

const SIDEBAR_DEFAULT_WIDTH = 280;
const TOP_VIEW_STORAGE_KEY = 'kurlo.topView.v1';
const TOP_VIEW_VALUES: TopView[] = ['overview', 'request', 'environment', 'git', 'runner', 'collection'];
const SIDEBAR_VIEW_VALUES: SidebarView[] = ['collections', 'environments', 'history'];
const INITIAL_BODY_DEFAULTS = requestBodyDefaultsFor('http');

type ImportSource = 'bruno' | 'postman' | 'insomnia' | 'openapi' | 'har';
type TopViewState = {
  topView: TopView;
  activeCollectionSettingsId?: string;
  collectionRunnerOpen?: boolean;
  collectionRunnerCollectionId?: string;
  gitWorkspaceOpen?: boolean;
  sidebarView?: SidebarView;
};

function normalizeWorkspaceDiagnostics(diagnostics: WorkspaceDiagnostic[] | null | undefined): WorkspaceDiagnostic[] {
  return Array.isArray(diagnostics) ? diagnostics.filter((diagnostic): diagnostic is WorkspaceDiagnostic => Boolean(diagnostic)) : [];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTopViewValue(value: unknown): value is TopView {
  return typeof value === 'string' && TOP_VIEW_VALUES.includes(value as TopView);
}

function isSidebarViewValue(value: unknown): value is SidebarView {
  return typeof value === 'string' && SIDEBAR_VIEW_VALUES.includes(value as SidebarView);
}

function normalizeTopViewState(value: unknown): TopViewState | null {
  if (isTopViewValue(value)) return { topView: value };
  if (!isPlainRecord(value) || !isTopViewValue(value.topView)) return null;
  const state: TopViewState = { topView: value.topView };
  if (typeof value.activeCollectionSettingsId === 'string') state.activeCollectionSettingsId = value.activeCollectionSettingsId;
  if (typeof value.collectionRunnerOpen === 'boolean') state.collectionRunnerOpen = value.collectionRunnerOpen;
  if (typeof value.collectionRunnerCollectionId === 'string') state.collectionRunnerCollectionId = value.collectionRunnerCollectionId;
  if (typeof value.gitWorkspaceOpen === 'boolean') state.gitWorkspaceOpen = value.gitWorkspaceOpen;
  if (isSidebarViewValue(value.sidebarView)) state.sidebarView = value.sidebarView;
  return state;
}

export type { GitAuthChoice, GitAuthRequest } from './features/git';

class AppVM {
  constructor() {
    const proto = Object.getPrototypeOf(this);
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc && typeof desc.value === 'function') {
        (this as unknown as Record<string, unknown>)[name] = desc.value.bind(this);
      }
    }
  }

  declare activeRequestCookieDomain: typeof cookieFeature.activeRequestCookieDomain;
  declare normalizeCookieEntry: typeof cookieFeature.normalizeCookieEntry;
  declare normalizeWorkspaceCookieStore: typeof cookieFeature.normalizeWorkspaceCookieStore;
  declare rememberActiveWorkspaceCookies: typeof cookieFeature.rememberActiveWorkspaceCookies;
  declare cookiesForWorkspace: typeof cookieFeature.cookiesForWorkspace;
  declare captureActiveWorkspaceCookies: typeof cookieFeature.captureActiveWorkspaceCookies;
  declare restoreWorkspaceCookieJar: typeof cookieFeature.restoreWorkspaceCookieJar;
  declare restoreCookieJar: typeof cookieFeature.restoreCookieJar;
  declare refreshCookieJar: typeof cookieFeature.refreshCookieJar;
  declare openCookieJar: typeof cookieFeature.openCookieJar;
  declare closeCookieJar: typeof cookieFeature.closeCookieJar;
  declare importCookieHeaderForUrl: typeof cookieFeature.importCookieHeaderForUrl;
  declare saveCookie: typeof cookieFeature.saveCookie;
  declare removeCookie: typeof cookieFeature.removeCookie;
  declare clearCookieJar: typeof cookieFeature.clearCookieJar;
  declare cookieSyncDomains: typeof cookieSyncFeature.cookieSyncDomains;
  declare cookieSyncActiveDomainIsListed: typeof cookieSyncFeature.cookieSyncActiveDomainIsListed;
  declare loadCookieSyncStatus: typeof cookieSyncFeature.loadCookieSyncStatus;
  declare startCookieSyncBridge: typeof cookieSyncFeature.startCookieSyncBridge;
  declare stopCookieSyncBridge: typeof cookieSyncFeature.stopCookieSyncBridge;
  declare toggleCookieSync: typeof cookieSyncFeature.toggleCookieSync;
  declare addCookieSyncDomain: typeof cookieSyncFeature.addCookieSyncDomain;
  declare addActiveRequestDomainToCookieSync: typeof cookieSyncFeature.addActiveRequestDomainToCookieSync;
  declare removeCookieSyncDomain: typeof cookieSyncFeature.removeCookieSyncDomain;
  declare revokeCookieSyncBrowser: typeof cookieSyncFeature.revokeCookieSyncBrowser;
  declare approveCookieSyncBrowser: typeof cookieSyncFeature.approveCookieSyncBrowser;
  declare denyCookieSyncBrowser: typeof cookieSyncFeature.denyCookieSyncBrowser;
  declare cookieSyncAwaitingApproval: typeof cookieSyncFeature.cookieSyncAwaitingApproval;
  declare cookieSyncUnreadableDomains: typeof cookieSyncFeature.cookieSyncUnreadableDomains;
  declare scheduleCookieSyncJarRefresh: typeof cookieSyncFeature.scheduleCookieSyncJarRefresh;
  declare copyCookieSyncPairingCode: typeof cookieSyncFeature.copyCookieSyncPairingCode;
  declare pointCookieSyncAtActiveWorkspace: typeof cookieSyncFeature.pointCookieSyncAtActiveWorkspace;
  declare initCookieSyncListeners: typeof cookieSyncFeature.initCookieSyncListeners;

  declare forgetSSESession: typeof sseFeature.forgetSSESession;
  declare sseSessionIsActive: typeof sseFeature.sseSessionIsActive;
  declare sseSessionIsVisible: typeof sseFeature.sseSessionIsVisible;
  declare clearTransientSSESession: typeof sseFeature.clearTransientSSESession;
  declare promoteActiveRequestToSSE: typeof sseFeature.promoteActiveRequestToSSE;
  declare _emptySSESession: typeof sseFeature._emptySSESession;
  declare _sseSetSession: typeof sseFeature._sseSetSession;
  declare _sseAddEvent: typeof sseFeature._sseAddEvent;
  declare _sseAddEvents: typeof sseFeature._sseAddEvents;
  declare _sseScheduleEventFlush: typeof sseFeature._sseScheduleEventFlush;
  declare _sseFlushEvents: typeof sseFeature._sseFlushEvents;
  declare _sseTrimEvents: typeof sseFeature._sseTrimEvents;
  declare _sseHistorySnapshot: typeof sseFeature._sseHistorySnapshot;
  declare _recordSSEHistoryOnce: typeof sseFeature._recordSSEHistoryOnce;
  declare sseConnect: typeof sseFeature.sseConnect;
  declare sseDisconnect: typeof sseFeature.sseDisconnect;
  declare sseClearEvents: typeof sseFeature.sseClearEvents;
  declare sseRestoreEvents: typeof sseFeature.sseRestoreEvents;

  declare forgetWebSocketSession: typeof websocketFeature.forgetWebSocketSession;
  declare _emptyWebSocketSession: typeof websocketFeature._emptyWebSocketSession;
  declare _wsSetSession: typeof websocketFeature._wsSetSession;
  declare _wsAddMessage: typeof websocketFeature._wsAddMessage;
  declare _wsAddMessages: typeof websocketFeature._wsAddMessages;
  declare _wsScheduleMessageFlush: typeof websocketFeature._wsScheduleMessageFlush;
  declare _wsFlushMessages: typeof websocketFeature._wsFlushMessages;
  declare _wsTrimMessages: typeof websocketFeature._wsTrimMessages;
  declare _wsHistorySnapshot: typeof websocketFeature._wsHistorySnapshot;
  declare _recordWebSocketHistoryOnce: typeof websocketFeature._recordWebSocketHistoryOnce;
  declare webSocketConnect: typeof websocketFeature.webSocketConnect;
  declare webSocketDisconnect: typeof websocketFeature.webSocketDisconnect;
  declare _wsOutgoingMessage: typeof websocketFeature._wsOutgoingMessage;
  declare webSocketSendCurrentMessage: typeof websocketFeature.webSocketSendCurrentMessage;
  declare webSocketSendControl: typeof websocketFeature.webSocketSendControl;
  declare webSocketClearMessages: typeof websocketFeature.webSocketClearMessages;
  declare webSocketRestoreMessages: typeof websocketFeature.webSocketRestoreMessages;

  declare forgetSocketIOSession: typeof socketioFeature.forgetSocketIOSession;
  declare _emptySocketIOSession: typeof socketioFeature._emptySocketIOSession;
  declare _sioSetSession: typeof socketioFeature._sioSetSession;
  declare _sioAddMessage: typeof socketioFeature._sioAddMessage;
  declare _sioAddMessages: typeof socketioFeature._sioAddMessages;
  declare _sioScheduleMessageFlush: typeof socketioFeature._sioScheduleMessageFlush;
  declare _sioFlushMessages: typeof socketioFeature._sioFlushMessages;
  declare _sioTrimMessages: typeof socketioFeature._sioTrimMessages;
  declare _sioHistorySnapshot: typeof socketioFeature._sioHistorySnapshot;
  declare _recordSocketIOHistoryOnce: typeof socketioFeature._recordSocketIOHistoryOnce;
  declare socketIOConnect: typeof socketioFeature.socketIOConnect;
  declare socketIODisconnect: typeof socketioFeature.socketIODisconnect;
  declare socketIOEmitCurrentMessage: typeof socketioFeature.socketIOEmitCurrentMessage;
  declare socketIOClearMessages: typeof socketioFeature.socketIOClearMessages;
  declare socketIORestoreMessages: typeof socketioFeature.socketIORestoreMessages;

  declare mkSioEventRow: typeof socketioFormFeature.mkSioEventRow;
  declare restoreSioEventRows: typeof socketioFormFeature.restoreSioEventRows;
  declare sioCurrentArg: typeof socketioFormFeature.sioCurrentArg;
  declare sioAddArg: typeof socketioFormFeature.sioAddArg;
  declare sioRemoveArg: typeof socketioFormFeature.sioRemoveArg;
  declare sioUpdateCurrentArg: typeof socketioFormFeature.sioUpdateCurrentArg;
  declare sioCurrentArgLang: typeof socketioFormFeature.sioCurrentArgLang;
  declare sioEventsWithTrailing: typeof socketioFormFeature.sioEventsWithTrailing;
  declare updateSioEventRow: typeof socketioFormFeature.updateSioEventRow;

  mockServer = $state<MockServerStatus>({ ...EMPTY_MOCK_SERVER_STATUS });
  mockServerCollectionId = $state('');
  mockServerPort = $state(DEFAULT_MOCK_PORT);
  mockServerSimulateLatency = $state(false);
  mockServerBusy = $state(false);
  mockServerLog = $state<MockRequestLog[]>([]);
  mockServerError = $state('');
  mockServerTabOpen = $state(false);
  mockServerRunningSignature = $state('');
  mockServerReloadTimer: ReturnType<typeof setTimeout> | null = null;
  declare mockServerTargetCollectionId: typeof mockServerFeature.mockServerTargetCollectionId;
  declare mockServerRoutes: typeof mockServerFeature.mockServerRoutes;
  declare mockServerRunningRoutes: typeof mockServerFeature.mockServerRunningRoutes;
  declare scheduleMockServerReload: typeof mockServerFeature.scheduleMockServerReload;
  declare mockServerRouteCount: typeof mockServerFeature.mockServerRouteCount;
  declare mockServerCollectionOptions: typeof mockServerFeature.mockServerCollectionOptions;
  declare refreshMockServerStatus: typeof mockServerFeature.refreshMockServerStatus;
  declare startMockServerForCollection: typeof mockServerFeature.startMockServerForCollection;
  declare stopMockServerNow: typeof mockServerFeature.stopMockServerNow;
  declare toggleMockServer: typeof mockServerFeature.toggleMockServer;
  declare recordMockRequest: typeof mockServerFeature.recordMockRequest;
  declare clearMockServerLog: typeof mockServerFeature.clearMockServerLog;
  declare selectMockServerCollection: typeof mockServerFeature.selectMockServerCollection;
  declare setMockServerPort: typeof mockServerFeature.setMockServerPort;
  declare openMockServerTab: typeof mockServerFeature.openMockServerTab;
  declare closeMockServerTab: typeof mockServerFeature.closeMockServerTab;
  declare mockServerRoutesChanged: typeof mockServerFeature.mockServerRoutesChanged;
  declare reloadMockServerRoutes: typeof mockServerFeature.reloadMockServerRoutes;
  declare openMockRouteExample: typeof mockServerFeature.openMockRouteExample;
  declare removeSioEventRow: typeof socketioFormFeature.removeSioEventRow;

  declare currentSSESession: typeof realtimeFeature.currentSSESession;
  declare currentWebSocketSession: typeof realtimeFeature.currentWebSocketSession;
  declare webSocketConnected: typeof realtimeFeature.webSocketConnected;
  declare webSocketConnecting: typeof realtimeFeature.webSocketConnecting;
  declare currentSocketIOSession: typeof realtimeFeature.currentSocketIOSession;
  declare socketIOConnected: typeof realtimeFeature.socketIOConnected;
  declare socketIOConnecting: typeof realtimeFeature.socketIOConnecting;
  declare realtimeStatusIsActive: typeof realtimeFeature.realtimeStatusIsActive;
  declare realtimeProtectedSessionIds: typeof realtimeFeature.realtimeProtectedSessionIds;
  declare realtimeSessionIdsToPrune: typeof realtimeFeature.realtimeSessionIdsToPrune;
  declare disposeRealtimeSession: typeof realtimeFeature.disposeRealtimeSession;
  declare cleanupRealtimeSessions: typeof realtimeFeature.cleanupRealtimeSessions;
  declare initSSEListeners: typeof realtimeFeature.initSSEListeners;
  declare initWebSocketListeners: typeof realtimeFeature.initWebSocketListeners;
  declare initSocketIOListeners: typeof realtimeFeature.initSocketIOListeners;

  declare collectionRunnerCollections: typeof collectionRunnerDerivedFeature.collectionRunnerCollections;
  declare collectionRunnerEffectiveCollectionId: typeof collectionRunnerDerivedFeature.collectionRunnerEffectiveCollectionId;
  declare collectionRunnerRequests: typeof collectionRunnerDerivedFeature.collectionRunnerRequests;
  declare collectionRunnerFilteredRequests: typeof collectionRunnerDerivedFeature.collectionRunnerFilteredRequests;
  declare collectionRunnerSelectableRequests: typeof collectionRunnerDerivedFeature.collectionRunnerSelectableRequests;
  declare collectionRunnerSelectedRequests: typeof collectionRunnerDerivedFeature.collectionRunnerSelectedRequests;
  declare collectionRunnerSelectedCount: typeof collectionRunnerDerivedFeature.collectionRunnerSelectedCount;
  declare collectionRunnerRunIterations: typeof collectionRunnerDerivedFeature.collectionRunnerRunIterations;
  declare collectionRunnerSummary: typeof collectionRunnerDerivedFeature.collectionRunnerSummary;

  declare collectionRunnerDefaultCollectionId: typeof collectionRunnerFeature.collectionRunnerDefaultCollectionId;
  declare collectionRunnerFilterTokens: typeof collectionRunnerFeature.collectionRunnerFilterTokens;
  declare collectionRunnerRequestTags: typeof collectionRunnerFeature.collectionRunnerRequestTags;
  declare collectionRunnerRequestMatchesFilters: typeof collectionRunnerFeature.collectionRunnerRequestMatchesFilters;
  declare ensureCollectionRunnerCollection: typeof collectionRunnerFeature.ensureCollectionRunnerCollection;
  declare openCollectionRunner: typeof collectionRunnerFeature.openCollectionRunner;
  declare closeCollectionRunnerTab: typeof collectionRunnerFeature.closeCollectionRunnerTab;
  declare setCollectionRunnerCollection: typeof collectionRunnerFeature.setCollectionRunnerCollection;
  declare showCollectionLastRun: typeof collectionRunnerFeature.showCollectionLastRun;
  declare setCollectionRunnerDelayMs: typeof collectionRunnerFeature.setCollectionRunnerDelayMs;
  declare setCollectionRunnerIterations: typeof collectionRunnerFeature.setCollectionRunnerIterations;
  declare selectCollectionRunnerDataFile: typeof collectionRunnerFeature.selectCollectionRunnerDataFile;
  declare clearCollectionRunnerDataFile: typeof collectionRunnerFeature.clearCollectionRunnerDataFile;
  declare setCollectionRunnerIncludeTags: typeof collectionRunnerFeature.setCollectionRunnerIncludeTags;
  declare setCollectionRunnerExcludeTags: typeof collectionRunnerFeature.setCollectionRunnerExcludeTags;
  declare setCollectionRunnerParallel: typeof collectionRunnerFeature.setCollectionRunnerParallel;
  declare setCollectionRunnerConcurrency: typeof collectionRunnerFeature.setCollectionRunnerConcurrency;
  declare selectAllCollectionRunnerRequests: typeof collectionRunnerFeature.selectAllCollectionRunnerRequests;
  declare deselectAllCollectionRunnerRequests: typeof collectionRunnerFeature.deselectAllCollectionRunnerRequests;
  declare toggleCollectionRunnerRequest: typeof collectionRunnerFeature.toggleCollectionRunnerRequest;
  declare resetCollectionRunner: typeof collectionRunnerFeature.resetCollectionRunner;
  declare startCollectionRunnerFromSelection: typeof collectionRunnerFeature.startCollectionRunnerFromSelection;
  declare runnerResultShell: typeof collectionRunnerFeature.runnerResultShell;
  declare runnerResultFromResponse: typeof collectionRunnerFeature.runnerResultFromResponse;
  declare runnerResultFromGrpcResponse: typeof collectionRunnerFeature.runnerResultFromGrpcResponse;
  declare buildCollectionRunnerSummary: typeof collectionRunnerFeature.buildCollectionRunnerSummary;
  declare updateCollectionRunnerResult: typeof collectionRunnerFeature.updateCollectionRunnerResult;
  declare downloadCollectionRunnerReport: typeof collectionRunnerFeature.downloadCollectionRunnerReport;
  declare runCollection: typeof collectionRunnerFeature.runCollection;
  declare runFolder: typeof collectionRunnerFeature.runFolder;
  declare waitForCollectionRunnerDelay: typeof collectionRunnerFeature.waitForCollectionRunnerDelay;
  declare executeCollectionRunnerRequest: typeof collectionRunnerFeature.executeCollectionRunnerRequest;
  declare startCollectionRunner: typeof collectionRunnerFeature.startCollectionRunner;
  declare stopCollectionRunner: typeof collectionRunnerFeature.stopCollectionRunner;
  declare closeCollectionRunner: typeof collectionRunnerFeature.closeCollectionRunner;

  declare currentRequestSettingsOverrides: typeof collectionDefaultsFeature.currentRequestSettingsOverrides;
  declare markRequestSettingOverride: typeof collectionDefaultsFeature.markRequestSettingOverride;
  declare applyCollectionVariableUpdates: typeof collectionDefaultsFeature.applyCollectionVariableUpdates;
  declare clearRequestSettingOverrides: typeof collectionDefaultsFeature.clearRequestSettingOverrides;
  declare collectionForRequest: typeof collectionDefaultsFeature.collectionForRequest;
  declare requestWithCollectionDefaults: typeof collectionDefaultsFeature.requestWithCollectionDefaults;
  declare activeRequestCollection: typeof collectionDefaultsFeature.activeRequestCollection;
  declare previewNames: typeof collectionDefaultsFeature.previewNames;
  declare maskedProxyUrl: typeof collectionDefaultsFeature.maskedProxyUrl;
  declare collectionSettingDisplayName: typeof collectionDefaultsFeature.collectionSettingDisplayName;
  declare collectionSettingDisplayValue: typeof collectionDefaultsFeature.collectionSettingDisplayValue;
  declare collectionSettingHasCustomDefault: typeof collectionDefaultsFeature.collectionSettingHasCustomDefault;
  declare collectionSettingIsInherited: typeof collectionDefaultsFeature.collectionSettingIsInherited;
  declare collectionSettingDefaultNote: typeof collectionDefaultsFeature.collectionSettingDefaultNote;
  declare appliedCollectionDefaultNotes: typeof collectionDefaultsFeature.appliedCollectionDefaultNotes;

  declare toggleCollectionCollapsed: typeof collectionFeature.toggleCollectionCollapsed;
  declare createCollection: typeof collectionFeature.createCollection;
  declare renameCollection: typeof collectionFeature.renameCollection;
  declare openCollectionSettings: typeof collectionFeature.openCollectionSettings;
  declare closeCollectionSettingsTab: typeof collectionFeature.closeCollectionSettingsTab;
  declare collectionRequestCount: typeof collectionFeature.collectionRequestCount;
  declare saveCollectionSettings: typeof collectionFeature.saveCollectionSettings;
  declare resetCollectionSettings: typeof collectionFeature.resetCollectionSettings;
  declare deleteCollection: typeof collectionFeature.deleteCollection;
  declare moveCollection: typeof collectionFeature.moveCollection;
  declare invalidCollectionFromDiagnostic: typeof collectionFeature.invalidCollectionFromDiagnostic;
  declare invalidRequestFromDiagnostic: typeof collectionFeature.invalidRequestFromDiagnostic;
  declare buildCollectionGroups: typeof collectionFeature.buildCollectionGroups;
  declare allFolderGroups: typeof collectionFeature.allFolderGroups;
  declare expandActiveCollection: typeof collectionFeature.expandActiveCollection;
  declare collapseActiveCollection: typeof collectionFeature.collapseActiveCollection;
  declare expandAllCollections: typeof collectionFeature.expandAllCollections;
  declare collapseAllCollections: typeof collectionFeature.collapseAllCollections;

  declare folderCollapseKey: typeof folderFeature.folderCollapseKey;
  declare folderDisplayName: typeof folderFeature.folderDisplayName;
  declare folderPathMatches: typeof folderFeature.folderPathMatches;
  declare folderPathEquals: typeof folderFeature.folderPathEquals;
  declare folderRequestCount: typeof folderFeature.folderRequestCount;
  declare toggleFolderCollapsed: typeof folderFeature.toggleFolderCollapsed;
  declare createRequestInFolder: typeof folderFeature.createRequestInFolder;
  declare createSubfolder: typeof folderFeature.createSubfolder;
  declare createFolderInCollection: typeof folderFeature.createFolderInCollection;
  declare renameFolder: typeof folderFeature.renameFolder;
  declare deleteFolder: typeof folderFeature.deleteFolder;

  declare openFindReplace: typeof findReplaceFeature.openFindReplace;
  declare closeFindReplace: typeof findReplaceFeature.closeFindReplace;
  declare findReplaceScopeLabel: typeof findReplaceFeature.findReplaceScopeLabel;
  declare findReplaceRequests: typeof findReplaceFeature.findReplaceRequests;
  declare findReplaceUnsavedIds: typeof findReplaceFeature.findReplaceUnsavedIds;
  declare applyFindReplace: typeof findReplaceFeature.applyFindReplace;
  declare undoFindReplace: typeof findReplaceFeature.undoFindReplace;

  declare currentGraphQLPayload: typeof graphqlFeature.currentGraphQLPayload;
  declare graphQLBodyContentForStore: typeof graphqlFeature.graphQLBodyContentForStore;
  declare graphQLBodyForSend: typeof graphqlFeature.graphQLBodyForSend;
  declare graphQLPayloadFromRequest: typeof graphqlFeature.graphQLPayloadFromRequest;
  declare graphQLPayloadError: typeof graphqlFeature.graphQLPayloadError;
  declare graphQLExplorerFields: typeof graphqlFeature.graphQLExplorerFields;
  declare applyGraphQLExplorerField: typeof graphqlFeature.applyGraphQLExplorerField;
  declare beautifyGraphQLQuery: typeof graphqlFeature.beautifyGraphQLQuery;
  declare graphQLPayloadHasContent: typeof graphqlFeature.graphQLPayloadHasContent;
  declare fetchGraphQLSchemaUrl: typeof graphqlFeature.fetchGraphQLSchemaUrl;
  declare importGraphQLSchemaText: typeof graphqlFeature.importGraphQLSchemaText;
  declare importGraphQLSchemaFromUrl: typeof graphqlFeature.importGraphQLSchemaFromUrl;
  declare importGraphQLSchemaFromFile: typeof graphqlFeature.importGraphQLSchemaFromFile;
  declare fetchGraphQLSchema: typeof graphqlFeature.fetchGraphQLSchema;
  declare clearGraphQLSchema: typeof graphqlFeature.clearGraphQLSchema;

  declare buildGrpcRequest: typeof grpcFeature.buildGrpcRequest;
  declare importGrpcProtoFile: typeof grpcFeature.importGrpcProtoFile;
  declare setGrpcProtoFilePath: typeof grpcFeature.setGrpcProtoFilePath;
  declare addGrpcProtoImportPath: typeof grpcFeature.addGrpcProtoImportPath;
  declare removeGrpcProtoImportPath: typeof grpcFeature.removeGrpcProtoImportPath;
  declare clearGrpcProtoFile: typeof grpcFeature.clearGrpcProtoFile;
  declare grpcSelectableMethods: typeof grpcFeature.grpcSelectableMethods;
  declare grpcMethodIsReflection: typeof grpcFeature.grpcMethodIsReflection;
  declare grpcMethodLabel: typeof grpcFeature.grpcMethodLabel;
  declare selectGrpcMethod: typeof grpcFeature.selectGrpcMethod;
  declare grpcExampleMessageForMethod: typeof grpcFeature.grpcExampleMessageForMethod;
  declare useGrpcExampleMessage: typeof grpcFeature.useGrpcExampleMessage;
  declare grpcEmptyMethodInfo: typeof grpcFeature.grpcEmptyMethodInfo;
  declare grpcSelectedMethodInfo: typeof grpcFeature.grpcSelectedMethodInfo;
  declare setActiveGrpcResponse: typeof grpcFeature.setActiveGrpcResponse;
  declare setActiveGrpcResponseTab: typeof grpcFeature.setActiveGrpcResponseTab;
  declare emptyGrpcResponse: typeof grpcFeature.emptyGrpcResponse;
  declare grpcBodyFromMessages: typeof grpcFeature.grpcBodyFromMessages;
  declare ensureActiveGrpcResponse: typeof grpcFeature.ensureActiveGrpcResponse;
  declare applyGrpcHeadersEvent: typeof grpcFeature.applyGrpcHeadersEvent;
  declare applyGrpcMessageEvent: typeof grpcFeature.applyGrpcMessageEvent;
  declare applyGrpcTrailersEvent: typeof grpcFeature.applyGrpcTrailersEvent;
  declare applyGrpcDoneEvent: typeof grpcFeature.applyGrpcDoneEvent;
  declare discoverGrpcServices: typeof grpcFeature.discoverGrpcServices;
  declare invokeGrpc: typeof grpcFeature.invokeGrpc;
  declare initGrpcListeners: typeof grpcFeature.initGrpcListeners;
  declare setActiveMcpResponse: typeof mcpFeature.setActiveMcpResponse;
  declare mcpSelectableTools: typeof mcpFeature.mcpSelectableTools;
  declare mcpSelectedTool: typeof mcpFeature.mcpSelectedTool;
  declare mcpSelectedToolRejection: typeof mcpFeature.mcpSelectedToolRejection;
  declare selectMcpTool: typeof mcpFeature.selectMcpTool;
  declare selectMcpMethod: typeof mcpFeature.selectMcpMethod;
  declare mcpArgumentsError: typeof mcpFeature.mcpArgumentsError;
  declare discoverMcpServer: typeof mcpFeature.discoverMcpServer;
  declare sendMcpCall: typeof mcpFeature.sendMcpCall;
  declare aiTurns: typeof aiFeature.aiTurns;
  declare setAiTurns: typeof aiFeature.setAiTurns;
  declare updateAiTurn: typeof aiFeature.updateAiTurn;
  declare clearAiConversation: typeof aiFeature.clearAiConversation;
  declare selectAiPreset: typeof aiFeature.selectAiPreset;
  declare aiCurrentPreset: typeof aiFeature.aiCurrentPreset;
  declare aiModelOptions: typeof aiFeature.aiModelOptions;
  declare loadAiModels: typeof aiFeature.loadAiModels;
  declare aiToolServerOptions: typeof aiFeature.aiToolServerOptions;
  declare toggleAiToolServer: typeof aiFeature.toggleAiToolServer;
  declare sendAiPrompt: typeof aiFeature.sendAiPrompt;
  declare initAiListeners: typeof aiFeature.initAiListeners;

  declare activePreRequestScript: typeof scriptsFeature.activePreRequestScript;
  declare activeTestScript: typeof scriptsFeature.activeTestScript;
  declare scriptFieldsForSend: typeof scriptsFeature.scriptFieldsForSend;

  declare bodyLang: typeof requestBodyFeature.bodyLang;
  declare bodyMode: typeof requestBodyFeature.bodyMode;
  declare setBodyMode: typeof requestBodyFeature.setBodyMode;
  declare setRawBodyType: typeof requestBodyFeature.setRawBodyType;
  declare bodyModeIs: typeof requestBodyFeature.bodyModeIs;
  declare rawTypeLabel: typeof requestBodyFeature.rawTypeLabel;
  declare webSocketMessageBodyType: typeof requestBodyFeature.webSocketMessageBodyType;
  declare webSocketMessageTypeLabel: typeof requestBodyFeature.webSocketMessageTypeLabel;
  declare setWebSocketMessageBodyType: typeof requestBodyFeature.setWebSocketMessageBodyType;
  declare selectedExample: typeof examplesFeature.selectedExample;
  declare selectExample: typeof examplesFeature.selectExample;
  declare saveResponseAsExample: typeof examplesFeature.saveResponseAsExample;
  declare renameExample: typeof examplesFeature.renameExample;
  declare deleteExample: typeof examplesFeature.deleteExample;
  declare moveExample: typeof examplesFeature.moveExample;
  declare updateExample: typeof examplesFeature.updateExample;
  declare updateExampleResponse: typeof examplesFeature.updateExampleResponse;
  declare exampleWarning: typeof examplesFeature.exampleWarning;
  declare requestBodyPlaceholder: typeof requestBodyFeature.requestBodyPlaceholder;
  declare webSocketMessagePlaceholder: typeof requestBodyFeature.webSocketMessagePlaceholder;
  declare bodyHasContent: typeof requestBodyFeature.bodyHasContent;
  declare bodyBadgeLabel: typeof requestBodyFeature.bodyBadgeLabel;
  declare resetBodyState: typeof requestBodyFeature.resetBodyState;
  declare setFormRowKind: typeof requestBodyFeature.setFormRowKind;
  declare markBodyFormatted: typeof requestBodyFeature.markBodyFormatted;
  declare registerBodyEditorFormat: typeof requestBodyFeature.registerBodyEditorFormat;
  declare beautifyBody: typeof requestBodyFeature.beautifyBody;
  declare stripBodyComments: typeof requestBodyFeature.stripBodyComments;
  declare requestBodyForSend: typeof requestBodyFeature.requestBodyForSend;
  declare bodyContentType: typeof requestBodyFeature.bodyContentType;
  declare bodyLengthLabel: typeof requestBodyFeature.bodyLengthLabel;
  declare pickFileForRow: typeof requestBodyFeature.pickFileForRow;
  declare pickBinaryFile: typeof requestBodyFeature.pickBinaryFile;
  declare applyParsedCurl: typeof requestBodyFeature.applyParsedCurl;
  declare onUrlPaste: typeof requestBodyFeature.onUrlPaste;
  declare syncUrlFromParams: typeof requestBodyFeature.syncUrlFromParams;
  declare syncParamsFromUrl: typeof requestBodyFeature.syncParamsFromUrl;

  declare openRequests: typeof requestCrudFeature.openRequests;
  declare openRequestsForTabs: typeof requestCrudFeature.openRequestsForTabs;
  declare activeRequest: typeof requestCrudFeature.activeRequest;
  declare activeRequestIsDirty: typeof requestCrudFeature.activeRequestIsDirty;
  declare activeRequestCanRevert: typeof requestCrudFeature.activeRequestCanRevert;
  declare requestTypeEditable: typeof requestCrudFeature.requestTypeEditable;
  declare pinnedRequests: typeof requestCrudFeature.pinnedRequests;
  declare requestsForDisplay: typeof requestCrudFeature.requestsForDisplay;
  declare isRequestType: typeof requestCrudFeature.isRequestType;
  declare normalizeRequestTypeValue: typeof requestCrudFeature.normalizeRequestTypeValue;
  declare savedRequestIsWebSocket: typeof requestCrudFeature.savedRequestIsWebSocket;
  declare savedRequestIsRealtime: typeof requestCrudFeature.savedRequestIsRealtime;
  declare savedRequestIsRunnerSkipped: typeof requestCrudFeature.savedRequestIsRunnerSkipped;
  declare savedRequestIsGraphQL: typeof requestCrudFeature.savedRequestIsGraphQL;
  declare requestTypeLabel: typeof requestCrudFeature.requestTypeLabel;
  declare requestHeaderName: typeof requestCrudFeature.requestHeaderName;
  declare setRequestHeaderName: typeof requestCrudFeature.setRequestHeaderName;
  declare commitRequestHeaderName: typeof requestCrudFeature.commitRequestHeaderName;
  declare selectRequestType: typeof requestCrudFeature.selectRequestType;
  declare createNewRequest: typeof requestCrudFeature.createNewRequest;
  declare createDraftRequest: typeof requestCrudFeature.createDraftRequest;
  declare saveDraftToCollection: typeof requestCrudFeature.saveDraftToCollection;
  declare discardDraftRequest: typeof requestCrudFeature.discardDraftRequest;
  declare openDraftRequests: typeof requestCrudFeature.openDraftRequests;
  declare hasUnsavedDrafts: typeof requestCrudFeature.hasUnsavedDrafts;
  declare hasUnsavedRequestChanges: typeof requestCrudFeature.hasUnsavedRequestChanges;
  declare reviewDraftsBeforeQuit: typeof requestCrudFeature.reviewDraftsBeforeQuit;
  declare switchRequest: typeof requestCrudFeature.switchRequest;
  declare closeRequestTab: typeof requestCrudFeature.closeRequestTab;
  declare closeActiveRequestTab: typeof requestCrudFeature.closeActiveRequestTab;
  declare closeRequestTabs: typeof requestCrudFeature.closeRequestTabs;
  declare closeOtherRequestTabs: typeof requestCrudFeature.closeOtherRequestTabs;
  declare closeAllRequestTabs: typeof requestCrudFeature.closeAllRequestTabs;
  declare closeActiveTab: typeof requestCrudFeature.closeActiveTab;
  declare switchOpenTabByOffset: typeof requestCrudFeature.switchOpenTabByOffset;
  declare switchOpenTabAt: typeof requestCrudFeature.switchOpenTabAt;
  declare switchLastOpenTab: typeof requestCrudFeature.switchLastOpenTab;
  declare reopenLastClosedTab: typeof requestCrudFeature.reopenLastClosedTab;
  declare visibleSidebarRequests: typeof requestCrudFeature.visibleSidebarRequests;
  declare switchSidebarItem: typeof requestCrudFeature.switchSidebarItem;
  declare renameRequest: typeof requestCrudFeature.renameRequest;
  declare duplicateRequest: typeof requestCrudFeature.duplicateRequest;
  declare deleteRequest: typeof requestCrudFeature.deleteRequest;
  declare toggleRequestPinned: typeof requestCrudFeature.toggleRequestPinned;
  declare copyActiveRequestItem: typeof requestCrudFeature.copyActiveRequestItem;
  declare pasteCopiedRequestItem: typeof requestCrudFeature.pasteCopiedRequestItem;

  declare savedRequestSnapshot: typeof requestDirtyFeature.savedRequestSnapshot;
  declare requestForEditing: typeof requestDirtyFeature.requestForEditing;
  declare requestDirtyFingerprint: typeof requestDirtyFeature.requestDirtyFingerprint;
  declare requestDiffersFromSaved: typeof requestDirtyFeature.requestDiffersFromSaved;
  declare requestDiffersFromStored: typeof requestDirtyFeature.requestDiffersFromStored;
  declare syncDirtyRequestIds: typeof requestDirtyFeature.syncDirtyRequestIds;
  declare syncManualRequestSnapshotState: typeof requestDirtyFeature.syncManualRequestSnapshotState;
  declare isRequestDirty: typeof requestDirtyFeature.isRequestDirty;
  declare removeDirtyRequest: typeof requestDirtyFeature.removeDirtyRequest;
  declare updateRequestDirtyState: typeof requestDirtyFeature.updateRequestDirtyState;
  declare requestsForStore: typeof requestDirtyFeature.requestsForStore;
  declare recordSavedRequestSnapshots: typeof requestDirtyFeature.recordSavedRequestSnapshots;

  declare buildRequest: typeof requestExecutionFeature.buildRequest;
  declare runActiveRequest: typeof requestExecutionFeature.runActiveRequest;
  declare runActiveRequestAndDownload: typeof requestExecutionFeature.runActiveRequestAndDownload;
  declare send: typeof requestExecutionFeature.send;
  declare cancelActiveRequest: typeof requestExecutionFeature.cancelActiveRequest;

  declare environmentValuesForRequest: typeof requestSerializationFeature.environmentValuesForRequest;
  declare secretEnvironmentKeysForRequest: typeof requestSerializationFeature.secretEnvironmentKeysForRequest;
  declare secretEnvironmentValuesForRequest: typeof requestSerializationFeature.secretEnvironmentValuesForRequest;
  declare resolveProxyFields: typeof requestSerializationFeature.resolveProxyFields;
  declare savedRequestToHttpRequest: typeof requestSerializationFeature.savedRequestToHttpRequest;
  declare savedRequestToRunnableHttpRequest: typeof requestSerializationFeature.savedRequestToRunnableHttpRequest;
  declare savedRequestToRunnableGrpcRequest: typeof requestSerializationFeature.savedRequestToRunnableGrpcRequest;
  declare savedRequestToRunnableMcpRequest: typeof requestSerializationFeature.savedRequestToRunnableMcpRequest;
  declare savedRequestToRunnableAiRequest: typeof requestSerializationFeature.savedRequestToRunnableAiRequest;
  declare normalizeRequestUrlForSend: typeof requestSerializationFeature.normalizeRequestUrlForSend;
  declare normalizeWebSocketUrlForSend: typeof requestSerializationFeature.normalizeWebSocketUrlForSend;

  declare requestEditSignal: typeof requestStateFeature.requestEditSignal;
  declare markRequestLoading: typeof requestStateFeature.markRequestLoading;
  declare requestIsActive: typeof requestStateFeature.requestIsActive;
  declare blankSavedRequest: typeof requestStateFeature.blankSavedRequest;
  declare snapshotActiveRequest: typeof requestStateFeature.snapshotActiveRequest;
  declare currentRequestName: typeof requestStateFeature.currentRequestName;
  declare snapshotRequestName: typeof requestStateFeature.snapshotRequestName;
  declare requestHasContent: typeof requestStateFeature.requestHasContent;
  declare applySavedRequest: typeof requestStateFeature.applySavedRequest;
  declare normalizeSavedRequestCtx: typeof requestStateFeature.normalizeSavedRequestCtx;

  declare autoRequestHeaders: typeof requestHeadersFeature.autoRequestHeaders;
  declare requestHeaderCount: typeof requestHeadersFeature.requestHeaderCount;
  declare hasEnabledHeader: typeof requestHeadersFeature.hasEnabledHeader;
  declare headerValidationErrorForRequest: typeof requestHeadersFeature.headerValidationErrorForRequest;
  declare buildAutoRequestHeaders: typeof requestHeadersFeature.buildAutoRequestHeaders;
  declare onHeaderKeyInput: typeof requestHeadersFeature.onHeaderKeyInput;

  declare setSaveStatus: typeof requestPersistenceFeature.setSaveStatus;
  declare flushPendingPersist: typeof requestPersistenceFeature.flushPendingPersist;
  declare requestStorePayload: typeof requestPersistenceFeature.requestStorePayload;
  declare persistRequestStore: typeof requestPersistenceFeature.persistRequestStore;
  declare persistRequestStoreView: typeof requestPersistenceFeature.persistRequestStoreView;
  declare scheduleRequestStorePersist: typeof requestPersistenceFeature.scheduleRequestStorePersist;
  declare persistActiveRequestNow: typeof requestPersistenceFeature.persistActiveRequestNow;
  declare saveActiveRequest: typeof requestPersistenceFeature.saveActiveRequest;
  declare saveRequestById: typeof requestPersistenceFeature.saveRequestById;
  declare saveDirtyRequestsToDisk: typeof requestPersistenceFeature.saveDirtyRequestsToDisk;
  declare savedRequestSnapshotFromStore: typeof requestPersistenceFeature.savedRequestSnapshotFromStore;
  declare discardRequestChanges: typeof requestPersistenceFeature.discardRequestChanges;
  declare revertActiveRequestChanges: typeof requestPersistenceFeature.revertActiveRequestChanges;
  declare scheduleActiveRequestPersist: typeof requestPersistenceFeature.scheduleActiveRequestPersist;

  declare snippetText: typeof snippetsFeature.snippetText;
  declare snippetRenderedLines: typeof snippetsFeature.snippetRenderedLines;
  declare refreshSnippet: typeof snippetsFeature.refreshSnippet;
  declare buildSnippetRequest: typeof snippetsFeature.buildSnippetRequest;
  declare copySnippet: typeof snippetsFeature.copySnippet;

  declare responseTestSummary: typeof responseFeature.responseTestSummary;
  declare grpcResponseTestSummary: typeof responseFeature.grpcResponseTestSummary;
  declare responseDisplayBody: typeof responseFeature.responseDisplayBody;
  declare responseBodyIsPaged: typeof responseFeature.responseBodyIsPaged;
  declare responseBodyVirtualized: typeof responseFeature.responseBodyVirtualized;
  declare responseBodyPageCount: typeof responseFeature.responseBodyPageCount;
  declare responseBodyPageLabel: typeof responseFeature.responseBodyPageLabel;
  declare responseRenderMode: typeof responseFeature.responseRenderMode;
  declare safeResponseSearchIndex: typeof responseFeature.safeResponseSearchIndex;
  declare isJsonResponse: typeof responseFeature.isJsonResponse;
  declare isHtmlResponse: typeof responseFeature.isHtmlResponse;
  declare isEventStreamResponse: typeof responseFeature.isEventStreamResponse;
  declare responseFullBody: typeof responseFeature.responseFullBody;
  declare responseRawBody: typeof responseFeature.responseRawBody;
  declare formatResponseBody: typeof responseFeature.formatResponseBody;
  declare testSummary: typeof responseFeature.testSummary;
  declare setActiveResponse: typeof responseFeature.setActiveResponse;
  declare setActiveResponseTab: typeof responseFeature.setActiveResponseTab;
  declare previousResponse: typeof responseFeature.previousResponse;
  declare diffBaselineExampleId: typeof responseFeature.diffBaselineExampleId;
  declare setDiffBaselineExample: typeof responseFeature.setDiffBaselineExample;
  declare diffBaselineResponse: typeof responseFeature.diffBaselineResponse;
  declare diffBaselineLabel: typeof responseFeature.diffBaselineLabel;
  declare diffBaselineOptions: typeof responseFeature.diffBaselineOptions;
  declare responseDiff: typeof responseFeature.responseDiff;
  declare clearResponseDiffBaseline: typeof responseFeature.clearResponseDiffBaseline;
  declare toggleResponseSearch: typeof responseFeature.toggleResponseSearch;
  declare scheduleResponseSearchCount: typeof responseFeature.scheduleResponseSearchCount;
  declare scrollCurrentSearchMatch: typeof responseFeature.scrollCurrentSearchMatch;
  declare nextResponseMatch: typeof responseFeature.nextResponseMatch;
  declare prevResponseMatch: typeof responseFeature.prevResponseMatch;
  declare setResponseBodyPage: typeof responseFeature.setResponseBodyPage;
  declare previousResponseBodyPage: typeof responseFeature.previousResponseBodyPage;
  declare nextResponseBodyPage: typeof responseFeature.nextResponseBodyPage;
  declare onResponseSearchKeydown: typeof responseFeature.onResponseSearchKeydown;
  declare clampResponseSearchIndex: typeof responseFeature.clampResponseSearchIndex;
  declare copyResponseBody: typeof responseFeature.copyResponseBody;
  declare copyGrpcResponseBody: typeof responseFeature.copyGrpcResponseBody;
  declare copyVisibleResponseOrError: typeof responseFeature.copyVisibleResponseOrError;
  declare saveResponseFile: typeof responseFeature.saveResponseFile;
  declare saveGrpcResponseFile: typeof responseFeature.saveGrpcResponseFile;
  declare loadResponseFromFile: typeof responseFeature.loadResponseFromFile;

  declare authLabel: typeof authFeature.authLabel;
  declare currentAuthState: typeof authFeature.currentAuthState;
  declare selectAuthType: typeof authFeature.selectAuthType;
  declare authHasConfig: typeof authFeature.authHasConfig;
  declare authStateHasData: typeof authFeature.authStateHasData;
  declare authForPersistence: typeof authFeature.authForPersistence;
  declare basicAuthPreview: typeof authFeature.basicAuthPreview;
  declare oauth2ConfigForRequest: typeof authFeature.oauth2ConfigForRequest;
  declare oauth2ConfigForAuthState: typeof authFeature.oauth2ConfigForAuthState;
  declare applyOAuth2Result: typeof authFeature.applyOAuth2Result;
  declare fetchOAuth2Token: typeof authFeature.fetchOAuth2Token;
  declare refreshOAuth2Token: typeof authFeature.refreshOAuth2Token;
  declare ensureValidOAuth2Token: typeof authFeature.ensureValidOAuth2Token;
  declare ensureValidOAuth2TokenForRequest: typeof authFeature.ensureValidOAuth2TokenForRequest;

  declare openPostmanImport: typeof importExportFeature.openPostmanImport;
  declare onPostmanImportFile: typeof importExportFeature.onPostmanImportFile;
  declare importCollectionPayload: typeof importExportFeature.importCollectionPayload;
  declare importBrunoOpenCollectionFolder: typeof importExportFeature.importBrunoOpenCollectionFolder;
  declare importOpenCollectionFiles: typeof importExportFeature.importOpenCollectionFiles;
  declare importHarPayload: typeof importExportFeature.importHarPayload;
  declare importRequestsPayload: typeof importExportFeature.importRequestsPayload;
  declare importCollectionBundle: typeof importExportFeature.importCollectionBundle;
  declare importPostmanVariableBundle: typeof importExportFeature.importPostmanVariableBundle;
  declare importPostmanPayload: typeof importExportFeature.importPostmanPayload;
  declare importInsomniaPayload: typeof importExportFeature.importInsomniaPayload;
  declare importOpenApiPayload: typeof importExportFeature.importOpenApiPayload;
  declare importOpenApiFromUrl: typeof importExportFeature.importOpenApiFromUrl;
  declare openOpenApiUrlImport: typeof importExportFeature.openOpenApiUrlImport;
  declare importHttpFilePayload: typeof importExportFeature.importHttpFilePayload;
  declare exportCollection: typeof importExportFeature.exportCollection;
  declare exportCollectionToOpenCollection: typeof importExportFeature.exportCollectionToOpenCollection;
  declare exportCollectionToPostman: typeof importExportFeature.exportCollectionToPostman;
  declare exportCollectionToInsomnia: typeof importExportFeature.exportCollectionToInsomnia;
  declare exportCollectionToOpenApi: typeof importExportFeature.exportCollectionToOpenApi;
  declare chooseCollectionSecretExportMode: typeof importExportFeature.chooseCollectionSecretExportMode;
  declare exportEnvironmentToPostman: typeof importExportFeature.exportEnvironmentToPostman;

  declare showDataTransferStatus: typeof dataBackupFeature.showDataTransferStatus;
  declare kurloBackupPayload: typeof dataBackupFeature.kurloBackupPayload;
  declare requestStoreLooksImportable: typeof dataBackupFeature.requestStoreLooksImportable;
  declare parseAllDataBackup: typeof dataBackupFeature.parseAllDataBackup;
  declare applyImportedPreferences: typeof dataBackupFeature.applyImportedPreferences;
  declare exportAllData: typeof dataBackupFeature.exportAllData;
  declare importAllDataPayload: typeof dataBackupFeature.importAllDataPayload;
  declare importAllData: typeof dataBackupFeature.importAllData;

  declare scheduleGitStatusRefreshAfterPersist: typeof gitFeature.scheduleGitStatusRefreshAfterPersist;
  declare refreshGitStatusAfterPersist: typeof gitFeature.refreshGitStatusAfterPersist;
  declare refreshGitStatus: typeof gitFeature.refreshGitStatus;
  declare selectGitFile: typeof gitFeature.selectGitFile;
  declare refreshGitQuietly: typeof gitFeature.refreshGitQuietly;
  declare loadMoreGitLog: typeof gitFeature.loadMoreGitLog;
  declare selectGitCommit: typeof gitFeature.selectGitCommit;
  declare loadGitConflictFile: typeof gitFeature.loadGitConflictFile;
  declare showGitToast: typeof gitFeature.showGitToast;
  declare showGitPullToast: typeof gitFeature.showGitPullToast;
  declare applyGitOperationResult: typeof gitFeature.applyGitOperationResult;
  declare beginGitMutation: typeof gitFeature.beginGitMutation;
  declare refreshGitBranches: typeof gitFeature.refreshGitBranches;
  declare openGitWorkspace: typeof gitFeature.openGitWorkspace;
  declare openGitTab: typeof gitFeature.openGitTab;
  declare closeGitTab: typeof gitFeature.closeGitTab;
  declare cloneGitWorkspace: typeof gitFeature.cloneGitWorkspace;
  declare openGitAuthDialog: typeof gitFeature.openGitAuthDialog;
  declare resolveGitAuth: typeof gitFeature.resolveGitAuth;
  declare promptAndStoreGitAuth: typeof gitFeature.promptAndStoreGitAuth;
  declare afterGitAuthRetry: typeof gitFeature.afterGitAuthRetry;
  declare fetchGitWorkspace: typeof gitFeature.fetchGitWorkspace;
  declare pullGitWorkspace: typeof gitFeature.pullGitWorkspace;
  declare pullGitBranch: typeof gitFeature.pullGitBranch;
  declare resolveGitConflict: typeof gitFeature.resolveGitConflict;
  declare continueGitOperation: typeof gitFeature.continueGitOperation;
  declare abortGitOperation: typeof gitFeature.abortGitOperation;
  declare stashGitWorkspace: typeof gitFeature.stashGitWorkspace;
  declare popGitStash: typeof gitFeature.popGitStash;
  declare initGitWorkspace: typeof gitFeature.initGitWorkspace;
  declare addGitRemote: typeof gitFeature.addGitRemote;
  declare testGitRemote: typeof gitFeature.testGitRemote;
  declare checkoutGitBranch: typeof gitFeature.checkoutGitBranch;
  declare createGitBranch: typeof gitFeature.createGitBranch;
  declare createGitBranchFromRemote: typeof gitFeature.createGitBranchFromRemote;
  declare deleteGitBranch: typeof gitFeature.deleteGitBranch;
  declare renameGitBranch: typeof gitFeature.renameGitBranch;
  declare viewGitOutgoingChanges: typeof gitFeature.viewGitOutgoingChanges;
  declare discardSelectedGitFile: typeof gitFeature.discardSelectedGitFile;
  declare discardSelectedGitFiles: typeof gitFeature.discardSelectedGitFiles;
  declare discardGitWorkspaceChanges: typeof gitFeature.discardGitWorkspaceChanges;
  declare stageGitWorkspaceFiles: typeof gitFeature.stageGitWorkspaceFiles;
  declare commitGitWorkspace: typeof gitFeature.commitGitWorkspace;
  declare pushGitWorkspace: typeof gitFeature.pushGitWorkspace;
  declare pullThenPushGitWorkspace: typeof gitFeature.pullThenPushGitWorkspace;
  declare forcePushGitWorkspace: typeof gitFeature.forcePushGitWorkspace;

  declare closeFloatingMenus: typeof menuFeature.closeFloatingMenus;
  declare toggleRequestMenu: typeof menuFeature.toggleRequestMenu;
  declare toggleLoadTestMenu: typeof menuFeature.toggleLoadTestMenu;
  declare toggleCollectionMenu: typeof menuFeature.toggleCollectionMenu;
  declare toggleFolderMenu: typeof menuFeature.toggleFolderMenu;
  declare toggleHistoryHeaderMenu: typeof menuFeature.toggleHistoryHeaderMenu;
  declare toggleHistoryEntryMenu: typeof menuFeature.toggleHistoryEntryMenu;
  declare toggleWorkspaceMenu: typeof menuFeature.toggleWorkspaceMenu;
  declare toggleEnvironmentMenu: typeof menuFeature.toggleEnvironmentMenu;
  declare toggleAuthMenu: typeof menuFeature.toggleAuthMenu;
  declare toggleFormTypeMenu: typeof menuFeature.toggleFormTypeMenu;
  declare onWindowMouseDown: typeof menuFeature.onWindowMouseDown;

  declare openPromptDialog: typeof dialogFeature.openPromptDialog;
  declare openConfirmDialog: typeof dialogFeature.openConfirmDialog;
  declare openAlertDialog: typeof dialogFeature.openAlertDialog;
  declare openSelectDialog: typeof dialogFeature.openSelectDialog;
  declare openSaveChangesDialog: typeof dialogFeature.openSaveChangesDialog;
  declare altDialog: typeof dialogFeature.altDialog;
  declare dismissDialog: typeof dialogFeature.dismissDialog;
  declare cancelDialog: typeof dialogFeature.cancelDialog;
  declare submitDialog: typeof dialogFeature.submitDialog;
  declare dialogSelectLabel: typeof dialogFeature.dialogSelectLabel;
  declare chooseDialogOption: typeof dialogFeature.chooseDialogOption;
  declare moveDialogSelection: typeof dialogFeature.moveDialogSelection;
  declare onDialogSelectKeydown: typeof dialogFeature.onDialogSelectKeydown;
  declare onDialogKeydown: typeof dialogFeature.onDialogKeydown;

  declare currentRequestSettings: typeof preferencesFeature.currentRequestSettings;
  declare applyRequestSettings: typeof preferencesFeature.applyRequestSettings;
  declare loadRequestSettings: typeof preferencesFeature.loadRequestSettings;
  declare saveRequestSettings: typeof preferencesFeature.saveRequestSettings;
  declare resetRequestSettings: typeof preferencesFeature.resetRequestSettings;
  declare toggleSSLVerification: typeof preferencesFeature.toggleSSLVerification;
  declare pickClientCertFile: typeof preferencesFeature.pickClientCertFile;
  declare clearClientCertField: typeof preferencesFeature.clearClientCertField;
  declare loadShortcutSettings: typeof preferencesFeature.loadShortcutSettings;
  declare saveShortcutSettings: typeof preferencesFeature.saveShortcutSettings;
  declare shortcutCombo: typeof preferencesFeature.shortcutCombo;
  declare shortcutGroups: typeof preferencesFeature.shortcutGroups;
  declare shortcutKeyLabel: typeof preferencesFeature.shortcutKeyLabel;
  declare normalizeShortcutKey: typeof preferencesFeature.normalizeShortcutKey;
  declare eventToCombo: typeof preferencesFeature.eventToCombo;
  declare shortcutForEvent: typeof preferencesFeature.shortcutForEvent;
  declare setShortcut: typeof preferencesFeature.setShortcut;
  declare resetShortcut: typeof preferencesFeature.resetShortcut;
  declare resetAllShortcuts: typeof preferencesFeature.resetAllShortcuts;
  declare startShortcutCapture: typeof preferencesFeature.startShortcutCapture;
  declare openShortcutHelp: typeof preferencesFeature.openShortcutHelp;
  declare closeShortcutHelp: typeof preferencesFeature.closeShortcutHelp;
  declare loadTheme: typeof preferencesFeature.loadTheme;
  declare applyTheme: typeof preferencesFeature.applyTheme;
  declare setTheme: typeof preferencesFeature.setTheme;
  declare setThemeMode: typeof preferencesFeature.setThemeMode;
  declare setThemeVariant: typeof preferencesFeature.setThemeVariant;
  declare loadAutosaveSettings: typeof preferencesFeature.loadAutosaveSettings;
  declare setAutosave: typeof preferencesFeature.setAutosave;
  declare loadStartupViewPreference: typeof preferencesFeature.loadStartupViewPreference;
  declare setStartupView: typeof preferencesFeature.setStartupView;
  declare readonly uiScale: number;
  declare setUiScale: typeof preferencesFeature.setUiScale;
  declare zoomIn: typeof preferencesFeature.zoomIn;
  declare zoomOut: typeof preferencesFeature.zoomOut;
  declare resetZoom: typeof preferencesFeature.resetZoom;
  declare loadProxyConfig: typeof preferencesFeature.loadProxyConfig;
  declare setProxyConfig: typeof preferencesFeature.setProxyConfig;
  declare loadScriptEngine: typeof preferencesFeature.loadScriptEngine;
  declare setScriptEngine: typeof preferencesFeature.setScriptEngine;

  declare pruneHistory: typeof historyFeature.pruneHistory;
  declare buildHistoryGroups: typeof historyFeature.buildHistoryGroups;
  declare toggleHistoryDay: typeof historyFeature.toggleHistoryDay;
  declare historyTitle: typeof historyFeature.historyTitle;
  declare recordRequestHistory: typeof historyFeature.recordRequestHistory;
  declare pruneStoredResponses: typeof historyFeature.pruneStoredResponses;
  declare showHistoryResponse: typeof historyFeature.showHistoryResponse;
  declare loadStoredHistoryResponse: typeof historyFeature.loadStoredHistoryResponse;
  declare saveHistoryEntryAsExample: typeof historyFeature.saveHistoryEntryAsExample;
  declare addCapturedExample: typeof examplesFeature.addCapturedExample;
  declare saveHistoryEntryToCollection: typeof historyFeature.saveHistoryEntryToCollection;
  declare saveHistoryEntryToNewCollection: typeof historyFeature.saveHistoryEntryToNewCollection;
  declare openHistoryEntry: typeof historyFeature.openHistoryEntry;
  declare deleteHistoryEntry: typeof historyFeature.deleteHistoryEntry;
  declare clearRequestHistory: typeof historyFeature.clearRequestHistory;
  declare historyDetailEntry: typeof historyFeature.historyDetailEntry;
  declare openHistoryDetail: typeof historyFeature.openHistoryDetail;
  declare closeHistoryDetail: typeof historyFeature.closeHistoryDetail;

  declare environmentLabel: typeof environmentFeature.environmentLabel;
  declare environmentValuesFor: typeof environmentFeature.environmentValuesFor;
  declare activeEnvironmentValues: typeof environmentFeature.activeEnvironmentValues;
  declare environmentVariableSuggestions: typeof environmentFeature.environmentVariableSuggestions;
  declare activeSecretEnvironmentKeys: typeof environmentFeature.activeSecretEnvironmentKeys;
  declare activeSecretEnvironmentValues: typeof environmentFeature.activeSecretEnvironmentValues;
  declare redactedActiveEnvironmentValues: typeof environmentFeature.redactedActiveEnvironmentValues;
  declare resolveTemplate: typeof environmentFeature.resolveTemplate;
  declare resolveRows: typeof environmentFeature.resolveRows;
  declare environmentHasValues: typeof environmentFeature.environmentHasValues;
  declare environmentValueCount: typeof environmentFeature.environmentValueCount;
  declare selectEnvironment: typeof environmentFeature.selectEnvironment;
  declare useEnvironment: typeof environmentFeature.useEnvironment;
  declare createEnvironment: typeof environmentFeature.createEnvironment;
  declare renameEnvironment: typeof environmentFeature.renameEnvironment;
  declare setEnvironmentProtected: typeof environmentFeature.setEnvironmentProtected;
  declare deleteEnvironment: typeof environmentFeature.deleteEnvironment;
  declare openEnvironment: typeof environmentFeature.openEnvironment;
  declare environmentRowsWithTrailing: typeof environmentFeature.environmentRowsWithTrailing;
  declare scheduleEnvironmentPersist: typeof environmentFeature.scheduleEnvironmentPersist;
  declare openGlobals: typeof globalsFeature.openGlobals;
  declare globalVariableRows: typeof globalsFeature.globalVariableRows;
  declare globalVariableValues: typeof globalsFeature.globalVariableValues;
  declare globalVariableCount: typeof globalsFeature.globalVariableCount;
  declare updateGlobalVariableRow: typeof globalsFeature.updateGlobalVariableRow;
  declare removeGlobalVariableRow: typeof globalsFeature.removeGlobalVariableRow;
  declare clearGlobalVariables: typeof globalsFeature.clearGlobalVariables;
  declare scheduleGlobalsPersist: typeof globalsFeature.scheduleGlobalsPersist;
  declare saveGlobals: typeof globalsFeature.saveGlobals;
  declare syncBackendGlobals: typeof globalsFeature.syncBackendGlobals;
  declare syncGlobalsFromBackend: typeof globalsFeature.syncGlobalsFromBackend;
  declare saveEnvironment: typeof environmentFeature.saveEnvironment;
  declare updateEnvironmentRow: typeof environmentFeature.updateEnvironmentRow;
  declare setEnvironmentView: typeof environmentFeature.setEnvironmentView;
  declare updateWorkspaceEnvironments: typeof environmentFeature.updateWorkspaceEnvironments;
  declare setEnvironmentMatrixValue: typeof environmentFeature.setEnvironmentMatrixValue;
  declare unsetEnvironmentMatrixValue: typeof environmentFeature.unsetEnvironmentMatrixValue;
  declare setEnvironmentVariableSecret: typeof environmentFeature.setEnvironmentVariableSecret;
  declare renameEnvironmentVariable: typeof environmentFeature.renameEnvironmentVariable;
  declare addEnvironmentVariable: typeof environmentFeature.addEnvironmentVariable;
  declare removeEnvironmentVariable: typeof environmentFeature.removeEnvironmentVariable;
  declare removeEnvironmentRow: typeof environmentFeature.removeEnvironmentRow;
  declare importEnvFromFile: typeof environmentFeature.importEnvFromFile;
  declare syncBackendEnvironment: typeof environmentFeature.syncBackendEnvironment;
  declare mergeActiveEnvironmentValues: typeof environmentFeature.mergeActiveEnvironmentValues;
  declare syncActiveEnvironmentFromBackend: typeof environmentFeature.syncActiveEnvironmentFromBackend;
  declare applyEnvironmentChangesFromResponse: typeof environmentFeature.applyEnvironmentChangesFromResponse;

  declare globalSearchResults: typeof uiShellFeature.globalSearchResults;
  declare codePanelAvailable: typeof uiShellFeature.codePanelAvailable;
  declare buildGlobalSearchResults: typeof uiShellFeature.buildGlobalSearchResults;
  declare openGlobalSearch: typeof uiShellFeature.openGlobalSearch;
  declare closeGlobalSearch: typeof uiShellFeature.closeGlobalSearch;
  declare openSettings: typeof uiShellFeature.openSettings;
  declare closeSettings: typeof uiShellFeature.closeSettings;
  declare startSidebarResize: typeof uiShellFeature.startSidebarResize;
  declare startPanelResize: typeof uiShellFeature.startPanelResize;
  declare startSplitResize: typeof uiShellFeature.startSplitResize;
  declare onSplitDividerKeydown: typeof uiShellFeature.onSplitDividerKeydown;
  declare setResponseLayout: typeof uiShellFeature.setResponseLayout;
  declare startCodePanelResize: typeof uiShellFeature.startCodePanelResize;
  declare startColResize: typeof uiShellFeature.startColResize;
  declare onWindowMouseMove: typeof uiShellFeature.onWindowMouseMove;
  declare onWindowMouseUp: typeof uiShellFeature.onWindowMouseUp;
  declare onPanelDividerKeydown: typeof uiShellFeature.onPanelDividerKeydown;
  declare onCodePanelDividerKeydown: typeof uiShellFeature.onCodePanelDividerKeydown;
  declare onSidebarDividerKeydown: typeof uiShellFeature.onSidebarDividerKeydown;
  declare focusSidebarSearch: typeof uiShellFeature.focusSidebarSearch;
  declare focusRequestUrl: typeof uiShellFeature.focusRequestUrl;
  declare isEditableTarget: typeof uiShellFeature.isEditableTarget;
  declare isKeyboardWidgetTarget: typeof uiShellFeature.isKeyboardWidgetTarget;
  declare isShortcutAllowedInEditable: typeof uiShellFeature.isShortcutAllowedInEditable;
  declare runShortcut: typeof uiShellFeature.runShortcut;
  declare showSidebarView: typeof uiShellFeature.showSidebarView;
  declare openEnvironmentPicker: typeof uiShellFeature.openEnvironmentPicker;
  declare copyActiveRequestCurl: typeof uiShellFeature.copyActiveRequestCurl;
  declare onKeydown: typeof uiShellFeature.onKeydown;

  declare workspaceBlocked: typeof workspaceDiagnosticsFeature.workspaceBlocked;
  declare workspaceGlobalBlockingDiagnostics: typeof workspaceDiagnosticsFeature.workspaceGlobalBlockingDiagnostics;
  declare workspaceBlockingDiagnostics: typeof workspaceDiagnosticsFeature.workspaceBlockingDiagnostics;
  declare workspaceDiagnosticScopeLabel: typeof workspaceDiagnosticsFeature.workspaceDiagnosticScopeLabel;
  declare workspaceDiagnosticKey: typeof workspaceDiagnosticsFeature.workspaceDiagnosticKey;
  declare workspaceDiagnosticLocation: typeof workspaceDiagnosticsFeature.workspaceDiagnosticLocation;
  declare workspaceDiagnosticTitle: typeof workspaceDiagnosticsFeature.workspaceDiagnosticTitle;
  declare workspaceDiagnosticSummary: typeof workspaceDiagnosticsFeature.workspaceDiagnosticSummary;
  declare workspaceDiagnosticIsGlobal: typeof workspaceDiagnosticsFeature.workspaceDiagnosticIsGlobal;
  declare workspaceDiagnosticTargetsWorkspace: typeof workspaceDiagnosticsFeature.workspaceDiagnosticTargetsWorkspace;
  declare workspaceBlockingDiagnosticsFor: typeof workspaceDiagnosticsFeature.workspaceBlockingDiagnosticsFor;
  declare workspaceIsBlocked: typeof workspaceDiagnosticsFeature.workspaceIsBlocked;
  declare guardWorkspaceListWritable: typeof workspaceDiagnosticsFeature.guardWorkspaceListWritable;
  declare workspaceBlockSummary: typeof workspaceDiagnosticsFeature.workspaceBlockSummary;
  declare showWorkspaceBlockedToast: typeof workspaceDiagnosticsFeature.showWorkspaceBlockedToast;
  declare guardWorkspaceWritable: typeof workspaceDiagnosticsFeature.guardWorkspaceWritable;
  declare guardGitWorkspaceMutable: typeof workspaceDiagnosticsFeature.guardGitWorkspaceMutable;
  declare diagnosticsForCollection: typeof workspaceDiagnosticsFeature.diagnosticsForCollection;
  declare diagnosticsForRequest: typeof workspaceDiagnosticsFeature.diagnosticsForRequest;
  declare openWorkspaceDiagnostic: typeof workspaceDiagnosticsFeature.openWorkspaceDiagnostic;
  declare openWorkspaceYAMLEditor: typeof workspaceDiagnosticsFeature.openWorkspaceYAMLEditor;
  declare closeWorkspaceYAMLEditor: typeof workspaceDiagnosticsFeature.closeWorkspaceYAMLEditor;
  declare saveWorkspaceYAMLEditor: typeof workspaceDiagnosticsFeature.saveWorkspaceYAMLEditor;
  declare invalidWorkspacesFromDiagnostics: typeof workspaceDiagnosticsFeature.invalidWorkspacesFromDiagnostics;
  declare initWorkspaceListeners: typeof workspaceDiagnosticsFeature.initWorkspaceListeners;
  declare externalWorkspacePendingMessage: typeof workspaceDiagnosticsFeature.externalWorkspacePendingMessage;
  declare showExternalWorkspacePendingToast: typeof workspaceDiagnosticsFeature.showExternalWorkspacePendingToast;
  declare markExternalWorkspaceChangePending: typeof workspaceDiagnosticsFeature.markExternalWorkspaceChangePending;
  declare clearExternalWorkspaceChangePending: typeof workspaceDiagnosticsFeature.clearExternalWorkspaceChangePending;
  declare refreshPendingExternalWorkspaceChangeIfClean: typeof workspaceDiagnosticsFeature.refreshPendingExternalWorkspaceChangeIfClean;
  declare reloadWorkspaceAfterExternalChange: typeof workspaceDiagnosticsFeature.reloadWorkspaceAfterExternalChange;
  declare handleExternalWorkspaceChange: typeof workspaceDiagnosticsFeature.handleExternalWorkspaceChange;

  declare defaultCollectionForWorkspace: typeof workspaceFeature.defaultCollectionForWorkspace;
  declare workspaceIdForCollection: typeof workspaceFeature.workspaceIdForCollection;
  declare activeCollectionId: typeof workspaceFeature.activeCollectionId;
  declare collectionNameById: typeof workspaceFeature.collectionNameById;
  declare workspaceRequestCountFor: typeof workspaceFeature.workspaceRequestCountFor;
  declare workspaceCollectionCountFor: typeof workspaceFeature.workspaceCollectionCountFor;
  declare workspaceRequestCount: typeof workspaceFeature.workspaceRequestCount;
  declare activeWorkspaceCollections: typeof workspaceFeature.activeWorkspaceCollections;
  declare switchWorkspace: typeof workspaceFeature.switchWorkspace;
  declare createWorkspace: typeof workspaceFeature.createWorkspace;
  declare updateWorkspaceDescription: typeof workspaceFeature.updateWorkspaceDescription;
  declare renameWorkspace: typeof workspaceFeature.renameWorkspace;
  declare deleteWorkspace: typeof workspaceFeature.deleteWorkspace;

  requestType = $state<RequestType>('http');
  requestName = $state('');
  requestNameAuto = $state(true);
  method = $state<Method>('GET');
  url = $state('https://jsonplaceholder.typicode.com/posts/1');
  requestTab = $state<RequestTab>('params');
  scriptTab = $state<ScriptTab>('pre-request');
  responseTab = $state<ResponseTab>('body');
  inFlightRequestIds = $state<Set<string>>(new Set());
  requestError = $state('');

  followRedirects = $state(true);
  timeoutMs = $state(30000);
  scriptTimeoutMs = $state(0);
  allowSendRequest = $state(false);
  httpVersion = $state<HttpVersion>('auto');
  enableSSLVerification = $state(true);
  followOriginalMethod = $state(false);
  followAuthorizationHeader = $state(false);
  removeRefererHeader = $state(false);
  encodeUrlAutomatically = $state(true);
  disableCookieJar = $state(false);
  maxRedirects = $state(10);
  proxyUrl = $state('');
  clientCertPath = $state('');
  clientKeyPath = $state('');
  clientKeyPassword = $state('');
  browserEmulation = $state(false);
  browserOrigin = $state('');
  browserWithCredentials = $state(false);
  browserEnforceCORS = $state(false);
  browserEnforceCSP = $state(false);
  browserCSP = $state('');
  proxyConfig = $state<ProxyConfig>({ ...DEFAULT_PROXY_CONFIG, auth: { ...DEFAULT_PROXY_CONFIG.auth } });
  wsHandshakeTimeoutMs = $state(0);
  wsReconnectAttempts = $state(0);
  wsReconnectIntervalMs = $state(5000);
  wsMaxMessageSizeMb = $state(10);
  wsKeepAliveIntervalMs = $state(0);
  sseDisableReconnect = $state(false);
  sseReconnectIntervalMs = $state(0);
  requestSettingsOverrides = $state<RequestSettingsOverrides>({});

  params = $state<KVRow[]>([mkRow()]);
  pathParams = $state<KVRow[]>([]);
  reqHeaders = $state<KVRow[]>([mkRow()]);
  formRows = $state<KVRow[]>([mkRow()]);
  bulkEditTables = $state<{ params: boolean; headers: boolean; form: boolean }>({ params: false, headers: false, form: false });

  authType = $state<AuthType>('none');
  bearerToken = $state('');
  basicUser = $state('');
  basicPass = $state('');
  apiKeyName = $state('X-API-Key');
  apiKeyValue = $state('');
  apiKeyIn = $state<'header' | 'query'>('header');
  oauth2GrantType = $state<OAuth2GrantType>('client_credentials');
  oauth2TokenURL = $state('');
  oauth2AuthURL = $state('');
  oauth2DeviceAuthURL = $state('');
  oauth2ClientID = $state('');
  oauth2Secret = $state('');
  oauth2Scope = $state('');
  oauth2Audience = $state('');
  oauth2Token = $state('');
  oauth2RefreshToken = $state('');
  oauth2TokenExpiry = $state(0);
  oauth2UsePKCE = $state(true);
  oauth2Loading = $state(false);
  oauth2Username = $state('');
  oauth2Password = $state('');
  oauth2ClientAuth = $state<OAuth2ClientAuth>('basic');
  oauth2AssertionAlgorithm = $state('');
  oauth2AssertionPrivateKey = $state('');
  oauth2AssertionKeyID = $state('');
  oauth2AssertionAudience = $state('');
  oauth2DevicePrompt = $state<OAuth2DevicePrompt | null>(null);
  awsAccessKey = $state('');
  awsSecretKey = $state('');
  awsSessionToken = $state('');
  awsRegion = $state('us-east-1');
  awsService = $state('execute-api');
  oauth1 = $state<OAuth1Fields>(oauth1FieldsFromAuth({}));

  bodyType = $state<BodyType>(INITIAL_BODY_DEFAULTS.bodyType);
  rawBodyType = $state<RawBodyType>(INITIAL_BODY_DEFAULTS.rawBodyType);
  bodyContent = $state(INITIAL_BODY_DEFAULTS.bodyContent);
  graphqlQuery = $state(DEFAULT_GRAPHQL_QUERY);
  graphqlVariables = $state(DEFAULT_GRAPHQL_VARIABLES);
  graphqlOperationName = $state('');
  graphqlSchema = $state('');
  graphqlSchemaLoading = $state(false);
  graphqlSchemaOperationToken = 0;
  graphqlSchemaStatus = $state('');
  graphqlSchemaError = $state('');
  bodyFilePath = $state('');
  bodyFileName = $state('');
  rawTypeMenuOpen = $state(false);
  authMenuOpen = $state(false);

  preRequestScript = $state('');
  testScript = $state('');
  preRequestScriptJs = $state('');
  testScriptJs = $state('');
  scriptEngine = $state<ScriptEngine>('js');
  requestNotes = $state('');
  requestExamples = $state<RequestExample[]>([]);
  selectedExampleId = $state('');

  responseSearchOpen = $state(false);
  responseSearch = $state('');
  responseSearchIndex = $state(0);
  responseSearchTotal = $state(0);
  responseSearchCounting = $state(false);
  response = $state<HttpResponse | null>(null);
  responses = $state<Map<string, HttpResponse>>(new Map());
  previousResponses = $state<Map<string, HttpResponse>>(new Map());
  diffBaselineExampleIds = $state<Map<string, string>>(new Map());
  responseTabs = $state<Map<string, ResponseTab>>(new Map());
  grpcResponse = $state<GrpcResponse | null>(null);
  grpcResponseTab = $state<GrpcResponseTab>('messages');
  grpcResponses = $state<Map<string, GrpcResponse>>(new Map());
  grpcResponseTabs = $state<Map<string, GrpcResponseTab>>(new Map());
  grpcServiceDefinition = $state<GrpcServiceDefinition>({ source: '', services: [], methods: [] });
  grpcServiceLoading = $state(false);
  grpcServiceOperationToken = 0;
  grpcServiceStatus = $state('');
  grpcServiceError = $state('');
  mcpResponse = $state<McpResponse | null>(null);
  mcpResponses = $state<Map<string, McpResponse>>(new Map());
  mcpCatalog = $state<McpResponse | null>(null);
  mcpCatalogLoading = $state(false);
  mcpCatalogError = $state('');
  mcpCatalogOperationToken = 0;
  aiConversations = $state<Map<string, AiTurn[]>>(new Map());
  aiModels = $state<Map<string, string[]>>(new Map());
  aiModelsLoading = $state(false);
  aiModelsError = $state<AiModelsProblem | null>(null);
  _responseSearchCountToken = 0;
  _responseSearchCountTimer: number | undefined = undefined;
  _responseSearchCountKey = '';
  _responseSearchCountSource = '';

  sseSessions = $state<Map<string, SSESession>>(new Map());
  _sseEntryCounter = 0;
  _ssePendingEvents = new Map<string, SSEEventEntry[]>();
  _sseFlushTimer: number | undefined = undefined;
  _sseStartedAt = new Map<string, number>();
  _sseHistoryRecorded = new Set<string>();
  _sseTouchedAt = new Map<string, number>();
  webSocketSessions = $state<Map<string, WebSocketSession>>(new Map());
  _wsEntryCounter = 0;
  _wsPendingMessages = new Map<string, WebSocketMessageEntry[]>();
  _wsFlushTimer: number | undefined = undefined;
  _wsStartedAt = new Map<string, number>();
  _wsHistoryRecorded = new Set<string>();
  _wsTouchedAt = new Map<string, number>();
  wsResponseTab = $state<'messages' | 'headers'>('messages');
  wsMessageTypeMenuOpen = $state(false);
  socketIOSessions = $state<Map<string, SocketIOSession>>(new Map());
  _sioEntryCounter = 0;
  _sioPendingMessages = new Map<string, SocketIOMessageEntry[]>();
  _sioFlushTimer: number | undefined = undefined;
  _sioStartedAt = new Map<string, number>();
  _sioHistoryRecorded = new Set<string>();
  _sioTouchedAt = new Map<string, number>();
  sioMessageTypeMenuOpen = $state(false);
  sioEventName = $state('');
  sioClientVersion = $state<SocketIOClientVersion>('v3');
  sioPath = $state('/socket.io');
  sioNamespace = $state('/');
  sioEvents = $state<KVRow[]>([mkSioEventRow()]);
  sioArgs = $state<SIOArg[]>(defaultSocketIOArgs());
  sioSelectedArgId = $state('1');
  sioAck = $state(false);
  grpcMethod = $state('');
  mcpMethod = $state('tools/list');
  mcpName = $state('');
  mcpArguments = $state('');
  mcpProtocolVersion = $state('');
  aiProvider = $state('');
  aiModel = $state('');
  aiSystem = $state('');
  aiPrompt = $state('');
  aiTemperature = $state('');
  aiTopP = $state('');
  aiMaxTokens = $state('');
  aiMaxSteps = $state('');
  aiIdleTimeoutSec = $state('');
  aiThinking = $state('');
  aiStream = $state(true);
  aiToolRequestIds = $state<string[]>([]);
  grpcMetadata = $state<KVRow[]>([mkRow()]);
  grpcUseReflection = $state(true);
  grpcProtoFilePath = $state('');
  grpcProtoFileName = $state('');
  grpcProtoImportPaths = $state<string[]>([]);
  grpcUseTls = $state(false);
  grpcServerName = $state('');
  grpcIncludeDefaultValues = $state(true);
  grpcMaxResponseMessageSizeMb = $state(10);
  appRuntime = $state('');
  appVersion = $state('');
  copiedBody = $state(false);
  beautifiedBody = $state(false);
  bodyEditorFormat: (() => boolean | void) | null = null;
  savedResponse = $state(false);
  curlPasteToast = $state(false);
  settingsSaved = $state(false);

  topView = $state<TopView>('request');
  starPromptVisible = $state(starPromptDue(loadStarPromptState()));
  requests = $state<SavedRequest[]>([]);
  requestsById = $derived(new Map(this.requests.map(request => [request.id, request])));
  workspaces = $state<Workspace[]>([]);
  collections = $state<Collection[]>([]);
  environments = $state<Environment[]>([]);
  activeRequestId = $state('');
  activeWorkspaceId = $state('');
  activeEnvironmentId = $state('');
  openRequestIds = $state<string[]>([]);
  requestStoreLoaded = $state(false);
  folderCollapseState = $state<Record<string, boolean>>({});
  sidebarSearch = $state('');
  workspaceMenuOpen = $state(false);
  workspaceSearch = $state('');
  environmentMenuOpen = $state(false);
  codePanelOpen = $state(false);
  codePanelWidth = $state(330);
  snippetLanguage = $state<SnippetLanguage>('curl');
  snippetMenuOpen = $state(false);
  snippetTextCache = $state('');
  snippetRenderedLinesCache = $state<RenderedSnippetLine[]>([]);
  snippetRenderKey = '';
  snippetRenderPendingKey = '';
  snippetRenderToken = 0;
  openFormTypeMenuId = $state<number | null>(null);
  copiedSnippet = $state(false);
  openRequestMenuId = $state('');
  openCollectionMenuId = $state('');
  activeCollectionSettingsId = $state('');
  collectionSettingsTab = $state<'overview' | 'headers' | 'vars' | 'auth' | 'script' | 'tests' | 'proxy'>('overview');
  collectionSettingsSaveState = $state<'idle' | 'saving' | 'saved'>('idle');
  openFolderMenuKey = $state('');
  openLoadTestMenuId = $state('');
  activeLoadTestId = $state('');
  activeLoadTestCollectionId = $state('');
  loadTestTab = $state<LoadTestTab>('flow');
  loadTestSaveState = $state<'idle' | 'saving' | 'saved'>('idle');
  loadTestSavedTimer: ReturnType<typeof setTimeout> | null = null;
  declare loadTestRequestOptions: typeof loadTestFeature.loadTestRequestOptions;
  declare loadTestRequestLabel: typeof loadTestFeature.loadTestRequestLabel;
  declare activeLoadTest: typeof loadTestFeature.activeLoadTest;
  declare validateLoadTestDraft: typeof loadTestFeature.validateLoadTestDraft;
  declare openLoadTest: typeof loadTestFeature.openLoadTest;
  declare closeLoadTestTab: typeof loadTestFeature.closeLoadTestTab;
  declare updateCollectionLoadTests: typeof loadTestFeature.updateCollectionLoadTests;
  declare createLoadTest: typeof loadTestFeature.createLoadTest;
  declare createLoadTestFromRequest: typeof loadTestFeature.createLoadTestFromRequest;
  declare duplicateLoadTest: typeof loadTestFeature.duplicateLoadTest;
  declare deleteLoadTest: typeof loadTestFeature.deleteLoadTest;
  declare saveLoadTest: typeof loadTestFeature.saveLoadTest;
  declare loadTestEnvironment: typeof loadTestFeature.loadTestEnvironment;
  declare exportLoadTestK6: typeof loadTestFeature.exportLoadTestK6;
  declare loadTestPayload: typeof loadTestFeature.loadTestPayload;
  k6Path = $state('');
  k6Info = $state<K6Info | null>(null);
  k6MissingOpen = $state(false);
  loadRun = $state<LoadRunState>(emptyLoadRunState());
  loadRunLogLines = $state<string[]>([]);
  loadRunLogTestId = $state('');
  loadRunResults = $state<Record<string, LoadRunResult>>({});
  declare initLoadRunListeners: typeof loadRunFeature.initLoadRunListeners;
  declare checkK6: typeof loadRunFeature.checkK6;
  declare chooseK6Binary: typeof loadRunFeature.chooseK6Binary;
  declare loadLastLoadRun: typeof loadRunFeature.loadLastLoadRun;
  declare confirmLoadTargets: typeof loadRunFeature.confirmLoadTargets;
  declare runLoadTest: typeof loadRunFeature.runLoadTest;
  declare stopLoadTest: typeof loadRunFeature.stopLoadTest;
  declare openLoadTestReport: typeof loadRunFeature.openLoadTestReport;
  declare saveLoadTestSummary: typeof loadRunFeature.saveLoadTestSummary;
  sidebarView = $state<SidebarView>('collections');
  requestHistory = $state<RequestHistoryEntry[]>([]);
  historyHeaderMenuOpen = $state(false);
  openHistoryMenuId = $state('');
  historyDetailId = $state('');
  historyDetailResponse = $state<HttpResponse | null>(null);
  historyDetailLoading = $state(false);
  historyDetailError = $state('');
  historyDayCollapseState = $state<Record<string, boolean>>({});
  appDialog = $state<AppDialogState | null>(null);
  dialogInputValue = $state('');
  dialogSelectOpen = $state(false);
  shortcutOverrides = $state<Record<string, string>>({});
  shortcutsOpen = $state(false);
  shortcutEditingId = $state<ShortcutId | ''>('');
  shortcutCaptureMessage = $state('');
  lastClosedRequestIds = $state<string[]>([]);
  draftRequestIds = $state<Set<string>>(new Set());
  findReplaceScope = $state<FindReplaceScope | null>(null);
  findReplaceUndo = $state<FindReplaceUndo | null>(null);
  copiedRequestItem = $state<SavedRequest | null>(null);
  sidebarHidden = $state(false);
  globalSearchOpen = $state(false);
  globalSearchQuery = $state('');
  settingsOpen = $state(false);
  settingsTab = $state<SettingsTab>('general');
  gitWorkspaceOpen = $state(false);
  collectionRunnerOpen = $state(false);
  collectionRunnerCollectionId = $state('');
  collectionRunnerSelectedRequestIds = $state<Set<string>>(new Set());
  collectionRunnerDelayMs = $state(0);
  collectionRunnerIncludeTags = $state('');
  collectionRunnerExcludeTags = $state('');
  collectionRunnerIterations = $state(1);
  collectionRunnerDataFileName = $state('');
  collectionRunnerDataRows = $state<RunnerDataRow[]>([]);
  collectionRunnerDataError = $state('');
  collectionRunnerParallel = $state(false);
  collectionRunnerConcurrency = $state(DEFAULT_RUNNER_CONCURRENCY);
  collectionRunnerTitle = $state('');
  collectionRunnerRunning = $state(false);
  collectionRunnerResults = $state<CollectionRunnerResult[]>([]);
  collectionLastRuns = $state<Record<string, CollectionRunRecord>>({});
  collectionRunnerShowingLastRun = $state(false);
  collectionRunnerStartedAt = $state(0);
  collectionRunnerFinishedAt = $state(0);
  cookieJarOpen = $state(false);
  cookieJarLoading = $state(false);
  cookieJarSaving = $state(false);
  cookieJarError = $state('');
  cookies = $state<CookieJarEntry[]>([]);
  workspaceCookies = $state<Record<string, CookieJarEntry[]>>({});
  cookieSync = $state<CookieSyncStatus>(EMPTY_COOKIE_SYNC_STATUS);
  cookieSyncBusy = $state(false);
  cookieSyncError = $state('');
  cookieSyncDomainInput = $state('');
  cookieSyncPort = $state(DEFAULT_COOKIE_SYNC_PORT);
  cookieSyncCodeCopied = $state(false);
  cookieSyncRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  appTheme = $state<AppTheme>(initialThemeState.appTheme);
  resolvedAppTheme = $state<ResolvedAppTheme>(initialThemeState.resolvedAppTheme);
  headerValueSuggestions = $state<string[]>([]);
  collectionImportToast = $state('');
  collectionImportSummary = $state('');
  collectionImportSource = $state<ImportSource>('postman');
  dataTransferStatus = $state('');
  defaultWorkspaceLocationPath = $state('');
  defaultWorkspaceLocationDraft = $state('');
  defaultWorkspaceLocationStatus = $state('');
  dataTransferStatusTimer: ReturnType<typeof setTimeout> | null = null;
  environmentToast = $state('');
  environmentToastTimer: ReturnType<typeof setTimeout> | null = null;
  gitStatus = $state<GitWorkspaceStatus>({ ...EMPTY_GIT_STATUS });
  gitDiff = $state<GitDiffResult>({ ...EMPTY_GIT_DIFF });
  gitBranches = $state<GitBranchListResult>({ ...EMPTY_GIT_BRANCHES });
  gitConflict = $state<GitConflictFileResult>({ ...EMPTY_GIT_CONFLICT_FILE });
  gitConflictContent = $state('');
  gitLog = $state<GitLogResult>({ ...EMPTY_GIT_LOG });
  gitSelectedCommit = $state('');
  gitSelectedPath = $state('');
  gitLoading = $state(false);
  gitLogLoadingMore = $state(false);
  gitDiffLoading = $state(false);
  gitAction = $state('');
  gitMessage = $state('');
  gitError = $state('');
  gitOutput = $state('');
  gitToast = $state('');
  gitToastTimer: ReturnType<typeof setTimeout> | null = null;
  gitPersistRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  workspacePersistTimer: ReturnType<typeof setTimeout> | null = null;
  topViewStateLoaded = false;
  savedTopViewState: TopViewState | null = null;
  workspaceDiagnostics = $state<WorkspaceDiagnostic[]>([]);
  externalWorkspaceChangePending = $state(false);
  externalWorkspaceChangeReason = $state('');
  focusedWorkspaceDiagnosticKey = $state('');
  yamlEditorOpen = $state(false);
  yamlEditorPath = $state('');
  yamlEditorContent = $state('');
  yamlEditorLoading = $state(false);
  yamlEditorSaving = $state(false);
  yamlEditorError = $state('');
  yamlEditorDiagnostic: WorkspaceDiagnostic | null = $state(null);
  missingSecrets = $state<WorkspaceSecretRef[]>([]);
  missingSecretValues = $state<Record<string, string>>({});
  missingSecretsSaving = $state(false);
  missingSecretsError = $state('');
  environmentSaveState = $state<'idle' | 'dirty' | 'saving' | 'saved'>('idle');
  environmentView = $state<EnvironmentView>(readEnvironmentView());
  globalVariables = $state<KVRow[]>([{ id: 1, enabled: true, key: '', value: '', description: '' }]);
  globalsSaveState = $state<'idle' | 'dirty' | 'saving' | 'saved'>('idle');
  globalsPersistTimer: ReturnType<typeof setTimeout> | null = null;
  globalsSavedTimer: ReturnType<typeof setTimeout> | null = null;
  responseBodyPage = $state(0);
  quitReviewInProgress = $state(false);
  autosave = $state(false);
  startupView = $state<StartupView>(DEFAULT_STARTUP_VIEW);
  startupViewApplied = false;
  saveStatus = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
  saveStatusTimer: ReturnType<typeof setTimeout> | null = null;
  dirtyRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
  dirtyRequestIds = $state<Set<string>>(new Set());
  dirtyRequestIdList = $state<string[]>([]);
  savedRequestSnapshots = new Map<string, SavedRequest>();
  unsavedRequestSnapshots = new Map<string, SavedRequest>();

  sidebarWidth = $state(SIDEBAR_DEFAULT_WIDTH);
  requestPanelHeight = $state(280);
  responseLayout = $state<ResponseLayout>(readResponseLayout());
  responseLayoutChosen = $state(readResponseLayoutChosen());
  requestSplitRatio = $state(0.5);
  splitResizing = $state(false);
  splitResizeStartX = 0;
  splitResizeStartRatio = 0.5;
  splitResizeWidth = 0;
  kvKeyW = $state(180);
  kvValW = $state(180);
  kvTypeW = $state(110);
  kvDescW = $state(260);
  sidebarResizing = $state(false);
  panelResizing = $state(false);
  codePanelResizing = $state(false);
  colResizing = $state<'key' | 'val' | 'type' | 'desc' | null>(null);
  colResizeMaxW = $state(420);

  applyingSavedRequest = false;
  persistTimer: ReturnType<typeof setTimeout> | null = null;
  requestStorePersistQueue: Promise<unknown> = Promise.resolve();
  requestStorePersistEpoch = 0;
  requestStorePersistTimer: ReturnType<typeof setTimeout> | null = null;
  environmentPersistTimer: ReturnType<typeof setTimeout> | null = null;
  environmentSavedTimer: ReturnType<typeof setTimeout> | null = null;
  collectionSettingsSavedTimer: ReturnType<typeof setTimeout> | null = null;
  renamingRequestId = '';
  sidebarResizeStartX = 0;
  sidebarResizeStartW = 0;
  panelResizeStartY = 0;
  panelResizeStartH = 0;
  codePanelResizeStartX = 0;
  codePanelResizeStartW = 0;
  colResizeStartX = 0;
  colResizeStartW = 0;
  collectionRunnerCancelRequested = false;
  collectionRunnerActiveRequestId = '';
  collectionRunnerActiveRequestIds = new Set<string>();

  _postmanImportInput: HTMLInputElement | undefined = undefined;
  _sidebarSearchInput: HTMLInputElement | undefined = undefined;
  _urlInputRef: HTMLInputElement | HTMLTextAreaElement | undefined = undefined;

  get collectionGroups(): CollectionGroup[] { return this.buildCollectionGroups(); }
  get historyGroups(): HistoryDayGroup[] { return this.buildHistoryGroups(); }
  get activeWorkspace(): Workspace | undefined {
    return this.workspaces.find(w => w.id === this.activeWorkspaceId) ?? this.workspaces[0];
  }
  get activeWorkspaceEnvironments(): Environment[] {
    return this.environments.filter(e => e.workspaceId === this.activeWorkspaceId);
  }
  get activeEnvironment(): Environment | undefined {
    return this.environments.find(e => e.id === this.activeEnvironmentId && e.workspaceId === this.activeWorkspaceId);
  }
  get activeCollectionSettings(): Collection | undefined {
    return this.collections.find(collection => collection.id === this.activeCollectionSettingsId && collection.workspaceId === this.activeWorkspaceId);
  }
  get variableSuggestions(): VariableSuggestion[] { return this.requestVariableSuggestions(); }
  get cookieJarDefaultDomain() { return this.activeRequestCookieDomain(); }
  get loading(): boolean { return Boolean(this.activeRequestId && this.inFlightRequestIds.has(this.activeRequestId)); }

  noteSuccessfulSend() {
    if (starPromptDue(recordSuccessfulSend())) this.starPromptVisible = true;
  }

  closeStarPrompt() {
    finishStarPrompt();
    this.starPromptVisible = false;
  }

  scheduleWorkspacePersist() {
    if (this.workspaceBlocked) return;
    if (!this.requestStoreLoaded) return;
    if (this.workspacePersistTimer) clearTimeout(this.workspacePersistTimer);
    this.workspacePersistTimer = setTimeout(() => {
      this.workspacePersistTimer = null;
      void this.persistWorkspaceNow();
    }, 450);
  }
  async persistWorkspaceNow() {
    if (this.workspaceBlocked) return;
    if (this.workspacePersistTimer) {
      clearTimeout(this.workspacePersistTimer);
      this.workspacePersistTimer = null;
    }
    await this.persistRequestStore(
      this.requests,
      this.activeRequestId,
      this.openRequestIds,
      this.workspaces,
      this.collections,
      this.activeWorkspaceId,
      this.requestHistory,
      this.environments,
      this.activeEnvironmentId,
    );
  }
  requestVariableSuggestions(): VariableSuggestion[] {
    const collectionId = this.topView === 'collection' && this.activeCollectionSettingsId
      ? this.activeCollectionSettingsId
      : this.activeCollectionId();
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    const collectionSuggestions = (collection?.defaults.variables ?? [])
      .filter(row => row.enabled && row.key.trim())
      .map(row => ({
        key: row.key.trim(),
        value: row.value,
        description: row.description || `Collection: ${collection?.name ?? ''}`.trim(),
        secret: row.secret ?? false,
      }));
    const globalSuggestions = this.globalVariableRows().map(row => ({
      key: row.key.trim(),
      value: row.value,
      description: row.description || 'Global',
      secret: row.secret ?? false,
    }));
    const rows = [...this.environmentVariableSuggestions(), ...collectionSuggestions, ...globalSuggestions];
    return rows.filter((row, index) => rows.findIndex(candidate => candidate.key === row.key) === index);
  }
  async copyHistoryEntryCurl(historyId: string) {
    const entry = this.requestHistory.find(candidate => candidate.id === historyId);
    if (!entry || !requestSupportsCurl(entry.request)) return;
    const { toCurl } = await import('../curl');
    const values = this.environmentValuesForRequest(entry.request, this.redactedActiveEnvironmentValues());
    clipboardCopy(toCurl(this.savedRequestToRunnableHttpRequest(entry.request, values, [], [])));
    this.collectionImportToast = 'Copied as cURL';
    setTimeout(() => { if (this.collectionImportToast === 'Copied as cURL') this.collectionImportToast = ''; }, 1800);
  }

  async copyRequestCurl(id: string) {
    const req = this.requestsById.get(id); if (!req) return;
    if (this.savedRequestIsRealtime(req)) { this.openRequestMenuId = ''; return; }
    const { toCurl } = await import('../curl');
    const values = this.environmentValuesForRequest(req, this.redactedActiveEnvironmentValues());
    clipboardCopy(toCurl(this.savedRequestToRunnableHttpRequest(req, values, [], []))); this.openRequestMenuId = '';
  }

  async loadRequestWorkspace(rawOverride?: string, diagnosticsOverride?: WorkspaceDiagnostic[]) {
    let lReqs: SavedRequest[] = [], lWs: Workspace[] = [], lCols: Collection[] = [], lEnvs: Environment[] = [];
    let lActiveId = '', lWsId = '', lEnvId = '', lOpenIds: string[] = [], lFolderCollapsed: Record<string, boolean> = {}, lHistory: RequestHistoryEntry[] = [];
    let lCollectionRuns: Record<string, CollectionRunRecord> = {};
    let lWorkspaceCookies: Record<string, CookieJarEntry[]> = {};
    let lGlobals: KVRow[] = withTrailingGlobalRow([]);
    let requestStoreRaw = '';
    let requestStoreParsed: Partial<RequestStore> | null = null;
    let requestStoreReadFailed = false;
    const savedTopViewState = this.loadTopViewState();
    this.workspaceDiagnostics = normalizeWorkspaceDiagnostics(diagnosticsOverride ?? await loadWorkspaceDiagnostics());
    try {
      const raw = rawOverride ?? await loadRequestStore();
      requestStoreRaw = raw;
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as Partial<RequestStore>;
        requestStoreParsed = parsed;
        lWs = (parsed.workspaces ?? []).map(normalizeWorkspace);
        lWsId = parsed.activeWorkspaceId ?? '';
        lCols = (parsed.collections ?? []).map(c => normalizeCollection(c, lWsId));
        lEnvs = (parsed.environments ?? []).map(e => normalizeEnvironment(e, lWsId));
        lEnvId = parsed.activeEnvironmentId ?? '';
        lActiveId = parsed.activeId ?? ''; lOpenIds = parsed.openIds ?? []; lFolderCollapsed = parsed.folderCollapsed ?? {};
      }
    } catch (e) {
      requestStoreReadFailed = true;
      this.collectionImportToast = 'Warning: workspace data could not be read — some settings may be reset';
      setTimeout(() => (this.collectionImportToast = ''), 5000);
    }
    lWs = [...lWs, ...this.invalidWorkspacesFromDiagnostics(lWs)];
    if (!lWs.length) lWs = [makeWorkspace(DEFAULT_WORKSPACE)];
    if (!lWsId || !lWs.some(w => w.id === lWsId)) lWsId = lWs.find(workspace => !workspace.isInvalid)?.id ?? lWs[0].id;
    if (!lCols.length && !this.workspaceDiagnostics.length && !lWs.find(workspace => workspace.id === lWsId)?.isInvalid) lCols = [makeCollection(lWsId, DEFAULT_COLLECTION)];
    if (lEnvId && !lEnvs.some(e => e.id === lEnvId && e.workspaceId === lWsId)) lEnvId = '';
    this.workspaces = lWs; this.collections = lCols; this.environments = lEnvs;
    try {
      let parsed = requestStoreParsed;
      if (requestStoreReadFailed) {
        const raw = rawOverride ?? await loadRequestStore();
        parsed = raw.trim() ? JSON.parse(raw) as Partial<RequestStore> : null;
      }
      if (parsed) {
        lReqs = (parsed.requests ?? []).map(r => normalizeSavedRequest(r, lCols, lWsId));
        lHistory = (parsed.history ?? []).map(e => normalizeHistoryEntry(e, lCols, lWsId)).filter((e): e is RequestHistoryEntry => Boolean(e));
        lWorkspaceCookies = this.normalizeWorkspaceCookieStore(parsed.workspaceCookies);
        lCollectionRuns = normalizeCollectionRuns(parsed.collectionRuns, new Set(lCols.map(collection => collection.id)));
        lGlobals = withTrailingGlobalRow(restoreRows(parsed.globals ?? []));
      }
    } catch (e) {
      this.collectionImportToast = 'Warning: some requests could not be loaded — data may be corrupt';
      setTimeout(() => (this.collectionImportToast = ''), 5000);
    }
    const firstAppLaunch = rawOverride === undefined && !requestStoreReadFailed && !requestStoreRaw.trim() && !savedTopViewState;
    const launching = !this.startupViewApplied;
    this.startupViewApplied = true;
    const needsDraft = launching
      ? startupNeedsDraftRequest({ view: this.startupView, hasRequests: lReqs.length > 0, firstAppLaunch, savedTopView: savedTopViewState?.topView })
      : !lReqs.length && (firstAppLaunch || savedTopViewState?.topView === 'request');
    if (needsDraft) {
      const draft: SavedRequest = { ...this.blankSavedRequest('', 'http'), isDraft: true, collectionId: '', collection: '' };
      lReqs = [draft];
      lActiveId = draft.id;
      lOpenIds = [draft.id];
    }
    if (lHistory.some(entry => !entry.responseStored)) lHistory = withStoredHistoryResponses(lHistory, await storedHistoryResponseIds());
    this.requests = lReqs; this.requestHistory = this.pruneHistory(lHistory);
    this.collectionLastRuns = lCollectionRuns;
    this.draftRequestIds = new Set(lReqs.filter(r => r.isDraft).map(r => r.id));
    this.savedRequestSnapshots = new Map(lReqs.filter(r => !r.isDraft).map(r => [r.id, this.savedRequestSnapshot(r)]));
    this.syncDirtyRequestIds(new Set());
    this.unsavedRequestSnapshots = new Map();
    this.folderCollapseState = lFolderCollapsed; this.activeWorkspaceId = lWsId; this.activeEnvironmentId = lEnvId;
    this.workspaceCookies = lWorkspaceCookies;
    this.globalVariables = lGlobals;
    void this.syncBackendGlobals();
    await this.restoreWorkspaceCookieJar(lWsId);
    if (!lReqs.length) {
      this.openRequestIds = [];
      this.activeRequestId = '';
      this.setActiveResponse(null);
      this.requestError = '';
      this.topView = 'overview';
      this.requestStoreLoaded = true;
    } else {
      const active = lReqs.find(r => r.id === lActiveId) ?? lReqs[0];
      const validOpenIds = lOpenIds.filter(id => lReqs.some(r => r.id === id));
      this.openRequestIds = validOpenIds.length ? validOpenIds : [active.id];
      this.applySavedRequest(active);
      this.requestStoreLoaded = true;
    }
    const launchTopView = launching ? startupTopView(this.startupView, { workspaceBlocked: this.workspaceBlocked, hasActiveRequest: Boolean(this.activeRequestId) }) : null;
    if (launchTopView) {
      if (savedTopViewState?.sidebarView) this.sidebarView = savedTopViewState.sidebarView;
      this.topView = launchTopView;
    } else {
      this.restoreTopViewState(savedTopViewState);
    }
    void this.refreshGitStatus();
  }

  async applyWorkspaceOpenResult(result: WorkspaceOpenResult, successMessage: string) {
    this.gitOutput = result.output ?? '';
    this.gitStatus = normalizeGitStatus(result.git);
    this.workspaceDiagnostics = normalizeWorkspaceDiagnostics(result.diagnostics);
    if (!result.ok) {
      this.cancelPendingPersistTimers();
      this.gitError = result.error || 'Workspace operation failed';
      if (this.workspaceDiagnostics.length) {
        this.focusedWorkspaceDiagnosticKey = this.workspaceDiagnosticKey(this.workspaceDiagnostics[0]);
        if (this.topView !== 'git') this.openGitTab(false);
      }
      return false;
    }
    this.gitError = '';
    this.gitMessage = successMessage;
    this.gitSelectedPath = '';
    this.gitDiff = { ...EMPTY_GIT_DIFF };
    this.gitSelectedCommit = '';
    this.gitConflict = { ...EMPTY_GIT_CONFLICT_FILE };
    this.gitConflictContent = '';
    const wasInGitView = this.topView === 'git';
    this.requestStoreLoaded = false;
    await this.loadRequestWorkspace(result.payload, result.diagnostics ?? []);
    if (wasInGitView) this.openGitTab(false);
    this.gitStatus = normalizeGitStatus(result.git ?? await gitStatus());
    if (this.gitStatus.isRepo) {
      this.gitBranches = normalizeGitBranches(await gitListBranches());
      this.gitLog = normalizeGitLog(await gitCommitLogPage(GIT_LOG_PAGE_SIZE, 0));
    } else {
      this.gitBranches = { ...EMPTY_GIT_BRANCHES };
      this.gitLog = { ...EMPTY_GIT_LOG };
    }
    this.openMissingSecretsWizard(result.missingSecrets ?? []);
    const issueCount = result.diagnostics?.length ?? 0;
    if (issueCount && this.topView !== 'git') {
      this.collectionImportToast = `${issueCount} workspace ${issueCount === 1 ? 'file needs' : 'files need'} attention. Open Git to see ${issueCount === 1 ? 'it' : 'them'}.`;
      setTimeout(() => (this.collectionImportToast = ''), 6000);
    }
    this.showGitToast(successMessage);
    setTimeout(() => { if (this.gitMessage === successMessage) this.gitMessage = ''; }, 3200);
    return true;
  }

  openMissingSecretsWizard(secrets: WorkspaceSecretRef[]) {
    this.missingSecrets = secrets;
    this.missingSecretValues = Object.fromEntries(secrets.map(secret => [secret.key, this.missingSecretValues[secret.key] ?? '']));
    this.missingSecretsError = '';
  }

  dismissMissingSecretsWizard() {
    this.missingSecrets = [];
    this.missingSecretValues = {};
    this.missingSecretsError = '';
  }

  updateMissingSecretValue(key: string, value: string) {
    this.missingSecretValues = { ...this.missingSecretValues, [key]: value };
  }

  async saveMissingSecrets() {
    if (!this.missingSecrets.length) return;
    this.missingSecretsSaving = true;
    this.missingSecretsError = '';
    try {
      const values: Record<string, string> = {};
      for (const secret of this.missingSecrets) values[secret.key] = this.missingSecretValues[secret.key] ?? '';
      const result = await saveWorkspaceSecrets(values);
      if (!result.ok) throw new Error(result.error || 'Could not save workspace secrets');
      await this.applyWorkspaceOpenResult(result, 'Workspace secrets saved');
      if (!(result.missingSecrets ?? []).length) this.dismissMissingSecretsWizard();
    } catch (error) {
      this.missingSecretsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.missingSecretsSaving = false;
    }
  }

  async loadDefaultWorkspaceLocation() {
    try {
      const result = await defaultWorkspaceLocation();
      this.defaultWorkspaceLocationPath = result.path;
      this.defaultWorkspaceLocationDraft = result.path;
      this.defaultWorkspaceLocationStatus = result.error ? `Default location unavailable: ${result.error}` : '';
    } catch (error) {
      this.defaultWorkspaceLocationStatus = error instanceof Error ? error.message : String(error);
    }
  }

  setDefaultWorkspaceLocationDraft(path: string) {
    this.defaultWorkspaceLocationDraft = path;
    if (this.defaultWorkspaceLocationStatus === 'Default location saved') this.defaultWorkspaceLocationStatus = '';
  }

  async saveDefaultWorkspaceLocation(path = this.defaultWorkspaceLocationDraft) {
    const result = await setDefaultWorkspaceLocation(path);
    if (result.error) {
      this.defaultWorkspaceLocationStatus = result.error;
      return;
    }
    this.defaultWorkspaceLocationPath = result.path;
    this.defaultWorkspaceLocationDraft = result.path;
    this.defaultWorkspaceLocationStatus = 'Default location saved';
    setTimeout(() => {
      if (this.defaultWorkspaceLocationStatus === 'Default location saved') this.defaultWorkspaceLocationStatus = '';
    }, 1800);
  }

  async browseDefaultWorkspaceLocation() {
    const path = await openDirectoryDialog('Choose default location', this.defaultWorkspaceLocationDraft || this.defaultWorkspaceLocationPath);
    if (!path) return;
    this.defaultWorkspaceLocationDraft = path;
    await this.saveDefaultWorkspaceLocation(path);
  }

  async defaultWorkspaceParentForDialogs() {
    if (!this.defaultWorkspaceLocationPath) await this.loadDefaultWorkspaceLocation();
    return this.defaultWorkspaceLocationPath;
  }

  async useLocalWorkspace() {
    this.closeFloatingMenus();
    await this.persistActiveRequestNow(true);
    const repoRoot = (this.gitStatus.root || this.gitStatus.workspaceRoot || '').trim();
    const confirmed = await this.openConfirmDialog(
      'Close repository',
      `Stop tracking this repository in Kurlo?${repoRoot ? `\n\n${repoRoot}` : ''}\n\nFiles stay on disk and you can open this repository again later.`,
      'Close'
    );
    if (!confirmed) return;
    this.gitLoading = true;
    this.gitAction = 'close-repo';
    this.gitError = '';
    try {
      const result = await useLocalWorkspaceStore();
      await this.applyWorkspaceOpenResult(result, 'Repository closed');
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'close-repo') this.gitAction = '';
    }
  }

  async useAppStorage() {
    this.closeFloatingMenus();
    this.gitLoading = true;
    this.gitAction = 'use-app-storage';
    this.gitError = '';
    try {
      const result = await useLocalWorkspaceStore();
      await this.applyWorkspaceOpenResult(result, 'Using Kurlo app storage');
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'use-app-storage') this.gitAction = '';
    }
  }

  async createLocalFolderWorkspace() {
    this.closeFloatingMenus();
    await this.persistActiveRequestNow(true);
    const baseName = safeFileName(this.activeWorkspace?.name || 'kurlo-workspace') || 'kurlo-workspace';
    const directoryName = await this.openPromptDialog('New folder workspace', baseName, 'Kurlo will create a workspace folder inside the parent directory you choose next.');
    if (!directoryName) return;
    const initMode = await this.openSelectDialog('Folder workspace setup', 'Choose what Kurlo should write into the new folder:', [
      { value: 'empty', label: 'Create empty workspace', description: `Create a clean workspace named "${directoryName}".` },
      { value: 'copy', label: 'Copy current workspaces', description: 'Copy all workspaces in the current folder, including their collections, requests, and environments.' },
    ], 'Create', 'Cancel');
    if (!initMode) return;
    const parentDir = await openDirectoryDialog(`Choose parent folder for ${directoryName}`, await this.defaultWorkspaceParentForDialogs());
    if (!parentDir) return;
    this.gitLoading = true;
    this.gitAction = 'local-create';
    this.gitError = '';
    try {
      const result = await createLocalWorkspaceRoot(parentDir, directoryName, initMode);
      await this.applyWorkspaceOpenResult(result, `Created folder workspace ${result.root || directoryName}`);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'local-create') this.gitAction = '';
    }
  }

  gitAuthRetryGuard = false;
  gitPendingRemoteRevert: { remote: string; originalUrl: string } | null = null;
  gitAuthRequest = $state<GitAuthRequest | null>(null);
  gitAuthResolver: ((v: GitAuthChoice | null) => void) | null = null;

  cancelPersistTimersOnly() {
    this.requestStorePersistEpoch += 1;
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    if (this.requestStorePersistTimer) { clearTimeout(this.requestStorePersistTimer); this.requestStorePersistTimer = null; }
    if (this.gitPersistRefreshTimer) { clearTimeout(this.gitPersistRefreshTimer); this.gitPersistRefreshTimer = null; }
  }

  cancelPendingPersistTimers() {
    this.cancelPersistTimersOnly();
    if (this.dirtyRequestIds.size || this.unsavedRequestSnapshots.size) {
      this.syncManualRequestSnapshotState({ dirtyRequestIds: new Set(), unsavedRequestSnapshots: new Map() });
    }
  }

  isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
  loadTopViewState(): TopViewState | null {
    if (this.topViewStateLoaded) return this.savedTopViewState;
    this.topViewStateLoaded = true;
    try {
      const raw = localStorage.getItem(TOP_VIEW_STORAGE_KEY);
      if (!raw) {
        this.savedTopViewState = null;
        return this.savedTopViewState;
      }
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {}
      this.savedTopViewState = normalizeTopViewState(parsed);
    } catch {
      this.savedTopViewState = null;
    }
    return this.savedTopViewState;
  }
  saveTopViewState() {
    if (!this.requestStoreLoaded) return;
    const state: TopViewState = { topView: this.topView };
    if (this.activeCollectionSettingsId) state.activeCollectionSettingsId = this.activeCollectionSettingsId;
    if (this.collectionRunnerOpen) {
      state.collectionRunnerOpen = true;
      if (this.collectionRunnerCollectionId) state.collectionRunnerCollectionId = this.collectionRunnerCollectionId;
    }
    if (this.gitWorkspaceOpen) state.gitWorkspaceOpen = true;
    if (this.sidebarView) state.sidebarView = this.sidebarView;
    try {
      localStorage.setItem(TOP_VIEW_STORAGE_KEY, JSON.stringify(state));
      this.savedTopViewState = state;
      this.topViewStateLoaded = true;
    } catch {}
  }
  restoreTopViewState(state: TopViewState | null) {
    if (!state) {
      if (this.activeRequestId) this.topView = 'request';
      return;
    }
    if (state.sidebarView) this.sidebarView = state.sidebarView;
    if (this.workspaceBlocked && state.topView !== 'overview' && state.topView !== 'git') {
      this.topView = 'overview';
      return;
    }
    if (state.topView === 'git') {
      this.gitWorkspaceOpen = true;
      this.topView = 'git';
      return;
    }
    if (state.topView === 'runner') {
      this.openCollectionRunner(state.collectionRunnerCollectionId ?? '');
      return;
    }
    if (state.topView === 'collection') {
      const collectionId = state.activeCollectionSettingsId ?? '';
      if (collectionId && this.collections.some(collection => collection.id === collectionId && !collection.isInvalid)) {
        this.activeCollectionSettingsId = collectionId;
        this.topView = 'collection';
        return;
      }
    }
    if (state.topView === 'environment') {
      this.sidebarView = 'environments';
      this.topView = 'environment';
      return;
    }
    if (state.topView === 'request' && this.activeRequestId) {
      this.topView = 'request';
      return;
    }
    this.topView = state.topView === 'overview' ? 'overview' : this.activeRequestId ? 'request' : 'overview';
  }
  async saveTextFile(name: string, content: string): Promise<boolean> {
    if (!window.go?.api?.App?.SaveFileDialog) {
      downloadTextFile(name, content);
      return true;
    }
    return Boolean(await saveFileDialog(name, content));
  }

}

function applyFeatures(target: object, ...features: object[]) {
  for (const feature of features) Object.defineProperties(target, Object.getOwnPropertyDescriptors(feature));
}

applyFeatures(
  AppVM.prototype,
  loadTestFeature,
  loadRunFeature,
  cookieFeature,
  cookieSyncFeature,
  sseFeature,
  websocketFeature,
  socketioFeature,
  socketioFormFeature,
  mockServerFeature,
  realtimeFeature,
  collectionRunnerDerivedFeature,
  collectionRunnerFeature,
  globalsFeature,
  collectionDefaultsFeature,
  collectionFeature,
  folderFeature,
  findReplaceFeature,
  graphqlFeature,
  grpcFeature,
  mcpFeature,
  aiFeature,
  scriptsFeature,
  examplesFeature,
  requestBodyFeature,
  requestCrudFeature,
  requestDirtyFeature,
  requestSerializationFeature,
  requestStateFeature,
  requestExecutionFeature,
  requestHeadersFeature,
  requestPersistenceFeature,
  snippetsFeature,
  responseFeature,
  authFeature,
  importExportFeature,
  dataBackupFeature,
  gitFeature,
  menuFeature,
  dialogFeature,
  preferencesFeature,
  historyFeature,
  environmentFeature,
  uiShellFeature,
  workspaceDiagnosticsFeature,
  workspaceFeature,
);

export const vm = new AppVM();
