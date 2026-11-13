<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import { openFileDialog } from '../backend';
  import { useClock } from '../clock.svelte';
  import { relativeTime } from '../collectionRuns';
  import { DEFAULT_OPENAPI_SYNC_INTERVAL, OPENAPI_SYNC_INTERVALS, openApiIntervalLabel, openApiSourceIsUrl } from '../openapiSource';
  import { guardTrailing, removeRow, restoreRows } from '../utils';
  import type { Collection, KVRow } from '../types/models';
  import Select from './Select.svelte';

  let { collection, workspaceBlocked = false }: { collection: Collection; workspaceBlocked?: boolean } = $props();

  const now = useClock();
  const intervalOptions = OPENAPI_SYNC_INTERVALS.map(minutes => ({ value: String(minutes), label: openApiIntervalLabel(minutes) }));

  let loadedFor = $state('');
  let source = $state('');
  let interval = $state(String(DEFAULT_OPENAPI_SYNC_INTERVAL));
  let skipTls = $state(false);
  let headers = $state<KVRow[]>([]);
  let busy = $state(false);

  $effect(() => {
    const key = `${collection.id}\u001f${JSON.stringify(collection.openapi ?? null)}`;
    if (key === loadedFor) return;
    loadedFor = key;
    source = collection.openapi?.source ?? '';
    interval = String(collection.openapi?.intervalMinutes ?? DEFAULT_OPENAPI_SYNC_INTERVAL);
    skipTls = collection.openapi?.skipTlsVerification ?? false;
    headers = restoreRows(collection.openapi?.headers ?? []);
  });

  const connected = $derived(Boolean(collection.openapi));
  const status = $derived(vm.openApiStatus(collection.id));
  const isUrl = $derived(openApiSourceIsUrl(source));
  const draft = $derived({
    source: source.trim(),
    intervalMinutes: Number(interval),
    skipTlsVerification: isUrl && skipTls,
    headers: isUrl ? headers.filter(row => row.key.trim() || row.value.trim()) : [],
    ...(collection.openapi?.ignored?.length ? { ignored: collection.openapi.ignored } : {}),
  });
  const dirty = $derived(connected && JSON.stringify({
    source: collection.openapi?.source ?? '',
    intervalMinutes: collection.openapi?.intervalMinutes ?? DEFAULT_OPENAPI_SYNC_INTERVAL,
    skipTlsVerification: collection.openapi?.skipTlsVerification ?? false,
    headers: (collection.openapi?.headers ?? []).map(row => [row.key, row.value, row.enabled]),
  }) !== JSON.stringify({ ...draft, ignored: undefined, headers: draft.headers.map(row => [row.key, row.value, row.enabled]) }));

  const statusLabel = $derived.by(() => {
    switch (status.state) {
      case 'checking': return 'Checking the spec…';
      case 'in-sync': return 'In sync';
      case 'updates': return status.summary;
      case 'skipped': return `${status.summary} (skipped)`;
      case 'error': return 'Check failed';
      default: return connected ? 'Not checked yet' : '';
    }
  });
  const checkedLabel = $derived(status.checkedAt ? `Checked ${relativeTime(status.checkedAt, now())}` : '');

  async function run(task: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    try {
      await task();
    } finally {
      busy = false;
    }
  }

  async function chooseFile() {
    const path = await openFileDialog('Choose an OpenAPI spec file');
    if (path) source = path;
  }

  function connect() {
    if (!draft.source) return;
    void run(() => vm.connectOpenApiSource(collection.id, draft));
  }

  function save() {
    void run(() => vm.saveOpenApiSource(collection.id, draft));
  }
</script>

