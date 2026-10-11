import { kurloChangedFiles } from '../../gitFiles';
import {
  gitStatus, gitDiff, gitOutgoingChanges, gitCommitLogPage, gitCommitDiff, gitConflictFile,
  gitResolveConflictFile, gitContinueOperation, gitAbortOperation, gitStashWorkspace, gitStashPopWorkspace,
  gitFetchWorkspace, gitPullWorkspace, gitPullBranch, gitCloneWorkspace, gitInitWorkspace, gitAddRemote,
  gitTestRemote, gitListBranches, gitCheckoutBranch, gitCreateBranch, gitCreateTrackingBranch,
  gitDeleteBranch, gitRenameBranch, gitStageWorkspaceFiles, gitCommitWorkspace, gitCommitWorkspaceFiles,
  gitPushWorkspace, gitForcePushWorkspace, gitDiscardWorkspaceFile, gitDiscardWorkspaceFiles,
  gitDiscardWorkspaceChanges, gitStoreToken, gitSetSshKey, gitCloneWorkspaceWithAuth, gitSshUrlFor,
  gitRemoteUrl, gitSetRemoteUrl, openWorkspaceRoot, openDirectoryDialog
} from '../../backend';
import { EMPTY_GIT_STATUS } from '../../wire';
import type {
  GitBranchListResult, GitConflictFileResult, GitDiffResult, GitLogResult, GitOperationResult, GitPullSummary,
  GitWorkspaceStatus, WorkspaceOpenResult,
} from '../../backend';
import { fastForwardPullDivergedMessage, normalizeGitPullStrategy, shouldPromptForDivergedPull } from '../../gitPullStrategy';
import { formatGitCommitToast, formatGitFetchToast, formatGitPullToast, formatGitPushToast } from '../../gitPullSummary';
import type { DialogOption } from '../../types/dialog';
import type { TopView } from '../ui';

export const GIT_LOG_PAGE_SIZE = 60;
const GIT_REMOTE_HELP = 'For a private repository Kurlo asks for a personal access token or an SSH key when it needs one. The token is kept encrypted on this device. SSH URLs look like git@gitlab.com:team/project.git.';

export { EMPTY_GIT_STATUS };

export const EMPTY_GIT_DIFF: GitDiffResult = {
  path: '',
  diff: '',
  stagedDiff: '',
  unstagedDiff: '',
  binary: false,
  truncated: false,
  error: '',
};

export const EMPTY_GIT_BRANCHES: GitBranchListResult = {
  ok: false,
  git: EMPTY_GIT_STATUS,
  current: '',
  localBranches: [],
  remoteBranches: [],
  error: '',
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
  error: '',
  output: '',
};

export const EMPTY_GIT_LOG: GitLogResult = {
  ok: false,
  git: EMPTY_GIT_STATUS,
  commits: [],
  limit: 0,
  offset: 0,
  hasMore: false,
  error: '',
  output: '',
};

export function cloneDirectoryNameFromUrl(remoteUrl: string): string {
  let value = remoteUrl.trim().replace(/\/+$/, '');
  const slash = value.lastIndexOf('/');
  if (slash >= 0) value = value.slice(slash + 1);
  const colon = value.lastIndexOf(':');
  if (colon >= 0) value = value.slice(colon + 1);
  value = value.replace(/\.git$/i, '').trim();
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '') || 'kurlo-workspace';
}

export function remoteNameFromUpstream(upstream: string): string {
  const value = upstream.trim();
  const slash = value.indexOf('/');
  return slash > 0 ? value.slice(0, slash) : 'origin';
}

export function isPushBehindError(message: string): boolean {
  return /^Remote has \d+ new commit/i.test(message.trim());
}

export function isUnmergedBranchDeleteError(message: string): boolean {
  return /not fully merged|not merged/i.test(message);
}

export function normalizeGitStatus(status: GitWorkspaceStatus | null | undefined): GitWorkspaceStatus {
  return {
    ...EMPTY_GIT_STATUS,
    ...(status ?? {}),
    files: Array.isArray(status?.files) ? status.files : [],
    remotes: Array.isArray(status?.remotes) ? status.remotes : [],
    stashes: Array.isArray(status?.stashes) ? status.stashes : [],
  };
}

export function normalizeGitBranches(branches: GitBranchListResult | null | undefined): GitBranchListResult {
  return {
    ...EMPTY_GIT_BRANCHES,
    ...(branches ?? {}),
    git: normalizeGitStatus(branches?.git),
    localBranches: Array.isArray(branches?.localBranches) ? branches.localBranches : [],
    remoteBranches: Array.isArray(branches?.remoteBranches) ? branches.remoteBranches : [],
  };
}

export function normalizeGitLog(log: GitLogResult | null | undefined): GitLogResult {
  return {
    ...EMPTY_GIT_LOG,
    ...(log ?? {}),
    git: normalizeGitStatus(log?.git),
    commits: Array.isArray(log?.commits) ? log.commits : [],
    limit: typeof log?.limit === 'number' ? log.limit : 0,
    offset: typeof log?.offset === 'number' ? log.offset : 0,
    hasMore: Boolean(log?.hasMore),
  };
}

function existingLocalBranchForRemote(branches: GitBranchListResult, startPoint: string) {
  const remoteBranch = branches.remoteBranches.find(branch => branch.fullName === startPoint);
  return branches.localBranches.find(branch => branch.upstream === startPoint)
    ?? (remoteBranch ? branches.localBranches.find(branch => branch.name === remoteBranch.name) : undefined);
}

export type GitAuthChoice =
  | { kind: 'token'; username: string; token: string }
  | { kind: 'ssh'; sshKeyPath: string };
export type GitAuthRequest = { host: string; scheme: string; tokenRejected: boolean; defaultUsername: string };

