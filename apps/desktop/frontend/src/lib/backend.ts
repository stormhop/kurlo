import type {
  AppInfo, AuthConfig, CollectionTextFile, CollectionTextFilesResult, CookieJarEntry, CookieJarResult,
  CookieSyncConfig, CookieSyncStatus,
  DefaultWorkspaceLocationResult, DownloadResult, GitAuthConfigResult, GitBranchListResult,
  GitConflictFileResult, GitDiffResult, GitLogResult, GitOperationResult, GitTokenInfoResult,
  GitWorkspaceStatus, GrpcRequest, GrpcResponse, GrpcServiceDefinition, HttpRequest, HttpResponse,
  OAuth2TokenResponse, SaveRequestStoreResult, SocketIOEmitMessage, SocketIOEmitResult, UpdateCheckResult,
  UpdateInfo, WebSocketSendMessage, WebSocketSendResult, WorkspaceDiagnostic, WorkspaceOpenResult,
  WorkspaceYAMLFileResult, HistoryResponseResult, MockServerConfig, MockServerStatus, MockRequestLog,
  McpResponse, AiRequest, AiResponse, LoadTest, LoadTestRequest,
} from './wire';
import {
  EMPTY_GIT_BRANCH_LIST, EMPTY_GIT_CONFLICT_FILE, EMPTY_GIT_LOG,
  EMPTY_GIT_OPERATION_RESULT, EMPTY_GIT_STATUS, EMPTY_WORKSPACE_OPEN_RESULT, EMPTY_MOCK_SERVER_STATUS,
  EMPTY_COOKIE_SYNC_STATUS,
} from './wire';

export * from './wire';

export async function getAppInfo(): Promise<AppInfo> {
  const app = window.go?.api?.App;
  if (!app?.AppInfo) {
    return { name: 'Kurlo', version: 'dev', runtime: 'browser', goVersion: 'unavailable', packaged: false };
  }
  return app.AppInfo();
}

export async function diagnosticsReport(): Promise<string> {
  const app = window.go?.api?.App;
  if (!app?.DiagnosticsReport) return 'Kurlo (browser preview)\nDiagnostics are only available in the desktop app.\n';
  return app.DiagnosticsReport();
}

export async function logFilePath(): Promise<string> {
  const app = window.go?.api?.App;
  if (!app?.LogFilePath) return '';
  return app.LogFilePath();
}

export type BrowserExtensionResult = { path: string; version: string; browser: string; error?: string };

export async function installBrowserExtension(browser: 'chromium' | 'firefox'): Promise<BrowserExtensionResult> {
  const app = window.go?.api?.App;
  if (!app?.InstallBrowserExtension) return { path: '', version: '', browser, error: 'The extension can be set up from the desktop app.' };
  return app.InstallBrowserExtension(browser);
}

export async function openLogFolder(): Promise<string> {
  const app = window.go?.api?.App;
  if (!app?.OpenLogFolder) return 'The log folder is only available in the desktop app.';
  return app.OpenLogFolder();
}

export async function sendHttpRequest(req: HttpRequest): Promise<HttpResponse> {
  const app = window.go?.api?.App;
  if (!app?.SendRequest) {
    throw new Error('Wails bridge not available');
  }
  return app.SendRequest(req);
}

export async function sendHttpRequestToFile(req: HttpRequest, defaultName: string): Promise<DownloadResult> {
  const app = window.go?.api?.App;
  if (!app?.SendRequestToFile) {
    throw new Error('Wails bridge not available');
  }
  return app.SendRequestToFile(req, defaultName);
}

export async function sendGrpcRequest(req: GrpcRequest): Promise<GrpcResponse> {
  const app = window.go?.api?.App;
  if (!app?.SendGrpcRequest) {
    throw new Error('Wails bridge not available');
  }
  return app.SendGrpcRequest(req);
}