<div class="settings-section openapi-sync-section">
  {#if connected}
    <div class="openapi-sync-status" data-state={status.state} role="status">
      <span class="openapi-sync-dot" aria-hidden="true"></span>
      <span class="openapi-sync-status-text">
        <strong>{statusLabel}</strong>
        {#if status.state === 'error'}<span class="openapi-sync-error">{status.message}</span>{:else if checkedLabel}<span>{checkedLabel}</span>{/if}
      </span>
      <span class="openapi-sync-actions">
        <button class="btn btn-secondary" type="button" disabled={busy || workspaceBlocked || status.state === 'checking'} onclick={() => run(() => vm.reviewOpenApiChanges(collection.id))}>{status.state === 'updates' || status.state === 'skipped' ? 'Review changes' : 'Check now'}</button>
        <button class="btn btn-ghost" type="button" disabled={busy || workspaceBlocked} onclick={() => run(() => vm.disconnectOpenApiSource(collection.id))}>Disconnect</button>
      </span>
    </div>
  {:else}
    <div class="openapi-sync-intro">
      <strong>Keep this collection in sync with an OpenAPI spec</strong>
      <span>Kurlo checks the spec for new, changed and removed endpoints and shows them before anything changes. Your scripts, tests and settings are never touched. No limits on how often you sync.</span>
    </div>
  {/if}

  <div class="settings-list">
    <div class="postman-setting openapi-source-setting">
      <span class="setting-copy"><strong>Spec source</strong><span>A URL, or a file path relative to the workspace folder. <code>&#123;&#123;variables&#125;&#125;</code> work.</span></span>
      <span class="openapi-source-input">
        <input class="field field-mono kv-input" type="text" placeholder="https://api.example.com/openapi.json" bind:value={source} spellcheck="false" autocomplete="off" aria-label="Spec source" />
        <button class="btn btn-secondary" type="button" onclick={chooseFile}>Choose file…</button>
      </span>
    </div>
    <div class="postman-setting">
      <span class="setting-copy"><strong>Check for updates</strong><span>While Kurlo is open. A minimized window checks when you come back.</span></span>
      <Select bind:value={interval} options={intervalOptions} className="setting-select" />
    </div>
    {#if isUrl}
      <label class="postman-setting">
        <span class="setting-copy"><strong>Skip TLS certificate check</strong><span>For self-signed or internal certificates. Only use it for a server you trust.</span></span>
        <span class="switch-control"><input type="checkbox" bind:checked={skipTls} /><span class="switch-track"></span><span class="switch-state">{skipTls ? 'ON' : 'OFF'}</span></span>
      </label>
      <div class="postman-setting openapi-headers-setting">
        <span class="setting-copy"><strong>Request headers</strong><span>Sent when Kurlo downloads the spec, for example <code>Authorization: Bearer &#123;&#123;specToken&#125;&#125;</code>.</span></span>
        <div class="kv-table openapi-headers" style="--kw: 11rem; --vw: 14rem">
          {#each headers as row, i (row.id)}
            <div class="kv-row openapi-header-row">
              <input type="checkbox" class="check" bind:checked={row.enabled} aria-label="Send header" disabled={!row.key && !row.value} />
              <input class="field field-bare kv-input" bind:value={row.key} placeholder="Header" spellcheck="false" oninput={() => guardTrailing(headers, i)} />
              <input class="field field-bare kv-input" bind:value={row.value} placeholder="Value" spellcheck="false" autocomplete="off" oninput={() => guardTrailing(headers, i)} />
              <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => removeRow(headers, i)} aria-label="Remove header">✕</button>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div class="openapi-sync-foot">
    {#if connected}
      <span class="openapi-sync-hint">The spec from the last sync is kept in <code>openapi/spec.json</code> next to <code>collection.yml</code>. Commit it with the collection so teammates see the same changes.</span>
      <button class="btn btn-primary" type="button" disabled={!dirty || !draft.source || busy || workspaceBlocked} onclick={save}>Save</button>
    {:else}
      <span class="openapi-sync-hint">Requests are matched to spec operations by method and path.</span>
      <button class="btn btn-primary" type="button" disabled={!draft.source || busy || workspaceBlocked} onclick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
    {/if}
  </div>
</div>
