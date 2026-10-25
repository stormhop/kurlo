<script lang="ts">
  import { uiScale } from '../uiScale';
  import { tabListKeyboard } from '../a11y';
  import { gitDiffRows, type GitDiffRow } from '../gitDiffRows';
  import { kurloChangedFiles, otherChangedFileCount } from '../gitFiles';
  import GitIcon from './GitIcon.svelte';
  import type { GitBranchEntry, GitBranchListResult, GitConflictFileResult, GitDiffResult, GitLogResult, GitWorkspaceStatus, WorkspaceDiagnostic } from '../backend';
  import { gitConflictHunks, parseGitConflictBlocks, replaceAllGitConflictHunks, replaceGitConflictHunk, type ConflictSide, type GitConflictBlock } from '../gitConflicts';

  let {
    status,
    branches,
    diff,
    conflict,
    conflictContent,
    commits,
    selectedCommit,
    selectedPath,
    loading,
    action,
    diffLoading,
    error,
    output,
    workspaceBlocked = false,
    workspaceDiagnostics = [],
    onEditWorkspaceDiagnostic = () => {},
    workspaceDiagnosticKey = (diagnostic: WorkspaceDiagnostic) => diagnostic.path,
    workspaceDiagnosticLocation = (diagnostic: WorkspaceDiagnostic) => diagnostic.path,
    workspaceDiagnosticScopeLabel = () => '',
    onRefresh,
    onUseLocal,
    onUseAppStorage = () => {},
    onCreateLocal,
    onOpen,
    onClone,
    onFetch,
    onPull,
    onPullBranch,
    onResolveConflict,
    onContinueOperation,
    onAbortOperation,
    onStash,
    onPopStash,
    onInit,
    onAddRemote,
    onTestRemote,
    onCheckoutBranch,
    onCreateBranch,
    onCreateBranchFromRemote,
    onDeleteBranch,
    onRenameBranch,
    onCommit,
    onViewOutgoing,
    onLoadMoreLog,
    logLoadingMore = false,
    onSelectCommit,
    onPush,
    onForcePush,
    onDiscardFile,
    onDiscardFiles,
    onDiscardAll,
    onSelectFile,
  }: {
    status: GitWorkspaceStatus;
    branches: GitBranchListResult;
    diff: GitDiffResult;
    conflict: GitConflictFileResult;
    conflictContent: string;
    commits: GitLogResult;
    selectedCommit: string;
    selectedPath: string;
    loading: boolean;
    action: string;
    diffLoading: boolean;
    error: string;
    output: string;
    workspaceBlocked?: boolean;
    workspaceDiagnostics?: WorkspaceDiagnostic[];
    onEditWorkspaceDiagnostic?: (diagnostic: WorkspaceDiagnostic) => void;
    workspaceDiagnosticKey?: (diagnostic: WorkspaceDiagnostic) => string;
    workspaceDiagnosticLocation?: (diagnostic: WorkspaceDiagnostic) => string;
    workspaceDiagnosticScopeLabel?: (diagnostic: WorkspaceDiagnostic) => string;
    onRefresh: () => void | Promise<void>;
    onUseLocal: () => void | Promise<void>;
    onUseAppStorage?: () => void | Promise<void>;
    onCreateLocal: () => void | Promise<void>;
    onOpen: () => void | Promise<void>;
    onClone: () => void | Promise<void>;
    onFetch: () => void | Promise<void>;
    onPull: (strategy?: string) => void | Promise<void>;
    onPullBranch: (branchName: string) => void | Promise<void>;
    onResolveConflict: (resolution: string, path?: string, content?: string) => boolean | void | Promise<boolean | void>;
    onContinueOperation: () => void | Promise<void>;
    onAbortOperation: () => void | Promise<void>;
    onStash: () => void | Promise<void>;
    onPopStash: (ref?: string) => void | Promise<void>;
    onInit: () => void | Promise<void>;
    onAddRemote: () => void | Promise<void>;
    onTestRemote: () => void | Promise<void>;
    onCheckoutBranch: (branchName?: string) => void | Promise<void>;
    onCreateBranch: (startPoint?: string) => void | Promise<void>;
    onCreateBranchFromRemote: (startPoint?: string) => void | Promise<void>;
    onDeleteBranch: (branchName: string, remote?: boolean) => void | Promise<void>;
    onRenameBranch: (branchName: string, remote?: boolean) => void | Promise<void>;
    onCommit: (paths?: string[]) => void | Promise<void>;
    onViewOutgoing: () => void | Promise<void>;
    onLoadMoreLog: () => void | Promise<void>;
    logLoadingMore?: boolean;
    onSelectCommit: (commit: string) => void | Promise<void>;
    onPush: () => void | Promise<void>;
    onForcePush: () => void | Promise<void>;
    onDiscardFile: () => void | Promise<void>;
    onDiscardFiles: (paths: string[]) => void | Promise<void>;
    onDiscardAll: () => void | Promise<void>;
    onSelectFile: (path: string) => void | Promise<void>;
  } = $props();

  const FILE_ROW_HEIGHT = 30;
  const COMMIT_ROW_HEIGHT = 56;
  const VIRTUAL_OVERSCAN = 8;
  const YAML_PAGE_SIZE = 6;

  type BranchRow = {
    key: string;
    label: string;
    prefix: string;
    meta: string;
    metaWarn: boolean;
    hint: string;
    current: boolean;
    disabled: boolean;
    deleteDisabled: boolean;
    pullBranchName: string;
    pullDisabled: boolean;
    pullTitle: string;
    remote: boolean;
    startPoint: string;
    remoteDeleteStartPoint: string;
    searchText: string;
    onOpen: () => void | Promise<void>;
  };
  type BranchListItem =
    | { kind: 'section'; key: string; label: string; section: 'local' | 'remote'; count: number; total: number; collapsed: boolean }
    | { kind: 'branch'; key: string; row: BranchRow };

  let branchFilter = $state('');
  let yamlVisibleCount = $state(YAML_PAGE_SIZE);
  let selectedFilePaths = $state<string[]>([]);
  let conflictDraft = $state('');
  let conflictDraftKey = $state('');
  let expandedPanel = $state<'diff' | 'conflict' | 'output' | ''>('');
  let currentConflictIndex = $state(0);
  let conflictRawMode = $state(false);
  let conflictResultEditor = $state<HTMLTextAreaElement | null>(null);
  let branchPickerOpen = $state(false);
  let branchPopoverEl = $state<HTMLElement | null>(null);
  let moreMenuOpen = $state(false);
  let fileScrollTop = $state(0);
  let fileListHeight = $state(320);
  let branchActionMenuKey = $state('');
  let branchActionMenuTop = $state(0);
  let branchActionMenuRight = $state(0);
  let localBranchesCollapsed = $state(false);
  let remoteBranchesCollapsed = $state(false);
  let commitScrollTop = $state(0);
  let commitListHeight = $state(320);
  let sideTab = $state<'changes' | 'history'>('changes');
  let yamlDiagnosticTotal = $derived(workspaceDiagnostics.length);
  let visibleYamlDiagnostics = $derived(workspaceDiagnostics.slice(0, yamlVisibleCount));
  let yamlHiddenCount = $derived(Math.max(0, yamlDiagnosticTotal - yamlVisibleCount));
  let yamlNextPage = $derived(Math.min(YAML_PAGE_SIZE, yamlHiddenCount));
  let changedFiles = $derived(kurloChangedFiles(status));
  let changeCount = $derived(changedFiles.length);
  let otherChangeCount = $derived(otherChangedFileCount(status));
  let conflictedFiles = $derived((status.files ?? []).filter(file => file.status === 'conflicted'));
  let changedFilePaths = $derived(changedFiles.map(file => file.path));
  let selectedFileSet = $derived(new Set(selectedFilePaths));
  let selectedFileCount = $derived(selectedFilePaths.length);
  let selectedFileLabel = $derived(`${selectedFileCount} selected`);
  let allFilesSelected = $derived(changeCount > 0 && selectedFileCount === changeCount);
  let branchLabel = $derived(status.branch || (status.isRepo ? 'HEAD' : 'No repo'));
  let canPull = $derived(status.isRepo && !loading && !status.operation);
  let canPullWithHistoryStrategy = $derived(canPull && (status.behind > 0 || (status.ahead > 0 && status.behind > 0)));


  let canAutostashPull = $derived(status.isRepo && !loading && !status.operation && Boolean(status.upstream));
  let workspaceRecoveryMode = $derived(Boolean(workspaceBlocked && !status.operation));
  let canRepoAction = $derived(status.isRepo && !loading && !workspaceRecoveryMode);
  let remoteCount = $derived(status.remotes?.length ?? 0);
  let pushCount = $derived(status.ahead > 0 ? status.ahead : (status.pushCommitCount ?? 0));
  let hasPushTarget = $derived(Boolean(status.upstream || remoteCount > 0));
  let canPush = $derived(Boolean(canRepoAction && !status.operation && hasPushTarget && (pushCount > 0 || !status.upstream || status.upstreamGone)));
  let showRepositorySetup = $derived(!status.isRepo || (!status.upstream && remoteCount === 0));
  let storagePath = $derived(status.isRepo ? status.root : (status.workspaceRoot || 'Kurlo local app storage'));
  let workspaceMissing = $derived(!status.isRepo && Boolean(status.missingRoot));
  let isAppStoragePath = $derived(!status.isRepo && (
    !status.workspaceRoot ||
    /[\\/](Application Support|AppData[\\/](Roaming|Local)|\.config)[\\/]Kurlo([\\/]|$)/i.test(status.workspaceRoot)
  ));
  let gitUnavailable = $derived(Boolean(status.gitMissing));
  let localEyebrow = $derived(gitUnavailable ? 'Git unavailable' : (workspaceMissing ? 'Folder missing' : (isAppStoragePath ? 'App storage · default location' : 'Folder workspace')));
  let localDescription = $derived(gitUnavailable
    ? 'Kurlo cannot run Git on this machine, so it cannot tell whether this folder is a repository. The workspace still works without Git; install Git and restart Kurlo to use branches, commits and remotes.'
    : (workspaceMissing
      ? 'Kurlo cannot find this workspace folder. Choose another folder, open an existing repository, or clone it again.'
      : (isAppStoragePath
        ? "Workspace lives inside Kurlo's default app data. Create a folder workspace in a location you control for backup, sharing and Git."
        : 'Workspace stored in your folder. Create another folder workspace or initialize Git here to track changes and sync with a remote.')));
  let localDividerLabel = $derived(gitUnavailable ? 'needs Git' : (workspaceMissing ? 'recover workspace' : (isAppStoragePath ? 'or start from a Git repository' : 'other options')));
  let localBranches = $derived(branches.localBranches ?? []);
  let remoteBranches = $derived(branches.remoteBranches ?? []);
  let localBranchRows = $derived(buildLocalBranchRows());
  let remoteBranchRows = $derived(buildRemoteBranchRows());
  let branchRows = $derived([...localBranchRows, ...remoteBranchRows]);
  let activeBranchActionRow = $derived(branchRows.find(branch => branch.key === branchActionMenuKey));
  let normalizedBranchFilter = $derived(branchFilter.trim().toLowerCase());
  let visibleLocalBranchRows = $derived(normalizedBranchFilter
    ? localBranchRows.filter(branch => branch.searchText.includes(normalizedBranchFilter))
    : localBranchRows);
  let visibleRemoteBranchRows = $derived(normalizedBranchFilter
    ? remoteBranchRows.filter(branch => branch.searchText.includes(normalizedBranchFilter))
    : remoteBranchRows);
  let visibleBranchItems = $derived([
    ...(localBranchRows.length ? [{ kind: 'section' as const, key: 'section:local', label: 'Local', section: 'local' as const, count: visibleLocalBranchRows.length, total: localBranchRows.length, collapsed: localBranchesCollapsed }] : []),
    ...(!localBranchesCollapsed ? visibleLocalBranchRows.map(row => ({ kind: 'branch' as const, key: row.key, row })) : []),
    ...(remoteBranchRows.length ? [{ kind: 'section' as const, key: 'section:remote', label: 'Remote', section: 'remote' as const, count: visibleRemoteBranchRows.length, total: remoteBranchRows.length, collapsed: remoteBranchesCollapsed }] : []),
    ...(!remoteBranchesCollapsed ? visibleRemoteBranchRows.map(row => ({ kind: 'branch' as const, key: row.key, row })) : []),
  ] satisfies BranchListItem[]);
  let commitRows = $derived(commits.commits ?? []);
  let selectedCommitInfo = $derived(commitRows.find(commit => commit.hash === selectedCommit));
  let fileWindow = $derived(virtualWindow(changedFiles.length, FILE_ROW_HEIGHT * $uiScale, fileScrollTop, fileListHeight));
  let commitWindow = $derived(virtualWindow(commitRows.length, COMMIT_ROW_HEIGHT * $uiScale, commitScrollTop, commitListHeight));
  let virtualChangedFiles = $derived(changedFiles.slice(fileWindow.start, fileWindow.end));
  let virtualCommitRows = $derived(commitRows.slice(commitWindow.start, commitWindow.end));
  let conflictOursLines = $derived(conflict.oursContent ? conflict.oursContent.split('\n') : []);
  let conflictTheirsLines = $derived(conflict.theirsContent ? conflict.theirsContent.split('\n') : []);
  let conflictBlocks = $derived(parseGitConflictBlocks(conflictDraft));
  let conflictHunks = $derived(gitConflictHunks(conflictDraft));
  let currentConflict = $derived(conflictHunks[Math.min(currentConflictIndex, Math.max(0, conflictHunks.length - 1))]);
  let hasInlineConflictMarkers = $derived(conflictHunks.length > 0);
  let hasOursVersion = $derived(Boolean(conflict.oursAvailable || conflict.oursContent || conflict.oursTruncated));
  let hasTheirsVersion = $derived(Boolean(conflict.theirsAvailable || conflict.theirsContent || conflict.theirsTruncated));
  let conflictProgressLabel = $derived(conflictHunks.length
    ? `${conflictHunks.length} unresolved hunk${conflictHunks.length === 1 ? '' : 's'}`
    : 'No inline markers');
  let visibleDiffRows = $derived(diff.diff ? gitDiffRows(diff.diff) : []);
  let stagedDiffRows = $derived(diff.stagedDiff ? gitDiffRows(diff.stagedDiff) : []);
  let unstagedDiffRows = $derived(diff.unstagedDiff ? gitDiffRows(diff.unstagedDiff) : []);
  let selectedChangedFile = $derived(status.files?.find(file => file.path === selectedPath));
  let selectedFileIsConflict = $derived(selectedChangedFile?.status === 'conflicted');
  let selectedConflictPathMatches = $derived(sameGitPath(conflict.path, selectedPath));
  let conflictLoaded = $derived(Boolean(selectedFileIsConflict && selectedConflictPathMatches && (conflict.ok || conflict.error)));
  let conflictReady = $derived(Boolean(selectedFileIsConflict && selectedConflictPathMatches && conflict.ok));
  let markerlessConflict = $derived(Boolean(conflictReady && !conflict.binary && !hasInlineConflictMarkers));
  let hasSplitDiff = $derived(Boolean(selectedChangedFile && (stagedDiffRows.length || unstagedDiffRows.length)));
  let canContinueOperation = $derived(Boolean(status.operation && conflictedFiles.length === 0 && !loading));
  let stashCount = $derived(status.stashes?.length ?? 0);
  let canStash = $derived(Boolean(canRepoAction && !status.operation && changedFiles.length > 0));
  let canPopStash = $derived(Boolean(canRepoAction && !status.operation && stashCount > 0));
  let statusTitle = $derived(`Git ${status.operation} in progress. Resolve the conflicted files, then continue or abort it.`);


  let canDiscardAction = $derived(status.isRepo && !loading);
  let canDiscardSelected = $derived(Boolean(canDiscardAction && selectedChangedFile && selectedPath !== 'Outgoing changes'));
  let canDiscardSelectedFiles = $derived(Boolean(canDiscardAction && selectedFileCount > 0));
  let canOperateOnSelectedFiles = $derived(Boolean(canRepoAction && selectedFileCount > 0));
  let diffTitle = $derived(selectedCommit ? `Commit ${selectedCommit.slice(0, 7)}` : (selectedPath || 'Diff'));

  $effect(() => {
    const changed = new Set(changedFilePaths);
    const next = selectedFilePaths.filter(path => changed.has(path));
    if (next.length !== selectedFilePaths.length) selectedFilePaths = next;
  });

  $effect(() => {
    const key = `${conflict.path}\n${conflict.content}`;
    if (key !== conflictDraftKey) {
      conflictDraftKey = key;
      conflictDraft = conflictContent ?? '';
      currentConflictIndex = 0;
    }
  });

  $effect(() => {
    if (currentConflictIndex >= conflictHunks.length) currentConflictIndex = Math.max(0, conflictHunks.length - 1);
  });

  function isBusy(name: string) {
    return loading && action === name;
  }

  function closeExpandedPanel() {
    expandedPanel = '';
  }

  function normalizeGitPath(path: string) {
    return path.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  }

  function sameGitPath(left: string, right: string) {
    const a = normalizeGitPath(left);
    const b = normalizeGitPath(right);
    return Boolean(a && b && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)));
  }

  function lineStartOffset(text: string, lineNumber: number) {
    if (lineNumber <= 1) return 0;
    let offset = 0;
    let line = 1;
    while (line < lineNumber && offset < text.length) {
      const next = text.indexOf('\n', offset);
      if (next < 0) return text.length;
      offset = next + 1;
      line += 1;
    }
    return offset;
  }

  function focusCurrentConflict() {
    if (!conflictResultEditor || !conflictRawMode) return;
    const offset = currentConflict ? lineStartOffset(conflictDraft, currentConflict.startLine) : 0;
    conflictResultEditor.focus();
    conflictResultEditor.setSelectionRange(offset, offset);
  }

  function openConflictResolver() {
    expandedPanel = 'conflict';
    queueMicrotask(focusCurrentConflict);
  }

  async function openFile(file: { path: string; status: string }) {
    await onSelectFile(file.path);
    if (file.status === 'conflicted') openConflictResolver();
  }

  async function openConflictFile(path: string) {
    await onSelectFile(path);
    currentConflictIndex = 0;
    openConflictResolver();
  }

  function jumpConflict(delta: number) {
    if (!conflictHunks.length) return;
    currentConflictIndex = Math.min(conflictHunks.length - 1, Math.max(0, currentConflictIndex + delta));
    queueMicrotask(focusCurrentConflict);
  }

  function acceptConflict(index: number, side: ConflictSide) {
    conflictDraft = replaceGitConflictHunk(conflictDraft, index, side);
    const nextHunks = gitConflictHunks(conflictDraft);
    currentConflictIndex = Math.min(currentConflictIndex, Math.max(0, nextHunks.length - 1));
    queueMicrotask(focusCurrentConflict);
  }

  function acceptCurrentConflict(side: ConflictSide) {
    if (!currentConflict) return;
    acceptConflict(currentConflict.index, side);
  }

  async function useConflictSide(side: ConflictSide) {
    if (currentConflict) {
      acceptCurrentConflict(side);
      return;
    }
    await resolveAndClose(side);
  }

  function acceptAllConflicts(side: ConflictSide) {
    conflictDraft = replaceAllGitConflictHunks(conflictDraft, side);
    currentConflictIndex = 0;
    queueMicrotask(focusCurrentConflict);
  }

  async function saveManualResolution() {
    await resolveAndClose('manual', conflictDraft);
  }

  async function resolveAndClose(resolution: string, content?: string) {
    const ok = await onResolveConflict(resolution, selectedPath, content);
    if (ok !== false) closeExpandedPanel();
  }

  function fullConflictSideActionLabel(side: ConflictSide) {
    if (!conflictLoaded) return side === 'ours' ? 'Use ours' : 'Use theirs';
    const available = side === 'ours' ? hasOursVersion : hasTheirsVersion;
    if (available) return side === 'ours' ? 'Use ours' : 'Use theirs';
    return side === 'ours' ? 'Use ours (delete)' : 'Use theirs (delete)';
  }

  function resolverConflictSideActionLabel(side: ConflictSide) {
    if (currentConflict) return side === 'ours' ? 'Use ours' : 'Use theirs';
    return fullConflictSideActionLabel(side);
  }

  function conflictSideTitle(side: ConflictSide) {
    const available = side === 'ours' ? hasOursVersion : hasTheirsVersion;
    if (currentConflict) return side === 'ours' ? 'Apply local lines to the current result hunk' : 'Apply remote lines to the current result hunk';
    if (!conflictLoaded) return side === 'ours' ? 'Loading the local conflict side' : 'Loading the remote conflict side';
    if (available) return side === 'ours' ? 'Resolve this file using the local version' : 'Resolve this file using the remote version';
    return side === 'ours'
      ? 'Resolve by keeping the local absence of this file'
      : 'Resolve by keeping the remote absence of this file';
  }

  function sideFallbackLabel(side: ConflictSide) {
    const available = side === 'ours' ? hasOursVersion : hasTheirsVersion;
    if (!conflictLoaded) return side === 'ours' ? 'Loading local version...' : 'Loading remote version...';
    if (conflict.error) return conflict.error;
    if (available) return side === 'ours' ? '(empty local version)' : '(empty remote version)';
    return side === 'ours'
      ? 'No local version available. Choosing ours removes this file from the merge result.'
      : 'No remote version available. Choosing theirs removes this file from the merge result.';
  }

  function conflictBlockKey(block: GitConflictBlock, index: number) {
    return `${block.kind}-${block.startLine}-${block.endLine}-${index}`;
  }

  function selectConflict(index: number) {
    currentConflictIndex = index;
    queueMicrotask(focusCurrentConflict);
  }

  function virtualWindow(total: number, rowHeight: number, scrollTop: number, viewportHeight: number) {
    const safeTotal = Math.max(0, total);
    const safeRowHeight = Math.max(1, rowHeight);
    const safeViewport = Math.max(safeRowHeight, viewportHeight || safeRowHeight * 8);
    const maxStart = Math.max(0, safeTotal - 1);
    const start = Math.min(maxStart, Math.max(0, Math.floor(scrollTop / safeRowHeight) - VIRTUAL_OVERSCAN));
    const visibleCount = Math.ceil(safeViewport / safeRowHeight) + VIRTUAL_OVERSCAN * 2;
    const end = Math.min(safeTotal, start + visibleCount);
    return {
      start,
      end,
      before: start * safeRowHeight,
      after: Math.max(0, (safeTotal - end) * safeRowHeight),
    };
  }

  function loadMoreCommitsNearEnd(event: Event) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement) || !commits.hasMore || logLoadingMore) return;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - COMMIT_ROW_HEIGHT * $uiScale * VIRTUAL_OVERSCAN) void onLoadMoreLog();
  }

  function updateVirtualScroll(event: Event, setScrollTop: (value: number) => void, setHeight: (value: number) => void) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    setScrollTop(target.scrollTop);
    setHeight(target.clientHeight);
  }

  function pathName(path: string) {
    return path.slice(path.lastIndexOf('/') + 1) || path;
  }

  function pathFolder(path: string) {
    const index = path.lastIndexOf('/');
    return index > 0 ? path.slice(0, index).replace(/^workspaces\/[^/]+\//, '') : '';
  }

  function fileStatusLabel(fileStatus: string) {
    const labels: Record<string, string> = {
      modified: 'M',
      added: 'A',
      deleted: 'D',
      renamed: 'R',
      untracked: 'U',
      conflicted: '!',
      changed: '*',
    };
    return labels[fileStatus] ?? '*';
  }

  function pullTitle() {
    if (!status.isRepo) return 'Open a Git repository first';
    if (status.operation) return `Finish or abort the current ${status.operation} first`;
    if (!status.clean) return 'Pull remote updates and re-apply local edits';
    return status.behind > 0 ? `Pull ${status.behind} remote update${status.behind === 1 ? '' : 's'}` : 'Pull latest changes';
  }

  function pushTitle() {
    if (!status.isRepo) return 'Open a Git repository first';
    if (status.operation) return `Finish or abort the current ${status.operation} first`;
    if (!hasPushTarget) return 'Add a remote before pushing';
    if (!status.upstream && pushCount > 0) return `Publish ${pushCount} local commit${pushCount === 1 ? '' : 's'} to ${status.pushRemote || 'remote'}`;
    if (!status.upstream) return `Publish this branch to ${status.pushRemote || 'remote'} and set its upstream`;
    if (status.upstreamGone) return `${status.upstream} is gone. Push to publish this branch again`;
    return pushCount > 0 ? `Push ${pushCount} local commit${pushCount === 1 ? '' : 's'}` : 'Nothing to push';
  }

  function operationTitle() {
    if (!status.operation) return '';
    return status.operation === 'rebase' ? 'Rebase in progress' : 'Merge in progress';
  }

  function commitDateLabel(value: string) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }

  function localBranchForRemote(remoteBranch: GitBranchEntry) {
    return localBranches.find(branch => branch.upstream === remoteBranch.fullName)
      ?? localBranches.find(branch => branch.name === remoteBranch.name);
  }

  function openRemoteBranch(remoteBranch: GitBranchEntry) {
    const localBranch = localBranchForRemote(remoteBranch);
    if (localBranch) return onCheckoutBranch(localBranch.name);
    return onCreateBranchFromRemote(remoteBranch.fullName);
  }

  function setFileSelection(path: string, selected: boolean) {
    if (selected) {
      selectedFilePaths = selectedFileSet.has(path) ? selectedFilePaths : [...selectedFilePaths, path];
      return;
    }
    selectedFilePaths = selectedFilePaths.filter(selectedPath => selectedPath !== path);
  }

  function toggleAllFileSelection() {
    selectedFilePaths = allFilesSelected ? [] : [...changedFilePaths];
  }

  function clearFileSelection() {
    selectedFilePaths = [];
  }

  async function commitSelectedFiles() {
    if (!selectedFilePaths.length) return;
    await onCommit([...selectedFilePaths]);
  }

  async function discardSelectedFiles() {
    if (!selectedFilePaths.length) return;
    await onDiscardFiles([...selectedFilePaths]);
  }

  function focusOnMount(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }

  function closeBranchPicker() {
    branchPickerOpen = false;
    branchActionMenuKey = '';
  }

  function toggleBranchSection(section: 'local' | 'remote') {
    branchActionMenuKey = '';
    if (section === 'local') {
      localBranchesCollapsed = !localBranchesCollapsed;
      return;
    }
    remoteBranchesCollapsed = !remoteBranchesCollapsed;
  }

  function branchSectionCount(item: Extract<BranchListItem, { kind: 'section' }>) {
    return normalizedBranchFilter ? `${item.count}/${item.total}` : `${item.total}`;
  }

  function closeMoreMenu() {
    moreMenuOpen = false;
  }

  async function runAndClosePicker(action: () => void | Promise<void>) {
    closeBranchPicker();
    await action();
  }

  async function runAndCloseMore(action: () => void | Promise<void>) {
    closeMoreMenu();
    await action();
  }

  async function runBranchAction(action: () => void | Promise<void>) {



    const pending = action();
    branchActionMenuKey = '';
    closeBranchPicker();
    await pending;
  }

  function toggleBranchActionMenu(event: MouseEvent, key: string) {
    event.stopPropagation();
    if (branchActionMenuKey === key) {
      branchActionMenuKey = '';
      return;
    }
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const buttonRect = target.getBoundingClientRect();
    const popoverRect = branchPopoverEl?.getBoundingClientRect();
    branchActionMenuTop = popoverRect ? buttonRect.bottom - popoverRect.top + 4 : 0;
    branchActionMenuRight = popoverRect ? Math.max(10, popoverRect.right - buttonRect.right) : 10;
    branchActionMenuKey = key;
  }

  function updateBranchScroll(event: Event) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    branchActionMenuKey = '';
  }

  function remoteBranchExists(fullName: string) {
    return remoteBranches.some(branch => branch.fullName === fullName);
  }

  function buildLocalBranchRows(): BranchRow[] {
    return localBranches.map(branch => {
      const upstreamGone = Boolean(branch.upstream && !remoteBranchExists(branch.upstream));
      const canPullBranch = Boolean(branch.upstream && !upstreamGone);
      return {
        key: `local:${branch.name}`,
        label: branch.name,
        prefix: '',
        meta: branch.upstream ? `${branch.upstream}${upstreamGone ? ' · gone' : ''}` : 'local only',
        metaWarn: upstreamGone,
        hint: branch.current
          ? `${branch.name} is the current branch`
          : `Switch to ${branch.name}${branch.upstream ? ` (tracks ${branch.upstream})` : ''}`,
        current: branch.current,
        disabled: loading || branch.current || workspaceRecoveryMode,
        deleteDisabled: loading || branch.current || workspaceRecoveryMode,
        pullBranchName: branch.name,
        pullDisabled: loading || workspaceRecoveryMode || !canPullBranch,
        pullTitle: canPullBranch
          ? `Pull ${branch.upstream} into ${branch.name}`
          : (branch.upstream ? `${branch.upstream} is gone` : `${branch.name} has no upstream`),
        remote: false,
        startPoint: branch.current ? '' : branch.name,
        remoteDeleteStartPoint: canPullBranch ? branch.upstream : '',
        searchText: `${branch.name} ${branch.upstream} local ${upstreamGone ? 'gone' : ''}`.toLowerCase(),
        onOpen: () => onCheckoutBranch(branch.name),
      };
    }).sort((left, right) => Number(right.current) - Number(left.current) || left.label.localeCompare(right.label));
  }

  function buildRemoteBranchRows(): BranchRow[] {
    return remoteBranches.filter(branch => !localBranchForRemote(branch)).map(branch => ({
      key: `remote:${branch.fullName}`,
      label: branch.name,
      prefix: `${branch.remote}/`,
      meta: 'remote only',
      metaWarn: false,
      hint: `Create a local branch that tracks ${branch.fullName} and switch to it`,
      current: false,
      disabled: loading || workspaceRecoveryMode,
      deleteDisabled: loading || workspaceRecoveryMode,
      pullBranchName: '',
      pullDisabled: true,
      pullTitle: `Create a local tracking branch before pulling ${branch.fullName}`,
      remote: true,
      startPoint: branch.fullName,
      remoteDeleteStartPoint: branch.fullName,
      searchText: `${branch.fullName} ${branch.remote} remote`.toLowerCase(),
      onOpen: () => openRemoteBranch(branch),
    })).sort((left, right) => left.label.localeCompare(right.label));
  }

  function remoteNameOf(startPoint: string) {
    return startPoint.slice(0, startPoint.indexOf('/')) || 'remote';
  }