export async function sendAiRequest(req: AiRequest): Promise<AiResponse> {
  const app = window.go?.api?.App;
  if (!app?.SendAiRequest) {
    throw new Error('Wails bridge not available');
  }
  return app.SendAiRequest(req);
}

export async function sendMcpRequest(req: HttpRequest): Promise<McpResponse> {
  const app = window.go?.api?.App;
  if (!app?.SendMcpRequest) {
    throw new Error('Wails bridge not available');
  }
  return app.SendMcpRequest(req);
}

export async function grpcDiscover(req: GrpcRequest): Promise<GrpcServiceDefinition> {
  const app = window.go?.api?.App;
  if (!app?.GrpcDiscover) {
    throw new Error('Wails bridge not available');
  }
  return app.GrpcDiscover(req);
}

export async function cancelHttpRequest(requestId: string): Promise<void> {
  await window.go?.api?.App?.CancelRequest?.(requestId);
}

export async function listCookies(workspaceId: string): Promise<CookieJarEntry[]> {
  const app = window.go?.api?.App;
  if (!app?.ListCookies) return [];
  return app.ListCookies(workspaceId);
}

export async function upsertCookie(workspaceId: string, cookie: CookieJarEntry): Promise<CookieJarResult> {
  const app = window.go?.api?.App;
  if (!app?.UpsertCookie) return { cookies: [], error: 'Wails bridge not available' };
  return app.UpsertCookie(workspaceId, cookie);
}

export async function deleteCookie(workspaceId: string, cookie: CookieJarEntry): Promise<CookieJarResult> {
  const app = window.go?.api?.App;
  if (!app?.DeleteCookie) return { cookies: [], error: 'Wails bridge not available' };
  return app.DeleteCookie(workspaceId, cookie);
}

const COOKIE_SYNC_UNAVAILABLE: CookieSyncStatus = {
  ...EMPTY_COOKIE_SYNC_STATUS,
  error: 'Cookie sync is only available in the desktop app.',
};

export async function cookieSyncStatus(): Promise<CookieSyncStatus> {
  const app = window.go?.api?.App;
  if (!app?.CookieSyncStatus) return COOKIE_SYNC_UNAVAILABLE;
  return app.CookieSyncStatus();
}

export async function startCookieSync(config: CookieSyncConfig, workspaceId: string): Promise<CookieSyncStatus> {
  const app = window.go?.api?.App;
  if (!app?.StartCookieSync) return COOKIE_SYNC_UNAVAILABLE;
  return app.StartCookieSync(config, workspaceId);
}

export async function stopCookieSync(): Promise<CookieSyncStatus> {
  const app = window.go?.api?.App;
  if (!app?.StopCookieSync) return EMPTY_COOKIE_SYNC_STATUS;
  return app.StopCookieSync();
}

export async function setCookieSyncDomains(domains: string[]): Promise<CookieSyncStatus> {
  const app = window.go?.api?.App;
  if (!app?.SetCookieSyncDomains) return COOKIE_SYNC_UNAVAILABLE;
  return app.SetCookieSyncDomains(domains);
}

export async function setCookieSyncWorkspace(workspaceId: string): Promise<CookieSyncStatus> {
  const app = window.go?.api?.App;
  if (!app?.SetCookieSyncWorkspace) return EMPTY_COOKIE_SYNC_STATUS;
  return app.SetCookieSyncWorkspace(workspaceId);
}

export async function revokeCookieSyncPairing(): Promise<CookieSyncStatus> {
  const app = window.go?.api?.App;
  if (!app?.RevokeCookieSyncPairing) return COOKIE_SYNC_UNAVAILABLE;
  return app.RevokeCookieSyncPairing();
}

export async function approveCookieSyncPairing(requestId: string): Promise<CookieSyncStatus> {
  const app = window.go?.api?.App;
  if (!app?.ApproveCookieSyncPairing) return COOKIE_SYNC_UNAVAILABLE;
  return app.ApproveCookieSyncPairing(requestId);
}

