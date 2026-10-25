<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { tabListKeyboard } from '../a11y';
  import { renderResponseBodyLines } from '../response-render';
  import { byteLength, formatSize } from '../utils';
  import type { KeyValue, WebSocketMessageEntry, WebSocketStatus } from '../types/models';

  type WSTab = 'messages' | 'headers';
  type WSMessageFilter = 'all' | 'sent' | 'received';
  const REALTIME_PAGE_SIZE = 200;

  const messageFilterOptions: { value: WSMessageFilter; label: string; icon: string }[] = [
    { value: 'all', label: 'All messages', icon: '' },
    { value: 'sent', label: 'Sent messages', icon: '↑' },
    { value: 'received', label: 'Received messages', icon: '↓' },
  ];

  let {
    status,
    connectedAt,
    messages,
    headers,
    error,
    responseTab = $bindable<WSTab>('messages'),
    canRestore,
    onClear,
    onRestore,
  }: {
    status: WebSocketStatus;
    connectedAt: number;
    messages: WebSocketMessageEntry[];
    headers: KeyValue[];
    error: string;
    responseTab: WSTab;
    canRestore: boolean;
    onClear: () => void;
    onRestore: () => void;
  } = $props();

  let searchQuery = $state('');
  let searchOpen = $state(false);
  let searchInput = $state<HTMLInputElement | undefined>();
  let messageFilter = $state<WSMessageFilter>('all');
  let filterMenuOpen = $state(false);
  let listEl = $state<HTMLElement | undefined>();
  let atTop = $state(true);
  let newMessagesBadge = $state(0);
  let expandedIds = $state<Set<string>>(new Set());
  let lastSeenCount = $state(0);
  let visibleMessageCount = $state(REALTIME_PAGE_SIZE);

  let streamSize = $derived.by(() => messages.reduce((total, message) => total + byteLength(message.data || message.message || ''), 0));
  let filteredMessages = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    return messages.filter((message) => {
      if (messageFilter === 'sent' && message.direction !== 'outgoing') return false;
      if (messageFilter === 'received' && message.direction !== 'incoming') return false;
      if (!q) return true;
      const haystack = [
        message.type,
        message.direction,
        message.encoding ?? '',
        message.message ?? '',
        messagePreview(message),
        displayData(message),
      ].join('\n').toLowerCase();
      return haystack.includes(q);
    });
  });
  let reversedMessages = $derived([...filteredMessages].reverse());
  let visibleReversedMessages = $derived(reversedMessages.slice(0, visibleMessageCount));
  let hiddenMessageCount = $derived(Math.max(0, filteredMessages.length - visibleReversedMessages.length));

  $effect(() => {
    const count = filteredMessages.length;
    untrack(() => {
      if (count === 0) {
        lastSeenCount = 0;
        newMessagesBadge = 0;
        atTop = true;
        return;
      }
      if (count === lastSeenCount) return;
      const delta = lastSeenCount === 0 ? 0 : Math.max(1, count - lastSeenCount);
      lastSeenCount = count;
      if (responseTab === 'messages' && atTop) {
        newMessagesBadge = 0;
        void scrollToTop();
      } else if (delta > 0) {
        newMessagesBadge = Math.min(9999, newMessagesBadge + delta);
      }
    });
  });

  $effect(() => {
    searchQuery;
    messageFilter;
    visibleMessageCount = REALTIME_PAGE_SIZE;
  });

  $effect(() => {
    if (searchOpen) setTimeout(() => searchInput?.focus(), 0);
  });

  async function scrollToTop() {
    await tick();
    requestAnimationFrame(() => {
      if (!listEl) return;
      listEl.scrollTop = 0;
      atTop = true;
      newMessagesBadge = 0;
      lastSeenCount = filteredMessages.length;
    });
  }

  function onScroll() {
    if (!listEl) return;
    atTop = listEl.scrollTop < 96;
    if (atTop) {
      newMessagesBadge = 0;
      lastSeenCount = filteredMessages.length;
    }
  }

  function jumpToTop() {
    responseTab = 'messages';
    atTop = true;
    newMessagesBadge = 0;
    lastSeenCount = filteredMessages.length;
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

  function selectMessageFilter(nextFilter: WSMessageFilter) {
    messageFilter = nextFilter;
    filterMenuOpen = false;
  }

  function filterLabel(): string {
    return messageFilterOptions.find((option) => option.value === messageFilter)?.label ?? 'All messages';
  }

  function filterEmptyLabel(): string {
    if (searchQuery.trim()) return `No messages match "${searchQuery}"`;
    if (messageFilter === 'sent') return 'No sent messages';
    if (messageFilter === 'received') return 'No received messages';
    return 'No messages';
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function isJson(data: string): boolean {
    const trimmed = data.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return false;
    try { JSON.parse(trimmed); return true; } catch { return false; }
  }

  function tryFormatJson(data: string): string {
    try { return JSON.stringify(JSON.parse(data), null, 2); } catch { return data; }
  }

  function displayData(message: WebSocketMessageEntry): string {
    if (message.message) return message.message;
    if (message.type === 'binary' && message.encoding === 'base64') return `[base64 ${formatSize(message.size)}] ${message.data}`;
    if (message.type === 'binary') return `[binary ${formatSize(message.size)}] ${message.data}`;
    return message.data;
  }

  function friendlyWebSocketClose(message: string): string {
    const raw = message.trim().replace(/^Error:\s*/i, '').replace(/^websocket:\s*/i, '');
    const lower = raw.toLowerCase();

    if (!raw) return 'Connection closed.';
    if (lower === 'disconnected') return 'Disconnected';
    if (lower.includes('connection closed unexpectedly') && lower.includes('close frame')) return raw;
    if (lower.includes('unexpected eof') || lower.includes('abnormal closure') || lower.includes('close 1006')) {
      return 'Connection closed unexpectedly. The server ended the connection without a close frame.';
    }
    if (lower.includes('close 1000') || lower.includes('normal closure')) return 'Connection closed normally.';
    if (lower.includes('close 1001') || lower.includes('going away')) return 'Server closed the connection.';
    if (lower.includes('read limit') || lower.includes('message too big')) return 'Message is too large for this WebSocket connection.';
    if (lower.includes('policy violation')) return 'Server closed the connection because of a policy violation.';
    if (lower.includes('protocol error')) return 'WebSocket protocol error.';
    return raw;
  }

  function friendlyWebSocketError(message: string): string {
    const raw = message.trim().replace(/^Error:\s*/i, '').replace(/^websocket:\s*/i, '');
    const lower = raw.toLowerCase();

    if (!raw) return 'WebSocket error. Check the URL and try again.';
    if (lower.includes('empty url')) return 'Enter a WebSocket URL.';
    if (lower.includes('invalid url') || lower.includes('unsupported websocket url scheme') || lower.includes('missing host')) {
      return 'Invalid WebSocket URL. Use ws:// or wss://.';
    }
    if (lower.includes('no such host') || lower.includes('enotfound')) return 'Host not found. Check the domain name.';
    if (lower.includes('no route to host') || lower.includes('network is unreachable') || lower.includes('ehostunreach') || lower.includes('enetunreach')) {
      return 'Host unreachable. Check the URL or network.';
    }
    if (lower.includes('connection refused') || lower.includes('econnrefused')) return 'Connection refused. Make sure the WebSocket server is running.';
    if (lower.includes('timeout') || lower.includes('etimedout')) return 'Connection timed out. Check the URL or network.';
    if (lower.includes('certificate') || lower.includes('tls:')) return 'TLS certificate error. Check SSL settings or the certificate.';
    if (lower.includes('handshake failed')) return raw.replace(/^WebSocket handshake failed:\s*/i, 'Handshake failed: ');
    return friendlyWebSocketClose(raw);
  }

  function messagePreview(message: WebSocketMessageEntry): string {
    const value = displayData(message);
    if (message.type === 'disconnected') return friendlyWebSocketClose(value);
    if (message.isError || message.type === 'error') return friendlyWebSocketError(value);
    if (message.isSystem) return value;
    return value;
  }

  function preview(message: WebSocketMessageEntry): string {
    const value = messagePreview(message);
    return value.length > 160 ? value.slice(0, 160) + '...' : value;
  }

  function renderMessageHtml(message: WebSocketMessageEntry): string {
    const data = displayData(message);
    const json = message.type !== 'binary' && isJson(data);
    return renderResponseBodyLines(json ? tryFormatJson(data) : data, json, searchQuery, 0)
      .map((line) => line.html)
      .join('\n');
  }

  function badgeClass(message: WebSocketMessageEntry): string {
    if (message.isError) return 'sse-badge-error';
    if (message.type === 'connected') return 'sse-badge-connected';
    if (message.type === 'reconnecting') return 'sse-badge-system';
    if (message.type === 'disconnected' || message.type === 'close') return 'sse-badge-disconnected';
    if (message.type === 'ping' || message.type === 'pong') return 'sse-badge-ping';
    if (message.type === 'binary') return 'sse-badge-notification';
    if (message.type === 'text' && isJson(displayData(message))) return 'sse-badge-default';
    if (message.isSystem) return 'sse-badge-system';
    return 'sse-badge-message';
  }

  function badgeLabel(message: WebSocketMessageEntry): string {
    if (message.type === 'text' && isJson(displayData(message))) return 'json';
    return message.type;
  }

  function isDisconnected(message: WebSocketMessageEntry): boolean {
    return message.type === 'disconnected' || message.type === 'close';
  }

  function isExpandable(message: WebSocketMessageEntry): boolean {
    if (message.handshake) return true;
    if (message.isSystem || message.isError || message.type === 'error' || isDisconnected(message)) return !!messagePreview(message);
    return !!displayData(message);
  }

  function detailStatusCode(message: WebSocketMessageEntry): number | undefined {
    if (message.handshake?.statusCode) return message.handshake.statusCode;
    const raw = message.handshake?.statusText ?? message.message ?? message.data ?? '';
    const parsed = Number(raw.match(/\b(\d{3})\b/)?.[1] ?? 0);
    return parsed || undefined;
  }

  function detailStatusText(message: WebSocketMessageEntry): string {
    if (message.type === 'connected') return '101 Switching Protocols';
    if (message.type === 'error') return friendlyWebSocketError(message.message ?? message.data);
    if (isDisconnected(message)) return friendlyWebSocketClose(message.message ?? message.data);
    if (message.handshake?.statusText) return message.handshake.statusText;
    return message.type;
  }

  function detailTone(message: WebSocketMessageEntry): 'ok' | 'error' | 'neutral' {
    if (message.isError || message.type === 'error') return 'error';
    if (message.type === 'connected') return 'ok';
    return 'neutral';
  }

  function statusLabel(): string {
    if (status === 'connecting') return 'Connecting';
    if (status === 'reconnecting') return 'Reconnecting';
    if (status === 'connected') return 'Connected';
    if (status === 'error') return 'Error';
    return 'Idle';
  }

  function elapsedTime(from: number): string {
    const secs = Math.floor((Date.now() - from) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  }

  let elapsed = $state('00:00:00');
  $effect(() => {
    if (status !== 'connected') { elapsed = '00:00:00'; return; }
    elapsed = elapsedTime(connectedAt);
    const id = setInterval(() => { elapsed = elapsedTime(connectedAt); }, 1000);
    return () => clearInterval(id);
  });
</script>

<div class="sse-panel ws-panel">
  <div class="sse-postman-bar">
    <div class="sse-summary">
      {#if status !== 'idle'}
        <span class="status-badge {status === 'error' ? 'status-5xx' : status === 'connected' ? 'status-2xx' : 'sse-status-neutral'}">{statusLabel()}</span>
      {/if}
      {#if status === 'connected'}<span class="sse-summary-dot"></span><span>{elapsed}</span>{/if}
      {#if status === 'reconnecting'}<span class="sse-summary-dot"></span><span class="sse-spinner-sm"></span><span>Reconnecting</span>{/if}
      {#if status === 'error' && error}<span class="sse-summary-dot"></span><span class="sse-status-error" title={error}>{friendlyWebSocketError(error)}</span>{/if}
      {#if status !== 'idle'}<span class="sse-summary-dot"></span>{/if}<span>{messages.length} {messages.length === 1 ? 'message' : 'messages'}</span>
      <span class="sse-summary-dot"></span><span>{formatSize(streamSize)}</span>
    </div>
    <div class="tab-bar response-tabs sse-tabs" role="tablist" use:tabListKeyboard>
      <button class="tab" role="tab" class:active={responseTab === 'messages'} aria-selected={responseTab === 'messages'} tabindex={responseTab === 'messages' ? 0 : -1} onclick={() => (responseTab = 'messages')} type="button">
        Messages{#if messages.length}<span class="badge">{messages.length}</span>{/if}
      </button>
      <button class="tab" role="tab" class:active={responseTab === 'headers'} aria-selected={responseTab === 'headers'} tabindex={responseTab === 'headers' ? 0 : -1} onclick={() => (responseTab = 'headers')} type="button">
        Headers{#if headers.length}<span class="badge">{headers.length}</span>{/if}
      </button>
    </div>

    {#if responseTab === 'messages' && searchOpen}
      <div class="field field-md field-wrap response-search-box">
        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
          <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        <input
          bind:this={searchInput}
          bind:value={searchQuery}
          placeholder="Search"
          aria-label="Search messages"
          type="search"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck={false}
        />
        <span class="response-search-count">{filteredMessages.length}/{messages.length}</span>
      </div>
    {/if}

    {#if responseTab === 'messages'}
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
            {#each messageFilterOptions as option, eachIndex (eachIndex)}
              <button class="menu-item"
                class:active={messageFilter === option.value}
                role="option"
                aria-selected={messageFilter === option.value}
                type="button"
                onclick={() => selectMessageFilter(option.value)}
              >
                <span class="ws-filter-icon">{option.icon}</span>
                <span>{option.label}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <div class="resp-actions">
      {#if responseTab === 'messages'}
        <button class="btn btn-icon" title="Search response" aria-label="Search response" aria-pressed={searchOpen} onclick={() => (searchOpen = !searchOpen)} type="button">
          <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
            <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
            <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
        </button>
      {/if}
      {#if canRestore}
        <button class="btn btn-secondary btn-sm sse-clear-btn sse-restore-btn" type="button" onclick={onRestore}>
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <path d="M3 6a3.5 3.5 0 116.1 2.3M3 6H1.5M3 6V4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Restore
        </button>
      {/if}
      {#if responseTab === 'messages'}
        <button class="btn btn-icon" type="button" onclick={onClear} disabled={messages.length === 0} title="Clear messages" aria-label="Clear messages">
          <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <path d="M2 3h9M5 3V2h3v1M4 3v7a1 1 0 001 1h3a1 1 0 001-1V3"
              stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      {/if}
    </div>
  </div>
  {#if status === 'connecting' || status === 'reconnecting'}
    <div class="realtime-progress" aria-hidden="true"><span></span></div>
  {/if}

  {#if responseTab === 'messages'}
    <div class="sse-event-list ws-message-list" bind:this={listEl} onscroll={onScroll} role="log" aria-live="polite">
      {#if !atTop && newMessagesBadge > 0}
        <div class="sio-new-top-wrap">
          <button class="btn btn-primary btn-sm sse-new-messages-btn" type="button" onclick={jumpToTop}>
            <svg width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M6 10V2M3 5l3-3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            {newMessagesBadge > 999 ? '999+' : newMessagesBadge} new message{newMessagesBadge !== 1 ? 's' : ''}
          </button>
        </div>
      {/if}

      {#if messages.length === 0}
        <div class="empty-state sse-empty-state">
          {#if status === 'connected'}
            <span class="empty-state-title">No messages yet</span>
          {:else}
            <span>Connect to send and receive messages</span>
          {/if}
        </div>
      {:else if filteredMessages.length === 0}
        <div class="empty-state sse-empty-state">
          <span class="empty-state-title">{filterEmptyLabel()}</span>
        </div>
      {:else}
        {#each visibleReversedMessages as message (message.id || message.timestamp)}
          {@const key = message.id || String(message.timestamp)}
          {@const expanded = expandedIds.has(key)}
          {@const hasExpandable = isExpandable(message)}
          <div
            class="sse-event-row"
            class:sse-event-system={message.isSystem}
            class:sse-event-connected={message.type === 'connected'}
            class:sse-event-disconnected={isDisconnected(message)}
            class:sse-event-error={message.isError}
          >
            <button
              class="sse-event-main"
              type="button"
              disabled={!hasExpandable}
              onclick={() => hasExpandable && toggleExpand(key)}
            >
              <span
                class="sse-event-arrow ws-event-arrow"
                class:incoming={message.direction === 'incoming'}
                class:outgoing={message.direction === 'outgoing'}
                class:system={message.direction === 'system'}
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
              <span class="sse-badge {badgeClass(message)}">{badgeLabel(message)}</span>
              <span class="sse-event-preview">{preview(message)}</span>
              <span class="sse-event-time">{formatTime(message.timestamp)}</span>

              {#if hasExpandable}
                <span class="sse-expand-chevron" style="transform: rotate({expanded ? 180 : 0}deg)" aria-hidden="true">
                  <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none">
                    <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                </span>
              {/if}
            </button>
            {#if expanded && hasExpandable}
              <div class="sse-event-body">
                {#if message.handshake || message.isSystem || message.isError || message.type === 'error' || isDisconnected(message)}
                  <div class="rt-handshake">
                    <div
                      class="rt-detail-message"
                      class:rt-detail-ok={detailTone(message) === 'ok'}
                      class:rt-detail-error={detailTone(message) === 'error'}
                    >
                      {messagePreview(message)}
                    </div>

                    <div class="rt-detail-section-title">Handshake details</div>
                    <div class="rt-detail-row">
                      <span class="rt-detail-key">Request URL</span>
                      <span class="rt-detail-val">{message.handshake?.url ?? ''}</span>
                    </div>
                    <div class="rt-detail-row">
                      <span class="rt-detail-key">Request method</span>
                      <span class="rt-detail-val rt-detail-method">{message.handshake?.method ?? 'GET'}</span>
                    </div>
                    {#if detailStatusCode(message)}
                      <div class="rt-detail-row">
                        <span class="rt-detail-key">Status Code</span>
                        <span class="rt-detail-val" class:rt-detail-status-ok={detailTone(message) === 'ok'} class:rt-detail-status-error={detailTone(message) === 'error'}>{detailStatusText(message)}</span>
                      </div>
                    {:else}
                      <div class="rt-detail-row">
                        <span class="rt-detail-key">Status</span>
                        <span class="rt-detail-val" class:rt-detail-status-error={detailTone(message) === 'error'}>{detailStatusText(message)}</span>
                      </div>
                    {/if}
                    {#if message.handshake?.protocol}
                      <div class="rt-detail-row">
                        <span class="rt-detail-key">Protocol</span>
                        <span class="rt-detail-val">{message.handshake.protocol}</span>
                      </div>
                    {/if}

                    {#if message.handshake?.requestHeaders && message.handshake.requestHeaders.length > 0}
                      <div class="rt-detail-section-title">Request headers</div>
                      {#each message.handshake.requestHeaders as h, eachIndex (eachIndex)}
                        <div class="rt-detail-header-row">
                          <span class="rt-detail-hkey">{h.key}</span>
                          <span class="rt-detail-hval">{h.value}</span>
                        </div>
                      {/each}
                    {/if}

                    {#if message.handshake?.responseHeaders && message.handshake.responseHeaders.length > 0}
                      <div class="rt-detail-section-title">Response headers</div>
                      {#each message.handshake.responseHeaders as h, eachIndex (eachIndex)}
                        <div class="rt-detail-header-row">
                          <span class="rt-detail-hkey">{h.key}</span>
                          <span class="rt-detail-hval">{h.value}</span>
                        </div>
                      {/each}
                    {/if}
                  </div>
                {:else}
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                  <pre class="sse-event-data-viewer sse-event-pre" class:sse-event-data-json={isJson(displayData(message))}><code>{@html renderMessageHtml(message)}</code></pre>
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
  {:else}
    <div class="response-headers-table sse-headers-table">
      {#if headers.length}
        {#each headers as h, eachIndex (eachIndex)}
          <div class="resp-header-row">
            <span class="resp-header-key">{h.key}</span>
            <span class="resp-header-val">{h.value}</span>
          </div>
        {/each}
      {:else}
        <div class="empty-state sse-empty-state"><span class="empty-state-title">No response headers yet</span></div>
      {/if}
    </div>
  {/if}
</div>
