<script lang="ts">
  import { useClock } from '../clock.svelte';
  const now = useClock();
  import Keycaps from './Keycaps.svelte';
  import RequestTypeBadge from './RequestTypeBadge.svelte';
  import { requestTabLabel, statusClass } from '../utils';
  import type { CollectionGroup, FolderGroup, RequestHistoryEntry, SavedRequest, Workspace } from '../types/models';
  import type { SettingsTab } from '../stores/ui';

  let {
    activeWorkspace,
    workspaceBlocked = false,
    defaultWorkspace,
    collectionGroups,
    history,
    environmentCount,
    storedInGit = false,
    shortcutCombo,
    appRuntime = '',
    updateWorkspaceDescription,
    renameWorkspace,
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
  }: {
    activeWorkspace: Workspace | undefined;
    workspaceBlocked?: boolean;
    defaultWorkspace: string;
    collectionGroups: CollectionGroup[];
    history: RequestHistoryEntry[];
    environmentCount: number;
    storedInGit?: boolean;
    shortcutCombo: (id: 'new-request' | 'search' | 'shortcut-help') => string;
    appRuntime?: string;
    updateWorkspaceDescription: (value: string) => void;
    renameWorkspace: () => void;
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

  function inputValue(event: Event): string {
    const target = event.currentTarget;
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : '';
  }
</script>

<section class="workspace-overview">
  <header class="workspace-overview-header">
    <div class="overview-title">
      <h1>{activeWorkspace?.name ?? defaultWorkspace}</h1>
      <p>{summary}. {storedInGit ? 'Stored in a Git repository.' : 'Stored on this machine.'}</p>
    </div>
    <div class="overview-actions">
      <button class="btn btn-ghost overview-text-btn" type="button" onclick={renameWorkspace} disabled={workspaceBlocked}>Rename</button>
      <button class="btn btn-ghost overview-text-btn" type="button" onclick={createWorkspace}>New workspace</button>
    </div>
  </header>

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
              <button class="overview-row" type="button" onclick={() => switchRequest(row.request.id)} disabled={workspaceBlocked}>
                <RequestTypeBadge request={row.request} variant="sidebar" />
                <span class="overview-row-name">{requestTabLabel(row.request)}</span>
                <span class="overview-row-meta">{row.location}</span>
                <span class="overview-row-status {row.statusCode ? statusClass(row.statusCode) : ''}">{row.statusCode || '—'}</span>
                <span class="overview-row-time">{relativeTime(row.createdAt)}</span>
              </button>
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
        <div class="overview-list">
          <button class="overview-row overview-action-row" type="button" onclick={() => createNewRequest()} disabled={workspaceBlocked}>
            <span class="overview-row-name">New request</span>
            {#if shortcutCombo('new-request')}<Keycaps combo={shortcutCombo('new-request')} runtime={appRuntime} />{/if}
          </button>
          <button class="overview-row overview-action-row" type="button" onclick={openGlobalSearch} disabled={workspaceBlocked}>
            <span class="overview-row-name">Search and run commands</span>
            {#if shortcutCombo('search')}<Keycaps combo={shortcutCombo('search')} runtime={appRuntime} />{/if}
          </button>
          <button class="overview-row overview-action-row" type="button" onclick={openImport} disabled={workspaceBlocked}>
            <span class="overview-row-name">Import a collection</span>
          </button>
          <button class="overview-row overview-action-row" type="button" onclick={createCollection} disabled={workspaceBlocked}>
            <span class="overview-row-name">New collection</span>
          </button>
          <button class="overview-row overview-action-row" type="button" onclick={createEnvironment} disabled={workspaceBlocked}>
            <span class="overview-row-name">New environment</span>
          </button>
          <button class="overview-row overview-action-row" type="button" onclick={openCollectionRunner} disabled={workspaceBlocked}>
            <span class="overview-row-name">Run a collection</span>
          </button>
          <button class="overview-row overview-action-row" type="button" onclick={() => openSettings('shortcuts')}>
            <span class="overview-row-name">Keyboard shortcuts</span>
            {#if shortcutCombo('shortcut-help')}<Keycaps combo={shortcutCombo('shortcut-help')} runtime={appRuntime} />{/if}
          </button>
        </div>
      </section>

      <section class="overview-section">
        <h2><label for="overview-notes">Notes</label></h2>
        <textarea
          id="overview-notes"
          class="field field-area overview-notes"
          value={activeWorkspace?.description ?? ''}
          oninput={(event) => updateWorkspaceDescription(inputValue(event))}
          placeholder="Conventions, auth hints, links — anything the next person opening this workspace should know."
          spellcheck="false"
          disabled={workspaceBlocked}
        ></textarea>
      </section>
    </aside>
  </div>
</section>