export async function denyCookieSyncPairing(requestId: string): Promise<CookieSyncStatus> {
  const app = window.go?.api?.App;
  if (!app?.DenyCookieSyncPairing) return COOKIE_SYNC_UNAVAILABLE;
  return app.DenyCookieSyncPairing(requestId);
}

export async function clearCookies(workspaceId: string): Promise<CookieJarEntry[]> {
  const app = window.go?.api?.App;
  if (!app?.ClearCookies) return [];
  return app.ClearCookies(workspaceId);
}

export async function getEnvironment(): Promise<Record<string, string>> {
  const app = window.go?.api?.App;
  if (!app?.GetEnvironment) return {};
  return app.GetEnvironment();
}

export async function setEnvironment(values: Record<string, string>): Promise<void> {
  const app = window.go?.api?.App;
  if (!app?.SetEnvironment) return;
  await app.SetEnvironment(values);
}

export async function getGlobalVariables(): Promise<Record<string, string>> {
  const app = window.go?.api?.App;
  if (!app?.GetVariables) return {};
  return app.GetVariables();
}

export async function setGlobalVariables(values: Record<string, string>): Promise<void> {
  const app = window.go?.api?.App;
  if (!app?.SetVariables) return;
  await app.SetVariables(values);
}

const REQUEST_STORE_FALLBACK_KEY = 'kurlo.request.store.v1';

export async function loadRequestStore(): Promise<string> {
  const app = window.go?.api?.App;
  if (!app?.LoadRequestStore) {
    return localStorage.getItem(REQUEST_STORE_FALLBACK_KEY) ?? '';
  }
  return app.LoadRequestStore();
}

export async function loadWorkspaceDiagnostics(): Promise<WorkspaceDiagnostic[]> {
  const app = window.go?.api?.App;
  if (!app?.LoadWorkspaceDiagnostics) return [];
  const diagnostics = await app.LoadWorkspaceDiagnostics();
  return Array.isArray(diagnostics) ? diagnostics : [];
}

export async function readWorkspaceYAMLFile(path: string): Promise<WorkspaceYAMLFileResult> {
  return (await window.go?.api?.App?.ReadWorkspaceYAMLFile?.(path)) ?? { ok: false, path, content: '', error: 'Wails bridge not available' };
}

export async function checkWorkspaceYAML(path: string, content: string): Promise<{ ok: boolean; line: number; message: string }> {
  return (await window.go?.api?.App?.CheckWorkspaceYAML?.(path, content)) ?? { ok: true, line: 0, message: '' };
}

export async function writeWorkspaceYAMLFile(path: string, content: string): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.WriteWorkspaceYAMLFile?.(path, content)) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function saveRequestStore(payload: string): Promise<SaveRequestStoreResult> {
  const app = window.go?.api?.App;
  if (app?.SaveRequestStoreWithError) {
    const result = await app.SaveRequestStoreWithError(payload);
    return { ok: Boolean(result?.ok), error: result?.error ?? '' };
  }
  if (!app?.SaveRequestStore) {
    localStorage.setItem(REQUEST_STORE_FALLBACK_KEY, payload);
    return { ok: true, error: '' };
  }
  const ok = await app.SaveRequestStore(payload);
  return { ok, error: ok ? '' : 'request store save failed' };
}

export type RequestStoreView = { activeId: string; activeWorkspaceId: string; openIds: string[] };

export async function saveRequestStoreView(view: RequestStoreView): Promise<SaveRequestStoreResult | null> {
  const app = window.go?.api?.App;
  if (!app?.SaveRequestStoreView) return null;
  const result = await app.SaveRequestStoreView(JSON.stringify(view));
  return { ok: Boolean(result?.ok), error: result?.error ?? '' };
}

export async function ackQuit(): Promise<void> {
  await window.go?.api?.App?.AckQuit?.();
}