</script>

{#snippet diffRowList(rows: GitDiffRow[])}
  {#each rows as row, index (index)}
    {#if row.kind === 'file'}
      <div class="git-diff-file">{row.text}</div>
    {:else if row.kind === 'hunk'}
      <div class="git-diff-line hunk"><span class="git-diff-line-no">⋯</span><span class="git-diff-sign"></span><code>{row.text}</code></div>
    {:else if row.kind === 'note'}
      <div class="git-diff-line note"><span class="git-diff-line-no"></span><span class="git-diff-sign"></span><code>{row.text}</code></div>
    {:else}
      <div class="git-diff-line" class:added={row.kind === 'added'} class:removed={row.kind === 'removed'}>
        <span class="git-diff-line-no">{row.line}</span>
        <span class="git-diff-sign" aria-hidden="true">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}</span>
        <code>{row.text || ' '}</code>
      </div>
    {/if}
  {/each}
{/snippet}

<section class="git-workspace">
  <div class="git-toolbar" class:standalone={!status.isRepo}>
    <div class="git-toolbar-identity">
      {#if status.isRepo}
        <div class="git-branch-control">
          <button
            class="git-branch-chip"
            class:open={branchPickerOpen}
            type="button"
            onclick={() => (branchPickerOpen = !branchPickerOpen)}
            aria-haspopup="listbox"
            aria-expanded={branchPickerOpen}
            title={`Switch branch · ${status.root}`}
          >
            <GitIcon name="branch" size={13} />
            <strong>{branchLabel}</strong>
            {#if status.ahead || status.behind}
              <span class="git-sync-indicator">
                {#if status.ahead}<em class="ahead">↑{status.ahead}</em>{/if}
                {#if status.behind}<em class="behind">↓{status.behind}</em>{/if}
              </span>
            {/if}
            <svg class="git-action-icon caret" width="0.625rem" height="0.625rem" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 6l5 5 5-5" />
            </svg>
          </button>
          {#if branchPickerOpen}
            <div class="git-branch-popover" role="dialog" aria-label="Switch branch" bind:this={branchPopoverEl}>
              <div class="git-branch-popover-head">
                <input class="field field-md"
                  bind:value={branchFilter}
                  type="search"
                  placeholder="Filter branches"
                  aria-label="Filter branches"
                  spellcheck="false"
                  use:focusOnMount
                  onkeydown={(event) => event.key === 'Escape' && closeBranchPicker()}
                />
                <button
                  class="btn btn-secondary btn-sm git-action-btn"
                  class:loading={isBusy('branch-create')}
                  type="button"
                  onclick={() => runAndClosePicker(() => onCreateBranch())}
                  disabled={!canRepoAction}
                  aria-busy={isBusy('branch-create')}
                  title="Create a new branch"
                >
                  <GitIcon name="branch-plus" busy={isBusy('branch-create')} />
                  New
                </button>
              </div>
              <div
                class="git-branch-rows virtual"
                onscroll={updateBranchScroll}
              >
                {#if visibleBranchItems.length}
                  {#each visibleBranchItems as item (item.key)}
                    {#if item.kind === 'section'}
                      <button
                        class="git-branch-section"
                        class:collapsed={item.collapsed}
                        type="button"
                        onclick={() => toggleBranchSection(item.section)}
                        aria-expanded={!item.collapsed}
                      >
                        <span>
                          <svg class="git-branch-section-caret" width="0.625rem" height="0.625rem" viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M3 6l5 5 5-5" />
                          </svg>
                          {item.label}
                        </span>
                        <em>{branchSectionCount(item)}</em>
                      </button>
                    {:else}
                      {@const branch = item.row}
                    <div class="git-branch-row" class:current={branch.current} aria-current={branch.current ? 'true' : undefined}>
                      <button
                        class="git-branch-row-main"
                        type="button"
                        disabled={branch.disabled}
                        onclick={() => runAndClosePicker(branch.onOpen)}
                        title={branch.hint}
                      >
                        <span class="git-branch-mark" aria-hidden="true"><GitIcon name={branch.current ? 'check' : 'branch'} /></span>
                        <strong>{#if branch.prefix}<span class="git-branch-prefix">{branch.prefix}</span>{/if}{branch.label}</strong>
                        <small class:warn={branch.metaWarn}>{branch.meta}</small>
                      </button>
                      <button
                        class="btn btn-ghost btn-icon btn-sm git-branch-row-menu-btn"
                        type="button"
                        disabled={loading || workspaceRecoveryMode}
                        onclick={(event) => toggleBranchActionMenu(event, branch.key)}
                        aria-haspopup="menu"
                        aria-expanded={branchActionMenuKey === branch.key}
                        aria-label={`Actions for ${branch.prefix}${branch.label}`}
                        title={`Actions for ${branch.prefix}${branch.label}`}
                      >
                        <span class="git-more-dots">⋯</span>
                      </button>
                    </div>
                    {/if}
                  {/each}
                {:else}
                  <div class="git-branch-empty">{normalizedBranchFilter ? 'No matches' : 'No branches'}</div>
                {/if}
              </div>
              {#if activeBranchActionRow}
                {@const row = activeBranchActionRow}
                <div
                  class="menu git-branch-row-menu floating"
                  role="menu"
                  style={`top: ${branchActionMenuTop}px; right: ${branchActionMenuRight}px;`}
                >
                  <button class="menu-item git-more-item" type="button" onclick={() => { const r = activeBranchActionRow; if (r) runBranchAction(() => onCreateBranch(r.startPoint)); }} role="menuitem">
                    <GitIcon name="branch-plus" />
                    Create from here
                  </button>
                  {#if !row.remote}
                    <button
                      class="menu-item git-more-item"
                      type="button"
                      onclick={() => { const r = activeBranchActionRow; if (r) runBranchAction(() => onPullBranch(r.pullBranchName)); }}
                      disabled={row.pullDisabled}
                      title={row.pullTitle}
                      role="menuitem"
                    >
                      <GitIcon name="pull" />
                      Pull
                    </button>
                  {/if}
                  <div class="git-more-sep"></div>
                  {#if !row.remote}
                    <button
                      class="menu-item git-more-item"
                      type="button"
                      onclick={() => { const r = activeBranchActionRow; if (r) runBranchAction(() => onRenameBranch(r.label, false)); }}
                      disabled={loading || workspaceRecoveryMode}
                      title={`Rename local branch ${row.label}`}
                      role="menuitem"
                    >
                      <GitIcon name="branch" />
                      Rename
                    </button>
                  {/if}
                  {#if row.remoteDeleteStartPoint}
                    <button
                      class="menu-item git-more-item"
                      type="button"
                      onclick={() => { const r = activeBranchActionRow; if (r) runBranchAction(() => onRenameBranch(r.remoteDeleteStartPoint, true)); }}
                      disabled={loading || workspaceRecoveryMode}
                      title={`Rename ${row.remoteDeleteStartPoint} on the remote`}
                      role="menuitem"
                    >
                      <GitIcon name="branch" />
                      Rename on {remoteNameOf(row.remoteDeleteStartPoint)}
                    </button>
                  {/if}
                  <div class="git-more-sep"></div>
                  {#if !row.remote}
                    <button
                      class="menu-item git-more-item danger"
                      type="button"
                      onclick={() => { const r = activeBranchActionRow; if (r) runBranchAction(() => onDeleteBranch(r.startPoint, false)); }}
                      disabled={row.deleteDisabled}
                      title={row.current ? 'Check out another branch before deleting this one' : `Delete ${row.label}`}
                      role="menuitem"
                    >
                      <GitIcon name="trash" />
                      Delete
                    </button>
                  {/if}
                  {#if row.remoteDeleteStartPoint}
                    <button
                      class="menu-item git-more-item danger"
                      type="button"
                      onclick={() => { const r = activeBranchActionRow; if (r) runBranchAction(() => onDeleteBranch(r.remoteDeleteStartPoint, true)); }}
                      disabled={loading || workspaceRecoveryMode}
                      title={`Delete ${row.remoteDeleteStartPoint} from remote`}
                      role="menuitem"
                    >
                      <GitIcon name="trash" />
                      Delete from {remoteNameOf(row.remoteDeleteStartPoint)}
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
        {#if status.operation}
          <span class="git-status-pill operation" title={statusTitle}>{status.operation} in progress</span>
        {/if}
        {#if status.upstream}
          <span
            class="git-upstream"
            class:warn={status.upstreamGone}
            title={status.upstreamGone ? `${status.upstream} no longer exists on the remote. Push to publish this branch again or choose another upstream.` : `Tracks ${status.upstream}`}
          >
            <span>{status.upstream}</span>{#if status.upstreamGone}<em class="git-upstream-state">gone</em>{/if}
          </span>
        {:else if remoteCount > 0}
          <span class="git-upstream warn" title={`This branch has not been pushed yet. First push will publish it to ${status.pushRemote || 'the selected remote'}.`}>Not published</span>
        {:else}
          <span class="git-upstream warn" title="No Git remote configured">No remote</span>
        {/if}
      {:else}
        <div class="git-branch-control">
          <span class="git-branch-chip disabled" aria-disabled="true" title={status.workspaceRoot || 'Kurlo local app storage'}>
            <GitIcon name="hard-drive" size={13} />
            <strong>{workspaceMissing ? 'Missing folder' : 'Local workspace'}</strong>
          </span>
        </div>
      {/if}
    </div>

    <div class="git-toolbar-actions">
      {#if status.isRepo}
        <button
          class="btn btn-secondary git-tool-btn"
          class:loading={isBusy('fetch')}
          type="button"
          onclick={onFetch}
          disabled={loading}
          aria-busy={isBusy('fetch')}
          title="Fetch remote updates"
        >
          <GitIcon name="fetch" busy={isBusy('fetch')} />
          Fetch
        </button>
        <button
          class="btn btn-secondary git-tool-btn"
          class:loading={isBusy('pull')}
          type="button"
          onclick={() => onPull()}
          disabled={!canPull}
          aria-busy={isBusy('pull')}
          title={pullTitle()}
        >
          <GitIcon name="pull" busy={isBusy('pull')} />
          Pull
          {#if status.behind > 0}<span class="git-tool-badge">{status.behind}</span>{/if}
        </button>
        <button
          class="btn btn-secondary git-tool-btn"
          class:loading={isBusy('push')}
          type="button"
          onclick={onPush}
          disabled={!canPush}
          aria-busy={isBusy('push')}
          title={pushTitle()}
        >
          <GitIcon name="push" busy={isBusy('push')} />
          Push
          {#if pushCount > 0}<span class="git-tool-badge">{pushCount}</span>{/if}
        </button>
        <div class="git-more-control">
          <button
            class="btn btn-ghost btn-icon git-tool-btn"
            type="button"
            onclick={() => (moreMenuOpen = !moreMenuOpen)}
            aria-haspopup="menu"
            aria-expanded={moreMenuOpen}
            aria-label="More Git actions"
            title="More Git actions"
          >
            <span class="git-more-dots">⋯</span>
          </button>
          {#if moreMenuOpen}
            <div class="menu git-more-menu" role="menu">
              <button class="menu-item git-more-item" type="button" onclick={() => runAndCloseMore(onRefresh)} disabled={loading} role="menuitem">
                <GitIcon name="refresh" />
                Refresh status
              </button>
              <button class="menu-item git-more-item" type="button" onclick={() => runAndCloseMore(onViewOutgoing)} disabled={!canRepoAction} role="menuitem">
                <GitIcon name="eye" />
                View outgoing
              </button>
              <button class="menu-item git-more-item" type="button" onclick={() => { moreMenuOpen = false; expandedPanel = 'output'; }} disabled={!output} role="menuitem" title={output ? 'Show what Git printed for the last command' : 'No Git output yet'}>
                <GitIcon name="history" />
                Show Git output
              </button>
              <div class="git-more-sep"></div>
              <button class="menu-item git-more-item" type="button" onclick={() => runAndCloseMore(() => onPull('merge'))} disabled={!canPullWithHistoryStrategy} role="menuitem">
                <GitIcon name="merge" />
                Pull (merge)
              </button>
              <button class="menu-item git-more-item" type="button" onclick={() => runAndCloseMore(() => onPull('rebase'))} disabled={!canPullWithHistoryStrategy} role="menuitem">
                <GitIcon name="rebase" />
                Pull (rebase)
              </button>
              <button class="menu-item git-more-item" type="button" onclick={() => runAndCloseMore(() => onPull('autostash'))} disabled={!canAutostashPull} role="menuitem" title="Stash uncommitted edits, rebase onto upstream, then re-apply">
                <GitIcon name="rebase" />
                Pull (rebase + autostash)
              </button>
              <div class="git-more-sep"></div>
              <button class="menu-item git-more-item" type="button" onclick={() => runAndCloseMore(onStash)} disabled={!canStash} role="menuitem" title="Stash Kurlo-managed YAML changes">
                <GitIcon name="archive" />
                Stash Kurlo changes
              </button>
              <button class="menu-item git-more-item" type="button" onclick={() => runAndCloseMore(() => onPopStash())} disabled={!canPopStash} role="menuitem" title="Apply the latest Git stash">
                <GitIcon name="download" />
                Apply latest stash
                {#if stashCount}<em class="git-more-count">{stashCount}</em>{/if}
              </button>
              <button class="menu-item git-more-item danger" type="button" onclick={() => runAndCloseMore(onForcePush)} disabled={!canRepoAction} role="menuitem">
                <GitIcon name="force-push" />
                Force push (with lease)
              </button>
              <div class="git-more-sep"></div>
              <button
                class="menu-item git-more-item"
                type="button"
                onclick={() => runAndCloseMore(onUseLocal)}
                disabled={loading}
                role="menuitem"
                title="Stop tracking this repository in Kurlo. Files stay on disk."
              >
                <GitIcon name="x" busy={isBusy('close-repo')} />
                Close repository
              </button>
            </div>
          {/if}
        </div>
      {:else}
        <button
          class="btn btn-secondary git-tool-btn"
          class:loading={isBusy('refresh')}
          type="button"
          onclick={onRefresh}
          disabled={loading}
          aria-busy={isBusy('refresh')}
          title="Refresh status"
        >
          <GitIcon name="refresh" busy={isBusy('refresh')} />
          Refresh
        </button>
      {/if}
    </div>
  </div>

  {#if branchPickerOpen || moreMenuOpen}
    <button
      class="git-popover-scrim"
      type="button"
      tabindex="-1"
      aria-label="Close menu"
      onclick={() => { closeBranchPicker(); closeMoreMenu(); }}
    ></button>
  {/if}

  <div class="git-content">
    {#if workspaceDiagnostics.length}
      <div class="git-yaml-card" class:blocking={workspaceBlocked} role="group" aria-label="Workspace issues">
        <div class="git-yaml-head">
          <strong>
            {#if workspaceBlocked}
              Editing is paused: {workspaceDiagnostics.length} workspace {workspaceDiagnostics.length === 1 ? 'file needs' : 'files need'} fixing
            {:else}
              {workspaceDiagnostics.length} workspace {workspaceDiagnostics.length === 1 ? 'file' : 'files'} could not be loaded
            {/if}
          </strong>
          <p>
            {#if workspaceBlocked}
              Saving and commits stay off until these files are fixed. Edit them here, or pull a commit that fixes them.
            {:else}
              What these files describe stays hidden until their YAML is fixed. Everything else works as usual.
            {/if}
          </p>
        </div>
        <div class="git-yaml-list">
          {#each visibleYamlDiagnostics as diagnostic (workspaceDiagnosticKey(diagnostic))}
            {@const location = workspaceDiagnosticLocation(diagnostic)}
            {@const scopeLabel = workspaceDiagnosticScopeLabel(diagnostic)}
            <div class="git-yaml-row" class:blocking={diagnostic.blocking}>
              <span class="git-yaml-dot" aria-hidden="true"></span>
              <div class="git-yaml-copy">
                <div class="git-yaml-file" title={location}>
                  <strong>{pathName(location)}</strong>
                  {#if pathFolder(diagnostic.path)}<em>{pathFolder(diagnostic.path)}</em>{/if}
                </div>
                <span>{diagnostic.message}</span>
                {#if scopeLabel}<small class="git-yaml-scope">{scopeLabel}</small>{/if}
              </div>
              <button
                class="btn btn-secondary btn-sm git-action-btn git-yaml-edit"
                type="button"
                onclick={() => onEditWorkspaceDiagnostic(diagnostic)}
                aria-label={`Edit ${diagnostic.path}`}
              >
                <GitIcon name="edit" />
                Edit YAML
              </button>
            </div>
          {/each}
        </div>
        {#if yamlDiagnosticTotal > YAML_PAGE_SIZE}
          <div class="git-yaml-foot">
            <small>Showing {visibleYamlDiagnostics.length} of {yamlDiagnosticTotal}</small>
            <div class="git-yaml-foot-actions">
              {#if yamlHiddenCount > 0}
                <button class="btn btn-secondary btn-sm git-action-btn" type="button" onclick={() => (yamlVisibleCount = Math.min(yamlDiagnosticTotal, yamlVisibleCount + YAML_PAGE_SIZE))}>
                  <GitIcon name="download" />
                  Show {yamlNextPage} more
                </button>
                <button class="btn btn-ghost btn-sm git-action-btn" type="button" onclick={() => (yamlVisibleCount = yamlDiagnosticTotal)}>
                  Show all
                </button>
              {:else}
                <button class="btn btn-ghost btn-sm git-action-btn" type="button" onclick={() => (yamlVisibleCount = YAML_PAGE_SIZE)}>
                  Show less
                </button>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {:else if workspaceBlocked}
      <div class="git-banner warning">Workspace files are invalid. Editing is paused until this workspace loads again; pull a commit that fixes them.</div>
    {/if}
    {#if error || status.error}
      <div class="git-banner error git-banner-row">
        <span>{error || status.error}</span>
        {#if output}
          <button class="btn btn-ghost btn-sm git-action-btn" type="button" onclick={() => (expandedPanel = 'output')}>Show output</button>
        {/if}
      </div>
    {/if}

    {#if status.operation || conflictedFiles.length}
      <div class="git-conflict-card">
        <div class="git-provider-copy">
          <span>{operationTitle() || 'Conflicts'}</span>
          <strong>{conflictedFiles.length ? `${conflictedFiles.length} conflicted Kurlo file${conflictedFiles.length === 1 ? '' : 's'}` : 'All conflicts are staged'}</strong>
          <small>{conflictedFiles.length ? 'Select a conflicted file, choose ours/theirs, or edit the conflict content manually.' : 'Continue the Git operation to finish.'}</small>
        </div>
        <div class="git-provider-actions">
          <button class="btn btn-secondary git-action-btn" class:loading={isBusy('operation-continue')} type="button" onclick={onContinueOperation} disabled={!canContinueOperation} aria-busy={isBusy('operation-continue')} title="Continue the current Git operation">
            <GitIcon name="play" busy={isBusy('operation-continue')} />
            Continue
          </button>
          <button class="btn btn-secondary btn-danger git-action-btn" class:loading={isBusy('operation-abort')} type="button" onclick={onAbortOperation} disabled={loading} aria-busy={isBusy('operation-abort')} title="Abort the current Git operation">
            <GitIcon name="x" busy={isBusy('operation-abort')} />
            Abort
          </button>
        </div>
      </div>
    {/if}

    {#if showRepositorySetup && status.isRepo}
      <div class="git-setup-card">
        <div class="git-provider-copy">
          <span>Remote setup</span>
          <strong>Connect this repository to a remote</strong>
          <small>Add and check an upstream remote before push and pull.</small>
        </div>
        <div class="git-provider-actions">
          <button class="btn btn-secondary git-action-btn" class:loading={isBusy('remote')} type="button" onclick={onAddRemote} disabled={!canRepoAction} aria-busy={isBusy('remote')} title="Add an upstream remote">
            <GitIcon name="link" busy={isBusy('remote')} />
            Add remote
          </button>
          <button class="btn btn-secondary git-action-btn" class:loading={isBusy('remote-test')} type="button" onclick={onTestRemote} disabled={!canRepoAction} aria-busy={isBusy('remote-test')} title="Test remote access">
            <GitIcon name="check" busy={isBusy('remote-test')} />
            Test remote
          </button>
        </div>
      </div>
    {/if}

    {#if !status.isRepo}
      <div class="git-local-card" class:missing={workspaceMissing}>
        <div class="git-local-head">
          <span class="git-local-eyebrow">{localEyebrow}</span>
          <code class="git-local-path" title={storagePath}>{storagePath}</code>
          {#if isAppStoragePath || workspaceMissing}
            <button
              class="btn btn-primary btn-lg git-action-btn git-local-cta"
              class:loading={isBusy('local-create')}
              type="button"
              onclick={onCreateLocal}
              disabled={loading}
              aria-busy={isBusy('local-create')}
              title={workspaceMissing ? 'Create a replacement workspace folder' : 'Create a folder workspace on disk'}
            >
              <GitIcon name="folder-plus" busy={isBusy('local-create')} />
              {workspaceMissing ? 'Create folder…' : 'New folder workspace…'}
            </button>
          {:else}
            <button
              class="btn btn-primary btn-lg git-action-btn git-local-cta"
              class:loading={isBusy('init')}
              type="button"
              onclick={onInit}
              disabled={loading || gitUnavailable}
              aria-busy={isBusy('init')}
              title={gitUnavailable ? 'Install Git and restart Kurlo to initialize a repository' : 'Initialize a Git repository in this folder'}
            >
              <GitIcon name="init" busy={isBusy('init')} />
              Init Git here
            </button>
          {/if}
          <small class="git-local-desc">
            {localDescription}
          </small>
        </div>
        <div class="git-local-divider" role="separator">
          <span>{localDividerLabel}</span>
        </div>
        <div class="git-local-options">
          {#if !isAppStoragePath && !workspaceMissing}
            <button class="option-card git-local-option" class:loading={isBusy('local-create')} type="button" onclick={onCreateLocal} disabled={loading} aria-busy={isBusy('local-create')}>
              <GitIcon name="folder-plus" busy={isBusy('local-create')} />
              <strong>New folder workspace</strong>
              <small>Create an empty workspace or copy the current one</small>
            </button>
          {/if}
          {#if workspaceMissing}
            <button class="option-card git-local-option" class:loading={isBusy('use-app-storage')} type="button" onclick={onUseAppStorage} disabled={loading} aria-busy={isBusy('use-app-storage')}>
              <GitIcon name="folder-open" busy={isBusy('use-app-storage')} />
              <strong>Use Kurlo's app storage</strong>
              <small>Switch back to the workspaces Kurlo keeps in its own data folder</small>
            </button>
          {/if}
          <button class="option-card git-local-option" class:loading={isBusy('open')} type="button" onclick={onOpen} disabled={loading} aria-busy={isBusy('open')}>
            <GitIcon name="folder-open" busy={isBusy('open')} />
            <strong>Open existing repo</strong>
            <small>Pick a folder that already contains <code>.git/</code></small>
          </button>
          <button class="option-card git-local-option" class:loading={isBusy('clone')} type="button" onclick={onClone} disabled={loading || gitUnavailable} aria-busy={isBusy('clone')}>
            <GitIcon name="clone" busy={isBusy('clone')} />
            <strong>Clone from URL</strong>
            <small>{gitUnavailable ? 'Needs Git installed on this machine' : 'Download a remote repository to a chosen folder'}</small>
          </button>
          {#if isAppStoragePath}
            <button class="option-card git-local-option" class:loading={isBusy('init')} type="button" onclick={onInit} disabled={loading || gitUnavailable} aria-busy={isBusy('init')}>
              <GitIcon name="init" busy={isBusy('init')} />
              <strong>Init Git here</strong>
              <small>{gitUnavailable ? 'Needs Git installed on this machine' : 'Initialize Git in the current workspace folder (advanced)'}</small>
            </button>
          {/if}
        </div>
      </div>
    {/if}

    {#if status.isRepo}
      <div class="git-layout">
      <div class="git-files">
        <div class="git-panel-head">
          <div class="segmented git-side-tabs" role="tablist" aria-label="Changes and history" use:tabListKeyboard>
            <button class="segmented-item" role="tab" type="button" class:active={sideTab === 'changes'} aria-selected={sideTab === 'changes'} tabindex={sideTab === 'changes' ? 0 : -1} onclick={() => (sideTab = 'changes')}>
              Changes{#if changeCount}<span class="subtab-count">{changeCount}</span>{/if}
            </button>
            <button class="segmented-item" role="tab" type="button" class:active={sideTab === 'history'} aria-selected={sideTab === 'history'} tabindex={sideTab === 'history' ? 0 : -1} onclick={() => (sideTab = 'history')}>
              History
            </button>
          </div>
        </div>
        {#if sideTab === 'history'}
          {#if commits.error}
            <div class="git-empty error">{commits.error}</div>
          {:else if commitRows.length}
            <div
              class="git-commit-list virtual"
              onscroll={(event) => { updateVirtualScroll(event, value => (commitScrollTop = value), value => (commitListHeight = value)); loadMoreCommitsNearEnd(event); }}
            >
              <div class="git-list-spacer" style={`height: ${commitWindow.before}px`}></div>
              {#each virtualCommitRows as commit (commit.hash)}
                <button
                  class="git-commit-row"
                  class:active={selectedCommit === commit.hash}
                  type="button"
                  onclick={() => onSelectCommit(commit.hash)}
                  title={`View changes in ${commit.hash}`}
                >
                  <span>
                    <strong>{commit.message || '(no message)'}</strong>
                    <small>{commit.shortHash} · {commit.author} · {commitDateLabel(commit.date)}</small>
                  </span>
                </button>
              {/each}
              <div class="git-list-spacer" style={`height: ${commitWindow.after}px`}></div>
            </div>
            {#if commits.hasMore}
              <div class="git-list-footer">
                <button class="btn btn-secondary btn-sm git-action-btn" class:loading={logLoadingMore} type="button" onclick={onLoadMoreLog} disabled={logLoadingMore} aria-busy={logLoadingMore} title="Load older commits">
                  <GitIcon name="download" busy={logLoadingMore} />
                  {logLoadingMore ? 'Loading older commits' : 'Load more'}
                </button>
              </div>
            {/if}
          {:else}
            <div class="empty-state git-empty">No commits yet</div>
          {/if}
        {:else}
          {#if selectedFileCount}
            <div class="git-selection-bar">
              <small>{selectedFileLabel}</small>
              <button
                class="btn btn-primary btn-sm git-action-btn"
                class:loading={isBusy('commit-selected')}
                type="button"
                onclick={commitSelectedFiles}
                disabled={!canOperateOnSelectedFiles}
                aria-busy={isBusy('commit-selected')}
                title="Commit selected Kurlo workspace files"
              >
                <GitIcon name="commit" busy={isBusy('commit-selected')} />
                Commit
              </button>
              <button
                class="btn btn-secondary btn-danger btn-icon btn-sm git-action-btn"
                class:loading={isBusy('discard-selected')}
                type="button"
                onclick={discardSelectedFiles}
                disabled={!canDiscardSelectedFiles}
                aria-busy={isBusy('discard-selected')}
                title="Discard selected Kurlo workspace file changes"
                aria-label="Discard selected"
              >
                <GitIcon name="trash" busy={isBusy('discard-selected')} />
              </button>
              <button class="btn btn-ghost btn-icon btn-sm git-action-btn" type="button" onclick={clearFileSelection} disabled={loading} title="Clear file selection" aria-label="Clear selection">
                <GitIcon name="x" />
              </button>
            </div>
          {:else if changeCount}
            <div class="git-selection-bar">
              <small>{changeCount} changed {changeCount === 1 ? 'file' : 'files'}</small>
              <button class="btn btn-ghost btn-icon btn-sm git-action-btn" type="button" onclick={toggleAllFileSelection} disabled={loading} title="Select all changed files" aria-label="Select all">
                <GitIcon name="check-square" />
              </button>
              <button
                class="btn btn-ghost btn-danger btn-icon btn-sm git-action-btn"
                class:loading={isBusy('discard-all')}
                type="button"
                onclick={onDiscardAll}
                disabled={loading}
                aria-busy={isBusy('discard-all')}
                title="Discard all uncommitted Kurlo workspace changes"
                aria-label="Discard all"
              >
                <GitIcon name="trash" busy={isBusy('discard-all')} />
              </button>
              <button
                class="btn btn-primary btn-sm git-action-btn"
                class:loading={isBusy('commit')}
                type="button"
                onclick={() => onCommit()}
                disabled={!canRepoAction}
                aria-busy={isBusy('commit')}
                title="Commit all changed Kurlo workspace files"
              >
                <GitIcon name="commit" busy={isBusy('commit')} />
                Commit all
              </button>
            </div>
          {/if}
          {#if !changeCount}
            <div class="empty-state git-empty"><span class="empty-state-title">No changed files</span></div>
            {#if otherChangeCount}<p class="git-other-changes">{otherChangeCount} other {otherChangeCount === 1 ? 'change' : 'changes'} in this repository {otherChangeCount === 1 ? "isn't a Kurlo file" : "aren't Kurlo files"}. Commit {otherChangeCount === 1 ? 'it' : 'them'} with your usual Git tool.</p>{/if}
          {:else}
            <div
              class="git-file-list virtual"
              role="list"
              onscroll={(event) => updateVirtualScroll(event, value => (fileScrollTop = value), value => (fileListHeight = value))}
            >
              <div class="git-list-spacer" style={`height: ${fileWindow.before}px`}></div>
              {#each virtualChangedFiles as file (file.path)}
                <div class="git-file-row" class:active={selectedPath === file.path} class:selected={selectedFileSet.has(file.path)} role="listitem">
                  <input
                    class="git-file-check check"
                    type="checkbox"
                    checked={selectedFileSet.has(file.path)}
                    aria-label={`Select ${file.path}`}
                    onchange={(event) => setFileSelection(file.path, event.currentTarget.checked)}
                    disabled={!canDiscardAction}
                  />
                  <button class="git-file-open" type="button" onclick={() => openFile(file)}>
                    <span
                      class:added={file.status === 'added' || file.status === 'untracked'}
                      class:removed={file.status === 'deleted'}
                      class:modified={file.status === 'modified' || file.status === 'changed' || file.status === 'renamed'}
                      class:conflict={file.status === 'conflicted'}
                      title={file.status}
                    >{fileStatusLabel(file.status)}</span>
                    <strong title={file.path}>{pathName(file.path)}<small>{pathFolder(file.path)}</small></strong>
                    <span class="sr-only">{file.status}</span>
                  </button>
                </div>
              {/each}
              <div class="git-list-spacer" style={`height: ${fileWindow.after}px`}></div>
            </div>
            {#if otherChangeCount}<p class="git-other-changes">{otherChangeCount} other {otherChangeCount === 1 ? 'change' : 'changes'} in this repository {otherChangeCount === 1 ? "isn't a Kurlo file" : "aren't Kurlo files"}. Commit {otherChangeCount === 1 ? 'it' : 'them'} with your usual Git tool.</p>{/if}
          {/if}
        {/if}
      </div>

      <div class="git-diff">
        <div class="git-panel-head">
          {#if selectedCommit}
            <span class="git-panel-title" title={selectedCommitInfo?.message || diffTitle}>{selectedCommitInfo?.message || diffTitle}{#if selectedCommitInfo}<small>{selectedCommitInfo.shortHash} · {selectedCommitInfo.author}</small>{/if}</span>
          {:else}
            <span class="git-panel-title" title={diffTitle}>{pathName(diffTitle)}{#if pathFolder(diffTitle)}<small>{pathFolder(diffTitle)}</small>{/if}</span>
          {/if}
          <div class="git-panel-actions">
            {#if diff.truncated}<small>truncated</small>{/if}
            <button
              class="btn btn-ghost btn-sm git-action-btn"
              type="button"
              onclick={() => selectedFileIsConflict ? openConflictResolver() : (expandedPanel = 'diff')}
              disabled={selectedFileIsConflict ? !conflict.path : (!diff.diff && !diffLoading)}
              title={selectedFileIsConflict ? 'Open conflict resolver' : 'Open diff in a large review window'}
            >
              <GitIcon name="expand" />
              Expand
            </button>
            {#if selectedChangedFile && selectedPath !== 'Outgoing changes'}
              <button
                class="btn btn-ghost btn-danger btn-sm git-action-btn"
                class:loading={isBusy('discard-file')}
                type="button"
                onclick={onDiscardFile}
                disabled={!canDiscardSelected}
                aria-busy={isBusy('discard-file')}
                title="Discard local changes for this file"
              >
                <GitIcon name="trash" busy={isBusy('discard-file')} />
                Discard
              </button>
            {/if}
          </div>
        </div>
        {#if selectedFileIsConflict}
          <div class="git-conflict-tools">
            <div>
              <strong>Resolve conflict</strong>
              <small>{conflict.truncated ? 'Content truncated' : selectedPath}</small>
            </div>
            <div class="git-conflict-buttons">
              <button class="btn btn-secondary btn-sm git-action-btn" class:loading={isBusy('resolve-ours')} type="button" onclick={() => onResolveConflict('ours', selectedPath)} disabled={loading || !conflictReady} aria-busy={isBusy('resolve-ours')} title={conflictSideTitle('ours')}>
                <GitIcon name="pull" busy={isBusy('resolve-ours')} />
                {fullConflictSideActionLabel('ours')}
              </button>
              <button class="btn btn-secondary btn-sm git-action-btn" class:loading={isBusy('resolve-theirs')} type="button" onclick={() => onResolveConflict('theirs', selectedPath)} disabled={loading || !conflictReady} aria-busy={isBusy('resolve-theirs')} title={conflictSideTitle('theirs')}>
                <GitIcon name="fetch" busy={isBusy('resolve-theirs')} />
                {fullConflictSideActionLabel('theirs')}
              </button>
              <button class="btn btn-secondary btn-sm git-action-btn" class:loading={isBusy('resolve-manual')} type="button" onclick={() => onResolveConflict('manual', selectedPath, conflictDraft)} disabled={loading || conflict.binary || !conflictReady} aria-busy={isBusy('resolve-manual')} title="Save the edited conflict content as resolved">
                <GitIcon name="save" busy={isBusy('resolve-manual')} />
                Save resolved
              </button>
              <button class="btn btn-secondary btn-sm git-action-btn" type="button" onclick={openConflictResolver} disabled={loading || conflict.binary || !conflictReady} title="Open a large three-way resolver">
                <GitIcon name="expand" />
                Open resolver
              </button>
            </div>
          </div>
          {#if conflict.binary}
            <div class="empty-state git-empty">Binary conflict. Use ours/theirs or resolve in an external editor.</div>
          {:else}
            <div class="git-conflict-review">
              <div class="git-conflict-side">
                <div class="git-conflict-side-head">
                  <strong>Ours</strong>
                  {#if conflict.oursTruncated}<small>truncated</small>{/if}
                </div>
                <pre>{conflictOursLines.slice(0, 80).join('\n') || sideFallbackLabel('ours')}</pre>
              </div>
              <div class="git-conflict-side incoming">
                <div class="git-conflict-side-head">
                  <strong>Theirs</strong>
                  {#if conflict.theirsTruncated}<small>truncated</small>{/if}
                </div>
                <pre>{conflictTheirsLines.slice(0, 80).join('\n') || sideFallbackLabel('theirs')}</pre>
              </div>
            </div>
            <textarea class="git-conflict-editor" bind:value={conflictDraft} spellcheck="false" aria-label="Conflict file content"></textarea>
          {/if}
        {/if}
        {#if diffLoading}
          <div class="empty-state git-empty">Loading diff...</div>
        {:else if diff.error}
          <div class="git-empty error">{diff.error}</div>
        {:else if diff.binary}
          <div class="empty-state git-empty">Binary file</div>
        {:else if diff.diff && hasSplitDiff}
          <div class="git-diff-code" role="region" aria-label="Git diff">
            {#if stagedDiffRows.length}
              <div class="git-diff-section-label">Staged</div>
              {@render diffRowList(stagedDiffRows)}
            {/if}
            {#if unstagedDiffRows.length}
              <div class="git-diff-section-label">Unstaged</div>
              {@render diffRowList(unstagedDiffRows)}
            {/if}
          </div>
        {:else if diff.diff}
          <div class="git-diff-code" role="region" aria-label="Git diff">
            {@render diffRowList(visibleDiffRows)}
          </div>
        {:else}
          <div class="empty-state git-empty">{selectedPath ? 'No text diff' : sideTab === 'history' ? 'Select a commit' : 'Select a file'}</div>
        {/if}
      </div>

    </div>
  {/if}

  </div>

  {#if expandedPanel}
    <div class="dialog-backdrop git-review-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && closeExpandedPanel()}>
      <div class="modal git-review-modal" class:conflict={expandedPanel === 'conflict'} class:output={expandedPanel === 'output'} role="dialog" aria-modal="true" aria-labelledby="git-review-title" tabindex="-1" onkeydown={(event) => event.key === 'Escape' && closeExpandedPanel()}>
        <div class="modal-head dialog-head git-review-head">
          <div>
            {#if expandedPanel === 'diff'}
              <h2 class="modal-title" id="git-review-title">{selectedCommit ? (selectedCommitInfo?.message || diffTitle) : pathName(diffTitle)}</h2>
              <p>{selectedCommit ? 'Commit diff' : (pathFolder(diffTitle) || 'Review workspace changes')}</p>
            {:else if expandedPanel === 'output'}
              <h2 class="modal-title" id="git-review-title">Git output</h2>
              <p>What Git printed for the last command</p>
            {:else}
              <h2 id="git-review-title">Resolve conflict{selectedPath ? ` · ${pathName(selectedPath)}` : ''}</h2>
              <p>{selectedPath ? (pathFolder(selectedPath) || selectedPath) : 'Choose a conflicted Kurlo file'}</p>
            {/if}
          </div>
          <button type="button" class="btn btn-ghost btn-icon dialog-close" onclick={closeExpandedPanel} aria-label={expandedPanel === 'output' ? 'Close Git output' : 'Close review'}>×</button>
        </div>
        {#if expandedPanel === 'output'}
          <div class="git-review-body">
            <pre class="git-output-log" aria-label="Git output">{output || 'No output'}</pre>
          </div>
        {:else if expandedPanel === 'diff'}
          <div class="git-review-body">
            {#if diffLoading}
              <div class="empty-state git-empty">Loading diff...</div>
            {:else if diff.error}
              <div class="git-empty error">{diff.error}</div>
            {:else if diff.binary}
              <div class="empty-state git-empty">Binary file</div>
            {:else if diff.diff && hasSplitDiff}
              <div class="git-diff-code expanded" role="region" aria-label="Expanded Git diff">
                {#if stagedDiffRows.length}
                  <div class="git-diff-section-label">Staged</div>
                  {@render diffRowList(stagedDiffRows)}
                {/if}
                {#if unstagedDiffRows.length}
                  <div class="git-diff-section-label">Unstaged</div>
                  {@render diffRowList(unstagedDiffRows)}
                {/if}
              </div>
            {:else if diff.diff}
              <div class="git-diff-code expanded" role="region" aria-label="Expanded Git diff">
                {@render diffRowList(visibleDiffRows)}
              </div>
            {:else}
              <div class="empty-state git-empty">{selectedPath ? 'No text diff' : sideTab === 'history' ? 'Select a commit' : 'Select a file'}</div>
            {/if}
          </div>
        {:else if expandedPanel === 'conflict'}
          <div class="git-review-body conflict">
            {#if conflict.binary}
              <div class="empty-state git-empty">Binary conflict. Use ours/theirs or resolve in an external editor.</div>
            {:else}
              <div class="git-conflict-workbench">
                <aside class="git-conflict-file-rail" aria-label="Conflicted files">
                  <div class="git-conflict-file-rail-head">
                    <strong>Files</strong>
                    <span>{conflictedFiles.length}</span>
                  </div>
                  <div class="git-conflict-file-rail-list">
                    {#each conflictedFiles as file (file.path)}
                      <button class="git-conflict-file-pill" class:active={selectedPath === file.path} type="button" onclick={() => openConflictFile(file.path)} title={file.path}>
                        <span>{fileStatusLabel(file.status)}</span>
                        <strong>{pathName(file.path)}</strong>
                        {#if pathFolder(file.path)}<small>{pathFolder(file.path)}</small>{/if}
                      </button>
                    {/each}
                  </div>
                  <div class="git-conflict-file-rail-foot">
                    <small>{conflictProgressLabel}</small>
                  </div>
                </aside>

                <div class="git-conflict-main">
                  <div class="git-conflict-resolver-toolbar">
                    <div class="git-conflict-hunk-nav">
                      <button class="btn btn-secondary btn-icon btn-sm git-action-btn" type="button" onclick={() => jumpConflict(-1)} disabled={!currentConflict || currentConflictIndex === 0} title="Previous conflict hunk" aria-label="Previous conflict hunk">
                        <span aria-hidden="true">&larr;</span>
                      </button>
                      <span>{currentConflict ? `Hunk ${currentConflictIndex + 1} of ${conflictHunks.length} · lines ${currentConflict.startLine}-${currentConflict.endLine}` : 'Unmerged file without inline markers'}</span>
                      <button class="btn btn-secondary btn-icon btn-sm git-action-btn" type="button" onclick={() => jumpConflict(1)} disabled={!currentConflict || currentConflictIndex >= conflictHunks.length - 1} title="Next conflict hunk" aria-label="Next conflict hunk">
                        <span aria-hidden="true">&rarr;</span>
                      </button>
                    </div>
                    <div class="git-conflict-resolver-actions">
                      <button class="btn btn-secondary btn-sm git-action-btn" type="button" onclick={() => useConflictSide('ours')} disabled={loading || !selectedPath || (!currentConflict && !conflictReady)} title={conflictSideTitle('ours')}>
                        <span aria-hidden="true">&larr;</span>
                        {resolverConflictSideActionLabel('ours')}
                      </button>
                      <button class="btn btn-secondary btn-sm git-action-btn" type="button" onclick={() => useConflictSide('theirs')} disabled={loading || !selectedPath || (!currentConflict && !conflictReady)} title={conflictSideTitle('theirs')}>
                        {resolverConflictSideActionLabel('theirs')}
                        <span aria-hidden="true">&rarr;</span>
                      </button>
                      <button class="btn btn-ghost btn-sm git-action-btn" type="button" onclick={() => acceptAllConflicts('ours')} disabled={!conflictHunks.length} title="Resolve every hunk with local changes">
                        All ours
                      </button>
                      <button class="btn btn-ghost btn-sm git-action-btn" type="button" onclick={() => acceptAllConflicts('theirs')} disabled={!conflictHunks.length} title="Resolve every hunk with remote changes">
                        All theirs
                      </button>
                      <button class="btn btn-secondary btn-sm git-action-btn" class:loading={isBusy('resolve-manual')} type="button" onclick={saveManualResolution} disabled={loading || conflict.binary || !conflictReady || hasInlineConflictMarkers} aria-busy={isBusy('resolve-manual')} title={hasInlineConflictMarkers ? 'Resolve all conflict markers before saving' : 'Save the middle result and mark file resolved'}>
                        <GitIcon name="save" busy={isBusy('resolve-manual')} />
                        Save resolved
                      </button>
                    </div>
                  </div>

                  <div class="git-conflict-columns">
                    <section class="git-conflict-pane ours" aria-label="Local version">
                      <div class="git-conflict-pane-head">
                        <strong>Ours</strong>
                        {#if conflict.oursTruncated}<small>truncated</small>{/if}
                      </div>
                      <pre class="git-conflict-code">{conflict.oursContent || sideFallbackLabel('ours')}</pre>
                    </section>
                    <section class="git-conflict-pane result" aria-label="Resolved result">
                      <div class="git-conflict-pane-head">
                        <strong>Result</strong>
                        <div class="segmented git-conflict-pane-switch" role="group" aria-label="Result editor mode">
                          <button class="segmented-item" type="button" class:active={!conflictRawMode} onclick={() => (conflictRawMode = false)}>Visual</button>
                          <button class="segmented-item" type="button" class:active={conflictRawMode} onclick={() => { conflictRawMode = true; queueMicrotask(focusCurrentConflict); }}>Raw markers</button>
                        </div>
                        <small>{conflictProgressLabel}</small>
                      </div>
                      {#if conflictRawMode}
                        <textarea bind:this={conflictResultEditor} class="git-conflict-result-editor" bind:value={conflictDraft} spellcheck="false" aria-label="Resolved conflict content"></textarea>
                      {:else}
                        <div class="git-conflict-result-visual" role="region" aria-label="Visual conflict result">
                          {#if markerlessConflict}
                            <div class="git-conflict-markerless">
                              <strong>Unmerged without inline markers</strong>
                              <p>Git still needs a resolution, but this file has no <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> block in the working copy. Pick a full-file side or save the current result.</p>
                              <div>
                                <button class="btn btn-secondary btn-sm" type="button" onclick={() => resolveAndClose('ours')} title={conflictSideTitle('ours')}>
                                  <span aria-hidden="true">&larr;</span> {fullConflictSideActionLabel('ours')}
                                </button>
                                <button class="btn btn-secondary btn-sm" type="button" onclick={() => resolveAndClose('theirs')} title={conflictSideTitle('theirs')}>
                                  {fullConflictSideActionLabel('theirs')} <span aria-hidden="true">&rarr;</span>
                                </button>
                                <button class="btn btn-secondary btn-sm" type="button" onclick={saveManualResolution}>Save current result</button>
                              </div>
                            </div>
                          {/if}
                          {#each conflictBlocks as block, blockIndex (conflictBlockKey(block, blockIndex))}
                            {#if block.kind === 'text'}
                              {#each block.raw as line, lineIndex (lineIndex)}
                                <div class="git-conflict-visual-line">
                                  <span>{block.startLine + lineIndex}</span>
                                  <code>{line || ' '}</code>
                                </div>
                              {/each}
                            {:else}
                              <div
                                class="git-conflict-inline-hunk"
                                class:active={currentConflict?.index === block.index}
                                role="group"
                                aria-label={`Conflict hunk ${block.index + 1}`}
                              >
                                <div class="git-conflict-inline-head">
                                  <strong>Conflict {block.index + 1}</strong>
                                  <small>lines {block.startLine}-{block.endLine}</small>
                                  <button class="btn btn-ghost btn-xs" type="button" onclick={() => selectConflict(block.index)}>Focus</button>
                                </div>
                                <div class="git-conflict-inline-choice ours">
                                  <button class="git-conflict-choice-btn" type="button" onclick={(event) => { event.stopPropagation(); acceptConflict(block.index, 'ours'); }} title="Apply local lines to the result">
                                    <span aria-hidden="true">&larr;</span> Use ours
                                  </button>
                                  <pre>{block.ours.join('\n') || '(empty)'}</pre>
                                </div>
                                <div class="git-conflict-inline-choice theirs">
                                  <button class="git-conflict-choice-btn" type="button" onclick={(event) => { event.stopPropagation(); acceptConflict(block.index, 'theirs'); }} title="Apply remote lines to the result">
                                    Use theirs <span aria-hidden="true">&rarr;</span>
                                  </button>
                                  <pre>{block.theirs.join('\n') || '(empty)'}</pre>
                                </div>
                              </div>
                            {/if}
                          {/each}
                        </div>
                      {/if}
                    </section>
                    <section class="git-conflict-pane theirs" aria-label="Remote version">
                      <div class="git-conflict-pane-head">
                        <strong>Theirs</strong>
                        {#if conflict.theirsTruncated}<small>truncated</small>{/if}
                      </div>
                      <pre class="git-conflict-code">{conflict.theirsContent || sideFallbackLabel('theirs')}</pre>
                    </section>
                  </div>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</section>
