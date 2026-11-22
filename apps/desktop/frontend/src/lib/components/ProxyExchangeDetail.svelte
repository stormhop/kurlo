<script lang="ts">
  import ResponseBodyViewer from './ResponseBodyViewer.svelte';
  import type { ProxyEntry, ProxyExchange } from '../wire';
  import { formatSize, methodColor, statusClass } from '../utils';
  import { shouldVirtualizeResponseBody, type ResponseRenderMode } from '../response-render';

  let {
    entry,
    exchange,
    busy,
    decrypted,
    onReplay,
    onCopyCurl,
    onMapLocal,
    onRewrite,
    onSave,
    onDecrypt,
  }: {
    entry: ProxyEntry;
    exchange: ProxyExchange | null;
    busy: boolean;
    decrypted: boolean;
    onReplay: () => void;
    onCopyCurl: () => void;
    onMapLocal: () => void;
    onRewrite: () => void;
    onSave: () => void;
    onDecrypt: (host: string) => void;
  } = $props();

  type Pane = 'response' | 'request' | 'frames';
  let pane = $state<Pane>('response');
  const tunnel = $derived(entry.method === 'CONNECT');
  const tunnelHost = $derived(entry.host.toLowerCase().replace(/:443$/, ''));
  const panes = $derived<Array<{ id: Pane; label: string }>>([
    { id: 'response', label: 'Response' },
    { id: 'request', label: 'Request' },
    ...(entry.stream ? [{ id: 'frames' as Pane, label: entry.stream === 'websocket' ? 'Messages' : 'Events' }] : []),
  ]);
  const activePane = $derived(panes.some(item => item.id === pane) ? pane : 'response');
  const message = $derived(exchange ? (activePane === 'request' ? exchange.request : exchange.response) : null);
  const headers = $derived(Object.entries(message?.headers || {}).flatMap(([key, values]) => values.map(value => ({ key, value }))));
  const contentType = $derived(headers.find(header => header.key.toLowerCase() === 'content-type')?.value.split(';')[0] ?? '');
  const body = $derived(!message || message.binary ? '' : formatBody(message.body));
  const mode = $derived<ResponseRenderMode>(message && isJSON(message.body) ? 'json' : /html/i.test(contentType) ? 'html' : 'text');
  const virtualized = $derived(body ? shouldVirtualizeResponseBody(body, mode) : false);
  const blocked = $derived(!exchange || exchange.request.binary || (exchange.request.truncated && !exchange.request.archived));
  const started = $derived(new Date(entry.started).toLocaleTimeString('en-GB', { hour12: false }));

  function isJSON(value: string) {
    const text = value.trim();
    if (!text || !'[{'.includes(text[0])) return false;
    try { JSON.parse(text); return true; } catch { return false; }
  }

  function formatBody(value: string) {
    return isJSON(value) ? JSON.stringify(JSON.parse(value), null, 2) : value;
  }
</script>