export async function confirmQuit(): Promise<void> {
  await window.go?.api?.App?.ConfirmQuit?.();
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  return (await window.go?.api?.App?.CheckForUpdate?.()) ?? { error: '' };
}

export async function applyUpdate(info: UpdateInfo): Promise<string> {
  return (await window.go?.api?.App?.ApplyUpdate?.(info)) ?? '';
}

export async function restartApp(): Promise<void> {
  await window.go?.api?.App?.RestartApp?.();
}

export async function cancelQuit(): Promise<void> {
  await window.go?.api?.App?.CancelQuit?.();
}

export async function clipboardSet(text: string): Promise<void> {
  await window.go?.api?.App?.ClipboardSet?.(text);
}

export async function openFileDialog(title: string): Promise<string> {
  return (await window.go?.api?.App?.OpenFileDialog?.(title)) ?? '';
}

export async function openDirectoryDialog(title: string, defaultDirectory = ''): Promise<string> {
  const app = window.go?.api?.App;
  if (defaultDirectory && app?.OpenDirectoryDialogWithDefault) {
    return (await app.OpenDirectoryDialogWithDefault(title, defaultDirectory)) ?? '';
  }
  return (await app?.OpenDirectoryDialog?.(title)) ?? '';
}

export async function readTextFile(path: string): Promise<string> {
  return (await window.go?.api?.App?.ReadTextFile?.(path)) ?? '';
}

export async function saveResponseBody(requestId: string, defaultName: string): Promise<{ savedPath: string; error?: string }> {
  const app = window.go?.api?.App;
  if (!app?.SaveResponseBody) return { savedPath: '', error: 'Saving binary responses is only available in the desktop app.' };
  return app.SaveResponseBody(requestId, defaultName);
}

export async function saveFileDialog(name: string, content: string): Promise<string> {
  return (await window.go?.api?.App?.SaveFileDialog?.(name, content)) ?? '';
}

export async function readCollectionTextFiles(root: string): Promise<CollectionTextFilesResult> {
  return (await window.go?.api?.App?.ReadCollectionTextFiles?.(root)) ?? { root, name: '', files: [], error: 'Wails bridge not available' };
}

export async function writeCollectionTextFiles(root: string, files: CollectionTextFile[]): Promise<string> {
  return (await window.go?.api?.App?.WriteCollectionTextFiles?.(root, files)) ?? 'Wails bridge not available';
}

export async function defaultWorkspaceLocation(): Promise<DefaultWorkspaceLocationResult> {
  return (await window.go?.api?.App?.DefaultWorkspaceLocation?.()) ?? { path: '', error: 'Wails bridge not available' };
}

export async function setDefaultWorkspaceLocation(path: string): Promise<DefaultWorkspaceLocationResult> {
  return (await window.go?.api?.App?.SetDefaultWorkspaceLocation?.(path)) ?? { path, error: 'Wails bridge not available' };
}


export async function gitStatus(): Promise<GitWorkspaceStatus> {
  return (await window.go?.api?.App?.GitStatus?.()) ?? EMPTY_GIT_STATUS;
}

export async function gitDiff(path: string): Promise<GitDiffResult> {
  return (await window.go?.api?.App?.GitDiff?.(path)) ?? { path, diff: '', stagedDiff: '', unstagedDiff: '', binary: false, truncated: false, error: 'Wails bridge not available' };
}

export async function gitOutgoingChanges(): Promise<GitDiffResult> {
  return (await window.go?.api?.App?.GitOutgoingChanges?.()) ?? { path: 'Outgoing changes', diff: '', stagedDiff: '', unstagedDiff: '', binary: false, truncated: false, error: 'Wails bridge not available' };
}

export async function gitCommitLog(limit = 50): Promise<GitLogResult> {
  return (await window.go?.api?.App?.GitCommitLog?.(limit)) ?? EMPTY_GIT_LOG;
}