type GitHost = {
  gitWorkspaceOpen: boolean;
  gitStatus: GitWorkspaceStatus;
  gitDiff: GitDiffResult;
  gitBranches: GitBranchListResult;
  gitConflict: GitConflictFileResult;
  gitConflictContent: string;
  gitLog: GitLogResult;
  gitSelectedCommit: string;
  gitSelectedPath: string;
  gitLoading: boolean;
  gitLogLoadingMore: boolean;
  gitDiffLoading: boolean;
  gitAction: string;
  gitMessage: string;
  gitError: string;
  gitOutput: string;
  gitToast: string;
  gitAuthRequest: GitAuthRequest | null;
  gitToastTimer: ReturnType<typeof setTimeout> | null;
  gitPersistRefreshTimer: ReturnType<typeof setTimeout> | null;
  gitAuthRetryGuard: boolean;
  gitPendingRemoteRevert: { remote: string; originalUrl: string } | null;
  gitAuthResolver: ((v: GitAuthChoice | null) => void) | null;
  topView: TopView;
  activeRequestId: string;
  closeFloatingMenus: () => void;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  openPromptDialog: (title: string, initialValue?: string, message?: string) => Promise<string | null>;
  openSelectDialog: (title: string, message: string, options: DialogOption[], confirmLabel?: string, cancelLabel?: string) => Promise<string | false | null>;
  openConfirmDialog: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  defaultWorkspaceParentForDialogs: () => Promise<string>;
  applyWorkspaceOpenResult: (result: WorkspaceOpenResult, successMessage: string) => Promise<boolean>;
  cancelPendingPersistTimers: () => void;
  guardGitWorkspaceMutable: (action?: string) => boolean;
  collectionImportToast: string;
  beginGitMutation: (action: string, options?: { guard?: boolean; refreshStatus?: boolean }) => Promise<boolean>;
  refreshGitStatus: () => Promise<void>;
  refreshGitStatusAfterPersist: () => Promise<void>;
  selectGitFile: (path: string) => Promise<void>;
  loadGitConflictFile: (path?: string) => Promise<void>;
  refreshGitBranches: () => Promise<void>;
  showGitToast: (message: string) => void;
  showGitPullToast: (summary: GitPullSummary | null | undefined) => void;
  applyGitOperationResult: (result: GitOperationResult, successMessage: string | ((result: GitOperationResult) => string)) => Promise<boolean>;
  openGitTab: (refresh?: boolean) => void;
  openGitAuthDialog: (req: GitAuthRequest) => Promise<GitAuthChoice | null>;
  promptAndStoreGitAuth: (g: GitWorkspaceStatus | undefined) => Promise<{ retry: boolean; sshKeyPath?: string; remoteUrlOverride?: string }>;
  afterGitAuthRetry: (status?: GitWorkspaceStatus) => Promise<void>;
  fetchGitWorkspace: () => Promise<void>;
  pullGitWorkspace: (strategy?: string) => Promise<void>;
  checkoutGitBranch: (branchName?: string) => Promise<void>;
  pullThenPushGitWorkspace: (strategy: string, remoteName: string) => Promise<void>;
  pushGitWorkspace: () => Promise<void>;
};

