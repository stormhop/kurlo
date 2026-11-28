<script lang="ts">
  import Select from './Select.svelte';
  import VirtualList from './VirtualList.svelte';
  import Chevron from './Chevron.svelte';
  import BirdSpinner from './BirdSpinner.svelte';
  import { renderResponseBodyLines } from '../response-render';
  import { formatSize } from '../utils';
  import { mqttTopicColor, mqttTopicMatches, mqttValidateFilter, type MqttMessage } from '../mqtt';
  import { mqttClearMessages, mqttSession } from '../stores/mqtt.svelte';
  import { vm } from '../stores/app.svelte';
  import { SvelteSet } from 'svelte/reactivity';

  type Filter = 'all' | 'received' | 'sent' | 'other';
  const ROW_HEIGHT = 34;
  const TOPIC_COLORS = ['--proto-grpc', '--proto-sio', '--proto-kafka', '--proto-graphql', '--proto-ws', '--proto-ai', '--proto-mcp', '--proto-mqtt'];

  let session = $derived(mqttSession(vm.activeRequestId));
  let messages = $derived(session.messages);
  let status = $derived(session.status);
  let query = $state('');
  let searchOpen = $state(false);
  let searchInput = $state<HTMLInputElement | undefined>();
  $effect(() => { if (searchOpen) setTimeout(() => searchInput?.focus(), 0); });
  let filter = $state<Filter>('all');
  let topicFilter = $state('');
  const expanded = new SvelteSet<string>();
  let listEl = $state<HTMLElement | undefined>();

  let topicQuery = $derived(topicFilter.trim());
  let topicWildcard = $derived(/[+#]/.test(topicQuery) && !mqttValidateFilter(topicQuery));
  let received = $derived(messages.filter(m => m.direction === 'incoming').length);
  let sent = $derived(messages.filter(m => m.direction === 'outgoing').length);
  let bytes = $derived(messages.reduce((total, m) => total + (m.isSystem ? 0 : m.size), 0));
  let filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return messages.filter(m => {
      if (filter === 'received' && m.direction !== 'incoming') return false;
      if (filter === 'sent' && m.direction !== 'outgoing') return false;
      if (filter === 'other' && m.direction !== 'system') return false;
      if (topicQuery && (m.isSystem || !m.topic || !(topicWildcard ? mqttTopicMatches(topicQuery, m.topic) : m.topic.toLowerCase().includes(topicQuery.toLowerCase())))) return false;
      if (!q) return true;
      return [m.topic ?? '', m.payload ?? '', m.message ?? ''].join('\n').toLowerCase().includes(q);
    });
  });
  let rows = $derived(filtered.map(m => ({ key: m.id, height: ROW_HEIGHT, m })).reverse());
  let following = true;
  let userScrolling = false;
  let userScrollTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    rows;
    if (!following || !listEl) return;
    const el = listEl;
    requestAnimationFrame(() => { if (following) el.scrollTop = 0; });
  });
  $effect(() => () => clearTimeout(userScrollTimer));
  $effect(() => {
    const el = listEl;
    if (!el) return;
    const events = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
    for (const name of events) el.addEventListener(name, noteUserScroll, { passive: true });
    return () => { for (const name of events) el.removeEventListener(name, noteUserScroll); };
  });

  function noteUserScroll() {
    userScrolling = true;
    clearTimeout(userScrollTimer);
    userScrollTimer = setTimeout(() => { userScrolling = false; }, 400);
  }

  function onLogScroll() {
    const el = listEl;
    if (!el) return;
    if (el.scrollTop < 48) following = true;
    else if (userScrolling) following = false;
    else if (following) el.scrollTop = 0;
  }


  let elapsed = $state('00:00:00');
  $effect(() => {
    if (status !== 'connected') { elapsed = '00:00:00'; return; }
    const from = session.connectedAt;
    const tickClock = () => {
      const secs = Math.max(0, Math.floor((Date.now() - from) / 1000));
      elapsed = [Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60].map(v => String(v).padStart(2, '0')).join(':');
    };
    tickClock();
    const id = setInterval(tickClock, 1000);
    return () => clearInterval(id);
  });

  function toggle(id: string) {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  }

  function time(ts: number) {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function isJson(text: string) {
    const t = text.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return false;
    try { JSON.parse(t); return true; } catch { return false; }
  }

  function kind(m: MqttMessage) {
    if (m.isError) return 'error';
    if (m.isSystem) return 'info';
    if (m.encoding === 'base64') return 'binary';
    return isJson(m.payload ?? '') ? 'json' : 'text';
  }

  function preview(m: MqttMessage) {
    const text = m.isSystem ? m.message ?? '' : m.payload ?? '';
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!m.isSystem && !flat) return '(empty)';
    return flat.length > 160 ? flat.slice(0, 160) + '…' : flat;
  }

  function html(m: MqttMessage) {
    const text = m.payload ?? '';
    const json = m.encoding !== 'base64' && isJson(text);
    return renderResponseBodyLines(json ? JSON.stringify(JSON.parse(text), null, 2) : text, json, query, 0).map(line => line.html).join('\n');
  }

  function topicStyle(topic: string) {
    return `--topic-color: var(${TOPIC_COLORS[mqttTopicColor(topic)]})`;
  }

  const statusLabel = $derived(status === 'connecting' ? 'Connecting' : status === 'reconnecting' ? 'Reconnecting' : status === 'connected' ? 'Connected' : status === 'error' ? 'Error' : status === 'disconnected' ? 'Disconnected' : 'Idle');