export async function gitCommitLogPage(limit = 60, offset = 0): Promise<GitLogResult> {
  const page = await window.go?.api?.App?.GitCommitLogPage?.(limit, offset);
  if (page) return page;
  const fallback = await gitCommitLog(limit + Math.max(0, offset));
  const commits = fallback.commits.slice(offset, offset + limit);
  return {
    ...fallback,
    commits,
    limit,
    offset,
    hasMore: fallback.commits.length > offset + limit,
  };
}

export async function gitCommitDiff(commit: string): Promise<GitDiffResult> {
  return (await window.go?.api?.App?.GitCommitDiff?.(commit)) ?? { path: 'Commit diff', diff: '', stagedDiff: '', unstagedDiff: '', binary: false, truncated: false, error: 'Wails bridge not available' };
}

export async function gitConflictFile(path: string): Promise<GitConflictFileResult> {
  return (await window.go?.api?.App?.GitConflictFile?.(path)) ?? EMPTY_GIT_CONFLICT_FILE;
}

export async function gitResolveConflictFile(path: string, resolution: string, content = ''): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitResolveConflictFile?.(path, resolution, content)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitContinueOperation(message = ''): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.GitContinueOperation?.(message)) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitAbortOperation(): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.GitAbortOperation?.()) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitStashWorkspace(message: string): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.GitStashWorkspace?.(message)) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitStashPopWorkspace(ref = ''): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.GitStashPopWorkspace?.(ref)) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitFetchWorkspace(): Promise<GitWorkspaceStatus> {
  return (await window.go?.api?.App?.GitFetchWorkspace?.()) ?? EMPTY_GIT_STATUS;
}

export async function gitPullWorkspace(strategy = 'ff'): Promise<WorkspaceOpenResult> {
  const app = window.go?.api?.App;
  if (app?.GitPullWorkspaceWithStrategy) return app.GitPullWorkspaceWithStrategy(strategy);
  return (await app?.GitPullWorkspace?.()) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitPullBranch(branchName: string): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitPullBranch?.(branchName)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitInitWorkspace(): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitInitWorkspace?.()) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitAddRemote(remoteName: string, remoteUrl: string): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitAddRemote?.(remoteName, remoteUrl)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitTestRemote(remoteNameOrUrl: string): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitTestRemote?.(remoteNameOrUrl)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitTokenInfo(remoteOrHost: string): Promise<GitTokenInfoResult> {
  return (await window.go?.api?.App?.GitTokenInfo?.(remoteOrHost)) ?? { host: '', hasToken: false, username: '' };
}

export async function gitStoreToken(remoteOrHost: string, username: string, token: string): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitStoreToken?.(remoteOrHost, username, token)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitClearToken(remoteOrHost: string): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitClearToken?.(remoteOrHost)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitSetSshKey(workspaceRoot: string, keyPath: string): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitSetSshKey?.(workspaceRoot, keyPath)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitAuthConfig(workspaceRoot: string): Promise<GitAuthConfigResult> {
  return (await window.go?.api?.App?.GitAuthConfig?.(workspaceRoot)) ?? { method: '', sshKeyPath: '' };
}

export async function gitSshUrlFor(remoteUrl: string): Promise<string> {
  return (await window.go?.api?.App?.GitSshUrlFor?.(remoteUrl)) ?? '';
}

export async function gitRemoteUrl(remoteName: string): Promise<string> {
  return (await window.go?.api?.App?.GitRemoteUrl?.(remoteName)) ?? '';
}

export async function gitSetRemoteUrl(remoteName: string, remoteUrl: string): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitSetRemoteUrl?.(remoteName, remoteUrl)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitListBranches(): Promise<GitBranchListResult> {
  return (await window.go?.api?.App?.GitBranches?.()) ?? EMPTY_GIT_BRANCH_LIST;
}

