<script lang="ts">
  import SaveActions from './SaveActions.svelte';
  import { NAME_MAX_LENGTH } from '../constants';
  import { useClock } from '../clock.svelte';
  const now = useClock();
  import { tick } from 'svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import Keycaps from './Keycaps.svelte';
  import CollapsibleMarkdown from './CollapsibleMarkdown.svelte';
  import { markdownTooLongToPreview } from '../markdown';
  import MenuIcon from './MenuIcon.svelte';
  import RequestTypeBadge from './RequestTypeBadge.svelte';
  import { requestTabLabel, statusClass } from '../utils';
  import type { CollectionGroup, FolderGroup, RequestHistoryEntry, SavedRequest, Workspace } from '../types/models';
  import type { SettingsTab } from '../stores/ui';
  import type { WorkspaceDiagnostic } from '../backend';

  let {
    activeWorkspace,
    workspaceBlocked = false,
    blockingDiagnostics = [],
    editDiagnostic = () => {},
    showWorkspaceIssues = () => {},
    defaultWorkspace,
    collectionGroups,
    history,
    environmentCount,
    storedInGit = false,
    shortcutCombo,
    appRuntime = '',
    updateWorkspaceDescription,
    autosave = true,
    readmeDraft = undefined,
    saveReadme = async () => true,
    discardReadme = () => {},
    setWorkspaceName,
    createWorkspace,
    openSettings,
    createCollection,
    createNewRequest,
    createEnvironment,
    openImport,
    openGlobalSearch,
    openCollectionRunner,
    openCollection,
    switchRequest,
    sendRequest,
  }: {
    activeWorkspace: Workspace | undefined;
    workspaceBlocked?: boolean;
    blockingDiagnostics?: WorkspaceDiagnostic[];
    editDiagnostic?: (diagnostic: WorkspaceDiagnostic) => void;
    showWorkspaceIssues?: () => void;
    defaultWorkspace: string;
    collectionGroups: CollectionGroup[];
    history: RequestHistoryEntry[];
    environmentCount: number;
    storedInGit?: boolean;
    shortcutCombo: (id: 'new-request' | 'search' | 'shortcut-help') => string;
    appRuntime?: string;
    updateWorkspaceDescription: (value: string) => void;
    autosave?: boolean;
    readmeDraft?: string;
    saveReadme?: () => Promise<boolean>;
    discardReadme?: () => void;
    setWorkspaceName: (name: string) => void;
    createWorkspace: () => void;
    openSettings: (tab?: SettingsTab) => void;
    createCollection: () => void;
    createNewRequest: () => void;
    createEnvironment: () => void;
    openImport: () => void;
    openGlobalSearch: () => void;
    openCollectionRunner: () => void;
    openCollection: (collectionId: string) => void;
    switchRequest: (requestId: string) => void;
    sendRequest: (requestId: string) => void;
  } = $props();

  const RECENT_LIMIT = 6;

  type RecentRow = { request: SavedRequest; location: string; statusCode: number; createdAt: number };

  function countFolders(folders: FolderGroup[]): number {
    return folders.reduce((total, folder) => total + 1 + countFolders(folder.children), 0);
  }

  function folderPathFor(request: SavedRequest): string {
    return (request.folderPath ?? []).join(' / ');
  }

  let requestCount = $derived(collectionGroups.reduce((total, group) => total + group.requests.length, 0));

  let recentRows = $derived.by((): RecentRow[] => {
    const byId = new Map<string, { request: SavedRequest; collectionName: string }>(
      collectionGroups.flatMap(group => group.requests.map(request => [request.id, { request, collectionName: group.collection.name }] as const)),
    );
    const rows: RecentRow[] = [];
    for (const entry of [...history].sort((a, b) => b.createdAt - a.createdAt)) {
      const sourceId = entry.sourceRequestId;
      const found = sourceId ? byId.get(sourceId) : undefined;
      if (!sourceId || !found || rows.some(row => row.request.id === sourceId)) continue;
      const folder = folderPathFor(found.request);
      rows.push({
        request: found.request,
        location: folder ? `${found.collectionName} / ${folder}` : found.collectionName,
        statusCode: entry.statusCode,
        createdAt: entry.createdAt,
      });
      if (rows.length >= RECENT_LIMIT) break;
    }
    return rows;
  });

  let summary = $derived([
    `${collectionGroups.length} ${collectionGroups.length === 1 ? 'collection' : 'collections'}`,
    `${requestCount} ${requestCount === 1 ? 'request' : 'requests'}`,
    `${environmentCount} ${environmentCount === 1 ? 'environment' : 'environments'}`,
  ].join(' · '));

  let isEmpty = $derived(collectionGroups.length === 0 && requestCount === 0);

  function relativeTime(timestamp: number): string {
    const seconds = Math.max(0, Math.round((now() - timestamp) / 1000));
    if (seconds < 60) return 'Just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  let renaming = $state(false);
  let nameDraft = $state('');
  let nameInput = $state<HTMLInputElement>();
  let workspaceName = $derived(activeWorkspace?.name ?? defaultWorkspace);

  async function startRename() {
    if (workspaceBlocked || !activeWorkspace) return;
    nameDraft = workspaceName;
    renaming = true;
    await tick();
    nameInput?.select();
  }

  function finishRename(save: boolean) {
    if (!renaming) return;
    renaming = false;
    if (save) setWorkspaceName(nameDraft);
  }

  function onNameKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      finishRename(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finishRename(false);
    }
  }

  function sendsDirectly(request: SavedRequest): boolean {
    const type = request.requestType ?? 'http';
    if (type === 'http') return request.method !== 'SSE';
    return type === 'graphql' || type === 'grpc';
  }


  let readme = $derived(readmeDraft ?? activeWorkspace?.description ?? '');
  let readmeDirty = $derived(!autosave && readmeDraft !== undefined);
  let readmeIssue = $derived(activeWorkspace?.readmeIssue ?? '');
  let readmeTooLarge = $derived(markdownTooLongToPreview(readme));
  let editingReadme = $state(false);

  let readmeInput = $state<HTMLTextAreaElement>();
  let readmeWorkspaceId = $state('');

  $effect(() => {
    const id = activeWorkspace?.id ?? '';
    if (id === readmeWorkspaceId) return;
    readmeWorkspaceId = id;
    editingReadme = false;
  });

  async function editReadme() {
    editingReadme = true;
    await tick();
    readmeInput?.focus();
  }

  function onReadmeKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!readmeDirty) editingReadme = false;
    }
  }

  async function finishReadme() {
    if (await saveReadme()) editingReadme = false;
  }

  function cancelReadme() {
    discardReadme();
    editingReadme = false;
  }

  function inputValue(event: Event): string {
    const target = event.currentTarget;
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : '';
  }
