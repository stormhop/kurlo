<script lang="ts">
  import type { MockRequestLog, MockRoute, MockServerStatus } from '../backend';
  import { methodColor, statusClass } from '../utils';
  import { mockRouteConflicts, mockRouteLabel } from '../mockRoutes';
  import Select from './Select.svelte';

  let {
    status,
    routes,
    collections,
    selectedCollectionId,
    port,
    simulateLatency,
    busy,
    error,
    log,
    onToggle,
    onSelectCollection,
    onPortChange,
    onSimulateLatencyChange,
    onClearLog,
    onCopy,
    onOpenExample,
  }: {
    status: MockServerStatus;
    routes: MockRoute[];
    collections: Array<{ id: string; name: string; exampleCount: number }>;
    selectedCollectionId: string;
    port: number;
    simulateLatency: boolean;
    busy: boolean;
    error: string;
    log: MockRequestLog[];
    onToggle: () => void;
    onSelectCollection: (id: string) => void;
    onPortChange: (port: number) => void;
    onSimulateLatencyChange: (value: boolean) => void;
    onClearLog: () => void;
    onCopy: (text: string) => void;
    onOpenExample: (exampleId: string) => void;
  } = $props();

  let filter = $state('');
  let copied = $state('');
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  const collectionOptions = $derived(collections.map(collection => ({
    value: collection.id,
    label: `${collection.name} — ${collection.exampleCount} example${collection.exampleCount === 1 ? '' : 's'}`,
  })));

  const conflicts = $derived(mockRouteConflicts(routes));
  const conflictCount = $derived([...conflicts.values()].reduce((total, count) => total + count - 1, 0));

  const filteredRoutes = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return routes;
    return routes.filter(route =>
      mockRouteLabel(route).toLowerCase().includes(needle)
      || route.exampleName.toLowerCase().includes(needle)
      || route.requestName.toLowerCase().includes(needle)
      || String(route.statusCode).includes(needle));
  });

  const reversedLog = $derived([...log].reverse());
  const unmatchedCount = $derived(log.filter(entry => !entry.matched).length);
  const servedElsewhere = $derived(
    status.running && status.collectionId !== '' && status.collectionId !== selectedCollectionId,
  );
  const canStart = $derived(routes.length > 0 && collections.length > 0);

  function routeUrl(route: MockRoute) {
    return `${status.url}${route.pathTemplate}`;
  }

  function isConflicting(route: MockRoute) {
    return conflicts.has(`${mockRouteLabel(route)}|${JSON.stringify(route.query.map(pair => [pair.key, pair.value]))}`);
  }

  function copy(text: string, token: string) {
    onCopy(text);
    copied = token;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = ''), 1400);
  }

  function formatTime(timestamp: number) {
    return new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false });
  }

  function portValue(event: Event) {
    return event.currentTarget instanceof HTMLInputElement ? Number(event.currentTarget.value) : port;
  }

  function exampleLabel(requestName: string, exampleName: string) {
    if (!exampleName || /^\d{3}(\s+[A-Za-z' -]*)?$/.test(exampleName.trim())) return requestName || exampleName;
    return requestName ? `${requestName} · ${exampleName}` : exampleName;
  }
</script>

<div class="mock-shell">
<section class="mock-workspace" aria-label="Mock server">
  <aside class="mock-config">
    <div class="mock-title">
      <span class="mock-glyph" aria-hidden="true">
        <svg width="1.1875rem" height="1.1875rem" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="5" width="18" height="14" rx="2.4" stroke="currentColor" stroke-width="1.8"/>
          <path d="M3 10h18" stroke="currentColor" stroke-width="1.8"/>
          <circle cx="6.6" cy="7.5" r="0.95" fill="currentColor"/>
        </svg>
      </span>
      <div>
        <h2>Mock server</h2>
        <p>{routes.length} example{routes.length === 1 ? '' : 's'} ready to serve</p>
      </div>
    </div>

    {#if status.running}
      <div class="mock-live">
        <div class="mock-live-head">
          <span class="mock-pulse" aria-hidden="true"></span>
          <span class="mock-live-label">Running</span>
          {#if simulateLatency}<span class="mock-chip">recorded latency</span>{/if}
        </div>
        <button
          class="mock-url"
          type="button"
          title="Copy the base URL"
          onclick={() => copy(status.url, 'base')}
        >
          <code>{status.url}</code>
          <span class="mock-url-action">{copied === 'base' ? 'Copied' : 'Copy'}</span>
        </button>
        <p class="mock-live-meta">
          Serving {status.routeCount} example{status.routeCount === 1 ? '' : 's'} from
          <strong>{status.collectionName || 'this collection'}</strong>. Edits to those examples reload automatically.
        </p>
      </div>
    {/if}

    {#if error}
      <p class="mock-error" role="alert">{error}</p>
    {/if}

    {#if servedElsewhere}
      <p class="mock-hint">
        The server is serving <strong>{status.collectionName}</strong>. Starting again switches it to the collection below.
      </p>
    {/if}

    <label class="mock-field">
      <span>Collection</span>
      <Select
        value={selectedCollectionId}
        options={collectionOptions}
        className="mock-select"
        disabled={!collections.length}
        onChange={onSelectCollection}
      />
    </label>

    <label class="mock-field">
      <span>Port</span>
      <input class="field"
        type="number"
        min="1"
        max="65535"
        value={port}
        placeholder="3100"
        onchange={(event) => onPortChange(portValue(event))}
      />
    </label>

    <label class="mock-toggle-row">
      <input
        class="check"
        type="checkbox"
        checked={simulateLatency}
        onchange={(event) => onSimulateLatencyChange(event.currentTarget instanceof HTMLInputElement && event.currentTarget.checked)}
      />
      <span>
        Reproduce recorded response times
        <small>Each example knows how long the real call took.</small>
      </span>
    </label>

    {#if conflictCount > 0}
      <p class="mock-warn">
        {conflictCount} example{conflictCount === 1 ? '' : 's'} answer a request another one already claims. The first match wins — give them different paths or query values to reach the rest.
      </p>
    {/if}

    <div class="mock-actions">
      {#if status.running}
        <button class="btn btn-secondary btn-lg" type="button" onclick={onToggle} disabled={busy}>Stop</button>
      {:else}
        <button class="btn btn-primary btn-lg" type="button" onclick={onToggle} disabled={busy || !canStart}>
          Start server
        </button>
      {/if}
    </div>

    {#if !canStart && !status.running}
      <p class="mock-hint">
        Nothing to serve yet. Send a request, then use <strong>Save as example</strong> in the response panel — the mock replays what you captured.
      </p>
    {/if}
  </aside>

  <section class="mock-main">
    <div class="mock-panes">
      <div class="mock-pane-wrap">
        <div class="mock-pane-head">
          <span class="mock-pane-title">Routes <span class="mock-count">{routes.length}</span></span>
          <input
            class="field field-md mock-filter"
            placeholder="Filter routes"
            value={filter}
            oninput={(event) => (filter = event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : '')}
          />
        </div>
        <div class="mock-pane">
        {#if routes.length === 0}
          <div class="empty-state mock-empty">
            <strong class="empty-state-title">No examples in this collection</strong>
            <span class="empty-state-text">Capture a response as an example and it becomes a route here.</span>
          </div>
        {:else if filteredRoutes.length === 0}
          <div class="empty-state mock-empty"><strong class="empty-state-title">No route matches “{filter}”</strong></div>
        {:else}
          {#each filteredRoutes as route (route.exampleId)}
            <div class="mock-row" class:conflict={isConflicting(route)}>
              <span class="collection-method {methodColor(route.method)}">{route.method.toUpperCase()}</span>
              <code class="mock-path">{route.pathTemplate}</code>
              {#each route.query as pair, eachIndex (eachIndex)}
                <span class="mock-chip mono">{pair.key}={pair.value}</span>
              {/each}
              <span class="status-badge {statusClass(route.statusCode)}">{route.statusCode}</span>
              <button
                class="mock-row-name"
                type="button"
                title="Open this example"
                onclick={() => onOpenExample(route.exampleId)}
              >
                {exampleLabel(route.requestName, route.exampleName)}
              </button>
              {#if status.running}
                <button
                  class="btn btn-ghost btn-xs mock-row-copy"
                  type="button"
                  title="Copy this route's URL"
                  onclick={() => copy(routeUrl(route), route.exampleId)}
                >
                  {copied === route.exampleId ? 'Copied' : 'Copy URL'}
                </button>
              {/if}
            </div>
          {/each}
        {/if}
        </div>
      </div>

      <div class="mock-pane-wrap mock-pane-log">
        <div class="mock-pane-head">
          <span class="mock-pane-title">
            Requests <span class="mock-count">{log.length}</span>
            {#if unmatchedCount > 0}<span class="mock-count-bad">· {unmatchedCount} unmatched</span>{/if}
          </span>
          {#if log.length}
            <button class="btn btn-secondary" type="button" onclick={onClearLog}>Clear</button>
          {/if}
        </div>
        <div class="mock-pane">
        {#if log.length === 0}
          <div class="empty-state mock-empty">
            <strong class="empty-state-title">{status.running ? 'Waiting for the first request' : 'Not running'}</strong>
            <span class="empty-state-text">
              {status.running
                ? 'Point a client at the base URL and every call shows up here.'
                : 'Start the server to watch what your client asks for.'}
            </span>
          </div>
        {:else}
          {#each reversedLog as entry (entry.id)}
            <div class="mock-row mock-log-row" class:unmatched={!entry.matched}>
              <span class="mock-time">{formatTime(entry.timestamp)}</span>
              <span class="collection-method {methodColor(entry.method)}">{entry.method}</span>
              <code class="mock-path">{entry.path}{entry.query ? `?${entry.query}` : ''}</code>
              <span class="status-badge {statusClass(entry.statusCode)}">{entry.statusCode}</span>
              {#if entry.matched}
                <button
                  class="mock-row-name"
                  type="button"
                  title="Open the example that answered"
                  onclick={() => onOpenExample(entry.exampleId ?? '')}
                >
                  {exampleLabel(entry.requestName ?? '', entry.exampleName ?? '')}
                </button>
              {:else}
                <span class="mock-row-name bad">{entry.note || 'no example matched'}</span>
              {/if}
              {#if entry.matched && entry.note}
                <span class="mock-row-note">{entry.note}</span>
              {/if}
              <span class="mock-duration">{entry.durationMs}ms</span>
            </div>
          {/each}
        {/if}
        </div>
      </div>
    </div>
  </section>
</section>
</div>