export async function gitCheckoutBranch(branchName: string): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.GitCheckoutBranch?.(branchName)) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitCreateBranch(branchName: string, startPoint = ''): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.GitCreateBranch?.(branchName, startPoint)) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitCreateTrackingBranch(branchName: string, startPoint = ''): Promise<WorkspaceOpenResult> {
  const app = window.go?.api?.App;
  return (await app?.GitCreateTrackingBranch?.(branchName, startPoint))
    ?? (await app?.GitCreateBranch?.(branchName, startPoint))
    ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitDeleteBranch(branchName: string, remote = false, force = false): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitDeleteBranch?.(branchName, remote, force)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitRenameBranch(branchName: string, newName: string, remote = false): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitRenameBranch?.(branchName, newName, remote)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitStageWorkspaceFiles(): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitStageWorkspaceFiles?.()) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitCommitWorkspace(message: string): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitCommitWorkspace?.(message)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitCommitWorkspaceFiles(paths: string[], message: string): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitCommitWorkspaceFiles?.(paths, message)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitPushWorkspace(remoteName: string): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitPushWorkspace?.(remoteName)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitForcePushWorkspace(remoteName: string): Promise<GitOperationResult> {
  return (await window.go?.api?.App?.GitForcePushWorkspace?.(remoteName)) ?? EMPTY_GIT_OPERATION_RESULT;
}

export async function gitDiscardWorkspaceFile(path: string): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.GitDiscardWorkspaceFile?.(path)) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitDiscardWorkspaceFiles(paths: string[]): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.GitDiscardWorkspaceFiles?.(paths)) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitDiscardWorkspaceChanges(): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.GitDiscardWorkspaceChanges?.()) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitCloneWorkspace(remoteUrl: string, parentDir: string, directoryName = '', initMode = 'empty'): Promise<WorkspaceOpenResult> {
  const app = window.go?.api?.App;
  if (app?.GitCloneWorkspaceWithMode) return app.GitCloneWorkspaceWithMode(remoteUrl, parentDir, directoryName, initMode);
  return (await app?.GitCloneWorkspace?.(remoteUrl, parentDir, directoryName)) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function gitCloneWorkspaceWithAuth(remoteUrl: string, parentDir: string, directoryName = '', initMode = 'empty', sshKeyPath = '', overwrite = false): Promise<WorkspaceOpenResult> {
  const app = window.go?.api?.App;
  if (app?.GitCloneWorkspaceWithAuth) return app.GitCloneWorkspaceWithAuth(remoteUrl, parentDir, directoryName, initMode, sshKeyPath, overwrite);
  return gitCloneWorkspace(remoteUrl, parentDir, directoryName, initMode);
}

export async function openWorkspaceRoot(path: string): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.OpenWorkspaceRoot?.(path)) ?? { ...EMPTY_WORKSPACE_OPEN_RESULT, root: path };
}

export async function useLocalWorkspaceStore(): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.UseLocalWorkspaceStore?.()) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function createLocalWorkspaceRoot(parentDir: string, directoryName: string, initMode = 'empty'): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.CreateLocalWorkspaceRoot?.(parentDir, directoryName, initMode)) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function saveWorkspaceSecrets(values: Record<string, string>): Promise<WorkspaceOpenResult> {
  return (await window.go?.api?.App?.SaveWorkspaceSecrets?.(values)) ?? EMPTY_WORKSPACE_OPEN_RESULT;
}

export async function fetchOAuth2Token(auth: AuthConfig): Promise<OAuth2TokenResponse | null> {
  return (await window.go?.api?.App?.FetchOAuth2Token?.(auth)) ?? null;
}

export async function authorizeOAuth2(auth: AuthConfig): Promise<OAuth2TokenResponse | null> {
  return (await window.go?.api?.App?.AuthorizeOAuth2?.(auth)) ?? null;
}

export async function authorizeOAuth2Device(auth: AuthConfig): Promise<OAuth2TokenResponse | null> {
  return (await window.go?.api?.App?.AuthorizeOAuth2Device?.(auth)) ?? null;
}

