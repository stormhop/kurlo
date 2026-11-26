<script lang="ts">
  import { loadRunKey } from './lib/loadTests';
  import type { RequestSelection } from './lib/sidebarSelection';
  import { kurloChangedFiles } from './lib/gitFiles';
  import { onMount, untrack } from 'svelte';
  import { docsRelativeLinkScopes, getAppInfo, checkForUpdate, applyUpdate, restartApp, clipboardSet, ackQuit } from './lib/backend';
  import type { MockRequestLog, OAuth2DevicePrompt, UpdateInfo } from './lib/backend';
  import { hasReleaseNotes } from 'virtual:kurlo-changelog-meta';
  import { isReleaseVersion, latestReleaseNotes, normalizeVersion, releaseNotesFor, shouldShowWhatsNew, shouldSpotlightAgentMode, type ChangelogSection } from './lib/whatsNew';
  import WhatsNewModal from './lib/components/WhatsNewModal.svelte';
  import UpdateBanner from './lib/components/UpdateBanner.svelte';
  import { vm } from './lib/stores/app.svelte';
  import { agentNavigation, syncAgentWorkspace } from './lib/stores/agent.svelte';
  import { appLazyComponents as lazy } from './lib/stores/lazyComponents.svelte';

  import AppOverlays from './lib/components/AppOverlays.svelte';
  import CollectionDocsModal from './lib/components/CollectionDocsModal.svelte';
  import AppToasts from './lib/components/AppToasts.svelte';
  import TextContextMenu from './lib/components/TextContextMenu.svelte';
  import { installFileDrop } from './lib/fileDrop';
  import { textTargetFrom, type TextMenuState } from './lib/textEditing';
  import BodyModeSelector from './lib/components/BodyModeSelector.svelte';
  import RequestBar from './lib/components/RequestBar.svelte';
  import RequestEditorTabs from './lib/components/RequestEditorTabs.svelte';
  import ActivityRail from './lib/components/ActivityRail.svelte';
  import { agentSidebarMaxWidth, responseRightMinWidth } from './lib/stores/features/uiShell';
  import { rem, toLogicalPx, uiScale } from './lib/uiScale';
  import Sidebar from './lib/components/Sidebar.svelte';
  import StatusBar from './lib/components/StatusBar.svelte';
  import WorkspaceChrome from './lib/components/WorkspaceChrome.svelte';
  import WorkspaceOverview from './lib/components/WorkspaceOverview.svelte';
  import WelcomeWorkspace from './lib/components/WelcomeWorkspace.svelte';
  import { WELCOME_SEEN_KEY, shouldShowWelcome } from './lib/welcome';
  import GlobalsWorkspace from './lib/components/GlobalsWorkspace.svelte';
  import HistoryDetail from './lib/components/HistoryDetail.svelte';
  import AgentWorkspace from './lib/components/AgentWorkspace.svelte';
  import { METHODS, REQUEST_TYPES, DEFAULT_WORKSPACE, RAW_BODY_TYPES } from './lib/constants';
  import { installQuitShortcut, installTitlebarDoubleClickHandler } from './lib/windowControls';
  import { requestSectionPreference, saveRequestSectionPreference } from './lib/requestTabPreferences';
  import { methodColor, requestTabLabel, requestTransportLabel, activeCount, statusClass, formatSize, scriptLineCount, requestSupportsCurl, numberDuplicateTabLabels, numberedTabLabel } from './lib/utils';
  import { requestTypeSupportsAssertions } from './lib/assertions';
  import type { SnippetLanguage } from './lib/stores/ui';
  import type { ResponseTab, SavedRequest } from './lib/types/models';
  import type { LoadTest } from './lib/wire';
  import { KURLO_DOCS_URL, openExternalURL } from './lib/externalLinks';
  import { shouldVirtualizeResponseBody, type ResponseRenderMode } from './lib/response-render';
  import { tallyCollectionRun } from './lib/collectionRuns';
  import { announceShellResize } from './lib/shellResize';
  import { shellLayout } from './lib/shellLayout.svelte';

  $effect(() => {
    if (!vm.requestStoreLoaded) return;
    const workspaceId = vm.activeWorkspaceId;
    const collections = vm.activeWorkspaceCollections().map(collection => collection.name);
    const environments = vm.activeWorkspaceEnvironments.map(environment => environment.name);
    const activeEnvironment = vm.activeEnvironment?.name ?? '';
    untrack(() => {
      syncAgentWorkspace(workspaceId, collections, environments, activeEnvironment);
    });
  });

  $effect(() => {
    if (!vm.requestStoreLoaded) return;
    const target = vm.environmentScopeTarget;
    untrack(() => {
      void vm.enterEnvironmentScope(target);
    });
  });

  let docsTarget = $state.raw<{ id: string; workspace: string; epoch: number; linkScopes: string[] | null } | null>(null);
  const docsCollection = $derived(docsTarget && docsTarget.workspace === vm.activeWorkspaceId && docsTarget.epoch === vm.requestStorePersistEpoch
    ? vm.collections.find(collection => collection.id === docsTarget?.id && collection.workspaceId === vm.activeWorkspaceId)
    : undefined);

  function reserveEditorSendShortcut(event: KeyboardEvent) {
    if (event.target instanceof Element && event.target.closest('.cm-content') && vm.shortcutForEvent(event) === 'send-request') {
      event.preventDefault();
    }
  }

  async function openDocs(id: string) {
    vm.closeFloatingMenus();
    const target = { id, workspace: vm.activeWorkspaceId, epoch: vm.requestStorePersistEpoch, linkScopes: null };
    docsTarget = target;
    try {
      await vm.ensureCollectionExamples(id);
      if (docsTarget !== target || !docsCollection) return;
      const requests = vm.requestsForStore(vm.requests).filter(request => request.collectionId === id && !request.isDraft);
      const notes: Record<string, string[]> = Object.create(null);
      for (const request of requests) {
        const sources = [request.requestNotes, ...(request.examples ?? []).map(example => example.notes ?? '')].filter(Boolean);
        if (sources.length) notes[request.id] = sources;
      }
      if (docsCollection.description) notes[''] = [docsCollection.description];
      const linkScopes = Object.keys(notes).length ? await docsRelativeLinkScopes(notes) : [];
      if (docsTarget === target) docsTarget = { ...target, linkScopes };
    } catch (error) {
      if (docsTarget !== target || !docsCollection) return;
      docsTarget = null;
      await vm.openAlertDialog('Could not prepare collection documentation', String(error));
    }
  }

  const AUTO_UPDATE_INSTALL_KEY = 'kurlo:auto-update-install';
  const UPDATE_READY_KEY = 'kurlo:update-ready';
  const LAST_SEEN_VERSION_KEY = 'kurlo:last-seen-version';
  const AGENT_SEEN_KEY = 'kurlo:agent-seen';

  let whatsNewSection = $state<ChangelogSection | null>(null);
  let whatsNewSpotlight = $state(false);
  let agentSeen = $state(readAgentSeen());
  let welcomeOpen = $state(false);
  let welcomeWorkspaceId = $state('');

  function showWelcome() {
    dismissWhatsNew();
    vm.topView = 'overview';
    welcomeWorkspaceId = vm.activeWorkspaceId;
    welcomeOpen = true;
    writeStoredValue(WELCOME_SEEN_KEY, '1');
  }

  function dismissWelcome() {
    welcomeOpen = false;
  }

  async function welcomeNewRequest(example = false) {
    const reusableDraft = vm.activeRequest?.isDraft && !vm.draftWasEdited(vm.activeRequest);
    if (reusableDraft) {
      if (example) vm.url = 'https://httpbin.org/get';
      vm.topView = 'request';
      dismissWelcome();
      return;
    }
    const previousId = vm.activeRequestId;
    await vm.createDraftRequest('http');
    if (vm.activeRequestId === previousId) return;
    if (example) vm.url = 'https://httpbin.org/get';
    dismissWelcome();
  }

  async function welcomeImport() {
    const collections = vm.collections;
    await vm.openPostmanImport();
    if (vm.collections !== collections) dismissWelcome();
  }

  async function welcomeOpenWorkspace() {
    const workspace = vm.activeWorkspace;
    await vm.openGitWorkspace();
    if (vm.gitError) {
      dismissWelcome();
      vm.openGitTab(false);
    } else if (vm.activeWorkspace !== workspace) {
      dismissWelcome();
    }
  }

  $effect(() => {
    if (vm.topView !== 'overview' || vm.activeWorkspaceId !== welcomeWorkspaceId) welcomeOpen = false;
  });

  function readAgentSeen() {
    try {
      return localStorage.getItem(AGENT_SEEN_KEY) === '1';
    } catch {
      return true;
    }
  }

  function readStoredFlag(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStoredValue(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
  }

  $effect(() => {
    if (vm.topView !== 'agent' || agentSeen) return;
    agentSeen = true;
    try {
      localStorage.setItem(AGENT_SEEN_KEY, '1');
    } catch {  }
  });

  const LAZY_WARM_DELAY_MS = 2500;

  async function loadChangelog(): Promise<string> {
    return (await import('virtual:kurlo-changelog')).default;
  }

  async function checkWhatsNew(version: string) {
    let lastSeen: string | null;
    try {
      lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY);
    } catch {
      return;
    }
    const spotlight = shouldSpotlightAgentMode(version, lastSeen);
    if (spotlight || shouldShowWhatsNew(version, lastSeen, hasReleaseNotes)) {
      const notes = hasReleaseNotes ? releaseNotesFor(await loadChangelog(), version) : null;
      const section = notes ?? (spotlight ? { version: normalizeVersion(version), date: '', body: '' } : null);
      if (!section) return;
      whatsNewSpotlight = spotlight;
      whatsNewSection = section;
    }
    if (isReleaseVersion(version)) {
      try {
        localStorage.setItem(LAST_SEEN_VERSION_KEY, version);
      } catch {  }
    }
  }

  function dismissWhatsNew() {
    whatsNewSection = null;
    whatsNewSpotlight = false;
  }

  function tryAgentMode() {
    dismissWhatsNew();
    vm.openAgentTab();
  }

  async function showWhatsNew() {
    const markdown = await loadChangelog();
    whatsNewSpotlight = false;
    whatsNewSection = releaseNotesFor(markdown, vm.appVersion) ?? latestReleaseNotes(markdown);
  }

  const whatsNewAvailable = hasReleaseNotes;

  const loadTestTab = $derived.by(() => {
    const active = vm.activeLoadTest();
    if (!active) return null;
    const edits = vm.loadTestEdits?.collectionId === active.collection.id && vm.loadTestEdits.test.id === active.loadTest.id ? vm.loadTestEdits : null;
    const title = (edits?.test.name ?? active.loadTest.name).trim() || 'New load test';
    const unsaved = active.isDraft ? 'Unsaved draft' : edits?.dirty && !vm.autosave ? 'Unsaved changes' : '';
    return { title, unsaved };
  });


  let updateInfo = $state<UpdateInfo | null>(null);
  let updateReady = $state(false);
  let autoUpdateInstall = $state(readStoredFlag(AUTO_UPDATE_INSTALL_KEY) === 'true');
  let autoUpdateInstalling = $state(false);
  let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let focusedBeforeWindowBlur: HTMLElement | null = null;
  let codePanelAvailable = $derived(vm.codePanelAvailable);
  let untitledTabNumbers = new Map<string, number>();
  let requestTabNumbers = $derived.by(() => {
    untitledTabNumbers = numberDuplicateTabLabels(untitledTabNumbers, vm.openRequestsForTabs.map(req => ({ id: req.id, label: requestTabLabel(req) })));
    return untitledTabNumbers;
  });
  const numberedRequestTabLabel = (req: SavedRequest) => numberedTabLabel(requestTabLabel(req), requestTabNumbers.get(req.id));
  let requestBarName = $derived(vm.requestNameAuto ? numberedTabLabel(vm.requestHeaderName(), requestTabNumbers.get(vm.activeRequestId)) : vm.requestHeaderName());
  let windowWidth = $state(window.innerWidth);
  let runtimePlatform = $state(document.documentElement.dataset.platform ?? 'browser');
  let agentDetailsDocked = $derived(vm.topView === 'agent' && agentNavigation.detailsOpen && !agentNavigation.activity && !vm.sidebarHidden);
  let slideSidebarWidth = $derived(vm.topView === 'agent' && agentNavigation.detailsOpen && !agentNavigation.activity ? Math.min(vm.sidebarWidth, agentSidebarMaxWidth(toLogicalPx(windowWidth))) : vm.sidebarWidth);
  let shownSidebarWidth = $derived(vm.sidebarHidden ? 0 : slideSidebarWidth);
  let switcherInSidebar = $state(!vm.sidebarHidden);
  let shellLayoutKey = '';
  $effect.pre(() => {
    const next = `${vm.sidebarHidden}:${vm.codePanelOpen && codePanelAvailable}`;
    if (shellLayoutKey && next !== shellLayoutKey) untrack(announceShellResize);
    shellLayoutKey = next;
  });
  $effect.pre(() => {
    shellLayout.sidebarWidth = shownSidebarWidth;
  });
  $effect(() => {
    const hidden = vm.sidebarHidden;
    if (!hidden) {
      switcherInSidebar = true;
      return;
    }
    const shell = document.querySelector<HTMLElement>('.shell');
    const sliding = shell ? parseFloat(getComputedStyle(shell).transitionDuration) > 0 : false;
    if (!sliding) {
      switcherInSidebar = false;
      return;
    }
    const finish = () => {
      if (vm.sidebarHidden) switcherInSidebar = false;
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === shell && event.propertyName === 'grid-template-columns') finish();
    };
    shell!.addEventListener('transitionend', onEnd);
    const timer = window.setTimeout(finish, 400);
    return () => {
      shell!.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
    };
  });
  $effect(() => {
    if (agentDetailsDocked && vm.sidebarWidth > shownSidebarWidth) vm.sidebarWidth = shownSidebarWidth;
  });
  let sseSessionVisible = $derived(vm.sseSessionIsVisible());
  let requestSplitWidth = $state(0);
  let activeRequestLocation = $derived.by(() => {
    const request = vm.activeRequest;
    if (!request || request.isDraft) return '';
    const collection = vm.collections.find(candidate => candidate.id === request.collectionId);
    return [collection?.name ?? '', ...(request.folderPath ?? [])].filter(Boolean).join(' / ');
  });
  let activeCollectionLastRun = $derived.by(() => {
    const record = vm.activeCollectionSettings ? vm.collectionLastRuns[vm.activeCollectionSettings.id] : undefined;
    return record ? { ...tallyCollectionRun(record), finishedAt: record.finishedAt } : null;
  });
  let historyDetailBody = $derived(vm.historyDetailResponse ? vm.formatResponseBody(vm.historyDetailResponse) : '');
  let historyDetailMode = $derived<ResponseRenderMode>(vm.responseRenderModeFor(vm.historyDetailResponse));
  let historyDetailVirtualized = $derived(historyDetailBody ? shouldVirtualizeResponseBody(historyDetailBody, historyDetailMode) : false);
  let responseOnRight = $derived(vm.responseLayout === 'right' && requestSplitWidth / $uiScale >= responseRightMinWidth(vm.responseLayoutChosen));
  let responseRightTooNarrow = $derived(!responseOnRight && requestSplitWidth > 0 && requestSplitWidth / $uiScale < responseRightMinWidth(true));

  function setRuntimePlatform(runtime: string) {
    const platform = runtime.split('/')[0] || 'browser';
    document.documentElement.dataset.platform = platform;
    runtimePlatform = platform;
    document.documentElement.dataset.runtime = runtime;
  }

  let textMenu = $state<TextMenuState | null>(null);

  function preventNativeContextMenu(event: MouseEvent) {
    event.preventDefault();
    const target = textTargetFrom(event.target);
    textMenu = target ? { x: event.clientX, y: event.clientY, target } : null;
  }

  function setAutoUpdateInstall(value: boolean) {
    autoUpdateInstall = value;
    writeStoredValue(AUTO_UPDATE_INSTALL_KEY, value ? 'true' : 'false');
  }

  function markUpdateReady(info: UpdateInfo) {
    updateInfo = info;
    updateReady = true;
  }

  function syncUpdateReadyForVersion(version: string): boolean {
    const pendingReadyVersion = readStoredFlag(UPDATE_READY_KEY);
    if (!pendingReadyVersion) {
      updateReady = false;
      return false;
    }
    if (pendingReadyVersion === version) {
      writeStoredValue(UPDATE_READY_KEY, null);
      updateReady = false;
      return false;
    }
    if (!isPendingVersionNewer(pendingReadyVersion, version)) {
      writeStoredValue(UPDATE_READY_KEY, null);
      updateReady = false;
      return false;
    }
    updateReady = true;
    return true;
  }

  function isPendingVersionNewer(pending: string, current: string): boolean {
    if (!pending || !current || pending === current) return false;
    const norm = (v: string) => v.replace(/^v/, '').split('-')[0]?.split('.').map(n => parseInt(n, 10) || 0) ?? [];
    const p = norm(pending);
    const c = norm(current);
    const len = Math.max(p.length, c.length);
    for (let i = 0; i < len; i++) {
      const pv = p[i] ?? 0;
      const cv = c[i] ?? 0;
      if (pv > cv) return true;
      if (pv < cv) return false;
    }
    return false;
  }

  async function installUpdateAutomatically(info: UpdateInfo): Promise<boolean> {
    if (info.manualInstallUrl || !autoUpdateInstall || autoUpdateInstalling || readStoredFlag(UPDATE_READY_KEY)) return false;
    autoUpdateInstalling = true;
    try {
      const err = await applyUpdate(info);
      if (err) {
        console.warn('Auto-update install failed:', err);
        return false;
      }
      writeStoredValue(UPDATE_READY_KEY, info.version);
      updateReady = true;
      return true;
    } catch (err) {
      console.warn('Auto-update install failed:', err);
      return false;
    } finally {
      autoUpdateInstalling = false;
    }
  }

  function downloadPackagedUpdate(info: UpdateInfo) {
    openExternalURL(info.manualInstallUrl);
  }

  function restartForInstalledUpdate() {
    writeStoredValue(UPDATE_READY_KEY, null);
    void restartApp();
  }

  $effect(() => {
    void vm.topView;
    untrack(() => vm.syncAgentSidebar());
  });

  $effect(() => {
    if (vm.sidebarView === 'agent' && untrack(() => vm.topView) !== 'agent') untrack(() => vm.syncAgentSidebar());
  });

  $effect(() => {
    vm.requestEditSignal();
    untrack(() => vm.scheduleActiveRequestPersist());
  });

  $effect(() => {
    const id = vm.previewRequestId;
    if (id && vm.requestStoreLoaded && (!vm.openRequestIds.includes(id) || vm.requestTabNeedsKeeping(id))) {
      untrack(() => vm.keepRequestTab(id));
    }
  });

  $effect(() => {
    vm.clampResponseSearchIndex();
  });

  $effect(() => {
    if (vm.mockServer.running) vm.mockServerLiveSignature();
    untrack(() => vm.scheduleMockServerReload());
  });

  $effect(() => {
    vm.response;
    vm.responseSearch;
    vm.responseBodyPage;
    vm.responseBodyIsPaged;
    vm.responseFilterOpen;
    vm.responseFilter;
    untrack(() => vm.scheduleResponseSearchCount());
  });

  $effect(() => { if (vm.perfDockOpen) void lazy.loadPerformanceDock(); });

  $effect(() => {
    lazy.preloadForAppShell({
      requestTab: requestSection,
      requestType: vm.requestType,
      method: vm.method,
      topView: vm.topView,
      codePanelOpen: vm.codePanelOpen,
      codePanelAvailable,
      globalSearchOpen: vm.globalSearchOpen,
      settingsOpen: vm.settingsOpen,
      sseSessionVisible,
    });
  });

  $effect(() => {
    if (vm.workspaceBlocked && vm.topView !== 'overview' && vm.topView !== 'git') vm.topView = 'overview';
  });

  $effect(() => {
    vm.requestStoreLoaded;
    vm.topView;
    vm.activeCollectionSettingsId;
    vm.activeFolderSettingsPath;
    vm.collectionRunnerOpen;
    vm.collectionRunnerCollectionId;
    vm.gitWorkspaceOpen;
    vm.sidebarView;
    untrack(() => vm.saveTopViewState());
  });

  const requestSection = $derived(vm.requestFiles.active ? 'file' : vm.requestTab);
  const fileDraft = $derived(vm.activeRequest?.isDraft ? undefined : vm.requestFiles.active);
  const barType = $derived(fileDraft?.barType ?? vm.requestType);
  const barMethod = $derived(fileDraft?.barValue('method', vm.method,
    ['ai', 'grpc', 'graphql', 'mcp'].includes(barType) ? 'POST' : 'GET') ?? vm.method);
  const barUrl = $derived(fileDraft?.barValue('url', vm.url) ?? vm.url);

  function setBarUrl(value: string) {
    if (fileDraft) fileDraft.editBar({ url: value });
    else vm.url = value;
  }

  function setBarMethod(value: string) {
    if (fileDraft) fileDraft.editBar({ method: value });
    else vm.method = value as typeof vm.method;
  }

  function changeBarProtocol(type: typeof vm.requestType, method?: string) {
    if (fileDraft) fileDraft.changeProtocol(type, method);
    else {
      vm.selectRequestType(type);
      if (method) setBarMethod(method);
    }
  }

  function setBarName(value: string) {
    if (fileDraft) fileDraft.editBar(fileDraft.currentBarValues()?.nameAuto === 'true' ? { name: value, nameAuto: false } : { name: value });
    else vm.setRequestHeaderName(value);
  }

  let previousRequestSectionKey = '';
  let previousFormRequestTab: typeof vm.requestTab | undefined;
  $effect(() => {
    const id = vm.activeRequestId;
    const root = vm.requestFiles.root;
    const section = vm.requestTab;
    const request = vm.requestsById.get(id);
    const workspaceId = vm.collections.find(collection => collection.id === request?.collectionId)?.workspaceId ?? vm.activeWorkspaceId;
    const key = id && root ? JSON.stringify([root, workspaceId, id]) : '';
    if (!vm.requestStoreLoaded || !key) {
      previousRequestSectionKey = '';
      previousFormRequestTab = undefined;
      return;
    }
    if (key !== previousRequestSectionKey) {
      previousRequestSectionKey = key;
      previousFormRequestTab = section;
      if (requestSectionPreference(root, workspaceId, id) === 'file' && !vm.requestFiles.active) {
        untrack(() => void vm.requestFiles.select('file'));
      }
      return;
    }
    if (!vm.requestFiles.active && previousFormRequestTab !== undefined && previousFormRequestTab !== section) {
      saveRequestSectionPreference(root, workspaceId, id, section);
    }
    previousFormRequestTab = section;
  });

  function selectRequestSection(section: import('./lib/stores/requestFiles.svelte').RequestSection) {
    void vm.requestFiles.select(section);
  }

  $effect(() => {
    if (vm.externalWorkspaceChangePending && !vm.requestFiles.dirtyIds.length) {
      untrack(() => void vm.refreshPendingExternalWorkspaceChangeIfClean());
    }
  });

  function hideBootScreen() {
    const boot = document.getElementById('boot-screen');
    if (!boot) return;
    boot.classList.add('boot-hidden');
    setTimeout(() => boot.remove(), 360);
  }

  onMount(() => {
    const uninstallTitlebarDoubleClick = installTitlebarDoubleClickHandler();
    const uninstallFileDrop = installFileDrop(window.runtime, vm.importDroppedFiles);
    vm.startOpenApiScheduler();
    let uninstallQuitShortcut = () => {};
    const offBeforeQuit = window.runtime?.EventsOn?.('kurlo:before-quit', () => {
      void ackQuit();
      void vm.reviewDraftsBeforeQuit();
    });
    const offDevicePrompt = window.runtime?.EventsOn?.<OAuth2DevicePrompt>('oauth2:device-prompt', prompt => {
      vm.oauth2DevicePrompt = prompt;
    });
    const offMockRequest = window.runtime?.EventsOn?.<MockRequestLog>('mock:request', entry => {
      vm.recordMockRequest(entry);
    });
    const offZoom = window.runtime?.EventsOn?.<string>('kurlo:zoom', action => {
      if (action === 'in') vm.zoomIn();
      else if (action === 'out') vm.zoomOut();
      else if (action === 'reset') vm.resetZoom();
    });
    vm.initCookieSyncListeners();
    vm.initLoadRunListeners();
    const disposePerformance = vm.initPerformanceListeners();
    void vm.refreshMockServerStatus();
    const warmLazyTimer = setTimeout(() => {
      void lazy.loadSettingsModal();
      void lazy.loadGlobalSearchModal();
    }, LAZY_WARM_DELAY_MS);
    const warmEditor = () => {
      void lazy.warmEditor();
      void lazy.warmRequestTabs();
    };
    const warmEditorIdle = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(warmEditor, { timeout: 1500 })
      : undefined;
    const warmEditorTimer = warmEditorIdle === undefined ? setTimeout(warmEditor, 800) : undefined;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      vm.flushPendingPersist();
      if (!vm.hasUnsavedDrafts() && !vm.hasUnsavedRequestChanges()) return;
      event.preventDefault();
    };
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') vm.flushPendingPersist();
    };
    const flushOnPageHide = () => vm.flushPendingPersist();
    const rememberFocusedElement = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement
        && event.target !== document.body
        && event.target !== document.documentElement
      ) {
        focusedBeforeWindowBlur = event.target;
      }
    };
    const rememberWindowFocus = () => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement
        && active !== document.body
        && active !== document.documentElement
      ) {
        focusedBeforeWindowBlur = active;
      }
    };
    const restoreWindowFocus = () => {
      const active = document.activeElement;
      if (
        focusedBeforeWindowBlur?.isConnected
        && (active === document.body || active === document.documentElement || active === null)
      ) {
        focusedBeforeWindowBlur.focus({ preventScroll: true });
      }
      if (vm.topView === 'git') void vm.refreshGitQuietly();
    };
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onThemeChange = () => {
      if (vm.appTheme.mode === 'system') vm.applyTheme();
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pagehide', flushOnPageHide);
    window.addEventListener('blur', rememberWindowFocus);
    window.addEventListener('focus', restoreWindowFocus);
    document.addEventListener('focusin', rememberFocusedElement);
    document.addEventListener('visibilitychange', flushOnHide);
    media.addEventListener('change', onThemeChange);

    void (async () => {
      vm.loadTheme();
      vm.loadRequestSettings();
      vm.loadShortcutSettings();
      vm.loadAutosaveSettings();
      vm.loadStartupViewPreference();
      vm.loadRequestTabPreferences();
      vm.loadProxyConfig();
      void vm.loadDefaultWorkspaceLocation();
      vm.initSSEListeners();
      vm.initAiListeners();
      vm.initGrpcListeners();
      vm.initWebSocketListeners();
      vm.initSocketIOListeners();
      vm.initWorkspaceListeners();
      try {
        await vm.loadRequestWorkspace();
        const forceWelcome = new URLSearchParams(window.location.search).get('welcome') === '1';
        if (forceWelcome || shouldShowWelcome({
          seen: readStoredFlag(WELCOME_SEEN_KEY) === '1',
          lastSeenVersion: readStoredFlag(LAST_SEEN_VERSION_KEY),
          requestCount: vm.requests.filter(request => !request.isDraft || vm.draftWasEdited(request)).length,
          historyCount: vm.requestHistory.length,
          environmentCount: vm.environments.length,
          collectionCount: vm.collections.length,
          workspaceCount: vm.workspaces.length,
          blocked: vm.workspaceBlocked,
        })) showWelcome();
        else writeStoredValue(WELCOME_SEEN_KEY, '1');
      } finally {
        hideBootScreen();
      }
      const welcomedOnStartup = welcomeOpen;
      void vm.loadCookieSyncStatus();
      const info = await getAppInfo();
      vm.appRuntime = info.runtime;
      vm.appVersion = info.version;
      setRuntimePlatform(info.runtime);
      if (!destroyed) uninstallQuitShortcut = installQuitShortcut(document.documentElement.dataset.platform ?? '');
      const updatePendingRestart = syncUpdateReadyForVersion(info.version);
      if (welcomedOnStartup) {
        if (isReleaseVersion(info.version)) writeStoredValue(LAST_SEEN_VERSION_KEY, info.version);
      } else {
        void checkWhatsNew(info.version);
      }

      if (info.version && info.version !== 'dev' && !updatePendingRestart) {
        updateCheckTimer = setTimeout(async () => {
          updateCheckTimer = null;
          if (destroyed) return;
          const result = await checkForUpdate();
          if (destroyed) return;
          if (result.info) {
            updateInfo = result.info;
            updateReady = await installUpdateAutomatically(result.info);
          } else {
            updateInfo = null;
            updateReady = false;
          }
        }, 4000);
      }
    })();

    return () => {
      destroyed = true;
      disposePerformance();
      clearTimeout(warmLazyTimer);
      if (warmEditorIdle !== undefined) window.cancelIdleCallback?.(warmEditorIdle);
      if (warmEditorTimer !== undefined) clearTimeout(warmEditorTimer);
      if (updateCheckTimer !== null) {
        clearTimeout(updateCheckTimer);
        updateCheckTimer = null;
      }
      uninstallTitlebarDoubleClick();
      uninstallFileDrop();
      uninstallQuitShortcut();
      vm.stopOpenApiScheduler();
      offBeforeQuit?.();
      offMockRequest?.();
      offZoom?.();
      offDevicePrompt?.();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('pagehide', flushOnPageHide);
      window.removeEventListener('blur', rememberWindowFocus);
      window.removeEventListener('focus', restoreWindowFocus);
      document.removeEventListener('focusin', rememberFocusedElement);
      document.removeEventListener('visibilitychange', flushOnHide);
      media.removeEventListener('change', onThemeChange);
    };
  });
