<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import Keycaps from './Keycaps.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import { tabListKeyboard } from '../a11y';
  import { middleClick } from '../middleClick';
  import RequestTypeBadge from './RequestTypeBadge.svelte';
  import WindowControls from './WindowControls.svelte';
  import { MAX_WORKSPACES } from '../constants';
  import type { Collection, Environment, SavedRequest, SidebarView, Workspace } from '../types/models';
  import type { TopView } from '../stores/ui';

  let {
    workspaceSearch = $bindable(''),
    workspaceMenuOpen = $bindable(false),
    topView = $bindable<TopView>('request'),
    environmentMenuOpen = $bindable(false),
    // eslint-disable-next-line no-useless-assignment
    sidebarView = $bindable<SidebarView>('collections'),
    codePanelOpen = $bindable(false),
    codePanelAvailable = true,
    defaultWorkspace,
    activeWorkspace,
    workspaces,
    activeWorkspaceId,
    openRequests,
    activeRequestId,
    activeWorkspaceEnvironments,
    activeEnvironmentId,
    dirtyRequestIds,
    collectionRunnerOpen = false,
    collectionRunnerRunning = false,
    activeCollectionSettings,
    historyDetailOpen = false,
    gitTabOpen = false,
    mockTabOpen = false,
    mockRunning = false,
    gitChangeCount = 0,
    autosave,
    appRuntime = '',
    workspaceBlocked = false,
    toggleWorkspaceMenu,
    createWorkspace,
    switchWorkspace,
    workspaceCollectionCountFor,
    workspaceRequestCountFor,
    deleteWorkspace,
    openGlobalSearch,
    closeCollectionRunner,
    closeCollectionSettings,
    closeHistoryDetail,
    openGitTab,
    closeGitTab,
    openMockTab,
    closeMockTab,
    requestTabLabel,
    switchRequest,
    closeRequestTab,
    createDraftRequest,
    toggleEnvironmentMenu,
    environmentLabel,
    useEnvironment,
    environmentHasValues,
    environmentValueCount,
  }: {
    workspaceSearch: string;
    workspaceMenuOpen: boolean;
    topView: TopView;
    environmentMenuOpen: boolean;
    sidebarView: SidebarView;
    codePanelOpen: boolean;
    codePanelAvailable?: boolean;
    defaultWorkspace: string;
    activeWorkspace: Workspace | undefined;
    workspaces: Workspace[];
    activeWorkspaceId: string;
    openRequests: SavedRequest[];
    activeRequestId: string;
    activeWorkspaceEnvironments: Environment[];
    activeEnvironmentId: string;
    dirtyRequestIds: string[];
    collectionRunnerOpen?: boolean;
    collectionRunnerRunning?: boolean;
    activeCollectionSettings?: Collection;
    historyDetailOpen?: boolean;
    gitTabOpen?: boolean;
    mockTabOpen?: boolean;
    mockRunning?: boolean;
    gitChangeCount?: number;
    autosave: boolean;
    appRuntime?: string;
    workspaceBlocked?: boolean;
    toggleWorkspaceMenu: (event: MouseEvent) => void;
    createWorkspace: () => void;
    switchWorkspace: (workspaceId: string) => void;
    workspaceCollectionCountFor: (workspaceId: string) => number;
    workspaceRequestCountFor: (workspaceId: string) => number;
    deleteWorkspace: (workspaceId: string) => void;
    openGlobalSearch: () => void;
    closeCollectionRunner: () => void;
    closeCollectionSettings: () => void;
    closeHistoryDetail: () => void;
    openGitTab: () => void;
    closeGitTab: () => void;
    openMockTab: () => void;
    closeMockTab: () => void;
    requestTabLabel: (request: SavedRequest) => string;
    switchRequest: (id: string) => void;
    closeRequestTab: (id: string) => void;
    createDraftRequest: () => void;
    toggleEnvironmentMenu: (event: MouseEvent) => void;
    environmentLabel: () => string;
    useEnvironment: (environmentId: string) => void;
    environmentHasValues: (environment: Environment) => boolean;
    environmentValueCount: (environment: Environment) => number;
  } = $props();

  let dirtyRequestIdSet = $derived(new Set(dirtyRequestIds));
  let workspaceLimitReached = $derived(workspaces.length >= MAX_WORKSPACES);
  let filteredWorkspaces = $derived(workspaces.filter(workspace => !workspaceSearch.trim() || workspace.name.toLowerCase().includes(workspaceSearch.trim().toLowerCase())));

  let tabListEl = $state<HTMLDivElement>();
  let tabsOverflowing = $state(false);
  let tabsHiddenBefore = $state(false);
  let tabsHiddenAfter = $state(false);
  let tabMenuOpen = $state(false);

  $effect(() => {
    const list = tabListEl;
    if (!list) return;
    const measure = () => {
      tabsOverflowing = list.scrollWidth > list.clientWidth + 1;
      tabsHiddenBefore = list.scrollLeft > 1;
      tabsHiddenAfter = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    const mutations = new MutationObserver(measure);
    mutations.observe(list, { childList: true });
    list.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => { observer.disconnect(); mutations.disconnect(); list.removeEventListener('scroll', measure); };
  });

  $effect(() => {
    if (!tabsOverflowing) tabMenuOpen = false;
  });

  function closeTabMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (!(current instanceof HTMLElement)) return;
    if (!(next instanceof Node) || !current.contains(next)) tabMenuOpen = false;
  }

  function onTabMenuKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      tabMenuOpen = false;
    }
  }

  function pickTab(select: () => void) {
    select();
    tabMenuOpen = false;
  }
  $effect(() => {
    topView;
    activeRequestId;
    openRequests.length;
    const list = tabListEl;
    if (!list) return;
    queueMicrotask(() => {
      list.querySelector<HTMLElement>('.saved-request-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  });

</script>

<div class="workspace-searchbar titlebar-drag-region">
  <div class="workspace-searchbar-left">
    <div class="workspace-switcher">
      <button class="btn btn-ghost workspace-switcher-trigger" type="button" onclick={toggleWorkspaceMenu} aria-label="Workspace switcher" aria-expanded={workspaceMenuOpen} title={`Workspace: ${activeWorkspace?.name ?? defaultWorkspace}`}>
        <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
          <path d="M4.5 6V4.2a3 3 0 016 0V6M3.2 6h8.6v6.2H3.2V6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
        </svg>
        <span>{activeWorkspace?.name ?? defaultWorkspace}</span>
        <svg width="0.625rem" height="0.4375rem" viewBox="0 0 10 7" fill="none" aria-hidden="true">
          <path d="M1.5 2L5 5.5L8.5 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      {#if workspaceMenuOpen}
        <div class="workspace-menu">
          <div class="workspace-menu-top">
            <input class="field field-md" bind:value={workspaceSearch} placeholder="Search workspaces..." spellcheck="false" />
            <button class="btn btn-secondary"
              type="button"
              onclick={createWorkspace}
              disabled={workspaceLimitReached}
              title={workspaceLimitReached ? `Limit: ${MAX_WORKSPACES} workspaces in this storage` : 'Create workspace'}
            >Create</button>
          </div>
          <div class="workspace-menu-limit" class:limit-reached={workspaceLimitReached}>
            {workspaces.length}/{MAX_WORKSPACES} workspaces
          </div>
          <div class="workspace-menu-list">
            {#each filteredWorkspaces as workspace, eachIndex (eachIndex)}
              <div class="workspace-menu-item" class:active={workspace.id === activeWorkspaceId} class:invalid={workspace.isInvalid}>
                <button class="workspace-menu-select" type="button" onclick={() => switchWorkspace(workspace.id)} title={workspace.isInvalid ? 'Open the Git tab to fix this workspace YAML' : 'Open workspace'}>
                  <span class="workspace-lock">
                    {#if workspace.isInvalid}
                      <span class="workspace-menu-badge" aria-hidden="true">!</span>
                    {:else}
                      <svg width="0.875rem" height="0.875rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                        <path d="M4.5 6V4.3a3 3 0 016 0V6M3.2 6h8.6v6.2H3.2V6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
                      </svg>
                    {/if}
                  </span>
                  <span>{workspace.name}</span>
                  <small>{workspace.isInvalid ? 'Fix workspace.yml first' : `${workspaceCollectionCountFor(workspace.id)} collections · ${workspaceRequestCountFor(workspace.id)} requests`}</small>
                </button>
                {#if workspaces.length >= 2}
                  <button class="btn btn-ghost btn-danger btn-icon workspace-delete-btn" type="button" onclick={(event) => { event.stopPropagation(); deleteWorkspace(workspace.id); }} aria-label="Delete workspace" title={workspace.isInvalid ? 'Fix workspace.yml before deleting this workspace' : 'Delete workspace'} disabled={workspaceBlocked || workspace.isInvalid}>
                    <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                      <path d="M2 3.5h9M5 3.5V2.5h3v1M3.5 3.5l.5 7h5l.5-7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </button>
                {/if}
              </div>
            {/each}
          </div>
          <button class="workspace-menu-footer" type="button" onclick={() => { workspaceMenuOpen = false; topView = 'overview'; }}>
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 2h4v4H2V2zM8 2h4v4H8V2zM2 8h4v4H2V8zM8 8h4v4H8V8z" stroke="currentColor" stroke-width="1.2"/>
            </svg>
            View all workspaces
          </button>
        </div>
      {/if}
    </div>
  </div>
  <div class="request-tab-strip">
    <div class="saved-request-tabs" class:fade-start={tabsHiddenBefore} class:fade-end={tabsHiddenAfter} role="tablist" use:tabListKeyboard bind:this={tabListEl}>
      <div class="saved-request-tab overview-request-tab" class:active={topView === 'overview'}>
        <button class="saved-request-tab-btn" role="tab" type="button" aria-label="Overview" title="Overview" aria-selected={topView === 'overview'} tabindex={topView === 'overview' ? 0 : -1} onclick={() => (topView = 'overview')}>
          <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M2 8.2h4.5M2 4.2h11M2 12.2h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          <span class="tab-title">Overview</span>
        </button>
      </div>
      {#if collectionRunnerOpen}
        <div class="saved-request-tab runner-tab" class:active={topView === 'runner'} class:dirty={collectionRunnerRunning} use:middleClick={workspaceBlocked ? undefined : closeCollectionRunner}>
          <button class="saved-request-tab-btn" role="tab" type="button" aria-selected={topView === 'runner'} tabindex={topView === 'runner' ? 0 : -1} onclick={() => (topView = 'runner')} disabled={workspaceBlocked}>
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="14.5" cy="4.5" r="2" stroke="currentColor" stroke-width="1.8"/>
              <path d="M9.5 9.5l3.4-1.8 2.4 3.1 3.2.6M12.2 10.6l-2 4.2-4 1.4M14.7 13.2l-1 3.7 2.5 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="tab-title">Runner</span>
          </button>
          <button class="tab-close" type="button" onclick={closeCollectionRunner} aria-label="Close runner tab" disabled={workspaceBlocked}><svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
        </div>
      {/if}
      {#if gitTabOpen}
        <div class="saved-request-tab runner-tab git-workspace-tab" class:active={topView === 'git'} class:dirty={gitChangeCount > 0} use:middleClick={closeGitTab}>
          <button class="saved-request-tab-btn" role="tab" type="button" aria-selected={topView === 'git'} tabindex={topView === 'git' ? 0 : -1} onclick={openGitTab}>
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <path d="M4 12.2V4.8a2 2 0 114 0v5.4a2 2 0 104 0V3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
            </svg>
            <span class="tab-title">Git</span>
            {#if gitChangeCount > 0}
              <span class="git-tab-count">{gitChangeCount > 99 ? '99+' : gitChangeCount}</span>
            {/if}
          </button>
          <button class="tab-close" type="button" onclick={closeGitTab} aria-label="Close Git tab"><svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
        </div>
      {/if}
      {#if mockTabOpen}
        <div class="saved-request-tab runner-tab" class:active={topView === 'mock'} use:middleClick={closeMockTab}>
          <button class="saved-request-tab-btn" role="tab" type="button" aria-selected={topView === 'mock'} tabindex={topView === 'mock' ? 0 : -1} onclick={openMockTab}>
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <rect x="2" y="3" width="11" height="9" rx="1.6" stroke="currentColor" stroke-width="1.35"/>
              <path d="M2 6.2h11" stroke="currentColor" stroke-width="1.35"/>
            </svg>
            <span class="tab-title">Mock</span>
            {#if mockRunning}
              <span class="mock-tab-dot" aria-label="Mock server is running"></span>
            {/if}
          </button>
          <button class="tab-close" type="button" onclick={closeMockTab} aria-label="Close Mock tab"><svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
        </div>
      {/if}
      {#if activeCollectionSettings}
        <div class="saved-request-tab runner-tab" class:active={topView === 'collection'} use:middleClick={workspaceBlocked ? undefined : closeCollectionSettings}>
          <button class="saved-request-tab-btn" role="tab" type="button" aria-selected={topView === 'collection'} tabindex={topView === 'collection' ? 0 : -1} onclick={() => (topView = 'collection')} disabled={workspaceBlocked}>
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <path d="M2.2 4h3.3l1.2 1.2h6.1v6.1a1.2 1.2 0 01-1.2 1.2H3.4a1.2 1.2 0 01-1.2-1.2V4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
              <path d="M5 8.2h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
            <span class="tab-title">{activeCollectionSettings.name}</span>
          </button>
          <button class="tab-close" type="button" onclick={closeCollectionSettings} aria-label="Close collection settings" disabled={workspaceBlocked}><svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
        </div>
      {/if}
      {#if historyDetailOpen}
        <div class="saved-request-tab runner-tab" class:active={topView === 'history'} use:middleClick={closeHistoryDetail}>
          <button class="saved-request-tab-btn" role="tab" type="button" aria-selected={topView === 'history'} tabindex={topView === 'history' ? 0 : -1} onclick={() => (topView = 'history')}>
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <circle cx="7.5" cy="7.5" r="5.5" stroke="currentColor" stroke-width="1.35"/>
              <path d="M7.5 4.6v3.1l2 1.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="tab-title">History</span>
          </button>
          <button class="tab-close" type="button" onclick={closeHistoryDetail} aria-label="Close history entry"><svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
        </div>
      {/if}
      {#each openRequests as req, eachIndex (eachIndex)}
        {@const unsaved = req.isDraft ? 'Unsaved draft' : !autosave && dirtyRequestIdSet.has(req.id) ? 'Unsaved changes' : ''}
        <div class="saved-request-tab" class:active={req.id === activeRequestId && topView === 'request'} class:draft={req.isDraft} class:dirty={!autosave && !req.isDraft && dirtyRequestIdSet.has(req.id)} class:unsaved={Boolean(unsaved)} title={unsaved || undefined} use:middleClick={workspaceBlocked ? undefined : () => closeRequestTab(req.id)}>
          <button class="saved-request-tab-btn" role="tab" type="button" aria-selected={req.id === activeRequestId && topView === 'request'} tabindex={req.id === activeRequestId && topView === 'request' ? 0 : -1} onclick={() => switchRequest(req.id)} disabled={workspaceBlocked}>
            <RequestTypeBadge request={req} variant="tab" />
            <span class="tab-title">{requestTabLabel(req)}</span>
            {#if unsaved}<span class="sr-only">({unsaved})</span>{/if}
          </button>
          <button class="tab-close" type="button" onclick={() => closeRequestTab(req.id)} aria-label="Close tab" disabled={workspaceBlocked}><svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
        </div>
      {/each}
    </div>
    <button class="btn btn-ghost btn-icon tabbar-icon new-request-tab-btn" type="button" onclick={() => createDraftRequest()} title={workspaceBlocked ? 'Fix workspace YAML before creating requests' : 'New unsaved request'} aria-label="New unsaved request" disabled={workspaceBlocked}>+</button>
    {#if tabsOverflowing}
      <div class="tab-overflow" onfocusout={closeTabMenuOnFocusOut} onkeydown={onTabMenuKeydown} role="presentation">
        <button class="btn btn-ghost btn-icon tabbar-icon tab-overflow-btn" class:active={tabMenuOpen} type="button" onclick={() => (tabMenuOpen = !tabMenuOpen)} aria-label="All open tabs" title="All open tabs" aria-haspopup="listbox" aria-expanded={tabMenuOpen}>
          <svg width="0.75rem" height="0.5rem" viewBox="0 0 12 8" fill="none" aria-hidden="true">
            <path d="M1.5 2l4.5 4.5L10.5 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        {#if tabMenuOpen}
          <div class="menu tab-overflow-menu" role="listbox" aria-label="Open tabs">
            <button class="menu-item" role="option" class:active={topView === 'overview'} aria-selected={topView === 'overview'} type="button" onclick={() => pickTab(() => (topView = 'overview'))}>
              <span class="tab-overflow-name">Overview</span>
            </button>
            {#if collectionRunnerOpen}
              <button class="menu-item" role="option" class:active={topView === 'runner'} aria-selected={topView === 'runner'} type="button" onclick={() => pickTab(() => (topView = 'runner'))} disabled={workspaceBlocked}>
                <span class="tab-overflow-name">Runner</span>
              </button>
            {/if}
            {#if gitTabOpen}
              <button class="menu-item" role="option" class:active={topView === 'git'} aria-selected={topView === 'git'} type="button" onclick={() => pickTab(openGitTab)}>
                <span class="tab-overflow-name">Git</span>
              </button>
            {/if}
            {#if mockTabOpen}
              <button class="menu-item" role="option" class:active={topView === 'mock'} aria-selected={topView === 'mock'} type="button" onclick={() => pickTab(openMockTab)}>
                <span class="tab-overflow-name">Mock</span>
              </button>
            {/if}
            {#if activeCollectionSettings}
              <button class="menu-item" role="option" class:active={topView === 'collection'} aria-selected={topView === 'collection'} type="button" onclick={() => pickTab(() => (topView = 'collection'))} disabled={workspaceBlocked}>
                <span class="tab-overflow-name">{activeCollectionSettings.name}</span>
              </button>
            {/if}
            {#if historyDetailOpen}
              <button class="menu-item" role="option" class:active={topView === 'history'} aria-selected={topView === 'history'} type="button" onclick={() => pickTab(() => (topView = 'history'))}>
                <span class="tab-overflow-name">History</span>
              </button>
            {/if}
            {#each openRequests as req (req.id)}
              <button class="menu-item" role="option" class:active={req.id === activeRequestId && topView === 'request'} aria-selected={req.id === activeRequestId && topView === 'request'} type="button" onclick={() => pickTab(() => switchRequest(req.id))} disabled={workspaceBlocked}>
                <RequestTypeBadge request={req} variant="tab" />
                <span class="tab-overflow-name">{requestTabLabel(req)}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
  <button class="global-search" type="button" onclick={openGlobalSearch} disabled={workspaceBlocked} title={workspaceBlocked ? 'Fix workspace YAML before searching requests' : 'Search requests and run commands'}>
    <svg width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7.5" stroke="currentColor" stroke-width="2"/>
      <path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <span class="global-search-label">Search requests…</span>
    {#if vm.shortcutCombo('search')}<Keycaps combo={vm.shortcutCombo('search')} runtime={appRuntime} />{/if}
  </button>
  <div class="searchbar-right">
    <div class="environment-switcher">
      <button class="btn btn-ghost select-trigger environment-select" class:env-none={!activeEnvironmentId} type="button" onclick={toggleEnvironmentMenu} aria-expanded={environmentMenuOpen} disabled={workspaceBlocked} title={`Environment: ${environmentLabel()}`}>
        <svg class="environment-select-icon" width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>
        </svg>
        <span>{environmentLabel()}</span>
        <svg width="0.625rem" height="0.4375rem" viewBox="0 0 10 7" fill="none" aria-hidden="true">
          <path d="M1.5 2L5 5.5L8.5 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      {#if environmentMenuOpen}
        <div class="menu environment-menu">
          <button class="menu-item" class:active={!activeEnvironmentId} type="button" onclick={() => useEnvironment('')} disabled={workspaceBlocked}>
            <span class="environment-menu-dot none" aria-hidden="true"></span>
            <span class="environment-menu-name">No environment</span>
          </button>
          {#each activeWorkspaceEnvironments as environment, eachIndex (eachIndex)}
            <button class="menu-item" class:active={environment.id === activeEnvironmentId} type="button" onclick={() => useEnvironment(environment.id)} disabled={workspaceBlocked}>
              <span class="environment-menu-dot" class:in-use={environment.id === activeEnvironmentId} aria-hidden="true"></span>
              <span class="environment-menu-name">{environment.name}</span>
              {#if environmentHasValues(environment)}<small>{environmentValueCount(environment)}</small>{/if}
            </button>
          {/each}
          <div class="menu-separator" role="separator"></div>
          <button class="menu-item" type="button" onclick={() => { environmentMenuOpen = false; sidebarView = 'environments'; topView = 'environment'; }} disabled={workspaceBlocked}>
            <MenuIcon name="settings" />
            <span class="environment-menu-name">Manage environments</span>
          </button>
        </div>
      {/if}
    </div>
    {#if codePanelAvailable}
      <button class="btn btn-ghost btn-icon tabbar-icon" class:active={codePanelOpen} type="button" onclick={() => (codePanelOpen = !codePanelOpen)} title="Code snippet" aria-label="Code snippet">
        &lt;/&gt;
      </button>
    {/if}
    <WindowControls />
  </div>
</div>
