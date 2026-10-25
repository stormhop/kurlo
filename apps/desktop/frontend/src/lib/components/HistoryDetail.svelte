<script lang="ts">
  import type { HttpResponse } from '../backend';
  import { AUTH_OPTIONS } from '../constants';
  import type { ResponseRenderMode } from '../response-render';
  import type { KVRow, RequestHistoryEntry } from '../types/models';
  import { formatSize, requestTabLabel, statusClass } from '../utils';
  import RequestTypeBadge from './RequestTypeBadge.svelte';
  import ResponseBodyViewer from './ResponseBodyViewer.svelte';

  let {
    entry,
    response,
    loading,
    error,
    source,
    displayBody,
    renderMode,
    virtualized,
    canCopyCurl,
    workspaceBlocked = false,
    onOpenInEditor,
    onGoToSource,
    onCopyCurl,
    onDelete,
  }: {
    entry: RequestHistoryEntry;
    response: HttpResponse | null;
    loading: boolean;
    error: string;
    source: { id: string; location: string } | null;
    displayBody: string;
    renderMode: ResponseRenderMode;
    virtualized: boolean;
    canCopyCurl: boolean;
    workspaceBlocked?: boolean;
    onOpenInEditor: () => void;
    onGoToSource: (id: string) => void;
    onCopyCurl: () => void;
    onDelete: () => void;
  } = $props();

  let request = $derived(entry.request);
  let sentAt = $derived(new Date(entry.createdAt));
  let sentLabel = $derived(sentAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }));
  let requestHeaders = $derived(enabledRows(request.headers));
  let formRows = $derived(enabledRows(request.formRows));
  let authLabel = $derived(AUTH_OPTIONS.find(option => option.value === request.auth?.type)?.label ?? '');
  let hasRawBody = $derived(['json', 'text', 'xml', 'html', 'graphql'].includes(request.bodyType) && request.bodyContent.trim() !== '');
  let responseHeaders = $derived(response?.headers ?? []);
  let contentType = $derived(entry.responseContentType || responseHeaders.find(header => header.key.toLowerCase() === 'content-type')?.value || '');

  function enabledRows(rows: KVRow[] | undefined) {
    return (rows ?? []).filter(row => row.enabled && row.key.trim());
  }

  function rowValue(row: KVRow) {
    if (row.secret) return '••••••';
    if (row.isFile) return row.fileName || 'File';
    return row.value;
  }
</script>

<section class="history-detail" aria-label="History entry">
  <header class="history-detail-head">
    <div class="history-detail-title">
      <h1>{requestTabLabel(request)}</h1>
      <p>
        Sent {sentLabel}
        {#if source}
          · from <button class="btn-link history-detail-link" type="button" onclick={() => onGoToSource(source.id)} disabled={workspaceBlocked}>{source.location}</button>
        {/if}
      </p>
    </div>
    <div class="history-detail-actions">
      {#if canCopyCurl}
        <button class="btn btn-secondary" type="button" onclick={onCopyCurl}>Copy as cURL</button>
      {/if}
      <button class="btn btn-secondary history-detail-delete" type="button" onclick={onDelete} disabled={workspaceBlocked}>Delete</button>
      <button class="btn btn-primary" type="button" onclick={onOpenInEditor} disabled={workspaceBlocked}>Open in editor</button>
    </div>
  </header>

  <div class="history-detail-body">
    <div class="history-detail-stats">
      <div class="runner-stat">
        <span>Status</span>
        <strong class={entry.statusCode ? statusClass(entry.statusCode) : 'history-detail-failed'}>{entry.statusCode ? entry.status || entry.statusCode : 'No response'}</strong>
      </div>
      <div class="runner-stat">
        <span>Time</span>
        <strong>{Math.round(entry.duration)} ms</strong>
      </div>
      {#if entry.responseSize !== undefined}
        <div class="runner-stat">
          <span>Size</span>
          <strong>{formatSize(entry.responseSize)}</strong>
        </div>
      {/if}
      {#if contentType}
        <div class="runner-stat history-detail-type">
          <span>Content type</span>
          <strong>{contentType.split(';')[0]}</strong>
        </div>
      {/if}
    </div>

    <div class="history-detail-url">
      <RequestTypeBadge request={request} />
      <code>{request.url}</code>
    </div>

    <div class="history-detail-columns">
      <section class="history-detail-section" aria-label="Request">
        <h2>Request</h2>
        <h3>Headers <span>{requestHeaders.length}</span></h3>
        {#if requestHeaders.length}
          <dl class="history-detail-kv">
            {#each requestHeaders as row, eachIndex (eachIndex)}
              <dt>{row.key}</dt><dd>{rowValue(row)}</dd>
            {/each}
          </dl>
        {:else}
          <p class="history-detail-note">No headers of its own. Kurlo adds Host, User-Agent and the like when sending.</p>
        {/if}
        {#if authLabel && request.auth?.type !== 'none' && request.auth?.type !== 'inherit'}
          <h3>Auth</h3>
          <p class="history-detail-plain">{authLabel}</p>
        {/if}
        <h3>Body</h3>
        {#if hasRawBody}
          <pre class="history-detail-code">{request.bodyContent}</pre>
        {:else if (request.bodyType === 'form' || request.bodyType === 'urlencoded') && formRows.length}
          <dl class="history-detail-kv">
            {#each formRows as row, eachIndex (eachIndex)}
              <dt>{row.key}</dt><dd>{rowValue(row)}</dd>
            {/each}
          </dl>
        {:else if request.bodyType === 'binary' && request.bodyFileName}
          <p class="history-detail-plain">{request.bodyFileName}</p>
        {:else}
          <p class="history-detail-note">No body.</p>
        {/if}
      </section>

      <section class="history-detail-section history-detail-response" aria-label="Response">
        <h2>Response</h2>
        {#if loading}
          <p class="history-detail-note">Loading the stored response…</p>
        {:else if error}
          <p class="history-detail-note history-detail-error">{error}</p>
        {:else if response}
          <h3>Headers <span>{responseHeaders.length}</span></h3>
          {#if responseHeaders.length}
            <dl class="history-detail-kv">
              {#each responseHeaders as header, eachIndex (eachIndex)}
                <dt>{header.key}</dt><dd>{header.value}</dd>
              {/each}
            </dl>
          {/if}
          <h3>Body</h3>
          {#if entry.responseTruncated}
            <p class="history-detail-note">Only the first 2 MB were kept.</p>
          {/if}
          {#if displayBody}
            <div class="history-detail-viewer" class:fixed={virtualized}>
              <ResponseBodyViewer source={displayBody} mode={renderMode} search="" searchIndex={0} {virtualized} page={0} />
            </div>
          {:else}
            <p class="history-detail-note">Empty body.</p>
          {/if}
        {:else}
          <p class="history-detail-note">The response was not kept. Kurlo stores responses up to 2 MB and skips binary bodies.</p>
        {/if}
      </section>
    </div>
  </div>
</section>
