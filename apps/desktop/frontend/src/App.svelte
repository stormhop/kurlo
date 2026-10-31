<script lang="ts">
  import { kurloChangedFiles } from './lib/gitFiles';
  import { onMount, untrack } from 'svelte';
  import { getAppInfo, checkForUpdate, applyUpdate, restartApp, clipboardSet, ackQuit } from './lib/backend';
  import type { MockRequestLog, OAuth2DevicePrompt, UpdateInfo } from './lib/backend';
  import { hasReleaseNotes } from 'virtual:kurlo-changelog-meta';
  import { isReleaseVersion, latestReleaseNotes, releaseNotesFor, shouldShowWhatsNew, type ChangelogSection } from './lib/whatsNew';
  import WhatsNewModal from './lib/components/WhatsNewModal.svelte';
  import UpdateBanner from './lib/components/UpdateBanner.svelte';
  import { vm } from './lib/stores/app.svelte';
  import { appLazyComponents as lazy } from './lib/stores/lazyComponents.svelte';
  import AppOverlays from './lib/components/AppOverlays.svelte';
  import AppToasts from './lib/components/AppToasts.svelte';
  import BodyModeSelector from './lib/components/BodyModeSelector.svelte';
  import RequestBar from './lib/components/RequestBar.svelte';
  import RequestEditorTabs from './lib/components/RequestEditorTabs.svelte';
  import ActivityRail from './lib/components/ActivityRail.svelte';
  import { shortcutComboLabel, usesMacShortcutGlyphs } from './lib/stores/features/preferences';
  import { responseRightMinWidth } from './lib/stores/features/uiShell';
  import { rem, uiScale } from './lib/uiScale';
  import Sidebar from './lib/components/Sidebar.svelte';
  import StatusBar from './lib/components/StatusBar.svelte';
  import WorkspaceChrome from './lib/components/WorkspaceChrome.svelte';
  import WorkspaceOverview from './lib/components/WorkspaceOverview.svelte';
  import GlobalsWorkspace from './lib/components/GlobalsWorkspace.svelte';
  import HistoryDetail from './lib/components/HistoryDetail.svelte';
  import { METHODS, REQUEST_TYPES, DEFAULT_WORKSPACE, RAW_BODY_TYPES } from './lib/constants';
  import { installTitlebarDoubleClickHandler } from './lib/windowControls';
  import { methodColor, requestTabLabel, requestTransportLabel, activeCount, statusClass, formatSize, scriptLineCount, requestSupportsCurl } from './lib/utils';
  import type { SnippetLanguage } from './lib/stores/ui';
  import type { ResponseTab } from './lib/types/models';
  import type { LoadTest } from './lib/wire';
  import { openExternalURL } from './lib/externalLinks';
  import { shouldVirtualizeResponseBody, type ResponseRenderMode } from './lib/response-render';
  import { tallyCollectionRun } from './lib/collectionRuns';

  const AUTO_UPDATE_INSTALL_KEY = 'kurlo:auto-update-install';
  const UPDATE_READY_KEY = 'kurlo:update-ready';
  const LAST_SEEN_VERSION_KEY = 'kurlo:last-seen-version';

  let whatsNewSection = $state<ChangelogSection | null>(null);

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
    const mayShow = shouldShowWhatsNew(version, lastSeen, hasReleaseNotes);
    if (mayShow) {
      const section = releaseNotesFor(await loadChangelog(), version);
      if (!section) return;
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
  }

  async function showWhatsNew() {
    const markdown = await loadChangelog();
    whatsNewSection = releaseNotesFor(markdown, vm.appVersion) ?? latestReleaseNotes(markdown);
  }

  const whatsNewAvailable = hasReleaseNotes;

  const loadTestTab = $derived.by(() => {
    const active = vm.activeLoadTest();
    if (!active) return null;
    const edits = vm.loadTestEdits?.test.id === active.loadTest.id ? vm.loadTestEdits : null;
    const title = (edits?.test.name ?? active.loadTest.name).trim() || 'New load test';
    const unsaved = active.isDraft ? 'Unsaved draft' : edits?.dirty && !vm.autosave ? 'Unsaved changes' : '';
    return { title, unsaved };
  });


  let updateInfo = $state<UpdateInfo | null>(null);
  let updateReady = $state(false);
  let autoUpdateInstall = $state(localStorage.getItem(AUTO_UPDATE_INSTALL_KEY) === 'true');
  let autoUpdateInstalling = $state(false);
  let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let focusedBeforeWindowBlur: HTMLElement | null = null;
  let codePanelAvailable = $derived(vm.codePanelAvailable);
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
  let historyDetailMode = $derived<ResponseRenderMode>(!vm.historyDetailResponse ? 'text' : vm.isJsonResponse(vm.historyDetailResponse) ? 'json' : vm.isHtmlResponse(vm.historyDetailResponse) ? 'html' : 'text');
  let historyDetailVirtualized = $derived(historyDetailBody ? shouldVirtualizeResponseBody(historyDetailBody, historyDetailMode) : false);
  let responseOnRight = $derived(vm.responseLayout === 'right' && requestSplitWidth / $uiScale >= responseRightMinWidth(vm.responseLayoutChosen));
  let responseRightTooNarrow = $derived(!responseOnRight && requestSplitWidth > 0 && requestSplitWidth / $uiScale < responseRightMinWidth(true));

  function setRuntimePlatform(runtime: string) {
    const platform = runtime.split('/')[0] || 'browser';
    document.documentElement.dataset.platform = platform;
    document.documentElement.dataset.runtime = runtime;
  }

  function preventNativeContextMenu(event: MouseEvent) {
    event.preventDefault();
  }

  function setAutoUpdateInstall(value: boolean) {
    autoUpdateInstall = value;
    localStorage.setItem(AUTO_UPDATE_INSTALL_KEY, value ? 'true' : 'false');
  }

  function markUpdateReady(info: UpdateInfo) {
    updateInfo = info;
    updateReady = true;
  }

  function syncUpdateReadyForVersion(version: string): boolean {
    const pendingReadyVersion = localStorage.getItem(UPDATE_READY_KEY);
    if (!pendingReadyVersion) {
      updateReady = false;
      return false;
    }
    if (pendingReadyVersion === version) {
      localStorage.removeItem(UPDATE_READY_KEY);
      updateReady = false;
      return false;
    }
    if (!isPendingVersionNewer(pendingReadyVersion, version)) {
      localStorage.removeItem(UPDATE_READY_KEY);
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
    if (info.manualInstallUrl || !autoUpdateInstall || autoUpdateInstalling || localStorage.getItem(UPDATE_READY_KEY)) return false;
    autoUpdateInstalling = true;
    try {
      const err = await applyUpdate(info);
      if (err) {
        console.warn('Auto-update install failed:', err);
        return false;
      }
      localStorage.setItem(UPDATE_READY_KEY, info.version);
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
    if (window.runtime?.BrowserOpenURL) {
      window.runtime.BrowserOpenURL(info.manualInstallUrl);
    } else {
      window.open(info.manualInstallUrl, '_blank');
    }
  }

  function restartForInstalledUpdate() {
    localStorage.removeItem(UPDATE_READY_KEY);
    void restartApp();
  }

  $effect(() => {
    vm.requestEditSignal();
    untrack(() => vm.scheduleActiveRequestPersist());
  });

  $effect(() => {
    vm.clampResponseSearchIndex();
  });

  $effect(() => {
    if (vm.mockServer.running) vm.mockServerRunningRoutes();
    untrack(() => vm.scheduleMockServerReload());
  });

  $effect(() => {
    vm.response;
    vm.responseSearch;
    vm.responseBodyPage;
    vm.responseBodyIsPaged;
    untrack(() => vm.scheduleResponseSearchCount());
  });

  $effect(() => {
    lazy.preloadForAppShell({
      requestTab: vm.requestTab,
      requestType: vm.requestType,
      method: vm.method,
      topView: vm.topView,
      codePanelOpen: vm.codePanelOpen,
      codePanelAvailable,
      cookieJarOpen: vm.cookieJarOpen,
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
    vm.collectionRunnerOpen;
    vm.collectionRunnerCollectionId;
    vm.gitWorkspaceOpen;
    vm.sidebarView;
    untrack(() => vm.saveTopViewState());
  });

  function hideBootScreen() {
    const boot = document.getElementById('boot-screen');
    if (!boot) return;
    boot.classList.add('boot-hidden');
    setTimeout(() => boot.remove(), 360);
  }

  onMount(() => {
    const uninstallTitlebarDoubleClick = installTitlebarDoubleClickHandler();
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
    void vm.refreshMockServerStatus();
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
      vm.loadProxyConfig();
      vm.loadScriptEngine();
      void vm.loadDefaultWorkspaceLocation();
      vm.initSSEListeners();
      vm.initAiListeners();
      vm.initGrpcListeners();
      vm.initWebSocketListeners();
      vm.initSocketIOListeners();
      vm.initWorkspaceListeners();
      try {
        await vm.loadRequestWorkspace();
      } finally {
        hideBootScreen();
      }
      void vm.loadCookieSyncStatus();
      const info = await getAppInfo();
      vm.appRuntime = info.runtime;
      vm.appVersion = info.version;
      setRuntimePlatform(info.runtime);
      const updatePendingRestart = syncUpdateReadyForVersion(info.version);
      void checkWhatsNew(info.version);

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
      if (updateCheckTimer !== null) {
        clearTimeout(updateCheckTimer);
        updateCheckTimer = null;
      }
      uninstallTitlebarDoubleClick();
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
/>

{#if whatsNewSection}
  <WhatsNewModal section={whatsNewSection} onDismiss={dismissWhatsNew} />
{/if}

<main
  class="shell"
  class:resizing-sidebar={vm.sidebarResizing}
  class:resizing-col={vm.colResizing !== null || vm.splitResizing}
  class:resizing-row={vm.panelResizing}
  class:resizing-code={vm.codePanelResizing}
  class:code-open={vm.codePanelOpen && codePanelAvailable}
  class:sidebar-hidden={vm.sidebarHidden}
  style="--sidebar-w: {rem(vm.sidebarHidden ? 0 : vm.sidebarWidth)}; --code-requested-w: {rem(vm.codePanelOpen && codePanelAvailable ? vm.codePanelWidth : 0)}"
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
    settingsShortcut={shortcutComboLabel(vm.shortcutCombo('settings'), vm.appRuntime)}
    workspaceBlocked={vm.workspaceBlocked}
    openCollectionRunner={vm.openCollectionRunner}
    openMockTab={vm.openMockServerTab}
    openCookieJar={vm.openCookieJar}
    openSettings={vm.openSettings}
  />

  <Sidebar
    bind:sidebarView={vm.sidebarView}
    bind:sidebarSearch={vm.sidebarSearch}
    bind:sidebarSearchInput={vm._sidebarSearchInput}
    topView={vm.topView}
    activeRequestId={vm.activeRequestId}
    activeEnvironmentId={vm.activeEnvironmentId}
    collectionGroups={vm.collectionGroups}
    historyGroups={vm.historyGroups}
    pinnedRequests={vm.pinnedRequests}
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
    exportCollection={vm.exportCollection}
    deleteCollection={vm.deleteCollection}
    moveCollection={vm.moveCollection}
    switchRequest={vm.switchRequest}
    {requestTabLabel}
    toggleRequestMenu={vm.toggleRequestMenu}
    renameRequest={vm.renameRequest}
    duplicateRequest={vm.duplicateRequest}
    copyRequestCurl={vm.copyRequestCurl}
    activeLoadTestId={vm.activeLoadTestId}
    openLoadTestMenuId={vm.openLoadTestMenuId}
    createLoadTest={(collectionId: string, requestIds?: string[]) => void vm.createLoadTest(collectionId, requestIds)}
    createLoadTestFromRequest={(requestId: string) => void vm.createLoadTestFromRequest(requestId)}
    openLoadTest={(collectionId: string, loadTestId: string) => void vm.openLoadTest(collectionId, loadTestId)}
    toggleLoadTestMenu={vm.toggleLoadTestMenu}
    renameLoadTest={vm.renameLoadTest}
    duplicateLoadTest={(collectionId: string, loadTestId: string) => void vm.duplicateLoadTest(collectionId, loadTestId)}
    deleteLoadTest={(collectionId: string, loadTestId: string) => void vm.deleteLoadTest(collectionId, loadTestId)}
    runningLoadTestId={vm.loadRun.running ? vm.loadRun.loadTestId : ''}
    loadRunResults={vm.loadRunResults}
    runLoadTest={(collectionId: string, loadTestId: string) => void vm.runSavedLoadTest(collectionId, loadTestId)}
    exportLoadTest={(collectionId: string, loadTestId: string) => void vm.exportSavedLoadTest(collectionId, loadTestId)}
    loadLoadTestResult={(loadTestId: string) => void vm.loadLastLoadRun(loadTestId)}
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
      bind:codePanelOpen={vm.codePanelOpen}
      codePanelAvailable={codePanelAvailable}
      defaultWorkspace={DEFAULT_WORKSPACE}
      activeWorkspace={vm.activeWorkspace}
      workspaces={vm.workspaces}
      activeWorkspaceId={vm.activeWorkspaceId}
      openRequests={vm.openRequestsForTabs}
      activeRequestId={vm.activeRequestId}
      activeWorkspaceEnvironments={vm.activeWorkspaceEnvironments}
      activeEnvironmentId={vm.activeEnvironmentId}
      dirtyRequestIds={vm.dirtyRequestIdList}
      collectionRunnerOpen={vm.collectionRunnerOpen}
      collectionRunnerRunning={vm.collectionRunnerRunning}
      activeCollectionSettings={vm.activeCollectionSettings}
      historyDetailOpen={Boolean(vm.historyDetailEntry)}
      gitTabOpen={vm.gitWorkspaceOpen}
      mockTabOpen={vm.mockServerTabOpen}
      loadTestTabTitle={loadTestTab ? loadTestTab.title : ''}
      loadTestTabUnsaved={loadTestTab ? loadTestTab.unsaved : ''}
      openLoadTestTab={() => (vm.topView = 'loadtest')}
      closeLoadTestTab={() => void vm.closeLoadTestTab()}
      mockRunning={vm.mockServer.running}
      gitChangeCount={kurloChangedFiles(vm.gitStatus).length}
      autosave={vm.autosave}
      appRuntime={vm.appRuntime}
      workspaceBlocked={vm.workspaceBlocked}
      toggleWorkspaceMenu={vm.toggleWorkspaceMenu}
      createWorkspace={vm.createWorkspace}
      switchWorkspace={vm.switchWorkspace}
      workspaceCollectionCountFor={vm.workspaceCollectionCountFor}
      workspaceRequestCountFor={vm.workspaceRequestCountFor}
      deleteWorkspace={vm.deleteWorkspace}
      openGlobalSearch={vm.openGlobalSearch}
      closeCollectionRunner={vm.closeCollectionRunnerTab}
      closeCollectionSettings={vm.closeCollectionSettingsTab}
      closeHistoryDetail={vm.closeHistoryDetail}
      openGitTab={vm.openGitTab}
      closeGitTab={vm.closeGitTab}
      openMockTab={vm.openMockServerTab}
      closeMockTab={vm.closeMockServerTab}
      {requestTabLabel}
      switchRequest={vm.switchRequest}
      closeRequestTab={vm.closeRequestTab}
      createDraftRequest={vm.createDraftRequest}
      toggleEnvironmentMenu={vm.toggleEnvironmentMenu}
      environmentLabel={vm.environmentLabel}
      useEnvironment={vm.useEnvironment}
      environmentHasValues={vm.environmentHasValues}
      environmentValueCount={vm.environmentValueCount}
    />

    {#if vm.topView === 'overview'}
      <WorkspaceOverview
        activeWorkspace={vm.activeWorkspace}
        workspaceBlocked={vm.workspaceBlocked}
        defaultWorkspace={DEFAULT_WORKSPACE}
        collectionGroups={vm.collectionGroups}
        history={vm.requestHistory}
        environmentCount={vm.activeWorkspaceEnvironments.length}
        storedInGit={vm.gitStatus.isRepo}
        shortcutCombo={(id) => vm.shortcutCombo(id)}
        appRuntime={vm.appRuntime}
        updateWorkspaceDescription={vm.updateWorkspaceDescription}
        renameWorkspace={vm.renameWorkspace}
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
      />

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
        useEnvironment={vm.useEnvironment}
        deleteEnvironment={vm.deleteEnvironment}
        saveEnvironment={vm.saveEnvironment}
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
        collection={vm.activeCollectionSettings}
        requestCount={vm.activeCollectionSettings ? vm.collectionRequestCount(vm.activeCollectionSettings.id) : 0}
        lastRun={activeCollectionLastRun}
        onOpenRunner={vm.openCollectionRunner}
        bind:collectionSettingsTab={vm.collectionSettingsTab}
        autosave={vm.autosave}
        saveState={vm.collectionSettingsSaveState}
        workspaceBlocked={vm.workspaceBlocked}
        variableSuggestions={vm.variableSuggestions}
        scriptEngine={vm.scriptEngine}
        onSave={vm.saveCollectionSettings}
        onReset={vm.resetCollectionSettings}
        onCreateRequest={vm.createNewRequest}
      />
      {/if}
    {:else if vm.topView === 'mock'}
      {#if lazy.MockServerWorkspaceComponent}
      <lazy.MockServerWorkspaceComponent
        status={vm.mockServer}
        routes={vm.mockServerRoutes()}
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
        onOpenExample={(exampleId: string) => void vm.openMockRouteExample(exampleId)}
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
        environments={vm.environments.filter(environment => environment.workspaceId === vm.activeWorkspaceId)}
        bind:loadTestTab={vm.loadTestTab}
        autosave={vm.autosave}
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
        logTestId={vm.loadRunLogTestId}
        result={active ? vm.loadRunResults[active.loadTest.id] ?? null : null}
        k6Info={vm.k6Info}
        bind:k6MissingOpen={vm.k6MissingOpen}
        onRun={(collectionId: string, draft: LoadTest) => void vm.runLoadTest(collectionId, draft)}
        onStop={() => void vm.stopLoadTest()}
        onLoadResult={(loadTestId: string) => void vm.loadLastLoadRun(loadTestId)}
        onOpenDashboard={(url: string) => openExternalURL(url)}
        onOpenReport={(loadTestId: string) => void vm.openLoadTestReport(loadTestId)}
        onSaveSummary={(loadTestId: string, fileName: string) => void vm.saveLoadTestSummary(loadTestId, fileName)}
        onChooseK6={() => void vm.chooseK6Binary()}
        onCheckK6={() => void vm.checkK6().then(info => { if (info.found) vm.k6MissingOpen = false; })}
        onOpenK6Guide={() => openExternalURL('https://grafana.com/docs/k6/latest/set-up/install-k6/')}
        pendingEdits={vm.loadTestEdits?.test ?? null}
        onEdits={(collectionId: string, test: LoadTest, dirty: boolean) => vm.reportLoadTestEdits(collectionId, test, dirty)}
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
        title={vm.collectionRunnerTitle}
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
        requestName={vm.requestHeaderName()}
        requestLocation={activeRequestLocation}
        showSave={!vm.workspaceBlocked && !vm.autosave && vm.activeRequestId !== ''}
        saveDirty={!vm.workspaceBlocked && vm.activeRequestIsDirty}
        canRevert={!vm.workspaceBlocked && vm.activeRequestCanRevert}
        saveShortcut={shortcutComboLabel(vm.shortcutCombo('save-request'), vm.appRuntime)}
        sendShortcut={shortcutComboLabel(vm.shortcutCombo('send-request'), vm.appRuntime)}
        sendShortcutInline={usesMacShortcutGlyphs(vm.appRuntime)}
        onSave={vm.saveActiveRequest}
        onRevert={vm.revertActiveRequestChanges}
        requestType={vm.requestType}
        bind:method={vm.method}
        bind:url={vm.url}
        bind:urlInputRef={vm._urlInputRef}
        requestTypes={REQUEST_TYPES}
        methods={METHODS}
        loading={vm.loading}
        {methodColor}
        requestTypeLabel={vm.requestTypeLabel}
        requestTypeEditable={vm.requestTypeEditable}
        variableSuggestions={vm.variableSuggestions}
        onRequestNameInput={vm.setRequestHeaderName}
        onRequestNameCommit={vm.commitRequestHeaderName}
        onRequestTypeChange={vm.selectRequestType}
        onUrlPaste={vm.onUrlPaste}
        onUrlInput={() => vm.syncParamsFromUrl()}
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
      <div class="request-editor" style={responseOnRight ? '' : `height: ${rem(vm.requestPanelHeight)}; --request-panel-h: ${rem(vm.requestPanelHeight)}`}>
        <RequestEditorTabs
          bind:requestTab={vm.requestTab}
          requestType={vm.requestType}
          method={vm.method}
          paramsCount={activeCount(vm.params) + vm.pathParams.filter(r => r.value).length}
          authConfigured={vm.authHasConfig()}
          headerCount={vm.requestHeaderCount}
          bodyHasContent={vm.bodyHasContent()}
          bodyBadgeLabel={vm.bodyBadgeLabel()}
          scriptLineCount={scriptLineCount(vm.preRequestScript) + scriptLineCount(vm.testScript)}
          listenEventCount={activeCount(vm.sioEvents)}
          metadataCount={activeCount(vm.grpcMetadata)}
          grpcMethodSelected={Boolean(vm.grpcMethod)}
          mcpArgumentsHaveContent={Boolean(vm.mcpArguments.trim())}
          aiPromptHasContent={Boolean(vm.aiPrompt.trim())}
          aiToolCount={vm.aiToolRequestIds.length}
          exampleCount={vm.requestExamples.length}
        />

        {#if vm.requestTab === 'body' && vm.requestType !== 'ws' && vm.requestType !== 'socketio' && vm.requestType !== 'graphql' && vm.requestType !== 'grpc' && vm.requestType !== 'mcp' && vm.requestType !== 'ai'}
          <BodyModeSelector
            bind:rawTypeMenuOpen={vm.rawTypeMenuOpen}
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

        <div class="tab-content" class:body-editor-mode={(vm.requestTab === 'body' && (vm.requestType === 'ws' || vm.requestType === 'socketio' || vm.requestType === 'grpc' || vm.requestType === 'mcp' || vm.requestType === 'ai' || !['none', 'form', 'urlencoded', 'binary'].includes(vm.bodyType))) || (vm.requestType === 'graphql' && (vm.requestTab === 'query' || vm.requestTab === 'schema'))}>
          {#if vm.requestTab === 'docs'}
            {#if lazy.DocsTabComponent}<lazy.DocsTabComponent />{/if}
          {:else if vm.requestTab === 'query'}
            {#if lazy.GraphQLQueryTabComponent}<lazy.GraphQLQueryTabComponent />{/if}
          {:else if vm.requestTab === 'params'}
            {#if lazy.ParamsTabComponent}<lazy.ParamsTabComponent />{/if}
          {:else if vm.requestTab === 'auth'}
            {#if lazy.AuthTabComponent}<lazy.AuthTabComponent />{/if}
          {:else if vm.requestTab === 'headers'}
            {#if lazy.HeadersTabComponent}<lazy.HeadersTabComponent />{/if}
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
              <lazy.BodyTabComponent />
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

      {#if vm.requestType === 'ws'}
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
          onGoToEvents={() => vm.requestTab = 'events'}
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
          responseTestSummary={vm.responseTestSummary}
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

  </div>

  <StatusBar
    sidebarHidden={vm.sidebarHidden}
    codePanelOpen={vm.codePanelOpen}
    codePanelAvailable={codePanelAvailable}
    {responseOnRight}
    {responseRightTooNarrow}
    topView={vm.topView}
    gitStatus={vm.gitStatus}
    appVersion={vm.appVersion}
    appRuntime={vm.appRuntime}
    appTheme={vm.appTheme}
    resolvedAppTheme={vm.resolvedAppTheme}
    setThemeMode={vm.setThemeMode}
    setThemeVariant={vm.setThemeVariant}
    onOpenGit={vm.openGitTab}
    onOpenAbout={() => vm.openSettings('about')}
    onToggleSidebar={() => (vm.sidebarHidden = !vm.sidebarHidden)}
    onToggleCodePanel={() => { if (codePanelAvailable) vm.codePanelOpen = !vm.codePanelOpen; }}
  />

  {#if vm.codePanelOpen && codePanelAvailable && lazy.CodeSnippetPanelComponent}
    <lazy.CodeSnippetPanelComponent
      lines={vm.snippetRenderedLines}
      codePanelOpen={vm.codePanelOpen}
      snippetLanguage={vm.snippetLanguage}
      bind:snippetMenuOpen={vm.snippetMenuOpen}
      copiedSnippet={vm.copiedSnippet}
      onSnippetLanguageChange={(lang: SnippetLanguage) => (vm.snippetLanguage = lang)}
      onCopy={vm.copySnippet}
      onResizeStart={vm.startCodePanelResize}
      onDividerKeydown={vm.onCodePanelDividerKeydown}
    />
  {/if}
</main>