export const gitFeature = {
  scheduleGitStatusRefreshAfterPersist(this: GitHost) {
    if (this.gitPersistRefreshTimer) clearTimeout(this.gitPersistRefreshTimer);
    this.gitPersistRefreshTimer = setTimeout(() => {
      this.gitPersistRefreshTimer = null;
      void this.refreshGitStatusAfterPersist();
    }, 180);
  },
  async refreshGitStatusAfterPersist(this: GitHost) {
    try {
      const status = normalizeGitStatus(await gitStatus());
      this.gitStatus = status;
      if (status.isRepo) {
        this.gitBranches = normalizeGitBranches(await gitListBranches());
      } else {
        this.gitBranches = { ...EMPTY_GIT_BRANCHES };
      }
      if (this.gitSelectedPath && status.files.some(file => file.path === this.gitSelectedPath)) {
        void this.selectGitFile(this.gitSelectedPath);
      } else if (this.gitSelectedPath) {
        this.gitSelectedPath = '';
        this.gitDiff = { ...EMPTY_GIT_DIFF };
      }
    } catch {
    }
  },
  async refreshGitStatus(this: GitHost) {
    this.gitLoading = true;
    this.gitAction = 'refresh';
    this.gitError = '';
    try {
      const status = normalizeGitStatus(await gitStatus());
      this.gitStatus = status;
      if (status.error) this.gitError = status.error;
      if (status.isRepo) {
        this.gitBranches = normalizeGitBranches(await gitListBranches());
        this.gitLog = normalizeGitLog(await gitCommitLogPage(GIT_LOG_PAGE_SIZE, 0));
      } else {
        this.gitBranches = { ...EMPTY_GIT_BRANCHES };
        this.gitLog = { ...EMPTY_GIT_LOG };
      }
      if (this.gitSelectedPath && !status.files.some(file => file.path === this.gitSelectedPath)) {
        this.gitSelectedPath = '';
        this.gitDiff = { ...EMPTY_GIT_DIFF };
        this.gitConflict = { ...EMPTY_GIT_CONFLICT_FILE };
        this.gitConflictContent = '';
      }
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'refresh') this.gitAction = '';
    }
  },
  async selectGitFile(this: GitHost, path: string) {
    this.gitSelectedPath = path;
    this.gitSelectedCommit = '';
    this.gitConflict = { ...EMPTY_GIT_CONFLICT_FILE };
    this.gitConflictContent = '';
    this.gitDiffLoading = true;
    this.gitDiff = { ...EMPTY_GIT_DIFF, path };
    const selected = this.gitStatus.files.find(file => file.path === path);
    const conflictPromise = selected?.status === 'conflicted' ? this.loadGitConflictFile(path) : Promise.resolve();
    try {
      const [diff] = await Promise.all([gitDiff(path), conflictPromise]);
      if (this.gitSelectedPath === path) this.gitDiff = diff;
    } catch (error) {
      if (this.gitSelectedPath === path) {
        this.gitDiff = { ...EMPTY_GIT_DIFF, path, error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      if (this.gitSelectedPath === path) this.gitDiffLoading = false;
    }
  },
  async refreshGitQuietly(this: GitHost) {
    if (this.gitLoading || !this.gitStatus.isRepo) return;
    await this.refreshGitStatusAfterPersist();
    if (this.gitLoading || !this.gitStatus.isRepo) return;
    try {
      const page = normalizeGitLog(await gitCommitLogPage(GIT_LOG_PAGE_SIZE, 0));
      if (!page.error && page.commits[0]?.hash !== this.gitLog.commits[0]?.hash) this.gitLog = page;
    } catch {
    }
  },
  async loadMoreGitLog(this: GitHost) {
    if (!this.gitStatus.isRepo || this.gitLogLoadingMore || !this.gitLog.hasMore) return;
    this.gitLogLoadingMore = true;
    const startLog = this.gitLog;
    try {
      const page = normalizeGitLog(await gitCommitLogPage(GIT_LOG_PAGE_SIZE, startLog.commits.length));
      if (this.gitLog !== startLog) return;
      const seen = new Set(startLog.commits.map(commit => commit.hash));
      this.gitLog = {
        ...page,
        commits: [...startLog.commits, ...page.commits.filter(commit => !seen.has(commit.hash))],
      };
      if (page.error) this.gitError = page.error;
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLogLoadingMore = false;
    }
  },
  async selectGitCommit(this: GitHost, commit: string) {
    commit = commit.trim();
    if (!commit) return;
    this.gitSelectedCommit = commit;
    this.gitSelectedPath = '';
    this.gitConflict = { ...EMPTY_GIT_CONFLICT_FILE };
    this.gitConflictContent = '';
    this.gitDiffLoading = true;
    this.gitDiff = { ...EMPTY_GIT_DIFF, path: 'Commit diff' };
    try {
      this.gitDiff = await gitCommitDiff(commit);
      if (this.gitDiff.error) this.gitError = this.gitDiff.error;
    } catch (error) {
      this.gitDiff = { ...EMPTY_GIT_DIFF, path: 'Commit diff', error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.gitDiffLoading = false;
    }
  },
  async loadGitConflictFile(this: GitHost, path = this.gitSelectedPath) {
    path = path.trim();
    if (!path) return;
    try {
      const result = await gitConflictFile(path);
      if (this.gitSelectedPath && this.gitSelectedPath !== path) return;
      this.gitConflict = { ...result, path: result.path || path };
      this.gitConflictContent = result.content ?? '';
      if (result.error) this.gitError = result.error;
    } catch (error) {
      if (this.gitSelectedPath && this.gitSelectedPath !== path) return;
      this.gitConflict = { ...EMPTY_GIT_CONFLICT_FILE, path, error: error instanceof Error ? error.message : String(error) };
      this.gitError = this.gitConflict.error;
    }
  },
  showGitToast(this: GitHost, message: string) {
    message = message.trim();
    if (!message) return;
    this.gitToast = message;
    if (this.gitToastTimer) clearTimeout(this.gitToastTimer);
    this.gitToastTimer = setTimeout(() => {
      if (this.gitToast === message) this.gitToast = '';
      this.gitToastTimer = null;
    }, 4200);
  },
  showGitPullToast(this: GitHost, summary: GitPullSummary | null | undefined) {
    this.showGitToast(formatGitPullToast(summary));
  },
  async applyGitOperationResult(this: GitHost, result: GitOperationResult, successMessage: string | ((result: GitOperationResult) => string)) {
    this.gitOutput = result.output ?? '';
    this.gitStatus = normalizeGitStatus(result.git ?? await gitStatus());
    if (!result.ok) {
      this.gitError = result.error || 'Git operation failed';
      return false;
    }
    const message = typeof successMessage === 'function' ? successMessage(result) : successMessage;
    this.gitError = '';
    this.gitMessage = message;
    if (this.gitStatus.isRepo) {
      this.gitBranches = normalizeGitBranches(await gitListBranches());
      this.gitLog = normalizeGitLog(await gitCommitLogPage(GIT_LOG_PAGE_SIZE, 0));
    }
    if (this.gitSelectedPath && this.gitStatus.files.some(file => file.path === this.gitSelectedPath)) {
      void this.selectGitFile(this.gitSelectedPath);
    } else if (this.gitSelectedPath) {
      this.gitSelectedPath = '';
      this.gitDiff = { ...EMPTY_GIT_DIFF };
      this.gitConflict = { ...EMPTY_GIT_CONFLICT_FILE };
      this.gitConflictContent = '';
    }
    this.showGitToast(message);
    setTimeout(() => { if (this.gitMessage === message) this.gitMessage = ''; }, 3200);
    return true;
  },
  async refreshGitBranches(this: GitHost) {
    this.gitLoading = true;
    this.gitAction = 'branches';
    this.gitError = '';
    try {
      const result = normalizeGitBranches(await gitListBranches());
      this.gitBranches = result;
      this.gitStatus = normalizeGitStatus(result.git);
      if (!result.ok) this.gitError = result.error || 'Could not load Git branches';
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'branches') this.gitAction = '';
    }
  },
  async beginGitMutation(this: GitHost, action: string, options: { guard?: boolean; refreshStatus?: boolean } = {}) {
    const { guard = true, refreshStatus = false } = options;
    if (guard && !this.guardGitWorkspaceMutable(action)) return false;
    await this.persistActiveRequestNow(true);
    if (refreshStatus) await this.refreshGitStatus();
    return true;
  },
  async openGitWorkspace(this: GitHost) {
    this.closeFloatingMenus();
    await this.persistActiveRequestNow(true);
    const path = await openDirectoryDialog('Open Kurlo workspace repository');
    if (!path) return;
    this.gitLoading = true;
    this.gitAction = 'open';
    this.gitError = '';
    try {
      const result = await openWorkspaceRoot(path);
      await this.applyWorkspaceOpenResult(result, `Opened ${result.root || path}`);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'open') this.gitAction = '';
    }
  },
  openGitTab(this: GitHost, refresh = true) {
    this.closeFloatingMenus();
    this.gitWorkspaceOpen = true;
    this.topView = 'git';
    if (refresh) void this.refreshGitStatus();
  },
  closeGitTab(this: GitHost) {
    this.gitWorkspaceOpen = false;
    if (this.topView === 'git') {
      this.topView = this.activeRequestId ? 'request' : 'overview';
    }
  },
  async cloneGitWorkspace(this: GitHost) {
    this.closeFloatingMenus();
    await this.persistActiveRequestNow(true);
    const remoteUrl = await this.openPromptDialog('Clone Git workspace', '', GIT_REMOTE_HELP);
    if (!remoteUrl) return;
    const defaultDirName = cloneDirectoryNameFromUrl(remoteUrl);
    const directoryName = await this.openPromptDialog('Clone folder name', defaultDirName, 'Kurlo will create this folder inside the parent directory you choose next.');
    if (!directoryName) return;
    const initMode = await this.openSelectDialog('Kurlo workspace setup', 'If the cloned repository does not already contain Kurlo workspace files, choose what Kurlo should create:', [
      { value: 'empty', label: 'Create empty workspace', description: `Create a workspace named "${directoryName}" with a default collection.` },
      { value: 'copy', label: 'Copy current workspaces', description: 'Copy all workspaces in the current folder, including their collections, requests, and environments.' },
    ], 'Clone', 'Cancel');
    if (!initMode) return;
    const parentDir = await openDirectoryDialog(`Choose parent folder for ${directoryName}`, await this.defaultWorkspaceParentForDialogs());
    if (!parentDir) return;
    this.gitLoading = true;
    this.gitAction = 'clone';
    this.gitError = '';
    try {
      let overwrite = false;
      let result = await gitCloneWorkspace(remoteUrl, parentDir, directoryName, initMode);
      if (!result.ok && result.targetExists) {
        const confirmed = await this.openConfirmDialog(
          'Folder already exists',
          `A folder named "${directoryName}" already exists in the chosen location.\n\nOverwrite it? This permanently deletes its current contents (only after the clone succeeds — a failed clone leaves it untouched).`,
          'Overwrite',
        );
        if (!confirmed) {
          this.gitError = result.error || 'Destination folder already exists.';
          return;
        }
        overwrite = true;
        result = await gitCloneWorkspaceWithAuth(remoteUrl, parentDir, directoryName, initMode, '', true);
      }
      if (!result.ok && result.git?.authRequired) {
        const auth = await this.promptAndStoreGitAuth(result.git);
        if (auth.retry) {
          let cloneUrl = remoteUrl;
          if (auth.sshKeyPath) {
            const sshUrl = (await gitSshUrlFor(remoteUrl)).trim();
            if (sshUrl) cloneUrl = sshUrl;
          }
          this.gitAuthRetryGuard = true;
          try {
            result = await gitCloneWorkspaceWithAuth(cloneUrl, parentDir, directoryName, initMode, auth.sshKeyPath ?? '', overwrite);
          } finally { this.gitAuthRetryGuard = false; }
        }
      }
      await this.applyWorkspaceOpenResult(result, `Cloned ${result.root || remoteUrl}`);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'clone') this.gitAction = '';
    }
  },
  openGitAuthDialog(this: GitHost, req: GitAuthRequest): Promise<GitAuthChoice | null> {
    return new Promise((resolve) => {
      this.gitAuthResolver = resolve;
      this.gitAuthRequest = req;
    });
  },
  resolveGitAuth(this: GitHost, choice: GitAuthChoice | null) {
    const resolve = this.gitAuthResolver;
    this.gitAuthResolver = null;
    this.gitAuthRequest = null;
    resolve?.(choice ?? null);
  },
  async promptAndStoreGitAuth(
    this: GitHost,
    g: GitWorkspaceStatus | undefined,
  ): Promise<{ retry: boolean; sshKeyPath?: string; remoteUrlOverride?: string }> {
    if (!g?.authRequired || this.gitAuthRetryGuard) return { retry: false };
    const host = (g.authHost || '').trim();
    const defaultUser = host.includes('gitlab') ? 'oauth2'
      : host.includes('github') ? 'x-access-token' : '';
    const choice = await this.openGitAuthDialog({
      host,
      scheme: g.authScheme || 'https',
      tokenRejected: !!g.tokenRejected,
      defaultUsername: defaultUser,
    });
    if (!choice) return { retry: false };
    if (choice.kind === 'ssh') {
      const keyPath = choice.sshKeyPath.trim();
      if (!keyPath) return { retry: false };
      const root = (this.gitStatus.root || g.root || '').trim();
      if (!root) {
        return { retry: true, sshKeyPath: keyPath };
      }
      const res = await gitSetSshKey(root, keyPath);
      if (!res.ok) { this.gitError = res.error || 'Could not save the SSH key.'; return { retry: false }; }
      if ((g.authScheme || 'https') === 'https') {
        const remote = this.gitStatus.upstream
          ? remoteNameFromUpstream(this.gitStatus.upstream)
          : (this.gitStatus.remotes?.[0] || 'origin');
        const originalUrl = (await gitRemoteUrl(remote)).trim();
        const sshUrl = originalUrl ? (await gitSshUrlFor(originalUrl)).trim() : '';
        if (sshUrl && sshUrl !== originalUrl) {
          const sw = await gitSetRemoteUrl(remote, sshUrl);
          if (sw.ok) this.gitPendingRemoteRevert = { remote, originalUrl };
        }
      }
      return { retry: true };
    }
    if (!host) { this.gitError = 'Could not determine the remote host for the token.'; return { retry: false }; }
    if (!choice.token.trim()) return { retry: false };
    const res = await gitStoreToken(host, choice.username || defaultUser, choice.token.trim());
    if (!res.ok) { this.gitError = res.error || 'Could not save the token.'; return { retry: false }; }
    return { retry: true };
  },
  async afterGitAuthRetry(this: GitHost, status?: GitWorkspaceStatus) {
    const rev = this.gitPendingRemoteRevert;
    if (!rev) return;
    this.gitPendingRemoteRevert = null;
    if ((status ?? this.gitStatus).authRequired) {
      await gitSetRemoteUrl(rev.remote, rev.originalUrl);
      this.gitError = `The SSH key didn't authenticate — reverted ${rev.remote} back to its HTTPS URL. Try another key or use a token.`;
    }
  },
  async fetchGitWorkspace(this: GitHost) {
    this.gitLoading = true;
    this.gitAction = 'fetch';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const status = await gitFetchWorkspace();
      this.gitStatus = normalizeGitStatus(status);
      if (this.gitStatus.isRepo) this.gitBranches = normalizeGitBranches(await gitListBranches());
      if (status.error) {
        this.gitError = status.error;
        if ((await this.promptAndStoreGitAuth(status)).retry) {
          this.gitAuthRetryGuard = true;
          try { await this.fetchGitWorkspace(); } finally { this.gitAuthRetryGuard = false; }
          await this.afterGitAuthRetry();
        }
      }
      else {
        const message = formatGitFetchToast(this.gitStatus);
        this.gitMessage = message;
        this.showGitToast(message);
        setTimeout(() => { if (this.gitMessage === message) this.gitMessage = ''; }, 3200);
      }
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'fetch') this.gitAction = '';
    }
  },
  async pullGitWorkspace(this: GitHost, strategy = 'ff') {
    await this.beginGitMutation('Pull', { guard: false });
    let normalizedStrategy = normalizeGitPullStrategy(strategy);
    if (shouldPromptForDivergedPull(normalizedStrategy, this.gitStatus)) {
      const selected = await this.openSelectDialog(
        'Branches diverged',
        'Your local branch and the remote branch both have new commits. Choose how Kurlo should pull:',
        [
          { value: 'merge', label: 'Merge remote changes', description: 'Creates a merge commit. If the same YAML changed on both sides, Kurlo will open the conflict editor.' },
          { value: 'rebase', label: 'Rebase local commit', description: 'Replays your local commit on top of the remote branch.' },
        ],
        'Pull',
        'Cancel',
      );
      if (!selected) return;
      normalizedStrategy = selected;
    }
    if ((normalizedStrategy === 'merge' || normalizedStrategy === 'rebase') && this.gitStatus.operation) {
      this.gitError = `Finish or abort the current ${this.gitStatus.operation} before pulling again.`;
      return;
    }
    this.gitLoading = true;
    this.gitAction = normalizedStrategy === 'ff' ? 'pull' : `pull-${normalizedStrategy}`;
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitPullWorkspace(normalizedStrategy);
      if (!result.ok) {
        if ((result.diagnostics ?? []).length) {
          await this.applyWorkspaceOpenResult(result, result.error || 'Workspace files or references need repair');
          if (this.gitStatus.isRepo) {
            this.gitBranches = normalizeGitBranches(await gitListBranches());
            this.gitLog = normalizeGitLog(await gitCommitLogPage(GIT_LOG_PAGE_SIZE, 0));
          }
          return;
        }
        this.gitStatus = normalizeGitStatus(result.git ?? this.gitStatus);
        if (this.gitStatus.isRepo) {
          this.gitBranches = normalizeGitBranches(await gitListBranches());
          this.gitLog = normalizeGitLog(await gitCommitLogPage(GIT_LOG_PAGE_SIZE, 0));
        }
        this.gitOutput = result.output ?? '';
        const rawError = result.error || 'Pull failed';
        this.gitError = normalizedStrategy === 'ff' ? fastForwardPullDivergedMessage(rawError) : rawError;
        if ((await this.promptAndStoreGitAuth(result.git)).retry) {
          this.gitAuthRetryGuard = true;
          try { await this.pullGitWorkspace(normalizedStrategy); } finally { this.gitAuthRetryGuard = false; }
          await this.afterGitAuthRetry();
        }
        return;
      }
      const label = normalizedStrategy === 'merge' ? 'Pulled with merge' : normalizedStrategy === 'rebase' ? 'Pulled with rebase' : 'Pulled latest workspace changes';
      if (await this.applyWorkspaceOpenResult(result, label)) this.showGitPullToast(result.pullSummary);
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'pull' || this.gitAction === `pull-${normalizedStrategy}`) this.gitAction = '';
    }
  },
  async pullGitBranch(this: GitHost, branchName: string) {
    branchName = branchName.trim();
    if (!branchName) return;
    if (branchName === this.gitStatus.branch) {
      await this.pullGitWorkspace('ff');
      return;
    }
    if (!await this.beginGitMutation('Branch pull')) return;
    this.gitLoading = true;
    this.gitAction = 'branch-pull';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitPullBranch(branchName);
      const ok = await this.applyGitOperationResult(result, `Pulled ${branchName}`);
      if (ok) this.showGitPullToast(result.pullSummary);
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'branch-pull') this.gitAction = '';
    }
  },
  async resolveGitConflict(this: GitHost, resolution: string, path = this.gitSelectedPath, content = this.gitConflictContent) {
    path = path.trim();
    if (!path) return false;
    this.cancelPendingPersistTimers();
    this.gitLoading = true;
    this.gitAction = `resolve-${resolution}`;
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitResolveConflictFile(path, resolution, content);
      const ok = await this.applyGitOperationResult(result, `Resolved ${path}`);
      if (result.ok) {
        this.gitConflict = { ...EMPTY_GIT_CONFLICT_FILE };
        this.gitConflictContent = '';
      }
      return ok;
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.gitLoading = false;
      if (this.gitAction === `resolve-${resolution}`) this.gitAction = '';
    }
  },
  async continueGitOperation(this: GitHost) {
    const operation = this.gitStatus.operation;
    if (!operation) return;
    let message = '';
    if (operation === 'merge') {
      const mergeMessage = await this.openPromptDialog('Continue merge', 'Merge Kurlo workspace', 'Kurlo will create the merge commit after all conflicts are resolved.');
      if (!mergeMessage) return;
      message = mergeMessage;
    }
    this.cancelPendingPersistTimers();
    this.gitLoading = true;
    this.gitAction = 'operation-continue';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitContinueOperation(message);
      if (!result.ok) {
        this.gitStatus = normalizeGitStatus(result.git ?? this.gitStatus);
        this.gitOutput = result.output ?? '';
        this.gitError = result.error || `Could not continue ${operation}`;
        if (this.gitStatus.isRepo) this.gitBranches = normalizeGitBranches(await gitListBranches());
        return;
      }
      await this.applyWorkspaceOpenResult(result, `${operation === 'rebase' ? 'Rebase' : 'Merge'} completed`);
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'operation-continue') this.gitAction = '';
    }
  },
  async abortGitOperation(this: GitHost) {
    const operation = this.gitStatus.operation;
    if (!operation) return;
    const confirmed = await this.openConfirmDialog(
      `Abort ${operation}`,
      `Abort the current Git ${operation} and reload the workspace from the previous state?`
    );
    if (!confirmed) return;
    this.cancelPendingPersistTimers();
    this.gitLoading = true;
    this.gitAction = 'operation-abort';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitAbortOperation();
      if (!result.ok) {
        this.gitStatus = normalizeGitStatus(result.git ?? this.gitStatus);
        this.gitOutput = result.output ?? '';
        this.gitError = result.error || `Could not abort ${operation}`;
        return;
      }
      await this.applyWorkspaceOpenResult(result, `${operation === 'rebase' ? 'Rebase' : 'Merge'} aborted`);
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'operation-abort') this.gitAction = '';
    }
  },
  async stashGitWorkspace(this: GitHost) {
    if (!this.gitStatus.isRepo || this.gitStatus.operation) return;
    if (!await this.beginGitMutation('Stash')) return;
    const message = await this.openPromptDialog('Stash Kurlo changes', 'Kurlo workspace changes', 'Only Kurlo-managed YAML files are stashed.');
    if (!message) return;
    this.gitLoading = true;
    this.gitAction = 'stash';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitStashWorkspace(message);
      if (!result.ok) {
        this.gitStatus = normalizeGitStatus(result.git ?? this.gitStatus);
        this.gitOutput = result.output ?? '';
        this.gitError = result.error || 'Could not stash Kurlo changes';
        return;
      }
      await this.applyWorkspaceOpenResult(result, 'Stashed Kurlo workspace changes');
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'stash') this.gitAction = '';
    }
  },
  async popGitStash(this: GitHost, ref = this.gitStatus.stashes?.[0]?.ref ?? '') {
    if (!this.gitStatus.isRepo || this.gitStatus.operation) return;
    if (!await this.beginGitMutation('Applying stash')) return;
    if (!ref) {
      this.gitError = 'No Git stashes to apply.';
      return;
    }
    this.gitLoading = true;
    this.gitAction = 'stash-pop';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitStashPopWorkspace(ref);
      if (!result.ok) {
        this.gitStatus = normalizeGitStatus(result.git ?? this.gitStatus);
        this.gitOutput = result.output ?? '';
        this.gitError = result.error || 'Could not apply Git stash';
        if (this.gitStatus.isRepo) this.gitBranches = normalizeGitBranches(await gitListBranches());
        return;
      }
      await this.applyWorkspaceOpenResult(result, 'Applied Git stash');
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'stash-pop') this.gitAction = '';
    }
  },
  async initGitWorkspace(this: GitHost) {
    this.closeFloatingMenus();
    if (!await this.beginGitMutation('Git init')) return;
    this.gitLoading = true;
    this.gitAction = 'init';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitInitWorkspace();
      await this.applyGitOperationResult(result, result.output?.includes('Already') ? 'Git repository is ready' : 'Initialized Git repository');
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'init') this.gitAction = '';
    }
  },
  async addGitRemote(this: GitHost) {
    if (!this.guardGitWorkspaceMutable('Remote changes')) return;
    this.closeFloatingMenus();
    const remoteUrl = await this.openPromptDialog('Add Git remote', '', GIT_REMOTE_HELP);
    if (!remoteUrl) return;
    const remoteName = await this.openPromptDialog('Remote name', this.gitStatus.upstream ? remoteNameFromUpstream(this.gitStatus.upstream) : 'origin');
    if (!remoteName) return;
    this.gitLoading = true;
    this.gitAction = 'remote';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitAddRemote(remoteName, remoteUrl);
      await this.applyGitOperationResult(result, `Remote ${remoteName} saved`);
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'remote') this.gitAction = '';
    }
  },
  async testGitRemote(this: GitHost) {
    this.closeFloatingMenus();
    const defaultRemote = this.gitStatus.upstream ? remoteNameFromUpstream(this.gitStatus.upstream) : 'origin';
    const remoteNameOrUrl = await this.openPromptDialog('Test Git remote', defaultRemote, 'Use a remote name such as origin, or paste an SSH/HTTPS Git URL. Kurlo uses your system Git auth.');
    if (!remoteNameOrUrl) return;
    this.gitLoading = true;
    this.gitAction = 'remote-test';
    this.gitError = '';
    this.gitMessage = '';
    try {
      let result = await gitTestRemote(remoteNameOrUrl);
      if (!result.ok && result.git?.authRequired) {
        this.gitStatus = normalizeGitStatus(result.git);
        this.gitError = result.error || 'Remote connection failed';
        if ((await this.promptAndStoreGitAuth(result.git)).retry) {
          this.gitAuthRetryGuard = true;
          try { result = await gitTestRemote(remoteNameOrUrl); } finally { this.gitAuthRetryGuard = false; }
          await this.afterGitAuthRetry(result.git);
        } else {
          return;
        }
      }
      await this.applyGitOperationResult(result, 'Remote connection works');
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'remote-test') this.gitAction = '';
    }
  },
  async checkoutGitBranch(this: GitHost, branchName = '') {
    this.closeFloatingMenus();
    if (!await this.beginGitMutation('Branch checkout', { refreshStatus: true })) return;
    if (!this.gitStatus.isRepo) {
      this.gitError = 'Open a Git repository first.';
      return;
    }
    if (!this.gitStatus.clean) {
      const count = this.gitStatus.files.length;
      this.gitError = 'Commit or discard local Git changes before switching branches.';
      await this.openAlertDialog(
        'Checkout blocked',
        `You have ${count} local Git change${count === 1 ? '' : 's'}. Kurlo will not switch branches until those changes are committed or discarded, so your local work is not overwritten.`
      );
      return;
    }
    branchName = branchName.trim();
    if (!branchName) {
      let branches = this.gitBranches.localBranches.filter(branch => !branch.current);
      if (!branches.length) {
        await this.refreshGitBranches();
        branches = this.gitBranches.localBranches.filter(branch => !branch.current);
      }
      if (!branches.length) {
        this.gitError = 'No other local branches found.';
        return;
      }
      const selectedBranchName = await this.openSelectDialog('Checkout branch', 'Switch to an existing local branch. Kurlo reloads the workspace after checkout.', branches.map(branch => ({
        value: branch.name,
        label: branch.name,
        description: branch.upstream ? `Tracks ${branch.upstream}` : 'Local branch',
      })), 'Checkout', 'Cancel');
      if (!selectedBranchName) return;
      branchName = selectedBranchName;
    }
    this.gitLoading = true;
    this.gitAction = 'checkout';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitCheckoutBranch(branchName);
      await this.applyWorkspaceOpenResult(result, `Switched to ${branchName}`);
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'checkout') this.gitAction = '';
    }
  },
  async createGitBranch(this: GitHost, startPoint = '') {
    this.closeFloatingMenus();
    if (!await this.beginGitMutation('Branch creation', { refreshStatus: true })) return;
    if (!this.gitStatus.isRepo) {
      this.gitError = 'Open a Git repository first.';
      return;
    }
    startPoint = startPoint.trim();
    if (startPoint && !this.gitStatus.clean) {
      const count = this.gitStatus.files.length;
      this.gitError = 'Commit or discard local Git changes before creating a branch from another base.';
      await this.openAlertDialog(
        'Branch creation blocked',
        `You have ${count} local Git change${count === 1 ? '' : 's'}. Kurlo can create a branch from the current HEAD, but creating one from ${startPoint} requires a clean workspace.`
      );
      return;
    }
    const branchName = await this.openPromptDialog('Create branch', '', startPoint ? `Create a new branch from ${startPoint} and switch to it.` : 'Create a new branch from the current HEAD and switch to it.');
    if (!branchName) return;
    this.gitLoading = true;
    this.gitAction = 'branch-create';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitCreateBranch(branchName, startPoint);
      await this.applyWorkspaceOpenResult(result, `Created branch ${branchName}`);
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'branch-create') this.gitAction = '';
    }
  },
  async createGitBranchFromRemote(this: GitHost, startPoint = '') {
    this.closeFloatingMenus();
    if (!await this.beginGitMutation('Branch tracking', { refreshStatus: true })) return;
    if (!this.gitStatus.isRepo) {
      this.gitError = 'Open a Git repository first.';
      return;
    }
    if (!this.gitStatus.clean) {
      const count = this.gitStatus.files.length;
      this.gitError = 'Commit or discard local Git changes before creating a branch from remote.';
      await this.openAlertDialog(
        'Track remote blocked',
        `You have ${count} local Git change${count === 1 ? '' : 's'}. Kurlo will not create or switch tracking branches until those changes are committed or discarded.`
      );
      return;
    }
    let branches = this.gitBranches.remoteBranches;
    startPoint = startPoint.trim();
    if (!startPoint) {
      if (!branches.length) {
        await this.refreshGitBranches();
        branches = this.gitBranches.remoteBranches;
      }
      if (!branches.length) {
        this.gitError = 'No remote branches found. Fetch first, then try again.';
        return;
      }
      const selectedStartPoint = await this.openSelectDialog('Track remote branch', 'Choose a remote branch to create locally and track.', branches.map(branch => ({
        value: branch.fullName,
        label: branch.fullName,
        description: `Remote ${branch.remote}`,
      })), 'Continue', 'Cancel');
      if (!selectedStartPoint) return;
      startPoint = selectedStartPoint;
    }
    const selected = branches.find(branch => branch.fullName === startPoint);
    const existingLocal = existingLocalBranchForRemote(this.gitBranches, startPoint);
    if (existingLocal) {
      if (existingLocal.current) {
        this.gitError = '';
        this.gitMessage = `${existingLocal.name} already tracks ${startPoint}`;
        setTimeout(() => { if (this.gitMessage === `${existingLocal.name} already tracks ${startPoint}`) this.gitMessage = ''; }, 3200);
        return;
      }
      await this.checkoutGitBranch(existingLocal.name);
      return;
    }
    const branchName = await this.openPromptDialog('Local branch name', selected?.name ?? startPoint.replace(/^[^/]+\//, ''), 'Kurlo will create and check out this local tracking branch.');
    if (!branchName) return;
    this.gitLoading = true;
    this.gitAction = 'branch-track';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitCreateTrackingBranch(branchName, startPoint);
      await this.applyWorkspaceOpenResult(result, `Created branch ${branchName}`);
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'branch-track') this.gitAction = '';
    }
  },
  async deleteGitBranch(this: GitHost, branchName: string, remote = false) {
    if (!this.guardGitWorkspaceMutable('Branch deletion')) return;
    this.closeFloatingMenus();
    branchName = branchName.trim();
    if (!branchName) return;
    const confirmed = await this.openConfirmDialog(
      remote ? 'Delete remote branch' : 'Delete branch',
      remote
        ? `Delete ${branchName} from the remote? This removes it for everyone who uses that remote.`
        : `Delete local branch ${branchName}? The remote branch, if any, is not deleted.`,
      'Delete'
    );
    if (!confirmed) return;
    this.gitLoading = true;
    this.gitAction = remote ? 'branch-delete-remote' : 'branch-delete';
    this.gitError = '';
    this.gitMessage = '';
    try {
      let result = await gitDeleteBranch(branchName, remote, false);
      if (!remote && !result.ok && isUnmergedBranchDeleteError(result.error || result.output || '')) {
        this.gitStatus = normalizeGitStatus(result.git ?? this.gitStatus);
        this.gitOutput = result.output ?? '';
        const forceConfirmed = await this.openConfirmDialog(
          'Branch has unmerged commits',
          `Git refused to safely delete ${branchName} because it has commits not merged into the current branch.\n\nForce delete this local branch?`,
          'Force delete'
        );
        if (!forceConfirmed) {
          this.gitError = result.error || 'Branch deletion cancelled';
          return;
        }
        result = await gitDeleteBranch(branchName, false, true);
      }
      await this.applyGitOperationResult(result, remote ? `Deleted remote branch ${branchName}` : `Deleted branch ${branchName}`);
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'branch-delete' || this.gitAction === 'branch-delete-remote') this.gitAction = '';
    }
  },
  async renameGitBranch(this: GitHost, branchName: string, remote = false) {
    if (!this.guardGitWorkspaceMutable('Branch rename')) return;
    this.closeFloatingMenus();
    branchName = branchName.trim();
    if (!branchName) return;
    const shortName = remote ? branchName.replace(/^[^/]+\//, '') : branchName;
    const newName = (await this.openPromptDialog(
      remote ? 'Rename remote branch' : 'Rename local branch',
      shortName,
      remote
        ? 'Kurlo recreates the branch under the new name on the remote, deletes the old name, and re-points any local tracking branch. This affects everyone who uses that remote.'
        : 'Renames only the local branch. The remote branch, if any, keeps its old name until you rename it on the remote too.'
    ))?.trim();
    if (!newName || newName === shortName) return;
    if (remote) {
      const confirmed = await this.openConfirmDialog(
        'Rename remote branch',
        `Rename ${branchName} to ${newName} on the remote? The old remote branch is deleted and recreated under the new name for everyone who uses that remote.`,
        'Rename'
      );
      if (!confirmed) return;
    }
    this.gitLoading = true;
    this.gitAction = remote ? 'branch-rename-remote' : 'branch-rename';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitRenameBranch(branchName, newName, remote);
      const ok = await this.applyGitOperationResult(result, remote ? `Renamed remote branch to ${newName}` : `Renamed branch to ${newName}`);
      if (ok && !remote) {
        const upstream = (result.git?.upstream || '').trim();
        const upstreamBranch = upstream.includes('/') ? upstream.slice(upstream.indexOf('/') + 1) : upstream;
        if (result.git?.branch === newName && upstream && upstreamBranch && upstreamBranch !== newName) {
          this.collectionImportToast = `Renamed locally to "${newName}". Remote still has "${upstreamBranch}" — use branch menu → "Rename (remote)" to update it, or push will be refused.`;
          setTimeout(() => (this.collectionImportToast = ''), 7000);
        }
      }
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'branch-rename' || this.gitAction === 'branch-rename-remote') this.gitAction = '';
    }
  },
  async viewGitOutgoingChanges(this: GitHost) {
    this.closeFloatingMenus();
    if (!this.gitStatus.isRepo) {
      this.gitError = 'Open a Git repository first.';
      return;
    }
    this.gitLoading = true;
    this.gitAction = 'outgoing';
    this.gitDiffLoading = true;
    this.gitError = '';
    this.gitMessage = '';
    this.gitSelectedPath = 'Outgoing changes';
    this.gitDiff = { ...EMPTY_GIT_DIFF, path: 'Outgoing changes' };
    try {
      const diff = await gitOutgoingChanges();
      this.gitDiff = diff;
      if (diff.error) this.gitError = diff.error;
    } catch (error) {
      this.gitDiff = { ...EMPTY_GIT_DIFF, path: 'Outgoing changes', error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.gitDiffLoading = false;
      this.gitLoading = false;
      if (this.gitAction === 'outgoing') this.gitAction = '';
    }
  },
  async discardSelectedGitFile(this: GitHost) {
    this.closeFloatingMenus();
    const path = this.gitSelectedPath;
    if (!this.gitStatus.isRepo || !path || path === 'Outgoing changes') return;
    const confirmed = await this.openConfirmDialog(
      'Discard file changes',
      `Discard local changes in "${path}" and reload the workspace? This cannot be undone.`
    );
    if (!confirmed) return;
    this.cancelPendingPersistTimers();
    this.gitLoading = true;
    this.gitAction = 'discard-file';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitDiscardWorkspaceFile(path);
      await this.applyWorkspaceOpenResult(result, `Discarded ${path}`);
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'discard-file') this.gitAction = '';
    }
  },
  async discardSelectedGitFiles(this: GitHost, paths: string[] = []) {
    this.closeFloatingMenus();
    const selectedPaths = [...new Set(paths.map(path => path.trim()).filter(Boolean))];
    if (!this.gitStatus.isRepo || !selectedPaths.length) return;
    const count = selectedPaths.length;
    const confirmed = await this.openConfirmDialog(
      'Discard selected changes',
      `Discard local changes in ${count} selected Kurlo file${count === 1 ? '' : 's'} and reload the workspace? This cannot be undone.`
    );
    if (!confirmed) return;
    this.cancelPendingPersistTimers();
    this.gitLoading = true;
    this.gitAction = 'discard-selected';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitDiscardWorkspaceFiles(selectedPaths);
      await this.applyWorkspaceOpenResult(result, `Discarded ${count} selected Kurlo file${count === 1 ? '' : 's'}`);
      if (!result.ok && !result.error) this.gitError = `Could not discard ${count} selected file${count === 1 ? '' : 's'}`;
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'discard-selected') this.gitAction = '';
    }
  },
  async discardGitWorkspaceChanges(this: GitHost) {
    this.closeFloatingMenus();
    if (!this.gitStatus.isRepo || !kurloChangedFiles(this.gitStatus).length) return;
    const count = kurloChangedFiles(this.gitStatus).length;
    const confirmed = await this.openConfirmDialog(
      'Discard Kurlo changes',
      `Discard local Kurlo workspace changes and reload from the current commit? This affects Kurlo-managed files only and cannot be undone.`
    );
    if (!confirmed) return;
    this.cancelPendingPersistTimers();
    this.gitLoading = true;
    this.gitAction = 'discard-all';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitDiscardWorkspaceChanges();
      await this.applyWorkspaceOpenResult(result, `Discarded local Kurlo changes`);
      if (!result.ok && !result.error) this.gitError = `Could not discard ${count} changed file${count === 1 ? '' : 's'}`;
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'discard-all') this.gitAction = '';
    }
  },
  async stageGitWorkspaceFiles(this: GitHost) {
    if (!await this.beginGitMutation('Staging')) return;
    this.gitLoading = true;
    this.gitAction = 'stage';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitStageWorkspaceFiles();
      await this.applyGitOperationResult(result, (stageResult) => {
        const count = stageResult.files?.length ?? 0;
        return count ? `Staged ${count} Kurlo file${count === 1 ? '' : 's'}` : 'No Kurlo file changes to stage';
      });
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'stage') this.gitAction = '';
    }
  },
  async commitGitWorkspace(this: GitHost, paths: string[] = []) {
    this.closeFloatingMenus();
    if (!await this.beginGitMutation('Committing')) return;
    const selectedPaths = [...new Set(paths.map(path => path.trim()).filter(Boolean))];
    const message = await this.openPromptDialog(selectedPaths.length ? 'Commit selected Kurlo files' : 'Commit Kurlo workspace', 'Update Kurlo workspace');
    if (!message) return;
    this.gitLoading = true;
    this.gitAction = selectedPaths.length ? 'commit-selected' : 'commit';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = selectedPaths.length
        ? await gitCommitWorkspaceFiles(selectedPaths, message)
        : await gitCommitWorkspace(message);
      const ok = await this.applyGitOperationResult(result, (commitResult) => {
        const count = commitResult.files?.length ?? 0;
        return count ? `Committed ${count} Kurlo file${count === 1 ? '' : 's'}` : 'Committed Kurlo workspace files';
      });
      if (ok) this.showGitToast(formatGitCommitToast(result));
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'commit' || this.gitAction === 'commit-selected') this.gitAction = '';
    }
  },
  async pushGitWorkspace(this: GitHost) {
    this.closeFloatingMenus();
    if (!await this.beginGitMutation('Pushing')) return;
    const remotes = [...new Set((this.gitStatus.remotes ?? []).map(remote => remote.trim()).filter(Boolean))];
    let remoteName = this.gitStatus.upstream ? remoteNameFromUpstream(this.gitStatus.upstream) : (this.gitStatus.pushRemote || remotes[0] || 'origin');
    if (!this.gitStatus.upstream) {
      if (!remotes.length) {
        this.gitError = 'Add a Git remote before pushing this branch.';
        await this.openAlertDialog('No Git remote', 'Add a remote such as origin before pushing this branch.');
        return;
      }
      if (remotes.length > 1) {
        const selectedRemote = await this.openSelectDialog(
          'Push remote',
          'Choose where to publish this branch and set its upstream.',
          remotes.map(remote => ({ value: remote, label: remote, description: remote === remoteName ? 'Default remote' : 'Git remote' })),
          'Push',
          'Cancel'
        );
        if (!selectedRemote) return;
        remoteName = selectedRemote;
      }
    }
    this.gitLoading = true;
    this.gitAction = 'push';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitPushWorkspace(remoteName);
      if (!result.ok && isPushBehindError(result.error || '')) {
        this.gitStatus = normalizeGitStatus(result.git ?? this.gitStatus);
        this.gitOutput = result.output ?? '';
        const dirty = !this.gitStatus.clean;
        const strategy = dirty ? 'autostash' : 'rebase';
        const detail = dirty
          ? 'You have uncommitted edits, so Kurlo will stash them, rebase onto the remote, then re-apply.'
          : 'Kurlo will rebase your local commits onto the remote.';
        const confirmed = await this.openConfirmDialog(
          'Remote has new commits',
          `${result.error}\n\n${detail}\n\nPull and then push?`
        );
        if (!confirmed) {
          this.gitError = result.error || 'Push failed';
          return;
        }
        await this.pullThenPushGitWorkspace(strategy, remoteName);
        return;
      }
      if (!result.ok && result.git?.authRequired) {
        this.gitStatus = normalizeGitStatus(result.git);
        this.gitError = result.error || 'Push failed';
        if ((await this.promptAndStoreGitAuth(result.git)).retry) {
          this.gitAuthRetryGuard = true;
          try { await this.pushGitWorkspace(); } finally { this.gitAuthRetryGuard = false; }
          await this.afterGitAuthRetry();
        }
        return;
      }
      const ok = await this.applyGitOperationResult(result, 'Pushed Kurlo workspace');
      if (ok) this.showGitToast(formatGitPushToast(result));
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'push') this.gitAction = '';
    }
  },
  async pullThenPushGitWorkspace(this: GitHost, strategy: string, remoteName: string) {
    this.gitAction = `pull-${strategy}`;
    const pullResult = await gitPullWorkspace(strategy);
    if (!pullResult.ok) {
      this.gitStatus = normalizeGitStatus(pullResult.git ?? this.gitStatus);
      this.gitOutput = pullResult.output ?? '';
      this.gitError = pullResult.error || 'Pull failed';
      if (this.gitStatus.isRepo) {
        this.gitBranches = normalizeGitBranches(await gitListBranches());
        this.gitLog = normalizeGitLog(await gitCommitLogPage(GIT_LOG_PAGE_SIZE, 0));
      }
      return;
    }
    if (await this.applyWorkspaceOpenResult(pullResult, 'Pulled remote updates')) this.showGitPullToast(pullResult.pullSummary);
    this.gitAction = 'push';
    const pushResult = await gitPushWorkspace(remoteName);
    const ok = await this.applyGitOperationResult(pushResult, 'Pulled and pushed Kurlo workspace');
    if (ok) this.showGitToast(formatGitPushToast(pushResult));
  },
  async forcePushGitWorkspace(this: GitHost) {
    this.closeFloatingMenus();
    if (!await this.beginGitMutation('Force push')) return;
    const confirmed = await this.openConfirmDialog(
      'Force push with lease',
      'Force push rewrites the remote branch. Kurlo refuses if the remote has commits this branch has not taken in yet — even ones a fetch already downloaded. Continue?'
    );
    if (!confirmed) return;
    if (!this.gitStatus.upstream) {
      this.gitError = 'Push normally first to set an upstream before force pushing.';
      await this.openAlertDialog('No upstream branch', 'Push this branch normally first. After Kurlo sets the upstream, force push will know which remote branch to protect with --force-with-lease.');
      return;
    }
    const remoteName = remoteNameFromUpstream(this.gitStatus.upstream);
    this.gitLoading = true;
    this.gitAction = 'force-push';
    this.gitError = '';
    this.gitMessage = '';
    try {
      const result = await gitForcePushWorkspace(remoteName);
      await this.applyGitOperationResult(result, 'Force pushed Kurlo workspace');
    } catch (error) {
      this.gitError = error instanceof Error ? error.message : String(error);
    } finally {
      this.gitLoading = false;
      if (this.gitAction === 'force-push') this.gitAction = '';
    }
  },
};
