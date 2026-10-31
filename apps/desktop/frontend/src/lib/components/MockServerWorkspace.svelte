<script lang="ts">
  import type { MockRequestLog, MockRoute, MockServerStatus } from '../backend';
  import { methodColor, statusClass } from '../utils';
  import { mockRouteConflicts, mockRouteLabel, mockRouteShadows } from '../mockRoutes';
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

  const routeGroups = $derived.by(() => {
    const groups: Array<{ name: string; routes: MockRoute[] }> = [];
    for (const route of filteredRoutes) {
      const name = route.requestName || 'Examples';
      const group = groups.find(candidate => candidate.name === name);
      if (group) group.routes.push(route);
      else groups.push({ name, routes: [route] });
    }
    return groups;
  });

  const shadows = $derived(mockRouteShadows(routes));


  function shadowedBy(route: MockRoute) {
    return shadows.get(route.exampleId) ?? null;
  }

  function routeUrl(route: MockRoute) {
    return `${status.url}${route.pathTemplate}`;
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
  <header class="mock-head">
    <div class="mock-head-top">
      <div class="mock-title">
        <span class="mock-glyph" aria-hidden="true">
          <svg width="1.125rem" height="1.125rem" viewBox="0 0 24 24" fill="none">
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
      <div class="mock-status" class:running={status.running}>
        {#if status.running}
          <span class="mock-status-state"><span class="mock-pulse" aria-hidden="true"></span><span class="mock-live-label">Running</span></span>
          <button class="mock-url" type="button" title="Copy the base URL" onclick={() => copy(status.url, 'base')}>
            <code>{status.url}</code>
            <span class="mock-url-action">{copied === 'base' ? 'Copied' : 'Copy URL'}</span>
          </button>
          <span class="mock-status-meta">{status.routeCount} example{status.routeCount === 1 ? '' : 's'} from <strong>{status.collectionName || 'this collection'}</strong>{#if simulateLatency} · recorded latency{/if}</span>
        {:else}
          <span class="mock-status-state">Stopped</span>
          <span class="mock-status-meta">{canStart ? `Start it to serve these examples on port ${port || 3100}.` : 'Nothing to serve yet.'}</span>
        {/if}
      </div>
      <div class="mock-actions">
        {#if status.running}
          <button class="btn btn-secondary" type="button" onclick={onToggle} disabled={busy}>Stop</button>
        {:else}
          <button class="btn btn-primary" type="button" onclick={onToggle} disabled={busy || !canStart}>Start server</button>
        {/if}
      </div>
    </div>
    <div class="mock-settings">
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
        <input class="field field-mono mock-port"
          type="number"
          min="1"
          max="65535"
          value={port}
          placeholder="3100"
          onchange={(event) => onPortChange(portValue(event))}
        />
      </label>
      <label class="mock-toggle-row" title="Each example knows how long the real call took.">
        <input
          class="check"
          type="checkbox"
          checked={simulateLatency}
          onchange={(event) => onSimulateLatencyChange(event.currentTarget instanceof HTMLInputElement && event.currentTarget.checked)}
        />
        Reproduce recorded response times
      </label>
      <span class="mock-settings-note">Edits to examples reload the server automatically.</span>
    </div>
    {#if error}
      <p class="mock-error" role="alert">{error}</p>
    {/if}
    {#if servedElsewhere}
      <p class="mock-hint">
        The server is serving <strong>{status.collectionName}</strong>. Starting again switches it to the collection above.
      </p>
    {/if}
    {#if !canStart && !status.running}
      <p class="mock-hint">
        Nothing to serve yet. Send a request, then use <strong>Save as example</strong> in the response panel — the mock replays what you captured.
      </p>
    {/if}
  </header>
  <div class="mock-panes">
    <div class="mock-pane-wrap">
      <div class="mock-pane-head">
        <span class="mock-pane-title">
          Routes <span class="mock-count">{routes.length}</span>
          {#if conflictCount > 0}<span class="mock-count-warn" title="The first matching example wins">· {conflictCount} never reached</span>{/if}
        </span>
        <input
          class="field field-md mock-filter"
          placeholder="Filter routes"
          aria-label="Filter routes"
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
        {#each routeGroups as group (group.name)}
          <div class="mock-group">{group.name}</div>
          {#each group.routes as route (route.exampleId)}
            {@const shadow = shadowedBy(route)}
            <div class="mock-row" class:conflict={Boolean(shadow)}>
              <span class="collection-method {methodColor(route.method)}">{route.method.toUpperCase()}</span>
              <span class="mock-route-main">
                <span class="mock-route-line">
                  <code class="mock-path">{route.pathTemplate}</code>
                  {#each route.query as pair, eachIndex (eachIndex)}
                    <span class="mock-chip mono">{pair.key}={pair.value}</span>
                  {/each}
                </span>
                {#if shadow}
                  <span class="mock-row-warning">Never reached — {exampleLabel(shadow.requestName, shadow.exampleName)} answers the same request first. Give it a different path or query value.</span>
                {/if}
              </span>
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
          <button class="btn btn-secondary btn-sm" type="button" onclick={onClearLog}>Clear</button>
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
            <span class="mock-route-main">
              <code class="mock-path">{entry.path}{entry.query ? `?${entry.query}` : ''}</code>
              {#if !entry.matched}
                <span class="mock-row-warning bad">{entry.note || 'no example matched'} · save one from a real response</span>
              {:else if entry.note}
                <span class="mock-row-note">{entry.note}</span>
              {/if}
            </span>
            {#if entry.matched}
              <button
                class="mock-row-name"
                type="button"
                title="Open the example that answered"
                onclick={() => onOpenExample(entry.exampleId ?? '')}
              >
                {exampleLabel(entry.requestName ?? '', entry.exampleName ?? '')}
              </button>
            {/if}
            <span class="status-badge {statusClass(entry.statusCode)}">{entry.statusCode}</span>
            <span class="mock-duration">{entry.durationMs}ms</span>
          </div>
        {/each}
      {/if}
      </div>
    </div>
  </div>
</section>
</div>
