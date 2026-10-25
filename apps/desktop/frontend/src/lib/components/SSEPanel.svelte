<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { tabListKeyboard } from '../a11y';
  import { renderResponseBodyLines } from '../response-render';
  import { byteLength, formatSize } from '../utils';
  import type { KeyValue, ResponseTimings, SSEEventEntry, SSEStatus } from '../types/models';
  import ResponseTimeTooltip from './ResponseTimeTooltip.svelte';

  type SSETab = 'messages' | 'headers';
  const REALTIME_PAGE_SIZE = 200;

  let {
    status,
    connectedUrl,
    statusText,
    statusCode,
    connectedAt,
    duration = 0,
    timings = null,
    events,
    headers,
    error,
    canRestore,
    onClear,
    onRestore,
  }: {
    status: SSEStatus;
    connectedUrl: string;
    statusText: string;
    statusCode: number;
    connectedAt: number;
    duration?: number;
    timings?: ResponseTimings | null;
    events: SSEEventEntry[];
    headers: KeyValue[];
    error: string;
    canRestore: boolean;
    onClear: () => void;
    onRestore: () => void;
  } = $props();

  let sseTab = $state<SSETab>('messages');
  let searchQuery = $state('');
  let searchOpen = $state(false);
  let searchInput = $state<HTMLInputElement | undefined>();
  let listEl = $state<HTMLElement | undefined>();
  let atTop = $state(true);
  let newMessagesBadge = $state(0);
  let expandedIds = $state<Set<number>>(new Set());
  let lastSeenEntryId = $state(0);
  let visibleEventCount = $state(REALTIME_PAGE_SIZE);

  function entryKey(ev: SSEEventEntry, idx: number): number {
    return ev.entryId ?? idx;
  }

  let filteredEvents = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    return q
      ? events.filter(
          (e) =>
            e.event.toLowerCase().includes(q) ||
            e.data.toLowerCase().includes(q) ||
            (e.message ?? '').toLowerCase().includes(q),
        )
      : events;
  });
  let reversedEvents = $derived([...filteredEvents].reverse());
  let visibleReversedEvents = $derived(reversedEvents.slice(0, visibleEventCount));
  let hiddenEventCount = $derived(Math.max(0, filteredEvents.length - visibleReversedEvents.length));

  let latestEntryId = $derived.by(() => {
    const ev = events[events.length - 1] as (SSEEventEntry & { entryId?: number }) | undefined;
    return ev?.entryId ?? events.length;
  });

  let streamSize = $derived.by(() => events.reduce((total, ev) => {
    return total + byteLength(ev.data || ev.message || '');
  }, 0));

  $effect(() => {
    const latest = latestEntryId;
    untrack(() => {
      if (latest === 0) {
        lastSeenEntryId = 0;
        newMessagesBadge = 0;
        atTop = true;
        return;
      }
      if (latest === lastSeenEntryId) return;
      const delta = lastSeenEntryId === 0 ? 0 : Math.max(1, latest - lastSeenEntryId);
      lastSeenEntryId = latest;
      if (sseTab === 'messages' && atTop) {
        newMessagesBadge = 0;
        void scrollToTop();
      } else if (delta > 0) {
        newMessagesBadge = Math.min(9999, newMessagesBadge + delta);
      }
    });
  });

  $effect(() => {
    searchQuery;
    visibleEventCount = REALTIME_PAGE_SIZE;
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
      lastSeenEntryId = latestEntryId;
    });
  }

  function onScroll() {
    if (!listEl) return;
    atTop = listEl.scrollTop < 96;
    if (atTop) {
      newMessagesBadge = 0;
      lastSeenEntryId = latestEntryId;
    }
  }

  function jumpToTop() {
    sseTab = 'messages';
    atTop = true;
    newMessagesBadge = 0;
    lastSeenEntryId = latestEntryId;
    void scrollToTop();
  }

  function toggleExpand(key: number) {
    expandedIds = expandedIds.has(key)
      ? new Set([...expandedIds].filter(item => item !== key))
      : new Set([...expandedIds, key]);
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function badgeClass(event: string, isError?: boolean, isSystem?: boolean): string {
    if (isError)  return 'sse-badge-error';
    const lower = event.toLowerCase();
    if (isSystem) {
      if (['connected', 'connect', 'open'].includes(lower)) return 'sse-badge-connected';
      if (['disconnected', 'disconnect', 'close', 'closed'].includes(lower)) return 'sse-badge-disconnected';
      return 'sse-badge-system';
    }
    const map: Record<string, string> = {
      error:        'sse-badge-error',
      notification: 'sse-badge-notification',
      info:         'sse-badge-info',
      ping:         'sse-badge-ping',
      heartbeat:    'sse-badge-ping',
      message:      'sse-badge-message',
    };
    return map[lower] ?? 'sse-badge-default';
  }

  function tryFormatJson(data: string): string {
    try { return JSON.stringify(JSON.parse(data), null, 2); } catch { return data; }
  }

  function isJson(data: string): boolean {
    const trimmed = data.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return false;
    try { JSON.parse(trimmed); return true; } catch { return false; }
  }

  function renderEventDataHtml(data: string): string {
    const json = isJson(data);
    return renderResponseBodyLines(json ? tryFormatJson(data) : data, json, searchQuery, 0)
      .map((line) => line.html)
      .join('\n');
  }

  function friendlySSEError(message: string): string {
    const raw = message.trim().replace(/^Error:\s*/i, '');
    const withoutMethod = raw.replace(/^(?:Get|Post|Put|Patch|Delete|Head|Options)\s+"[^"]+":\s*/i, '');
    const lower = withoutMethod.toLowerCase();

    if (!raw) return 'Connection failed. Check the URL and try again.';
    if (lower.includes('empty url')) return 'Enter a URL to open an SSE stream.';
    if (lower.includes('invalid url') || lower.includes('failed to build request')) {
      return 'Invalid URL. Check the address and try again.';
    }
    if (lower.includes('no such host') || lower.includes('enotfound')) {
      return 'Host not found. Check the domain name.';
    }
    if (lower.includes('no route to host') || lower.includes('network is unreachable') || lower.includes('ehostunreach')) {
      return 'Host unreachable. Check the URL or network.';
    }
    if (lower.includes('connection refused') || lower.includes('econnrefused')) {
      return 'Connection refused. Make sure the server is running.';
    }
    if (lower.includes('timeout') || lower.includes('etimedout')) {
      return 'Connection timed out. Check the URL or network.';
    }
    if (lower.includes('certificate') || lower.includes('tls:')) {
      return 'TLS certificate error. Check SSL settings or the certificate.';
    }

    return withoutMethod || raw;
  }

  function eventPreview(ev: SSEEventEntry): string {
    if (ev.isError) return friendlySSEError(ev.message ?? ev.data);
    if (ev.isSystem) return ev.message ?? '';
    return ev.data.length > 140 ? ev.data.slice(0, 140) + '...' : ev.data;
  }

  function sseStatusClass(): string {
    if (status === 'error') return 'status-5xx';
    if (status === 'reconnecting') return 'sse-status-neutral';
    if (!statusCode) return 'sse-status-neutral';
    if (statusCode >= 200 && statusCode < 300) return 'status-2xx';
    if (statusCode >= 300 && statusCode < 400) return 'status-3xx';
    if (statusCode >= 400 && statusCode < 500) return 'status-4xx';
    return 'status-5xx';
  }

  function statusLabel(): string {
    if (status === 'connecting') return 'Connecting';
    if (status === 'reconnecting') return 'Reconnecting';
    if (status === 'error') return 'Error';
    if (statusCode) return String(statusCode);
    return status === 'connected' ? 'Connected' : 'Idle';
  }

  function summaryStatusLabel(): string {
    if (status === 'reconnecting') return 'Reconnecting';
    if (status === 'connected' && statusText) return statusText;
    return statusLabel();
  }

  function showStatusBadge(): boolean {
    return status !== 'idle' || statusCode > 0;
  }

  function positiveMs(value: number | undefined | null): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  }

  let requestDuration = $derived(positiveMs(duration) || positiveMs(timings?.total));
  let hasRequestTiming = $derived(requestDuration > 0 || timings !== null);

  function elapsedMs(from: number): number {
    return Math.max(0, Date.now() - from);
  }

  function formatElapsed(ms: number): string {
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
    const secs = Math.floor(ms / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  let elapsed = $state('00:00:00');
  $effect(() => {
    if (status !== 'connected') { elapsed = '0 ms'; return; }
    elapsed = formatElapsed(elapsedMs(connectedAt));
    const id = setInterval(() => {
      elapsed = formatElapsed(elapsedMs(connectedAt));
    }, 250);
    return () => clearInterval(id);
  });
</script>

<div class="sse-panel">
  <div class="sse-postman-bar">
    <div class="sse-summary">
      {#if showStatusBadge()}
        <span class="status-badge {sseStatusClass()}">{summaryStatusLabel()}</span>
      {/if}
      {#if hasRequestTiming}
        <span class="sse-summary-dot"></span>
        <ResponseTimeTooltip timings={timings} total={requestDuration} streaming />
      {/if}
      {#if status === 'connected'}
        <span class="sse-summary-dot"></span>
        <span>{events.length.toLocaleString('en-US')} {events.length === 1 ? 'event' : 'events'}</span>
        <span class="sse-summary-dot"></span>
        <span>{formatSize(streamSize)}</span>
        <span class="sse-summary-dot"></span>
        <span class="sse-stream-elapsed" title="Stream duration">{elapsed}</span>
        <span class="sse-summary-url" title={connectedUrl}>{connectedUrl}</span>
      {:else if status === 'connecting'}
        <span class="sse-summary-dot"></span>
        <span class="sse-spinner-sm"></span>
        <span>Opening stream</span>
      {:else if status === 'error'}
        <span class="sse-summary-dot"></span>
        <span class="sse-status-error" title={error}>{friendlySSEError(error)}</span>
      {:else}
        <span>{events.length.toLocaleString('en-US')} {events.length === 1 ? 'event' : 'events'}</span>
        <span class="sse-summary-dot"></span>
        <span>{formatSize(streamSize)}</span>
      {/if}
    </div>

    <div class="tab-bar response-tabs sse-tabs" role="tablist" use:tabListKeyboard>
      <button class="tab" role="tab" class:active={sseTab === 'messages'} aria-selected={sseTab === 'messages'} tabindex={sseTab === 'messages' ? 0 : -1} onclick={() => (sseTab = 'messages')} type="button">
        Messages<span class="badge">{events.length.toLocaleString('en-US')}</span>
      </button>
      <button class="tab" role="tab" class:active={sseTab === 'headers'} aria-selected={sseTab === 'headers'} tabindex={sseTab === 'headers' ? 0 : -1} onclick={() => (sseTab = 'headers')} type="button">
        Headers{#if headers.length}<span class="badge">{headers.length}</span>{/if}
      </button>
    </div>

    {#if sseTab === 'messages' && searchOpen}
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
        <span class="response-search-count">{filteredEvents.length}/{events.length}</span>
      </div>
    {/if}

    <div class="resp-actions">
      {#if sseTab === 'messages'}
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
      {#if sseTab === 'messages'}
        <button class="btn btn-icon" type="button" onclick={onClear} disabled={events.length === 0} title="Clear messages" aria-label="Clear messages">
          <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <path d="M2 3h9M5 3V2h3v1M4 3v7a1 1 0 001 1h3a1 1 0 001-1V3"
              stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      {/if}
    </div>
  </div>
  {#if status === 'connecting'}
    <div class="realtime-progress" aria-hidden="true"><span></span></div>
  {/if}

  {#if sseTab === 'messages'}
    <div class="sse-event-list" bind:this={listEl} onscroll={onScroll} role="log" aria-live="polite">
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
      {#if events.length === 0 && status === 'idle'}
        <div class="empty-state sse-empty-state">
          <svg width="2rem" height="2rem" viewBox="0 0 32 32" fill="none" opacity="0.35">
            <circle cx="16" cy="16" r="13" stroke="currentColor" stroke-width="1.5"/>
            <path d="M10 16h12M16 10v12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <span class="empty-state-title">Connect to start receiving events</span>
        </div>
      {:else if filteredEvents.length === 0 && searchQuery}
        <div class="empty-state sse-empty-state">
          <span class="empty-state-title">No events match "{searchQuery}"</span>
        </div>
      {:else}
        {#each visibleReversedEvents as ev, idx (entryKey(ev, idx))}
          {@const key = entryKey(ev, idx)}
          {@const expanded = expandedIds.has(key)}
          {@const hasExpandable = !ev.isSystem && !ev.isError && !!ev.data}

          <div
            class="sse-event-row"
            class:sse-event-system={ev.isSystem}
            class:sse-event-connected={ev.isSystem && badgeClass(ev.event, ev.isError, ev.isSystem) === 'sse-badge-connected'}
            class:sse-event-disconnected={ev.isSystem && badgeClass(ev.event, ev.isError, ev.isSystem) === 'sse-badge-disconnected'}
            class:sse-event-error={ev.isError}
          >
            <button
              class="sse-event-main"
              type="button"
              disabled={!hasExpandable}
              onclick={() => hasExpandable && toggleExpand(key)}
            >
              <span class="sse-event-arrow" aria-hidden="true">
                {#if ev.isSystem || ev.isError}
                  <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
                    <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.2"/>
                    <path d="M6.5 4v3.5M6.5 9.5v.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                  </svg>
                {:else}
                  <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
                    <path d="M6.5 2v9M3 8l3.5 3L10 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
              </span>

              <span class="sse-badge {badgeClass(ev.event, ev.isError, ev.isSystem)}">
                {ev.isError ? 'error' : ev.event || 'system'}
              </span>

              <span class="sse-event-preview">
                {eventPreview(ev)}
              </span>

              <span class="sse-event-time">{formatTime(ev.timestamp)}</span>

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
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                <pre class="sse-event-data-viewer sse-event-pre" class:sse-event-data-json={isJson(ev.data)}><code>{@html renderEventDataHtml(ev.data)}</code></pre>
              </div>
            {/if}
          </div>
        {/each}
        {#if hiddenEventCount > 0}
          <div class="sse-pagination-row">
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => (visibleEventCount = Math.min(filteredEvents.length, visibleEventCount + REALTIME_PAGE_SIZE))}>
              Load {Math.min(REALTIME_PAGE_SIZE, hiddenEventCount).toLocaleString('en-US')} older
            </button>
            <span>Showing {visibleReversedEvents.length.toLocaleString('en-US')} of {filteredEvents.length.toLocaleString('en-US')}</span>
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
        <div class="empty-state sse-empty-state">
          <span class="empty-state-title">No response headers yet</span>
        </div>
      {/if}
    </div>
  {/if}
</div>
