<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { byteLength, formatSize } from '../utils';
  import { renderResponseBodyLines } from '../response-render';
  import type { SocketIOMessageEntry, SocketIOStatus } from '../types/models';

  type SIOFilter = 'all' | 'sent' | 'received';
  const REALTIME_PAGE_SIZE = 200;

  const filterOptions: { value: SIOFilter; label: string; icon: string }[] = [
    { value: 'all', label: 'All messages', icon: '' },
    { value: 'sent', label: 'Sent messages', icon: '↑' },
    { value: 'received', label: 'Received messages', icon: '↓' },
  ];

  let {
    status,
    connectedAt,
    namespace,
    messages,
    error,
    canRestore,
    listenEventCount,
    onClear,
    onRestore,
    onGoToEvents,
  }: {
    status: SocketIOStatus;
    connectedAt: number;
    namespace: string;
    messages: SocketIOMessageEntry[];
    error: string;
    canRestore: boolean;
    listenEventCount: number;
    onClear: () => void;
    onRestore: () => void;
    onGoToEvents?: () => void;
  } = $props();

  let searchQuery = $state('');
  let searchOpen = $state(false);
  let searchInput = $state<HTMLInputElement | undefined>();
  let messageFilter = $state<SIOFilter>('all');
  let filterMenuOpen = $state(false);
  let listEl = $state<HTMLElement | undefined>();
  let atTop = $state(true);
  let newMessagesBadge = $state(0);
  let expandedIds = $state<Set<string>>(new Set());
  let lastSeenCount = $state(0);
  let elapsed = $state('00:00:00');
  let visibleMessageCount = $state(REALTIME_PAGE_SIZE);

  let streamSize = $derived.by(() =>
    messages.reduce((total, m) => total + byteLength(m.args?.join('') || m.message || ''), 0)
  );

  let filteredMessages = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    return messages.filter((m) => {
      if (messageFilter === 'sent' && m.direction !== 'outgoing') return false;
      if (messageFilter === 'received' && m.direction !== 'incoming') return false;
      if (!q) return true;
      const hay = [m.eventName, m.namespace, m.direction, m.message ?? '', ...(m.args ?? [])].join('\n').toLowerCase();
      return hay.includes(q);
    });
  });

  let reversedMessages = $derived([...filteredMessages].reverse());
  let visibleReversedMessages = $derived(reversedMessages.slice(0, visibleMessageCount));
  let hiddenMessageCount = $derived(Math.max(0, filteredMessages.length - visibleReversedMessages.length));

  function isJson(text: string): boolean {
    try { JSON.parse(text); return true; } catch { return false; }
  }

  function tryFormatJson(text: string): string {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }

  function renderBodyHtml(text: string): string {
    const json = isJson(text);
    return renderResponseBodyLines(json ? tryFormatJson(text) : text, json, searchQuery, 0)
      .map((line) => line.html)
      .join('\n');
  }

  function elapsedTime(since: number) {
    const diff = Math.max(0, Date.now() - since);
    const h = Math.floor(diff / 3600000).toString().padStart(2, '0');
    const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
    const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  $effect(() => {
    if (status !== 'connected') { elapsed = '00:00:00'; return; }
    elapsed = elapsedTime(connectedAt);
    const id = setInterval(() => { elapsed = elapsedTime(connectedAt); }, 1000);
    return () => clearInterval(id);
  });

  $effect(() => {
    const count = filteredMessages.length;
    if (count === 0) { lastSeenCount = 0; newMessagesBadge = 0; atTop = true; return; }
    if (count === lastSeenCount) return;
    const delta = lastSeenCount === 0 ? 0 : Math.max(1, count - lastSeenCount);
    lastSeenCount = count;
    if (atTop) {
      newMessagesBadge = 0;
      void scrollToTop();
    } else {
      newMessagesBadge = Math.min(9999, newMessagesBadge + delta);
    }
  });

  $effect(() => {
    searchQuery;
    messageFilter;
    visibleMessageCount = REALTIME_PAGE_SIZE;
  });

  $effect(() => {
    if (searchOpen) setTimeout(() => searchInput?.focus(), 0);
  });

  function onScroll() {
    if (!listEl) return;
    atTop = listEl.scrollTop < 96;
    if (atTop) { lastSeenCount = filteredMessages.length; newMessagesBadge = 0; }
  }

  async function scrollToTop() {
    await tick();
    untrack(() => {
      if (!listEl) return;
      listEl.scrollTop = 0;
      atTop = true;
      newMessagesBadge = 0;
      lastSeenCount = messages.length;
    });
  }

  function jumpToTop() {
    atTop = true;
    newMessagesBadge = 0;
    lastSeenCount = messages.length;
    void scrollToTop();
  }

  function toggleExpand(id: string) {
    expandedIds = expandedIds.has(id)
      ? new Set([...expandedIds].filter(item => item !== id))
      : new Set([...expandedIds, id]);
  }

  function closeFilterMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (!(current instanceof HTMLElement)) return;
    if (!(next instanceof Node) || !current.contains(next)) filterMenuOpen = false;
  }

  function selectMessageFilter(f: SIOFilter) { messageFilter = f; filterMenuOpen = false; }
  function filterLabel() { return filterOptions.find((o) => o.value === messageFilter)?.label ?? 'All messages'; }

  function filterEmptyLabel(): string {
    if (searchQuery.trim()) return `No events match "${searchQuery}"`;
    if (messageFilter === 'sent') return 'No sent events';
    if (messageFilter === 'received') return 'No received events';
    return 'No events';
  }

  function formatTime(ts: number) {
    const options: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    };
    return new Date(ts).toLocaleTimeString('en-GB', options);
  }

  function formatDuration(ms: number | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  function displayArgs(m: SocketIOMessageEntry): string {
    if (!m.args || m.args.length === 0) return m.message ?? '';
    try {
      const parsed = m.args.map(a => { try { return JSON.parse(a); } catch { return a; } });
      return JSON.stringify(parsed.length === 1 ? parsed[0] : parsed, null, 2);
    } catch { return m.args.join(', '); }
  }

  function previewText(m: SocketIOMessageEntry): string {
    if (m.isSystem) return m.message ?? '';
    if (m.args && m.args.length > 0) {
      const raw = m.args[0];
      try { return JSON.stringify(JSON.parse(raw)); } catch { return raw; }
    }
    return m.message ?? '';
  }

  function badgeClass(m: SocketIOMessageEntry): string {
    if (m.isError) return 'sse-badge-error';
    if (m.isSystem) {
      if (/^disconnected\b/i.test(m.message ?? '')) return 'sse-badge-disconnected';
      if (/^connected\b/i.test(m.message ?? '')) return 'sse-badge-connected';
      return 'sse-badge-system';
    }
    return m.direction === 'outgoing' ? 'sse-badge-notification' : 'sse-badge-message';
  }

  function statusLabel(): string {
    if (status === 'connected') return 'Connected';
    if (status === 'connecting') return 'Connecting';
    if (status === 'reconnecting') return 'Reconnecting';
    if (status === 'disconnected') return 'Disconnected';
    if (status === 'error') return 'Error';
    return 'Idle';
  }

  function isDisconnectedMessage(m: SocketIOMessageEntry): boolean {
    return m.isSystem && /^disconnected\b/i.test(m.message ?? '');
  }

  function isExpandable(m: SocketIOMessageEntry): boolean {
    if (m.handshake) return true;
    if (m.isError) return true;
    if (isDisconnectedMessage(m)) return true;
    return !m.isSystem && !!(displayArgs(m));
  }
</script>

<div class="sse-panel ws-panel sio-panel">
  <div class="sse-postman-bar">
    <div class="sse-summary">
      {#if status !== 'idle'}
        <span class="status-badge {status === 'error' || status === 'disconnected' ? 'status-5xx' : status === 'connected' ? 'status-2xx' : 'sse-status-neutral'}">{statusLabel()}</span>
      {/if}
      {#if status === 'connected'}
        <span class="sse-summary-dot"></span>
        <span>{elapsed}</span>
        {#if namespace && namespace !== '/'}
          <span class="sse-summary-dot"></span>
          <span class="sio-ns-label">{namespace}</span>
        {/if}
        {#if listenEventCount === 0}
          <span class="sse-summary-dot"></span>
          <button class="btn-link sio-not-listening-inline" type="button" onclick={() => onGoToEvents?.()}>
            Not listening to events
          </button>
        {/if}
      {/if}
      {#if status === 'reconnecting'}
        <span class="sse-summary-dot"></span>
        <span class="sse-spinner-sm"></span>
        <span>Reconnecting</span>
      {/if}
      {#if status === 'error' && error}
        <span class="sse-summary-dot"></span>
        <span class="sse-status-error" title={error}>{error}</span>
      {/if}
      {#if status !== 'idle'}<span class="sse-summary-dot"></span>{/if}
      <span>{messages.length} event{messages.length === 1 ? '' : 's'}</span>
      {#if status === 'connected' && listenEventCount > 0}
        <span class="sse-summary-dot"></span>
        <span class="sio-listen-count">{listenEventCount} listening</span>
      {/if}
      <span class="sse-summary-dot"></span>
      <span>{formatSize(streamSize)}</span>
    </div>

    {#if searchOpen}
      <div class="field field-md field-wrap response-search-box">
        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
          <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        <input
          bind:this={searchInput}
          bind:value={searchQuery}
          placeholder="Search"
          aria-label="Search events"
          type="search"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck={false}
        />
        <span class="response-search-count">{filteredMessages.length}/{messages.length}</span>
      </div>
    {/if}

    <div class="ws-filter-menu" onfocusout={closeFilterMenuOnFocusOut}>
      <button
        class="field select-trigger ws-filter-button"
        class:open={filterMenuOpen}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={filterMenuOpen}
        onclick={() => (filterMenuOpen = !filterMenuOpen)}
      >
        {filterLabel()}
        <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none" aria-hidden="true">
          <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      {#if filterMenuOpen}
        <div class="menu ws-filter-list" role="listbox" aria-label="Message filter">
          {#each filterOptions as opt, eachIndex (eachIndex)}
            <button class="menu-item"
              class:active={messageFilter === opt.value}
              role="option"
              aria-selected={messageFilter === opt.value}
              type="button"
              onclick={() => selectMessageFilter(opt.value)}
            >
              <span class="ws-filter-icon">{opt.icon}</span>
              <span>{opt.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="resp-actions">
      <button class="btn btn-icon" title="Search response" aria-label="Search response" aria-pressed={searchOpen} onclick={() => (searchOpen = !searchOpen)} type="button">
        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
          <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
          <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </button>
      {#if canRestore}
        <button class="btn btn-secondary btn-sm sse-clear-btn sse-restore-btn" type="button" onclick={onRestore}>
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <path d="M3 6a3.5 3.5 0 116.1 2.3M3 6H1.5M3 6V4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Restore
        </button>
      {/if}
      <button class="btn btn-icon" type="button" onclick={onClear} disabled={messages.length === 0} title="Clear events" aria-label="Clear events">
        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <path d="M2 3h9M5 3V2h3v1M4 3v7a1 1 0 001 1h3a1 1 0 001-1V3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  </div>
  {#if status === 'connecting' || status === 'reconnecting'}
    <div class="realtime-progress" aria-hidden="true"><span></span></div>
  {/if}

  <div class="sse-event-list ws-message-list" bind:this={listEl} onscroll={onScroll} role="log" aria-live="polite">
    {#if !atTop && newMessagesBadge > 0}
      <div class="sio-new-top-wrap">
        <button class="btn btn-primary btn-sm sse-new-messages-btn" type="button" onclick={jumpToTop}>
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6 10V2M3 5l3-3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {newMessagesBadge > 999 ? '999+' : newMessagesBadge} new event{newMessagesBadge !== 1 ? 's' : ''}
        </button>
      </div>
    {/if}

    {#if messages.length === 0}
      <div class="empty-state sse-empty-state">
        {#if status === 'connected'}
          <span class="empty-state-title">No events yet</span>
        {:else}
          <span>Connect to send and receive events</span>
        {/if}
      </div>
    {:else if filteredMessages.length === 0}
      <div class="empty-state sse-empty-state"><span class="empty-state-title">{filterEmptyLabel()}</span></div>
    {:else}
      {#each visibleReversedMessages as message (message.id || message.timestamp)}
        {@const key = message.id}
        {@const expanded = expandedIds.has(key)}
        {@const expandable = isExpandable(message)}
        <div
          class="sse-event-row"
          class:sse-event-system={message.isSystem}
          class:sse-event-connected={message.isSystem && /^connected/i.test(message.message ?? '')}
          class:sse-event-disconnected={message.isSystem && /^disconnected/i.test(message.message ?? '')}
          class:sse-event-error={message.isError}
        >
          <button
            class="sse-event-main"
            type="button"
            disabled={!expandable}
            onclick={() => expandable && toggleExpand(key)}
          >
            <span
              class="sse-event-arrow ws-event-arrow"
              class:incoming={message.direction === 'incoming'}
              class:outgoing={message.direction === 'outgoing'}
              class:system={message.isSystem}
              aria-hidden="true"
            >
              {#if message.direction === 'outgoing'}
                <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
                  <path d="M6.5 11V2M3 5l3.5-3L10 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              {:else if message.direction === 'incoming'}
                <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
                  <path d="M6.5 2v9M3 8l3.5 3L10 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              {:else}
                <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
                  <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.2"/>
                  <path d="M6.5 4v3.5M6.5 9.5v.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                </svg>
              {/if}
            </span>
            {#if !message.isSystem && message.eventName}
              <span class="sse-badge sio-event-name-badge">{message.eventName}</span>
            {:else}
              <span class="sse-badge {badgeClass(message)}">{message.isSystem ? (message.message?.split(' ')[0] ?? 'system') : (message.direction === 'outgoing' ? 'send' : 'event')}</span>
            {/if}
            <span class="sse-event-preview">{previewText(message)}</span>
            <span class="sse-event-time">{formatTime(message.timestamp)}</span>
            {#if expandable}
              <span class="sse-expand-chevron" style="transform: rotate({expanded ? 180 : 0}deg)" aria-hidden="true">
                <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none">
                  <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </span>
            {/if}
          </button>

          {#if expanded && expandable}
            <div class="sse-event-body">
              {#if message.handshake}
                <div class="sio-handshake">
                  {#if message.isError}
                    <div class="sio-hs-error">Error: {message.message}</div>
                  {:else}
                    <div class="sio-hs-connected">{message.message}</div>
                  {/if}

                  <div class="sio-hs-section-title">Handshake details</div>
                  <div class="sio-hs-row">
                    <span class="sio-hs-key">Request URL</span>
                    <span class="sio-hs-val">{message.handshake.url}</span>
                  </div>
                  <div class="sio-hs-row">
                    <span class="sio-hs-key">Request method</span>
                    <span class="sio-hs-val sio-hs-method">{message.handshake.method}</span>
                  </div>
                  {#if message.handshake.statusCode}
                    <div class="sio-hs-row">
                      <span class="sio-hs-key">Status Code</span>
                      <span class="sio-hs-val" class:sio-hs-status={message.isError} class:sio-hs-status-ok={!message.isError}>{message.handshake.statusText ?? message.handshake.statusCode}</span>
                    </div>
                  {/if}

                  {#if message.handshake.requestHeaders && message.handshake.requestHeaders.length > 0}
                    <div class="sio-hs-section-title">Request headers</div>
                    {#each message.handshake.requestHeaders as h, eachIndex (eachIndex)}
                      <div class="sio-hs-header-row">
                        <span class="sio-hs-hkey">{h.key}</span>
                        <span class="sio-hs-hval">{h.value}</span>
                      </div>
                    {/each}
                  {/if}

                  {#if message.handshake.responseHeaders && message.handshake.responseHeaders.length > 0}
                    <div class="sio-hs-section-title">Response headers</div>
                    {#each message.handshake.responseHeaders as h, eachIndex (eachIndex)}
                      <div class="sio-hs-header-row">
                        <span class="sio-hs-hkey">{h.key}</span>
                        <span class="sio-hs-hval">{h.value}</span>
                      </div>
                    {/each}
                  {/if}
                </div>
              {:else if isDisconnectedMessage(message)}
                <div class="rt-handshake">
                  <div class="rt-detail-message rt-detail-error">{message.message}</div>
                  <div class="rt-detail-section-title">Connection details</div>
                  {#if message.details?.connectedUrl}
                    <div class="rt-detail-row">
                      <span class="rt-detail-key">Request URL</span>
                      <span class="rt-detail-val">{message.details.connectedUrl}</span>
                    </div>
                  {/if}
                  <div class="rt-detail-row">
                    <span class="rt-detail-key">Namespace</span>
                    <span class="rt-detail-val">{message.details?.namespace ?? (message.namespace || '/')}</span>
                  </div>
                  <div class="rt-detail-row">
                    <span class="rt-detail-key">Duration</span>
                    <span class="rt-detail-val">{formatDuration(typeof message.details?.durationMs === 'number' ? message.details.durationMs : undefined)}</span>
                  </div>
                  <div class="rt-detail-row">
                    <span class="rt-detail-key">Messages</span>
                    <span class="rt-detail-val">{message.details?.messageCount ?? 0}</span>
                  </div>
                  <div class="rt-detail-row">
                    <span class="rt-detail-key">Reason</span>
                    <span class="rt-detail-val">{message.details?.reason ?? message.message}</span>
                  </div>
                  <div class="rt-detail-row">
                    <span class="rt-detail-key">Status</span>
                    <span class="rt-detail-val rt-detail-status-error">Disconnected</span>
                  </div>
                </div>
              {:else}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                <pre class="sse-event-data-viewer sse-event-pre" class:sse-event-data-json={isJson(displayArgs(message))}><code>{@html renderBodyHtml(displayArgs(message))}</code></pre>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
      {#if hiddenMessageCount > 0}
        <div class="sse-pagination-row">
          <button class="btn btn-secondary btn-sm" type="button" onclick={() => (visibleMessageCount = Math.min(filteredMessages.length, visibleMessageCount + REALTIME_PAGE_SIZE))}>
            Load {Math.min(REALTIME_PAGE_SIZE, hiddenMessageCount).toLocaleString('en-US')} older
          </button>
          <span>Showing {visibleReversedMessages.length.toLocaleString('en-US')} of {filteredMessages.length.toLocaleString('en-US')}</span>
        </div>
      {/if}
    {/if}
  </div>

</div>

<style>
  .sio-ns-label {
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius-xs);
    padding: 1px var(--space-1-5);
  }
  .sio-event-name-badge {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent-hover);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .sio-expanded-body {
    font-family: var(--font-mono);
    font-size: var(--text-label);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    color: inherit;
  }

  .sio-handshake {
    padding: var(--space-3) var(--space-3);
    font-size: var(--text-label);
    font-family: var(--font-mono);
    line-height: var(--leading-relaxed);
  }
  .sio-hs-error {
    color: var(--delete);
    font-weight: var(--weight-medium);
    margin-bottom: var(--space-3);
    font-family: inherit;
  }
  .sio-hs-connected {
    color: var(--success);
    font-weight: var(--weight-medium);
    margin-bottom: var(--space-3);
    font-family: inherit;
  }
  .sio-hs-status-ok { color: var(--success); }

  .sio-listen-count {
    color: var(--accent);
    opacity: 0.8;
  }

  .sio-not-listening-inline {
    opacity: 0.85;
  }
  .sio-not-listening-inline:hover { opacity: 1; }

  .sio-new-top-wrap {
    display: flex;
    justify-content: center;
    padding: var(--space-1-5) 0 var(--space-0-5);
    position: sticky;
    top: 0;
    z-index: 5;
    pointer-events: none;
  }
  .sio-new-top-wrap .sse-new-messages-btn {
    pointer-events: all;
  }
  .sio-hs-section-title {
    color: var(--accent);
    font-size: var(--text-caption);
    font-weight: var(--weight-semibold);
    text-transform: none;
    letter-spacing: 0;
    margin: var(--space-2-5) 0 var(--space-1);
    font-family: var(--font-ui);
  }
  .sio-hs-row {
    display: flex;
    gap: var(--space-2);
    padding: 1px 0;
    color: var(--text);
  }
  .sio-hs-key {
    color: var(--text-2);
    white-space: nowrap;
    min-width: 8.75rem;
    flex-shrink: 0;
  }
  .sio-hs-url {
    color: var(--accent);
    word-break: break-all;
    text-decoration: none;
  }
  .sio-hs-url:hover { text-decoration: underline; }
  .sio-hs-method { color: var(--success); }
  .sio-hs-status { color: var(--danger); }
  .sio-hs-val { word-break: break-all; }

  .sio-hs-header-row {
    display: flex;
    gap: var(--space-2);
    padding: 1px var(--space-3);
  }
  .sio-hs-hkey {
    color: var(--text-3);
    white-space: nowrap;
    min-width: 12.5rem;
    flex-shrink: 0;
  }
  .sio-hs-hval {
    color: var(--accent);
    word-break: break-all;
  }
</style>