</script>

<section class="workspace-overview">
  <header class="workspace-overview-header">
    <div class="overview-title">
      {#if renaming}
        <input
          class="field overview-name-input"
          maxlength={NAME_MAX_LENGTH}
          bind:this={nameInput}
          bind:value={nameDraft}
          onkeydown={onNameKeydown}
          onblur={() => finishRename(true)}
          aria-label="Workspace name"
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
        />
      {:else}
        <h1>
          <button class="overview-name" type="button" onclick={startRename} disabled={workspaceBlocked || !activeWorkspace} aria-label={`Rename workspace ${workspaceName}`}>
            <span>{workspaceName}</span>
            <MenuIcon name="rename" />
          </button>
        </h1>
      {/if}
      <p>{summary}. {storedInGit ? 'Stored in a Git repository.' : 'Stored on this machine.'}</p>
    </div>
    <div class="overview-actions">
      <button class="btn btn-secondary" type="button" onclick={createWorkspace}><AddCloseIcon add /> New workspace</button>
    </div>
  </header>

  {#if workspaceBlocked && blockingDiagnostics.length}
    {@const first = blockingDiagnostics[0]}
    <div class="overview-blocked" role="alert">
      <div class="overview-blocked-copy">
        <strong>Editing is paused: {blockingDiagnostics.length} workspace {blockingDiagnostics.length === 1 ? 'file needs' : 'files need'} fixing</strong>
        <p>Kurlo will not save or change anything in this workspace until {blockingDiagnostics.length === 1 ? 'it is' : 'they are'} fixed, so nothing on disk is overwritten.</p>
        <p class="overview-blocked-file"><code>{first.path}</code> — {first.message}</p>
      </div>
      <div class="overview-blocked-actions">
        <button class="btn btn-primary btn-sm" type="button" onclick={() => editDiagnostic(first)}><MenuIcon name="rename" />Edit YAML</button>
        <button class="btn btn-secondary btn-sm" type="button" onclick={showWorkspaceIssues}>Show all issues</button>
      </div>
    </div>
  {/if}

  {#if isEmpty}
    <div class="overview-first-run">
      <h2>Send your first request</h2>
      <p>Open a new request and paste a URL or a whole cURL command — Kurlo fills in the method, headers and body. Or bring in what you already have.</p>
      <div class="overview-first-run-actions">
        <button class="btn btn-primary" type="button" onclick={() => createNewRequest()} disabled={workspaceBlocked}>New request</button>
        <button class="btn btn-secondary" type="button" onclick={openImport} disabled={workspaceBlocked}>Import collection</button>
        <button class="btn btn-secondary" type="button" onclick={createCollection} disabled={workspaceBlocked}>New collection</button>
      </div>
      <p class="overview-first-run-note">Import reads Postman, Insomnia, OpenAPI, Bruno / OpenCollection and HAR.</p>
    </div>
  {/if}

  <div class="overview-columns">
    <div class="overview-main">
      {#if recentRows.length}
        <section class="overview-section" aria-labelledby="overview-recent-title">
          <h2 id="overview-recent-title">Continue where you left off</h2>
          <div class="overview-list">
            {#each recentRows as row (row.request.id)}
              <div class="overview-recent-row">
                <button class="overview-row" type="button" onclick={() => switchRequest(row.request.id)} disabled={workspaceBlocked}>
                  <RequestTypeBadge request={row.request} variant="sidebar" />
                  <span class="overview-row-name">{requestTabLabel(row.request)}</span>
                  <span class="overview-row-meta">{row.location}</span>
                  <span class="overview-row-status {row.statusCode ? statusClass(row.statusCode) : ''}">{row.statusCode || '—'}</span>
                  <span class="overview-row-time">{relativeTime(row.createdAt)}</span>
                </button>
                {#if sendsDirectly(row.request)}
                  <button class="btn btn-secondary btn-sm overview-send" type="button" onclick={() => sendRequest(row.request.id)} disabled={workspaceBlocked} aria-label={`Send ${requestTabLabel(row.request)}`}><MenuIcon name="play" />Send</button>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if collectionGroups.length}
        <section class="overview-section" aria-labelledby="overview-collections-title">
          <h2 id="overview-collections-title">Collections</h2>
          <div class="overview-list">
            {#each collectionGroups as group (group.collection.id)}
              {@const folders = countFolders(group.folders)}
              <button class="overview-row overview-collection-row" type="button" onclick={() => openCollection(group.collection.id)} disabled={workspaceBlocked || group.collection.isInvalid}>
                <svg class="overview-row-icon" width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                </svg>
                <span class="overview-row-name">{group.collection.name}</span>
                <span class="overview-row-meta">
                  {#if group.collection.isInvalid}
                    Needs fixing — open it from the sidebar
                  {:else}
                    {group.requests.length} {group.requests.length === 1 ? 'request' : 'requests'}{folders ? ` · ${folders} ${folders === 1 ? 'folder' : 'folders'}` : ''}
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        </section>
      {/if}
    </div>

    <aside class="overview-side">
      <section class="overview-section" aria-labelledby="overview-start-title">
        <h2 id="overview-start-title">Start</h2>
        <div class="overview-tiles">
          <button class="overview-tile" type="button" onclick={() => createNewRequest()} disabled={workspaceBlocked}>
            <MenuIcon name="request" /><span>New request</span>
            {#if shortcutCombo('new-request')}<Keycaps combo={shortcutCombo('new-request')} runtime={appRuntime} />{/if}
          </button>
          <button class="overview-tile" type="button" onclick={openGlobalSearch} disabled={workspaceBlocked}>
            <MenuIcon name="replace" /><span>Search</span>
            {#if shortcutCombo('search')}<Keycaps combo={shortcutCombo('search')} runtime={appRuntime} />{/if}
          </button>
          <button class="overview-tile" type="button" onclick={openImport} disabled={workspaceBlocked}>
            <MenuIcon name="import" /><span>Import</span>
          </button>
          <button class="overview-tile" type="button" onclick={openCollectionRunner} disabled={workspaceBlocked}>
            <MenuIcon name="play" /><span>Run collection</span>
          </button>
          <button class="overview-tile" type="button" onclick={createCollection} disabled={workspaceBlocked}>
            <MenuIcon name="collection-add" /><span>New collection</span>
          </button>
          <button class="overview-tile" type="button" onclick={createEnvironment} disabled={workspaceBlocked}>
            <svg class="menu-icon" width="0.9375rem" height="0.9375rem" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 2.5c-1.5 0-2 .6-2 1.8v1.5c0 1-.5 1.6-1.5 2.2 1 .6 1.5 1.2 1.5 2.2v1.5c0 1.2.5 1.8 2 1.8M10.5 2.5c1.5 0 2 .6 2 1.8v1.5c0 1 .5 1.6 1.5 2.2-1 .6-1.5 1.2-1.5 2.2v1.5c0 1.2-.5 1.8-2 1.8"/></svg><span>New environment</span>
          </button>
        </div>
        <button class="btn btn-ghost btn-sm overview-shortcuts-link" type="button" onclick={() => openSettings('shortcuts')}>
          Keyboard shortcuts
          {#if shortcutCombo('shortcut-help')}<Keycaps combo={shortcutCombo('shortcut-help')} runtime={appRuntime} />{/if}
        </button>
      </section>

      <section class="overview-section overview-readme" aria-labelledby="overview-readme-title">
        <div class="overview-section-head">
          <h2 id="overview-readme-title">README</h2>
          {#if readmeIssue}
            <span class="overview-readme-readonly">Read-only</span>
          {:else if editingReadme && !autosave}
            <div class="overview-readme-actions">
              <button class="btn btn-secondary btn-sm" type="button" onclick={() => (editingReadme = false)}>Done</button>
              <SaveActions saveDirty={readmeDirty} canRevert={readmeDirty} disabled={workspaceBlocked} onSave={() => void finishReadme()} onRevert={cancelReadme} />
            </div>
          {:else if editingReadme}
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => (editingReadme = false)}>Done</button>
          {:else if readmeDirty}
            <div class="overview-readme-actions">
              <button class="btn btn-ghost btn-sm" type="button" onclick={editReadme} disabled={workspaceBlocked}><MenuIcon name="rename" />Edit</button>
              <SaveActions saveDirty={readmeDirty} canRevert={readmeDirty} disabled={workspaceBlocked} onSave={() => void saveReadme()} onRevert={cancelReadme} />
            </div>
          {:else if readme.trim()}
            <button class="btn btn-ghost btn-sm" type="button" onclick={editReadme} disabled={workspaceBlocked}><MenuIcon name="rename" />Edit</button>
          {/if}
        </div>
        {#if readmeIssue}
          <p class="overview-readme-issue" role="status">{readmeIssue}</p>
        {:else if editingReadme}
          <textarea
            class="field field-area overview-readme-input"
            bind:this={readmeInput}
            value={readme}
            oninput={(event) => updateWorkspaceDescription(inputValue(event))}
            onkeydown={onReadmeKeydown}
            aria-label="README"
            placeholder={'# How to use this workspace\n\nRun **Login** first — it sets {{token}}.\nstage is free to break, prod is protected.'}
            spellcheck="false"
            disabled={workspaceBlocked}
          ></textarea>
          {#if readmeTooLarge}
            <p class="overview-readme-hint error" role="alert">README is over 256 KB. Kurlo still saves it, but shows it read-only until it is shorter.</p>
          {:else}
            <p class="overview-readme-hint">Markdown. Saved as README.md in the workspace folder{storedInGit ? ', so your Git host shows it too' : ''}.</p>
          {/if}
        {:else if readme.trim()}
          <CollapsibleMarkdown source={readme} resetKey={readmeWorkspaceId} />
        {:else}
          <div class="overview-readme-empty">
            <p>Conventions, auth hints, links — anything the next person opening this workspace should know.</p>
            <button class="btn btn-secondary btn-sm" type="button" onclick={editReadme} disabled={workspaceBlocked}><AddCloseIcon add /> Write README</button>
          </div>
        {/if}
      </section>
    </aside>
  </div>
</section>