export async function refreshOAuth2Token(auth: AuthConfig): Promise<OAuth2TokenResponse | null> {
  return (await window.go?.api?.App?.RefreshOAuth2Token?.(auth)) ?? null;
}

export async function sseConnect(sessionId: string, req: HttpRequest): Promise<void> {
  await window.go?.api?.App?.SSEConnect?.(sessionId, req);
}

export async function sseDisconnect(sessionId: string): Promise<void> {
  await window.go?.api?.App?.SSEDisconnect?.(sessionId);
}

export async function webSocketConnect(sessionId: string, req: HttpRequest): Promise<void> {
  await window.go?.api?.App?.WebSocketConnect?.(sessionId, req);
}

export async function webSocketDisconnect(sessionId: string): Promise<void> {
  await window.go?.api?.App?.WebSocketDisconnect?.(sessionId);
}

export async function webSocketSend(sessionId: string, msg: WebSocketSendMessage): Promise<WebSocketSendResult> {
  return (await window.go?.api?.App?.WebSocketSend?.(sessionId, msg)) ?? { ok: false, error: 'Wails bridge not available' };
}

export async function socketIOConnect(sessionId: string, req: HttpRequest): Promise<void> {
  await window.go?.api?.App?.SocketIOConnect?.(sessionId, req);
}

export async function socketIODisconnect(sessionId: string): Promise<void> {
  await window.go?.api?.App?.SocketIODisconnect?.(sessionId);
}

export async function socketIOEmit(sessionId: string, msg: SocketIOEmitMessage): Promise<SocketIOEmitResult> {
  return (await window.go?.api?.App?.SocketIOEmit?.(sessionId, msg)) ?? { ok: false, error: 'Wails bridge not available' };
}

export async function saveHistoryResponse(id: string, payload: string): Promise<HistoryResponseResult> {
  return (await window.go?.api?.App?.SaveHistoryResponse?.(id, payload)) ?? { stored: false, truncated: false };
}

export async function loadHistoryResponse(id: string): Promise<HistoryResponseResult> {
  return (await window.go?.api?.App?.LoadHistoryResponse?.(id)) ?? { stored: false, truncated: false };
}

export async function pruneHistoryResponses(keepIds: string[]): Promise<string> {
  return (await window.go?.api?.App?.PruneHistoryResponses?.(keepIds)) ?? '';
}

export async function storedHistoryResponseIds(): Promise<string[]> {
  return (await window.go?.api?.App?.StoredHistoryResponseIDs?.()) ?? [];
}

export async function clearHistoryResponses(): Promise<string> {
  return (await window.go?.api?.App?.ClearHistoryResponses?.()) ?? '';
}

export async function validateLoadTest(test: LoadTest, requests: LoadTestRequest[]): Promise<string[]> {
  return (await window.go?.api?.App?.ValidateLoadTest?.(test, requests)) ?? [];
}

export async function startMockServer(config: MockServerConfig): Promise<MockServerStatus> {
  const app = window.go?.api?.App;
  if (!app?.StartMockServer) {
    return { ...EMPTY_MOCK_SERVER_STATUS, error: 'The mock server is only available in the desktop app.' };
  }
  return app.StartMockServer(config);
}

export async function stopMockServer(): Promise<MockServerStatus> {
  const app = window.go?.api?.App;
  if (!app?.StopMockServer) return EMPTY_MOCK_SERVER_STATUS;
  return app.StopMockServer();
}

export async function mockServerStatus(): Promise<MockServerStatus> {
  const app = window.go?.api?.App;
  if (!app?.MockServerStatus) return EMPTY_MOCK_SERVER_STATUS;
  return app.MockServerStatus();
}

export async function mockServerLog(): Promise<MockRequestLog[]> {
  const app = window.go?.api?.App;
  if (!app?.MockServerLog) return [];
  return app.MockServerLog();
}