</script>

<svelte:window
  bind:innerWidth={windowWidth}
  on:keydown={vm.onKeydown}
  on:contextmenu={preventNativeContextMenu}
  on:mousedown={vm.onWindowMouseDown}
  on:click={vm.onWindowMouseDown}
  on:mousemove={vm.onWindowMouseMove}
  on:mouseup={vm.onWindowMouseUp}
/>

{#if updateInfo}
  <UpdateBanner
    info={updateInfo}
    ready={updateReady}
    installing={autoUpdateInstalling}
    onDismiss={() => (updateInfo = null)}
    onOpen={() => { vm.openSettings('about'); }}
    onDownload={downloadPackagedUpdate}
    onRestart={restartForInstalledUpdate}
  />
{/if}

<AppToasts />
{#if docsCollection}
  <CollectionDocsModal collection={docsCollection} linkScopes={docsTarget?.linkScopes ?? null}
    requests={vm.requests.filter(request => request.collectionId === docsCollection?.id && !request.isDraft)}
    onClose={() => docsTarget = null}
    onGenerate={(ids, linkBaseUrl) => {
      const collection = docsCollection;
      docsTarget = null;
      if (collection) void vm.buildCollectionDocs(collection.id, ids, linkBaseUrl);
    }} />
{/if}

<AppOverlays
  startupUpdateInfo={updateInfo}
  startupUpdateReady={updateReady}
  {autoUpdateInstall}
  {autoUpdateInstalling}
  {setAutoUpdateInstall}
  appRuntime={vm.appRuntime}
  onUpdateInstalled={markUpdateReady}
  {whatsNewAvailable}
  onShowWhatsNew={showWhatsNew}
  onShowWelcome={showWelcome}
/>

{#if whatsNewSection}
  <WhatsNewModal section={whatsNewSection} onDismiss={dismissWhatsNew} spotlight={whatsNewSpotlight} onTryAgent={tryAgentMode} />
{/if}

<main
  class="shell"
  class:resizing-sidebar={vm.sidebarResizing}
  class:resizing-col={vm.colResizing !== null || vm.splitResizing}
  class:resizing-row={vm.panelResizing}
  class:resizing-code={vm.codePanelResizing}
  class:code-open={vm.codePanelOpen && codePanelAvailable}
  class:sidebar-hidden={vm.sidebarHidden}
  class:sidebar-gone={!switcherInSidebar}
  style="--sidebar-w: {rem(shownSidebarWidth)}; --sidebar-slide-w: {rem(slideSidebarWidth)}; --code-requested-w: {rem(vm.codePanelWidth)}"
>
  <input
    class="hidden-file-input"
    bind:this={vm._postmanImportInput}
    type="file"
    accept=".json,.yaml,.yml,.bru,.http,.rest,.har,application/json,application/yaml,text/yaml,text/x-yaml"
    onchange={vm.onPostmanImportFile}
  />

  <ActivityRail
    bind:sidebarView={vm.sidebarView}
    bind:sidebarHidden={vm.sidebarHidden}
    topView={vm.topView}
    mockRunning={vm.mockServer.running}
    cookieCount={vm.cookies.length}
    workspaceBlocked={vm.workspaceBlocked}
    openCollectionRunner={vm.openCollectionRunner}
    openMockTab={vm.openMockServerTab}
    openCookieJar={vm.openCookieJar}
    openSettings={vm.openSettings}
    openAgent={() => vm.openAgentTab()}
    agentNew={!agentSeen}
  />

  <Sidebar
    gone={!switcherInSidebar}
    bind:sidebarView={vm.sidebarView}
    bind:sidebarSearch={vm.sidebarSearch}
    bind:sidebarSearchInput={vm._sidebarSearchInput}
    requestSortMode={vm.requestSortMode}
    setRequestSortMode={vm.setRequestSortMode}
    topView={vm.topView}
    activeRequestId={vm.activeRequestId}
    activeEnvironmentId={vm.activeEnvironmentId}
    collectionGroups={vm.collectionGroups}
    historyGroups={vm.historyGroups}
    pinnedRequests={vm.pinnedRequests}
    starredRequestIds={vm.starredRequestIds}
    activeWorkspaceEnvironments={vm.activeWorkspaceEnvironments}
    openCollectionMenuId={vm.openCollectionMenuId}
    openRequestMenuId={vm.openRequestMenuId}
    historyHeaderMenuOpen={vm.historyHeaderMenuOpen}
    openHistoryMenuId={vm.openHistoryMenuId}
    openPostmanImport={vm.openPostmanImport}
    createCollection={vm.createCollection}
    toggleCollectionCollapsed={vm.toggleCollectionCollapsed}
    toggleCollectionMenu={vm.toggleCollectionMenu}
    createNewRequest={vm.createNewRequest}
    renameCollection={vm.renameCollection}
    openCollectionSettings={vm.openCollectionSettings}
    openOpenApiSettings={vm.openOpenApiSettings}
    openApiUpdates={(id: string) => vm.openApiHasUpdates(id) ? vm.openApiStatus(id).summary : ''}
    openFolderSettings={vm.openFolderSettings}
    buildCollectionDocs={openDocs}
    exportCollection={vm.exportCollection}
    deleteCollection={vm.deleteCollection}
    moveCollection={vm.moveCollection}
    moveRequests={vm.moveRequests}
    requestSelection={vm.requestSelection}
    setRequestSelection={(selection: RequestSelection) => (vm.requestSelection = selection)}
    deleteRequests={(ids: string[]) => void vm.deleteRequests(ids)}
    duplicateRequests={(ids: string[]) => void vm.duplicateRequests(ids)}
    setRequestsStarred={(ids: string[], starred: boolean) => void vm.setRequestsStarred(ids, starred)}
    switchRequest={vm.switchRequest}
    {requestTabLabel}
    toggleRequestMenu={vm.toggleRequestMenu}
    renameRequest={vm.renameRequest}
    duplicateRequest={vm.duplicateRequest}
    copyRequestCurl={vm.copyRequestCurl}
    revealInFileManager={vm.revealInFileManager}
    activeLoadTestKey={loadRunKey(vm.activeLoadTestCollectionId, vm.activeLoadTestId)}
    openLoadTestMenuId={vm.openLoadTestMenuId}
    createLoadTest={(collectionId: string, requestIds?: string[]) => void vm.createLoadTest(collectionId, requestIds)}
    createLoadTestFromRequest={(requestId: string) => void vm.createLoadTestFromRequest(requestId)}
    openLoadTest={(collectionId: string, loadTestId: string) => void vm.openLoadTest(collectionId, loadTestId)}
    toggleLoadTestMenu={vm.toggleLoadTestMenu}
    renameLoadTest={vm.renameLoadTest}
    duplicateLoadTest={(collectionId: string, loadTestId: string) => void vm.duplicateLoadTest(collectionId, loadTestId)}
    deleteLoadTest={(collectionId: string, loadTestId: string) => void vm.deleteLoadTest(collectionId, loadTestId)}
    runningLoadTestKey={vm.loadRun.running ? loadRunKey(vm.loadRun.collectionId, vm.loadRun.loadTestId) : ''}
    loadRunResults={vm.loadRunResults}
    runLoadTest={(collectionId: string, loadTestId: string) => void vm.runSavedLoadTest(collectionId, loadTestId)}
    exportLoadTest={(collectionId: string, loadTestId: string) => void vm.exportSavedLoadTest(collectionId, loadTestId)}
    loadLoadTestResult={(collectionId: string, loadTestId: string) => void vm.loadLastLoadRun(collectionId, loadTestId)}
    toggleRequestPinned={vm.toggleRequestPinned}
    deleteRequest={vm.deleteRequest}
    toggleFolderCollapsed={vm.toggleFolderCollapsed}
    openFolderMenuKey={vm.openFolderMenuKey}
    toggleFolderMenu={vm.toggleFolderMenu}
    createRequestInFolder={vm.createRequestInFolder}
    createSubfolder={vm.createSubfolder}
    renameFolder={vm.renameFolder}
    openFindReplace={vm.openFindReplace}
    deleteFolder={vm.deleteFolder}
    createFolderInCollection={vm.createFolderInCollection}
    runFolder={vm.runFolder}
    toggleHistoryHeaderMenu={vm.toggleHistoryHeaderMenu}
    clearRequestHistory={vm.clearRequestHistory}
    toggleHistoryDay={vm.toggleHistoryDay}
    openHistoryEntry={vm.openHistoryEntry}
    openHistoryDetail={vm.openHistoryDetail}
    activeHistoryId={vm.topView === 'history' ? vm.historyDetailId : ''}
    saveHistoryEntryAsExample={(id) => vm.saveHistoryEntryAsExample(id)}
    historyTitle={vm.historyTitle}
    {statusClass}
    toggleHistoryEntryMenu={vm.toggleHistoryEntryMenu}
    activeWorkspaceCollections={vm.activeWorkspaceCollections}
    saveHistoryEntryToCollection={vm.saveHistoryEntryToCollection}
    saveHistoryEntryToNewCollection={vm.saveHistoryEntryToNewCollection}
    deleteHistoryEntry={vm.deleteHistoryEntry}
    createEnvironment={vm.createEnvironment}
    openGlobals={vm.openGlobals}
    globalVariableCount={vm.globalVariableCount()}
    selectEnvironment={vm.selectEnvironment}
    openEnvironment={vm.openEnvironment}
    renameEnvironment={vm.renameEnvironment}
    environmentValueCount={vm.environmentValueCount}
    openWorkspaceDiagnostic={vm.openWorkspaceDiagnostic}
    workspaceBlocked={vm.workspaceBlocked}
  />

  <button
    class="sidebar-divider"
    type="button"
    onmousedown={vm.startSidebarResize}
    onkeydown={vm.onSidebarDividerKeydown}
    aria-label="Resize sidebar"
  ></button>

  <div class="workspace">
    <WorkspaceChrome
      bind:workspaceSearch={vm.workspaceSearch}
      bind:workspaceMenuOpen={vm.workspaceMenuOpen}
      bind:topView={vm.topView}
      bind:environmentMenuOpen={vm.environmentMenuOpen}
      bind:sidebarView={vm.sidebarView}
      switcherDocked={runtimePlatform === 'darwin' && switcherInSidebar}
      defaultWorkspace={DEFAULT_WORKSPACE}
      overviewLabel={welcomeOpen ? 'Welcome' : 'Overview'}
      activeWorkspace={vm.activeWorkspace}
      workspaces={vm.workspaces}
      activeWorkspaceId={vm.activeWorkspaceId}
      openRequests={vm.openRequestsForTabs}
      previewRequestId={vm.previewRequestId}
      keepRequestTab={vm.keepRequestTab}
      activeRequestId={vm.activeRequestId}
      activeWorkspaceEnvironments={vm.activeWorkspaceEnvironments}
      environmentMenu={vm.environmentMenu}
      environmentScopeName={vm.environmentScopeCollection?.name ?? ''}
      activeEnvironmentId={vm.activeEnvironmentId}
      dirtyRequestIds={[...(vm.autosave ? [] : vm.dirtyRequestIdList), ...vm.requestFiles.dirtyIds]}
      editedDraftIds={vm.editedDraftIds}
      collectionRunnerOpen={vm.collectionRunnerOpen}
      collectionRunnerRunning={vm.collectionRunnerRunning}
      activeCollectionSettings={vm.activeCollectionSettings}
      activeFolderSettingsPath={vm.activeFolderSettingsPath}
      historyDetailOpen={Boolean(vm.historyDetailEntry)}
      gitTabOpen={vm.gitWorkspaceOpen}
      agentTabOpen={vm.agentTabOpen}
      openAgentTab={() => vm.openAgentTab()}
      closeAgentTab={() => vm.closeAgentTab()}
      mockTabOpen={vm.mockServerTabOpen}
      loadTestTabTitle={loadTestTab ? loadTestTab.title : ''}
      loadTestTabUnsaved={loadTestTab ? loadTestTab.unsaved : ''}
      openLoadTestTab={() => (vm.topView = 'loadtest')}
      closeLoadTestTab={() => void vm.closeLoadTestTab()}
      mockRunning={vm.mockServer.running}
      gitChangeCount={kurloChangedFiles(vm.gitStatus).length}
      workspaceBlocked={vm.workspaceBlocked}
      toggleWorkspaceMenu={vm.toggleWorkspaceMenu}
      createWorkspace={vm.createWorkspace}
      switchWorkspace={vm.switchWorkspace}
      workspaceCollectionCountFor={vm.workspaceCollectionCountFor}
      workspaceRequestCountFor={vm.workspaceRequestCountFor}
      deleteWorkspace={vm.deleteWorkspace}
      closeCollectionRunner={vm.closeCollectionRunnerTab}
      closeCollectionSettings={vm.closeCollectionSettingsTab}
      closeHistoryDetail={vm.closeHistoryDetail}
      openGitTab={vm.openGitTab}
      closeGitTab={vm.closeGitTab}
      openMockTab={vm.openMockServerTab}
      closeMockTab={vm.closeMockServerTab}
      requestTabLabel={numberedRequestTabLabel}
      switchRequest={vm.switchRequest}
      closeRequestTab={vm.closeRequestTab}
      createDraftRequest={vm.createDraftRequest}
      toggleEnvironmentMenu={vm.toggleEnvironmentMenu}
      environmentLabel={vm.environmentLabel}
      useEnvironment={vm.useEnvironment}
      environmentHasValues={vm.environmentHasValues}
      environmentValueCount={vm.environmentValueCount}
    />

    {#if vm.topView === 'overview' && welcomeOpen}
      <WelcomeWorkspace
        shortcut={vm.shortcutCombo('new-request')}
        appRuntime={vm.appRuntime}
        workspaceBlocked={vm.workspaceBlocked}
        onNewRequest={() => void welcomeNewRequest()}
        onImport={() => void welcomeImport()}
        onOpenWorkspace={() => void welcomeOpenWorkspace()}
        onSetUpAgent={() => vm.openSettings('ai')}
        onExample={() => void welcomeNewRequest(true)}
        onDocumentation={() => openExternalURL(KURLO_DOCS_URL)}
        onDismiss={dismissWelcome}
      />
    {:else if vm.topView === 'overview'}
      <WorkspaceOverview
        activeWorkspace={vm.activeWorkspace}
        workspaceBlocked={vm.workspaceBlocked}
        blockingDiagnostics={vm.workspaceBlockingDiagnostics}
        editDiagnostic={vm.openWorkspaceYAMLEditor}
        showWorkspaceIssues={() => vm.openGitTab(false)}
        defaultWorkspace={DEFAULT_WORKSPACE}
        collectionGroups={vm.collectionGroups}
        history={vm.requestHistory}
        environmentCount={vm.activeWorkspaceEnvironments.length}
        storedInGit={vm.gitStatus.isRepo}
        shortcutCombo={(id) => vm.shortcutCombo(id)}
        appRuntime={vm.appRuntime}
        updateWorkspaceDescription={vm.updateWorkspaceDescription}
        autosave={vm.autosave}
        readmeDraft={vm.activeWorkspace ? vm.workspaceReadmeDrafts[vm.activeWorkspace.id] : undefined}
        saveReadme={vm.saveWorkspaceReadmes}
        discardReadme={vm.discardWorkspaceReadmes}
        setWorkspaceName={(name) => vm.setWorkspaceName(name)}
        createWorkspace={vm.createWorkspace}
        openSettings={vm.openSettings}
        createCollection={vm.createCollection}
        createNewRequest={vm.createNewRequest}
        createEnvironment={vm.createEnvironment}
        openImport={vm.openPostmanImport}
        openGlobalSearch={vm.openGlobalSearch}
        openCollectionRunner={() => vm.openCollectionRunner()}
        openCollection={(id) => vm.openCollectionSettings(id)}
        switchRequest={(id) => vm.switchRequest(id)}
        sendRequest={(id) => vm.openAndRunRequest(id)}
      />
    {:else if vm.topView === 'git'}
      {#if lazy.GitWorkspaceComponent}
      <lazy.GitWorkspaceComponent
        status={vm.gitStatus}
        branches={vm.gitBranches}
        diff={vm.gitDiff}
        conflict={vm.gitConflict}
        conflictContent={vm.gitConflictContent}
        commits={vm.gitLog}
        selectedCommit={vm.gitSelectedCommit}
        selectedPath={vm.gitSelectedPath}
        loading={vm.gitLoading}
        action={vm.gitAction}
        diffLoading={vm.gitDiffLoading}
        error={vm.gitError}
        output={vm.gitOutput}
        workspaceBlocked={vm.workspaceBlocked}
        workspaceDiagnostics={vm.workspaceDiagnostics}
        workspaceDiagnosticScopeLabel={vm.workspaceDiagnosticScopeLabel}
        onEditWorkspaceDiagnostic={vm.openWorkspaceYAMLEditor}
        workspaceDiagnosticKey={vm.workspaceDiagnosticKey}
        workspaceDiagnosticLocation={vm.workspaceDiagnosticLocation}
        onRefresh={vm.refreshGitStatus}
        onUseLocal={vm.useLocalWorkspace}
        onUseAppStorage={vm.useAppStorage}
        onCreateLocal={vm.createLocalFolderWorkspace}
        onOpen={vm.openGitWorkspace}
        onClone={vm.cloneGitWorkspace}
        onFetch={vm.fetchGitWorkspace}
        onPull={vm.pullGitWorkspace}
        onPullBranch={vm.pullGitBranch}
        onResolveConflict={vm.resolveGitConflict}
        onContinueOperation={vm.continueGitOperation}
        onAbortOperation={vm.abortGitOperation}
        onStash={vm.stashGitWorkspace}
        onPopStash={vm.popGitStash}
        onInit={vm.initGitWorkspace}
        onAddRemote={vm.addGitRemote}
        onTestRemote={vm.testGitRemote}
        onCheckoutBranch={vm.checkoutGitBranch}
        onCreateBranch={vm.createGitBranch}
        onCreateBranchFromRemote={vm.createGitBranchFromRemote}
        onDeleteBranch={vm.deleteGitBranch}
        onRenameBranch={vm.renameGitBranch}
        onCommit={vm.commitGitWorkspace}
        onViewOutgoing={vm.viewGitOutgoingChanges}
        onLoadMoreLog={vm.loadMoreGitLog}
        logLoadingMore={vm.gitLogLoadingMore}
        onSelectCommit={vm.selectGitCommit}
        onPush={vm.pushGitWorkspace}
        onForcePush={vm.forcePushGitWorkspace}
        onDiscardFile={vm.discardSelectedGitFile}
        onDiscardFiles={vm.discardSelectedGitFiles}
        onDiscardAll={vm.discardGitWorkspaceChanges}
        onSelectFile={vm.selectGitFile}
      />
      {/if}
    {:else if vm.topView === 'globals'}
      <GlobalsWorkspace
        rows={vm.globalVariables}
        autosave={vm.autosave}
        saveState={vm.globalsSaveState}
        updateRow={vm.updateGlobalVariableRow}
        removeRow={vm.removeGlobalVariableRow}
        clearAll={vm.clearGlobalVariables}
        save={vm.saveGlobals}
        discard={vm.discardGlobalsChanges}
      />

    {:else if vm.topView === 'cookies'}
      {#if lazy.CookieWorkspaceComponent}
        <lazy.CookieWorkspaceComponent />
      {/if}

    {:else if vm.topView === 'secrets'}
      {#if lazy.SecretProvidersWorkspaceComponent}
        <lazy.SecretProvidersWorkspaceComponent />
      {/if}

    {:else if vm.topView === 'environment'}
      {#if lazy.EnvironmentWorkspaceComponent}
      <lazy.EnvironmentWorkspaceComponent
        activeEnvironment={vm.activeEnvironment}
        activeEnvironmentId={vm.activeEnvironmentId}
        autosave={vm.autosave}
        environmentSaveState={vm.environmentSaveState}
        createEnvironment={vm.createEnvironment}
        renameEnvironment={vm.renameEnvironment}
        setEnvironmentProtected={vm.setEnvironmentProtected}
        setEnvironmentSandbox={vm.setEnvironmentSandbox}
        setEnvironmentSecretSources={vm.setEnvironmentSecretSources}
        setEnvironmentColor={vm.setEnvironmentColor}
        setEnvironmentParent={vm.setEnvironmentParent}
        deleteEnvironment={vm.deleteEnvironment}
        saveEnvironment={vm.saveEnvironment}
        discardEnvironment={vm.discardEnvironmentChanges}
        updateEnvironmentRow={vm.updateEnvironmentRow}
        removeEnvironmentRow={vm.removeEnvironmentRow}
        importEnvFromFile={vm.importEnvFromFile}
        exportEnvironment={vm.exportEnvironmentToPostman}
        environments={vm.activeWorkspaceEnvironments}
        environmentView={vm.environmentView}
        setEnvironmentView={vm.setEnvironmentView}
        openEnvironment={vm.openEnvironment}
        setMatrixValue={vm.setEnvironmentMatrixValue}
        unsetMatrixValue={vm.unsetEnvironmentMatrixValue}
        setVariableSecret={vm.setEnvironmentVariableSecret}
        renameVariable={vm.renameEnvironmentVariable}
        addVariable={vm.addEnvironmentVariable}
        removeVariable={vm.removeEnvironmentVariable}
      />
      {/if}
    {:else if vm.topView === 'collection'}
      {#if lazy.CollectionWorkspaceComponent}
      <lazy.CollectionWorkspaceComponent
        bind:this={vm._collectionWorkspaceRef}
        collection={vm.activeCollectionSettings}
        environments={vm.activeWorkspaceEnvironments}
        requestCount={vm.activeCollectionSettings ? vm.collectionRequestCount(vm.activeCollectionSettings.id) : 0}
        lastRun={activeCollectionLastRun}
        onOpenRunner={vm.openCollectionRunner}
        bind:collectionSettingsTab={vm.collectionSettingsTab}
        autosave={vm.autosave}
        autosaveDelayMs={vm.autosaveDelayMs}
        saveState={vm.collectionSettingsSaveState}
        workspaceBlocked={vm.workspaceBlocked}
        variableSuggestions={vm.variableSuggestions}
        onSave={vm.saveCollectionSettings}
        onReset={vm.resetCollectionSettings}
        onCreateRequest={vm.createNewRequest}
        folderPath={vm.activeFolderSettingsPath}
        folderRequestCount={vm.activeCollectionSettings && vm.activeFolderSettingsPath.length ? vm.requests.filter(request => !request.isDraft && request.collectionId === vm.activeCollectionSettings?.id && vm.folderPathMatches(request.folderPath ?? [], vm.activeFolderSettingsPath)).length : 0}
        onSaveFolder={vm.saveFolderSettings}
        onResetFolder={vm.resetFolderSettings}
        onCreateRequestInFolder={vm.createRequestInFolder}
        onBuildDocs={openDocs}
        onExport={vm.exportCollection}
        onDelete={vm.deleteCollection}
      />
      {/if}
    {:else if vm.topView === 'mock'}
      {#if lazy.MockServerWorkspaceComponent}
      <lazy.MockServerWorkspaceComponent
        status={vm.mockServer}
        routes={vm.mockServerRoutes()}
        routesPending={vm.mockServerRoutesPending()}
        collections={vm.mockServerCollectionOptions()}
        selectedCollectionId={vm.mockServerTargetCollectionId()}
        port={vm.mockServerPort}
        simulateLatency={vm.mockServerSimulateLatency}
        busy={vm.mockServerBusy}
        error={vm.mockServerError}
        log={vm.mockServerLog}
        onToggle={vm.toggleMockServer}
        onSelectCollection={vm.selectMockServerCollection}
        onPortChange={vm.setMockServerPort}
        onSimulateLatencyChange={(value: boolean) => (vm.mockServerSimulateLatency = value)}
        onClearLog={vm.clearMockServerLog}
        onCopy={(text: string) => void clipboardSet(text)}
        onOpenExample={(exampleId: string, requestId: string) => void vm.openMockRouteExample(exampleId, requestId)}
      />
      {/if}
    {:else if vm.topView === 'loadtest'}
      {#if lazy.LoadTestWorkspaceComponent}
      {@const active = vm.activeLoadTest()}
      <lazy.LoadTestWorkspaceComponent
        collection={active?.collection}
        loadTest={active?.loadTest}
        isDraft={active?.isDraft ?? false}
        requests={active ? vm.loadTestRequestOptions(active.collection.id) : []}
        environments={vm.activeWorkspaceEnvironments}
        activeEnvironmentId={vm.activeEnvironmentId}
        bind:loadTestTab={vm.loadTestTab}
        autosave={vm.autosave}
        autosaveDelayMs={vm.autosaveDelayMs}
        saveState={vm.loadTestSaveState}
        workspaceBlocked={vm.workspaceBlocked}
        onSave={vm.saveLoadTest}
        onValidate={vm.validateLoadTestDraft}
        onOpenRequest={(requestId: string) => void vm.switchRequest(requestId)}
        onChooseData={vm.chooseLoadTestData}
        onPreviewData={vm.previewLoadTestData}
        onSaveFolder={vm.saveLoadTestK6Folder}
        onExport={vm.exportLoadTestK6}
        onSaveScript={(fileName: string, script: string) => vm.saveTextFile(fileName, script)}
        onCopy={(text: string) => void clipboardSet(text)}
        run={vm.loadRun}
        logLines={vm.loadRunLogLines}
        logKey={vm.loadRunLogKey}
        result={active ? vm.loadRunResults[loadRunKey(active.collection.id, active.loadTest.id)] ?? null : null}
        k6Info={vm.k6Info}
        bind:k6MissingOpen={vm.k6MissingOpen}
        onRun={(collectionId: string, draft: LoadTest) => void vm.runLoadTest(collectionId, draft)}
        onStop={() => void vm.stopLoadTest()}
        onLoadResult={(collectionId: string, loadTestId: string) => void vm.loadLastLoadRun(collectionId, loadTestId)}
        onOpenDashboard={(url: string) => openExternalURL(url)}
        onOpenReport={(collectionId: string, loadTestId: string) => void vm.openLoadTestReport(collectionId, loadTestId)}
        onSaveSummary={(collectionId: string, loadTestId: string, fileName: string) => void vm.saveLoadTestSummary(collectionId, loadTestId, fileName)}
        onChooseK6={() => void vm.chooseK6Binary()}
        onCheckK6={() => void vm.checkK6().then(info => { if (info.found) vm.k6MissingOpen = false; })}
        onOpenK6Guide={() => openExternalURL('https://grafana.com/docs/k6/latest/set-up/install-k6/')}
        pendingEdits={vm.loadTestEdits?.collectionId === active?.collection.id ? vm.loadTestEdits?.test ?? null : null}
        onEdits={(collectionId: string, test: LoadTest, dirty: boolean, baseFingerprint?: string) => vm.reportLoadTestEdits(collectionId, test, dirty, baseFingerprint)}
        exportRequestId={vm.loadTestExportRequestId}
        onExportRequestHandled={() => (vm.loadTestExportRequestId = '')}
      />
      {/if}
    {:else if vm.topView === 'history' && vm.historyDetailEntry}
      {@const historyEntry = vm.historyDetailEntry}
      {@const sourceRequest = historyEntry.sourceRequestId ? vm.requests.find(request => request.id === historyEntry.sourceRequestId && !request.isDraft) : undefined}
      <HistoryDetail
        entry={historyEntry}
        response={vm.historyDetailResponse}
        loading={vm.historyDetailLoading}
        error={vm.historyDetailError}
        source={sourceRequest ? { id: sourceRequest.id, location: [vm.collectionNameById(sourceRequest.collectionId), ...(sourceRequest.folderPath ?? [])].filter(Boolean).join(' / ') || 'its request' } : null}
        displayBody={historyDetailBody}
        renderMode={historyDetailMode}
        virtualized={historyDetailVirtualized}
        canCopyCurl={requestSupportsCurl(historyEntry.request)}
        workspaceBlocked={vm.workspaceBlocked}
        onOpenInEditor={() => vm.openHistoryEntry(historyEntry.id)}
        onGoToSource={(id) => vm.switchRequest(id)}
        onCopyCurl={() => vm.copyHistoryEntryCurl(historyEntry.id)}
        onDelete={() => vm.deleteHistoryEntry(historyEntry.id)}
      />
    {:else if vm.topView === 'agent'}
      <AgentWorkspace workspaceBlocked={vm.workspaceBlocked} />
    {:else if vm.topView === 'runner'}
      {#if lazy.CollectionRunnerWorkspaceComponent}
      <lazy.CollectionRunnerWorkspaceComponent
        collections={vm.collectionRunnerCollections}
        selectedCollectionId={vm.collectionRunnerEffectiveCollectionId}
        filteredRequests={vm.collectionRunnerFilteredRequests}
        selectedRequestIds={vm.collectionRunnerSelectedRequestIds}
        selectedCount={vm.collectionRunnerSelectedCount}
        delayMs={vm.collectionRunnerDelayMs}
        includeTags={vm.collectionRunnerIncludeTags}
        excludeTags={vm.collectionRunnerExcludeTags}
        iterations={vm.collectionRunnerRunIterations}
        dataFileName={vm.collectionRunnerDataFileName}
        dataRowCount={vm.collectionRunnerDataRows.length}
        dataError={vm.collectionRunnerDataError}
        parallel={vm.collectionRunnerParallel}
        concurrency={vm.collectionRunnerConcurrency}
        running={vm.collectionRunnerRunning}
        preflighting={vm.collectionRunnerPreflighting}
        preflightFailures={vm.collectionRunnerPreflightFailures}
        onDismissPreflightFailures={() => (vm.collectionRunnerPreflightFailures = [])}
        results={vm.collectionRunnerResults}
        summary={vm.collectionRunnerSummary}
        lastRunAt={vm.collectionRunnerShowingLastRun ? vm.collectionRunnerFinishedAt : 0}
        {methodColor}
        {requestTabLabel}
        {requestTransportLabel}
        requestTags={vm.collectionRunnerRequestTags}
        isRequestSkipped={vm.savedRequestIsRunnerSkipped}
        onSelectCollection={vm.setCollectionRunnerCollection}
        onSetDelayMs={vm.setCollectionRunnerDelayMs}
        onSetIncludeTags={vm.setCollectionRunnerIncludeTags}
        onSetExcludeTags={vm.setCollectionRunnerExcludeTags}
        onSetIterations={vm.setCollectionRunnerIterations}
        onSelectDataFile={vm.selectCollectionRunnerDataFile}
        onClearDataFile={vm.clearCollectionRunnerDataFile}
        onSetParallel={vm.setCollectionRunnerParallel}
        onSetConcurrency={vm.setCollectionRunnerConcurrency}
        onToggleRequest={vm.toggleCollectionRunnerRequest}
        onSelectAll={vm.selectAllCollectionRunnerRequests}
        onDeselectAll={vm.deselectAllCollectionRunnerRequests}
        onReset={vm.resetCollectionRunner}
        onDownloadReport={vm.downloadCollectionRunnerReport}
        onRun={vm.startCollectionRunnerFromSelection}
        onStop={vm.stopCollectionRunner}
      />
      {/if}
    {:else}
      <RequestBar
        bind:codePanelOpen={vm.codePanelOpen}
        {codePanelAvailable}
        requestName={fileDraft?.barValue('name', vm.requestHeaderName()) ?? requestBarName}
        requestLocation={activeRequestLocation}
        {fileDraft}
        showSave={!vm.requestFiles.active && !vm.workspaceBlocked && !vm.autosave && vm.activeRequestId !== ''}
        saveDirty={!vm.workspaceBlocked && vm.activeRequestIsDirty}
        canRevert={!vm.workspaceBlocked && vm.activeRequestCanRevert}
        onSave={vm.saveActiveRequest}
        onRevert={vm.revertActiveRequestChanges}
        requestType={barType}
        bind:method={() => barMethod, setBarMethod}
        bind:url={() => barUrl, setBarUrl}
        bind:urlInputRef={vm._urlInputRef}
        requestTypes={REQUEST_TYPES}
        methods={METHODS}
        loading={vm.loading}
        {methodColor}
        requestTypeLabel={vm.requestTypeLabel}
        requestTypeEditable={vm.requestTypeEditable}
        variableSuggestions={vm.variableSuggestions}
        onRequestNameInput={setBarName}
        onRequestNameCommit={() => { if (!fileDraft) vm.commitRequestHeaderName(); }}
        onRequestTypeChange={changeBarProtocol}
        onUrlPaste={vm.onUrlPaste}
        onUrlInput={() => { if (!fileDraft) vm.syncParamsFromUrl(); }}
        onSend={vm.runActiveRequest}
        onSendAndDownload={() => vm.runActiveRequestAndDownload()}
        sseStatus={vm.requestType === 'http' && (vm.method === 'SSE' || sseSessionVisible) ? (vm.currentSSESession?.status ?? 'idle') : undefined}
        wsStatus={vm.requestType === 'ws' ? (vm.currentWebSocketSession?.status ?? 'idle') : undefined}
        sioStatus={vm.requestType === 'socketio' ? (vm.currentSocketIOSession?.status ?? 'idle') : undefined}
        grpcMethod={vm.grpcMethod}
        grpcMethods={vm.grpcSelectableMethods()}
        grpcServiceLoading={vm.grpcServiceLoading}
        grpcMethodLabel={vm.grpcMethodLabel}
        onGrpcMethodChange={vm.selectGrpcMethod}
        onGrpcDiscover={vm.discoverGrpcServices}
      />

      <div class="request-split" class:split-right={responseOnRight} bind:clientWidth={requestSplitWidth} style="--request-split: {vm.requestSplitRatio}">
      <div class="request-editor" role="presentation" onkeydowncapture={reserveEditorSendShortcut} style={responseOnRight ? '' : `height: ${rem(vm.requestPanelHeight)}; --request-panel-h: ${rem(vm.requestPanelHeight)}`}>
        <RequestEditorTabs
          requestTab={requestSection}
          onselect={selectRequestSection}
          requestType={barType}
          method={barMethod}
          paramsCount={activeCount(vm.params) + vm.pathParams.filter(r => r.value).length}
          authConfigured={vm.authHasConfig()}
          headerCount={vm.requestHeaderCount}
          bodyHasContent={vm.bodyHasContent()}
          bodyBadgeLabel={vm.bodyBadgeLabel()}
          scriptLineCount={scriptLineCount(vm.preRequestScriptJs) + scriptLineCount(vm.testScriptJs)}
          assertionCount={vm.assertions.filter(row => row.target.trim()).length}
          listenEventCount={activeCount(vm.sioEvents)}
          metadataCount={activeCount(vm.grpcMetadata)}
          grpcMethodSelected={Boolean(vm.grpcMethod)}
          mcpArgumentsHaveContent={Boolean(vm.mcpArguments.trim())}
          aiPromptHasContent={Boolean(vm.aiPrompt.trim())}
          aiToolCount={vm.aiToolRequestIds.length + (vm.aiKurloTools ? 1 : 0)}
          varCount={activeCount(vm.requestVars) + (requestTypeSupportsAssertions(vm.requestType) ? activeCount(vm.postResponseVars) : 0)}
          exampleCount={vm.requestExamplesLoaded ? vm.requestExamples.length : (vm.requestsById.get(vm.activeRequestId)?.exampleCount ?? 0)}
        />

        {#if requestSection === 'body' && vm.requestType !== 'ws' && vm.requestType !== 'socketio' && vm.requestType !== 'graphql' && vm.requestType !== 'grpc' && vm.requestType !== 'mcp' && vm.requestType !== 'ai' && vm.requestType !== 'kafka'}
          <BodyModeSelector
            showVariants={vm.method !== 'SSE'}
            rawBodyType={vm.rawBodyType}
            rawBodyTypes={RAW_BODY_TYPES}
            bodyModeIs={vm.bodyModeIs}
            setBodyMode={vm.setBodyMode}
            rawTypeLabel={vm.rawTypeLabel}
            setRawBodyType={vm.setRawBodyType}
            showBeautify={vm.bodyModeIs('raw')}
            beautified={vm.beautifiedBody}
            beautifyDisabled={vm.bodyLang !== 'json'}
            onBeautify={() => vm.beautifyBody()}
          />
        {/if}

        <div class="tab-content" class:file-editor-mode={requestSection === 'file'} class:script-editor-mode={requestSection === 'scripts' && (vm.scriptTab !== 'assertions' || !requestTypeSupportsAssertions(vm.requestType))} class:body-editor-mode={(requestSection === 'body' && (vm.requestType === 'ws' || vm.requestType === 'socketio' || vm.requestType === 'grpc' || vm.requestType === 'mcp' || vm.requestType === 'ai' || !['none', 'form', 'urlencoded', 'binary'].includes(vm.bodyType))) || (vm.requestType === 'graphql' && (requestSection === 'query' || requestSection === 'schema'))}>
          {#if vm.requestFiles.active}
            {#if vm.activeRequest?.isDraft}
              <div class="file-tab-empty">
                <p>Save this request to a collection to edit its YAML file.</p>
                <button type="button" class="btn btn-secondary btn-sm" onclick={vm.saveActiveRequest}>Save request</button>
              </div>
            {:else if lazy.FileTabComponent}
              <lazy.FileTabComponent draft={vm.requestFiles.active} />
            {/if}
          {:else if vm.requestType === 'kafka' && (vm.requestTab === 'body' || vm.requestTab === 'settings')}
            {#if lazy.KafkaEditorComponent}<lazy.KafkaEditorComponent />{/if}
          {:else if vm.requestTab === 'docs'}
            {#if lazy.DocsTabComponent}<lazy.DocsTabComponent />{/if}
          {:else if vm.requestTab === 'query'}
            {#if lazy.GraphQLQueryTabComponent}<lazy.GraphQLQueryTabComponent />{/if}
          {:else if vm.requestTab === 'params'}
            {#if lazy.ParamsTabComponent}<lazy.ParamsTabComponent />{/if}
          {:else if vm.requestTab === 'auth'}
            {#if lazy.AuthTabComponent}<lazy.AuthTabComponent />{/if}
          {:else if vm.requestTab === 'headers' && vm.requestType === 'kafka'}
            {#if lazy.GrpcMetadataTabComponent}<lazy.GrpcMetadataTabComponent kafka />{/if}
          {:else if vm.requestTab === 'headers'}
            {#if lazy.HeadersTabComponent}<lazy.HeadersTabComponent />{/if}
          {:else if vm.requestTab === 'vars'}
            {#if lazy.VarsTabComponent}<lazy.VarsTabComponent />{/if}
          {:else if vm.requestTab === 'metadata'}
            {#if lazy.GrpcMetadataTabComponent}<lazy.GrpcMetadataTabComponent />{/if}
          {:else if vm.requestTab === 'body'}
            {#if vm.requestType === 'ws'}
              {#if lazy.WebSocketMessageTabComponent}<lazy.WebSocketMessageTabComponent />{/if}
            {:else if vm.requestType === 'socketio'}
              {#if lazy.SocketIOMessageTabComponent}<lazy.SocketIOMessageTabComponent />{/if}
            {:else if vm.requestType === 'grpc'}
              {#if lazy.GrpcMessageTabComponent}<lazy.GrpcMessageTabComponent />{/if}
            {:else if vm.requestType === 'mcp'}
              {#if lazy.McpCallTabComponent}<lazy.McpCallTabComponent />{/if}
            {:else if vm.requestType === 'ai'}
              {#if lazy.AiPromptTabComponent}<lazy.AiPromptTabComponent />{/if}
            {:else if lazy.BodyTabComponent}
              {#key vm.activeBodyVariant}<lazy.BodyTabComponent />{/key}
            {/if}
          {:else if vm.requestTab === 'tools'}
            {#if lazy.AiToolsTabComponent}<lazy.AiToolsTabComponent />{/if}
          {:else if vm.requestTab === 'events'}
            {#if lazy.SocketIOEventsTabComponent}<lazy.SocketIOEventsTabComponent />{/if}
          {:else if vm.requestTab === 'schema'}
            {#if lazy.GraphQLSchemaTabComponent}<lazy.GraphQLSchemaTabComponent />{/if}
          {:else if vm.requestTab === 'service'}
            {#if lazy.GrpcServiceDefinitionTabComponent}<lazy.GrpcServiceDefinitionTabComponent />{/if}
          {:else if vm.requestTab === 'scripts'}
            {#if lazy.ScriptsTabComponent}<lazy.ScriptsTabComponent />{/if}
          {:else if vm.requestTab === 'examples'}
            {#if lazy.ExamplesTabComponent}<lazy.ExamplesTabComponent />{/if}
          {:else if vm.requestTab === 'settings'}
            {#if vm.requestType === 'ws'}
              {#if lazy.WebSocketSettingsTabComponent}<lazy.WebSocketSettingsTabComponent />{/if}
            {:else if vm.requestType === 'socketio'}
              {#if lazy.SocketIOSettingsTabComponent}<lazy.SocketIOSettingsTabComponent />{/if}
            {:else if vm.requestType === 'grpc'}
              {#if lazy.GrpcSettingsTabComponent}<lazy.GrpcSettingsTabComponent />{/if}
            {:else if vm.requestType === 'ai'}
              {#if lazy.AiSettingsTabComponent}<lazy.AiSettingsTabComponent />{/if}
            {:else if lazy.RequestSettingsTabComponent}
              <lazy.RequestSettingsTabComponent />
            {/if}
          {/if}
        </div>
      </div>

      {#if responseOnRight}
        <button
          class="panel-divider panel-divider-vertical"
          type="button"
          onmousedown={vm.startSplitResize}
          onkeydown={vm.onSplitDividerKeydown}
          aria-label="Resize panels"
        ></button>
      {:else}
        <button
          class="panel-divider"
          type="button"
          onmousedown={vm.startPanelResize}
          onkeydown={vm.onPanelDividerKeydown}
          aria-label="Resize panels"
        ></button>
      {/if}

      {#if vm.requestType === 'kafka'}
        {#if lazy.KafkaResponsePanelComponent}{#key vm.activeRequestId}<lazy.KafkaResponsePanelComponent />{/key}{/if}
      {:else if vm.requestType === 'ws'}
        {#if lazy.WebSocketPanelComponent}
        <lazy.WebSocketPanelComponent
          status={vm.currentWebSocketSession?.status ?? 'idle'}
          connectedAt={vm.currentWebSocketSession?.connectedAt ?? 0}
          messages={vm.currentWebSocketSession?.messages ?? []}
          headers={vm.currentWebSocketSession?.headers ?? []}
          error={vm.currentWebSocketSession?.error ?? ''}
          bind:responseTab={vm.wsResponseTab}
          canRestore={(vm.currentWebSocketSession?.clearedMessages?.length ?? 0) > 0}
          onClear={vm.webSocketClearMessages}
          onRestore={vm.webSocketRestoreMessages}
        />
        {/if}
      {:else if vm.requestType === 'socketio'}
        {#if lazy.SocketIOPanelComponent}
        <lazy.SocketIOPanelComponent
          status={vm.currentSocketIOSession?.status ?? 'idle'}
          connectedAt={vm.currentSocketIOSession?.connectedAt ?? 0}
          namespace={vm.currentSocketIOSession?.namespace ?? '/'}
          messages={vm.currentSocketIOSession?.messages ?? []}
          error={vm.currentSocketIOSession?.error ?? ''}
          canRestore={(vm.currentSocketIOSession?.clearedMessages?.length ?? 0) > 0}
          listenEventCount={vm.sioEvents.filter(r => r.enabled && r.key.trim()).length}
          onClear={vm.socketIOClearMessages}
          onRestore={vm.socketIORestoreMessages}
          onGoToEvents={() => void vm.requestFiles.select('events')}
        />
        {/if}
      {:else if vm.requestType === 'http' && (vm.method === 'SSE' || sseSessionVisible)}
        {#if lazy.SSEPanelComponent}
        <lazy.SSEPanelComponent
          status={vm.currentSSESession?.status ?? 'idle'}
          connectedUrl={vm.currentSSESession?.connectedUrl ?? ''}
          statusText={vm.currentSSESession?.statusText ?? ''}
          statusCode={vm.currentSSESession?.statusCode ?? 0}
          connectedAt={vm.currentSSESession?.connectedAt ?? 0}
          duration={vm.currentSSESession?.duration ?? 0}
          timings={vm.currentSSESession?.timings ?? null}
          events={vm.currentSSESession?.events ?? []}
          headers={vm.currentSSESession?.headers ?? []}
          error={vm.currentSSESession?.error ?? ''}
          canRestore={(vm.currentSSESession?.clearedEvents?.length ?? 0) > 0}
          onClear={vm.sseClearEvents}
          onRestore={vm.sseRestoreEvents}
        />
        {/if}
      {:else if vm.requestType === 'grpc'}
        {#if lazy.GrpcResponsePanelComponent}
          <lazy.GrpcResponsePanelComponent />
        {/if}
      {:else if vm.requestType === 'mcp'}
        {#if lazy.McpResponsePanelComponent}
          <lazy.McpResponsePanelComponent />
        {/if}
      {:else if vm.requestType === 'ai'}
        {#if lazy.AiConversationPanelComponent}
          <lazy.AiConversationPanelComponent />
        {/if}
      {:else if lazy.ResponsePanelComponent}
        <lazy.ResponsePanelComponent
          loading={vm.loading}
          requestError={vm.requestError}
          response={vm.response}
          responseTab={vm.responseTab}
          bind:responseSearchOpen={vm.responseSearchOpen}
          bind:responseSearch={vm.responseSearch}
          bind:responseSearchIndex={vm.responseSearchIndex}
          responseDiffSummary={vm.responseDiff()}
          diffBaseline={vm.diffBaselineResponse()}
          diffBaselineLabel={vm.diffBaselineLabel()}
          diffBaselineOptions={vm.diffBaselineOptions()}
          diffBaselineExampleId={vm.diffBaselineExampleId()}
          onSelectDiffBaseline={(id: string) => vm.setDiffBaselineExample(id)}
          responseSearchTotal={vm.responseSearchTotal}
          responseDisplayBody={vm.responseDisplayBody}
          responseRenderMode={vm.responseRenderMode}
          responseBodyIsPaged={vm.responseBodyIsPaged}
          responseBodyVirtualized={vm.responseBodyVirtualized}
          responseBodyPage={vm.responseBodyPage}
          responseBodyPageCount={vm.responseBodyPageCount}
          responseBodyPageLabel={vm.responseBodyPageLabel}
          copiedBody={vm.copiedBody}
          savedResponse={vm.savedResponse}
          appRuntime={vm.appRuntime}
          {statusClass}
          {formatSize}
          onResponseSearchKeydown={vm.onResponseSearchKeydown}
          prevResponseMatch={vm.prevResponseMatch}
          nextResponseMatch={vm.nextResponseMatch}
          previousResponseBodyPage={vm.previousResponseBodyPage}
          nextResponseBodyPage={vm.nextResponseBodyPage}
          toggleResponseSearch={vm.toggleResponseSearch}
          copyResponseBody={vm.copyResponseBody}
          saveResponseFile={vm.saveResponseFile}
          loadResponseFromFile={vm.loadResponseFromFile}
          saveResponseAsExample={vm.requestType === 'http' || vm.requestType === 'graphql' ? () => vm.saveResponseAsExample() : null}
          setResponseTab={(tab: ResponseTab) => vm.setActiveResponseTab(tab)}
          clearResponseDiffBaseline={() => vm.clearResponseDiffBaseline()}
        />
      {/if}
      </div>
    {/if}

    {#if vm.perfDockOpen && (vm.perfSample || vm.perfError) && lazy.PerformanceDockComponent}
      <lazy.PerformanceDockComponent />
    {/if}
  </div>

  <StatusBar
    sidebarHidden={vm.sidebarHidden}
    {responseOnRight}
    {responseRightTooNarrow}
    topView={vm.topView}
    gitStatus={vm.gitStatus}
    appVersion={vm.appVersion}
    appTheme={vm.appTheme}
    resolvedAppTheme={vm.resolvedAppTheme}
    setThemeMode={vm.setThemeMode}
    setThemeVariant={vm.setThemeVariant}
    onOpenGit={vm.openGitTab}
    onOpenAbout={() => vm.openSettings('about')}
    onToggleSidebar={() => (vm.sidebarHidden = !vm.sidebarHidden)}
  />

  <aside class="code-snippet-panel" aria-label="Code snippet panel" aria-hidden={!vm.codePanelOpen || !codePanelAvailable} inert={!vm.codePanelOpen || !codePanelAvailable}>
    {#if lazy.CodeSnippetPanelComponent}
      <lazy.CodeSnippetPanelComponent
        lines={vm.codePanelOpen && codePanelAvailable ? vm.snippetRenderedLines : vm.snippetRenderedLinesCache}
        codePanelOpen={vm.codePanelOpen && codePanelAvailable}
        snippetLanguage={vm.snippetLanguage}
        copiedSnippet={vm.copiedSnippet}
        onSnippetLanguageChange={(lang: SnippetLanguage) => (vm.snippetLanguage = lang)}
        onCopy={vm.copySnippet}
        onResizeStart={vm.startCodePanelResize}
        onDividerKeydown={vm.onCodePanelDividerKeydown}
      />
    {/if}
  </aside>

  {#if textMenu}
    <TextContextMenu menu={textMenu} onclose={() => (textMenu = null)} />
  {/if}
</main>