</script>

<div class="sse-panel mqtt-panel" data-testid="mqtt-panel">
  <div class="sse-postman-bar">
    <div class="sse-summary">
      {#if status !== 'idle'}
        <span class="status-badge {status === 'error' ? 'status-5xx' : status === 'connected' ? 'status-2xx' : 'sse-status-neutral'}">{statusLabel}</span>
      {/if}
      {#if status === 'connected'}<span class="sse-summary-dot"></span><span>{elapsed}</span>{/if}
      {#if status === 'reconnecting' || status === 'connecting'}<span class="sse-summary-dot"></span><BirdSpinner size="0.875rem" />{/if}
      {#if session.clientId && status === 'connected'}<span class="sse-summary-dot"></span><span class="client-id">{session.clientId}</span>{/if}
      {#if status !== 'idle'}<span class="sse-summary-dot"></span>{/if}<span>↓ {received} · ↑ {sent}</span>
      <span class="sse-summary-dot"></span><span>{formatSize(bytes)}</span>
    </div>
    {#if searchOpen}
      <div class="field field-md field-wrap response-search-box">
        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
          <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        <input bind:this={searchInput} bind:value={query} placeholder="Search" aria-label="Search messages" type="search" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} />
        <span class="response-search-count">{filtered.length}/{messages.length}</span>
      </div>
    {/if}
    <Select className="ws-filter-menu" ariaLabel="Message filter" bind:value={filter} options={[{ value: 'all', label: 'All messages' }, { value: 'received', label: 'Received' }, { value: 'sent', label: 'Sent' }, { value: 'other', label: 'Connection events' }]} />
    <input class="field field-md topic-filter" aria-label="Topic filter" placeholder="Filter by topic" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" bind:value={topicFilter} />
    <div class="resp-actions">
      <button class="btn btn-icon" aria-label="Search response" aria-pressed={searchOpen} onclick={() => { searchOpen = !searchOpen; if (!searchOpen) query = ''; }} type="button">
        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
          <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </button>
      <button class="btn btn-icon" type="button" onclick={() => mqttClearMessages(vm.activeRequestId)} disabled={messages.length === 0} aria-label="Clear messages">
        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <path d="M2 3h9M5 3V2h3v1M4 3v7a1 1 0 001 1h3a1 1 0 001-1V3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  </div>
  {#if status === 'connecting' || status === 'reconnecting'}
    <div class="realtime-progress" aria-hidden="true"><span></span></div>
  {/if}

  <div class="sse-event-list ws-message-list mqtt-log" bind:this={listEl} onscroll={onLogScroll} role="log">
    {#if messages.length === 0}
      <div class="empty-state sse-empty-state">
        <span>{status === 'connected' ? 'No messages yet. Subscribe to a topic or send a message.' : 'Connect to the broker to publish and receive messages'}</span>
      </div>
    {:else if filtered.length === 0}
      <div class="empty-state sse-empty-state"><span class="empty-state-title">No messages match the filters</span></div>
    {:else}
      {#if listEl}
      <VirtualList {rows} rowHeight={ROW_HEIGHT} scroller={listEl} ariaLabel="MQTT messages">
        {#snippet row({ m })}
        {@const open = expanded.has(m.id)}
        <div class="sse-event-row" class:sse-event-system={m.isSystem} class:sse-event-error={m.isError} data-testid="mqtt-message">
          <button class="sse-event-main" type="button" disabled={m.isSystem} aria-expanded={m.isSystem ? undefined : open} onclick={() => !m.isSystem && toggle(m.id)}>
            <span class="sse-event-arrow ws-event-arrow" class:incoming={m.direction === 'incoming'} class:outgoing={m.direction === 'outgoing'} class:system={m.direction === 'system'} aria-label={m.direction === 'incoming' ? 'Received' : m.direction === 'outgoing' ? 'Sent' : 'Event'}>
              {#if m.direction === 'outgoing'}
                <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M6.5 11V2M3 5l3.5-3L10 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {:else if m.direction === 'incoming'}
                <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M6.5 2v9M3 8l3.5 3L10 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {:else}
                <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M6.5 4v3.5M6.5 9.5v.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
              {/if}
            </span>
            {#if !m.isSystem && m.topic}<span class="topic-chip" style={topicStyle(m.topic)}>{m.topic}</span>{/if}
            <span class="sse-event-preview">{preview(m)}</span>
            {#if !m.isSystem}
              <span class="flags">{#if m.retain}<span class="flag">R</span>{/if}<span class="flag">Q{m.qos}</span></span>
            {/if}
            <span class="sse-event-time">{time(m.timestamp)}</span>
            {#if !m.isSystem}<span class="sse-expand-chevron" style="transform: rotate({open ? 180 : 0}deg)" aria-hidden="true"><Chevron /></span>{/if}
          </button>
          {#if open && !m.isSystem}
            <div class="sse-event-body mqtt-details">
              <div class="rt-handshake">
                <div class="rt-detail-row"><span class="rt-detail-key">Topic</span><span class="rt-detail-val">{m.topic}</span></div>
                <div class="rt-detail-row"><span class="rt-detail-key">QoS</span><span class="rt-detail-val">{m.qos}</span></div>
                <div class="rt-detail-row"><span class="rt-detail-key">Retained</span><span class="rt-detail-val">{m.retain ? 'Yes' : 'No'}</span></div>
                {#if m.duplicate}<div class="rt-detail-row"><span class="rt-detail-key">Duplicate</span><span class="rt-detail-val">Yes</span></div>{/if}
                <div class="rt-detail-row"><span class="rt-detail-key">Message type</span><span class="rt-detail-val">{kind(m) === 'binary' ? 'Binary (shown as Base64)' : kind(m) === 'json' ? 'JSON' : 'Text'}</span></div>
                <div class="rt-detail-row"><span class="rt-detail-key">Size</span><span class="rt-detail-val">{formatSize(m.size)}{#if m.truncated}{' · the first 256 KB are shown'}{/if}</span></div>
                {#if m.contentType}<div class="rt-detail-row"><span class="rt-detail-key">Content type</span><span class="rt-detail-val">{m.contentType}</span></div>{/if}
                {#if m.responseTopic}<div class="rt-detail-row"><span class="rt-detail-key">Response topic</span><span class="rt-detail-val">{m.responseTopic}</span></div>{/if}
                {#if m.correlationData}<div class="rt-detail-row"><span class="rt-detail-key">Correlation data</span><span class="rt-detail-val">{m.correlationData}</span></div>{/if}
                {#if m.userProperties?.length}
                  <div class="rt-detail-section-title">User properties</div>
                  {#each m.userProperties as p, i (i)}
                    <div class="rt-detail-header-row"><span class="rt-detail-hkey">{p.key}</span><span class="rt-detail-hval">{p.value}</span></div>
                  {/each}
                {/if}
              </div>
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              <pre class="sse-event-data-viewer sse-event-pre" class:sse-event-data-json={kind(m) === 'json'}><code>{@html html(m)}</code></pre>
            </div>
          {/if}
        </div>
        {/snippet}
      </VirtualList>
      {/if}
    {/if}
  </div>
</div>

<style>
  .topic-filter { flex: 0 1 14rem; min-width: 8rem; font-family: var(--font-mono); }
  .client-id { max-width: 14rem; overflow: hidden; color: var(--text-3); font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
  .topic-chip {
    flex: 0 1 auto;
    max-width: 40%;
    overflow: hidden;
    padding: 0 var(--space-1-5);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--topic-color) 14%, transparent);
    color: var(--topic-color);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .flags { display: flex; flex: none; gap: var(--space-1); }
  .flag { padding: 0 var(--space-1); border-radius: var(--radius-sm); background: var(--elevated); color: var(--text-3); font-family: var(--font-mono); font-size: var(--text-micro); }
  .mqtt-details { display: flex; flex-direction: column; gap: var(--space-2); }
</style>