<section class="capture-detail" aria-label="Captured exchange">
  <header class="capture-detail-head">
    <div class="capture-detail-title">
      <h3>
        {#if tunnel}
          <span class="capture-lock" aria-hidden="true"><svg width="0.8125rem" height="0.8125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>
          HTTPS tunnel to {entry.host}
        {:else}
          <span class="collection-method {methodColor(entry.method)}">{entry.method}</span><code>{entry.path || '/'}</code>
        {/if}
      </h3>
      <p>
        {entry.host} · {started} · {entry.inProgress ? 'open' : entry.duration + ' ms'} · {formatSize(entry.received)}
        {#if entry.process} · {entry.process}{/if}
        {#if entry.local} · <span class="capture-local">Answered by {entry.rule || 'a Map local rule'}</span>{/if}
      </p>
    </div>
    {#if !tunnel}
      <div class="capture-detail-actions">
        <button class="btn btn-ghost btn-sm" type="button" disabled={busy || !exchange || exchange.request.binary || exchange.request.truncated} onclick={onCopyCurl}>Copy cURL</button>
        <button class="btn btn-ghost btn-sm" type="button" disabled={busy || !exchange} onclick={onMapLocal}>Map local</button>
        <button class="btn btn-ghost btn-sm" type="button" disabled={busy} onclick={onRewrite}>Rewrite</button>
        <button class="btn btn-secondary btn-sm" type="button" disabled={busy || blocked} onclick={onReplay}>Open in editor</button>
        <button class="btn btn-primary btn-sm" type="button" disabled={busy || blocked} onclick={onSave}>Save as request</button>
      </div>
    {/if}
  </header>

  {#if entry.rewritten}<p class="mock-hint capture-detail-error">Sent to <code>{entry.rewritten}</code> by {entry.rule}.</p>{/if}
  {#if entry.error}<p class="mock-error capture-detail-error" role="alert">{entry.error}</p>{/if}

  {#if tunnel}
    <div class="capture-detail-body capture-tunnel">
      <dl class="history-detail-kv">
        <dt>Status</dt><dd>{entry.inProgress ? 'Connected' : 'Closed'}</dd>
        <dt>Sent</dt><dd>{formatSize(entry.sent)}</dd>
        <dt>Received</dt><dd>{formatSize(entry.received)}</dd>
      </dl>
      <p class="history-detail-note">HTTPS tunnel · metadata only. The traffic inside stays encrypted.</p>
      {#if !decrypted}
        <div class="capture-decrypt-hint">
          <span>Decrypt this host to record its requests and responses. Reload the page after you add it.</span>
          <button class="btn btn-secondary btn-sm" type="button" disabled={busy} onclick={() => onDecrypt(tunnelHost)}>Decrypt {tunnelHost}</button>
        </div>
      {/if}
    </div>
  {:else}
    <div class="capture-detail-tabs tab-bar" role="tablist" aria-label="Exchange parts">
      {#each panes as item (item.id)}
        <button class="tab" role="tab" type="button" aria-selected={activePane === item.id} tabindex={activePane === item.id ? 0 : -1} onclick={() => (pane = item.id)}>
          {item.label}
          {#if item.id === 'response' && entry.status}<span class="status-badge {statusClass(entry.status)}">{entry.status}</span>{/if}
        </button>
      {/each}
    </div>
    <div class="capture-detail-body">
      {#if !exchange || !message}
        <div class="capture-detail-pending" aria-busy="true"></div>
      {:else if activePane === 'frames'}
        <p class="history-detail-note">First 16 KiB in each direction{entry.inProgress ? ', updating while the stream is open' : ''}.</p>
        {#each exchange.frames || [] as frame, index (index)}
          <div class="capture-frame" class:inbound={frame.direction === 'Received'}>
            <span class="capture-frame-meta">{frame.direction} · {frame.kind} · {formatSize(frame.size)}</span>
            <pre class="history-detail-code">{frame.text}</pre>
          </div>
        {:else}
          <p class="history-detail-note">No messages yet.</p>
        {/each}
      {:else}
        <details class="capture-headers" open={activePane === 'request'}>
          <summary>Headers <span>{headers.length}</span></summary>
          {#if headers.length}
            <dl class="history-detail-kv">
              {#each headers as header, index (index)}<dt>{header.key}</dt><dd>{header.value}</dd>{/each}
            </dl>
          {:else}
            <p class="history-detail-note">No headers.</p>
          {/if}
        </details>
        {#if message.binary}
          <p class="history-detail-note">Binary content{contentType ? ` (${contentType})` : ''}. Export HAR to keep it.</p>
        {:else if body}
          <div class="capture-viewer" class:fixed={virtualized}>
            <ResponseBodyViewer source={body} {mode} search="" searchIndex={0} {virtualized} page={0} />
          </div>
        {:else}
          <p class="history-detail-note">No body.</p>
        {/if}
        {#if message.truncated}
          <p class="history-detail-note">{message.archived ? 'First 16 KiB shown. Export HAR for the full body.' : 'Only the first 16 KiB were kept.'}</p>
        {/if}
      {/if}
    </div>
  {/if}
</section>
