<script lang="ts">
  import KurloBird from './KurloBird.svelte';
  import Keycaps from './Keycaps.svelte';
  import { tabListKeyboard } from '../a11y';
  import { renderResponseBodyLines } from '../response-render';
  import { vm } from '../stores/app.svelte';
  import type { GrpcMessage } from '../types/models';
  import { formatSize } from '../utils';

  type GrpcResponseRow =
    | {
        kind: 'message';
        key: string;
        timestamp: number;
        sortIndex: number;
        message: GrpcMessage;
        preview: string;
        body: string;
      }
    | {
        kind: 'cancelled' | 'error';
        key: string;
        timestamp: number;
        sortIndex: number;
        title: string;
        detail: string;
      };

  let response = $derived(vm.grpcResponse);
  let responseSearchInput = $state<HTMLInputElement | undefined>();
  let expandedIds = $state<Set<string>>(new Set());
  let hasScripts = $derived(Boolean(
    response?.testResult?.tests?.length ||
    response?.preRequestResult?.logs?.length ||
    response?.testResult?.logs?.length ||
    response?.preRequestResult?.error ||
    response?.testResult?.error,
  ));
  let responseTestSummary = $derived(vm.grpcResponseTestSummary);
  let grpcRows = $derived.by(() => {
    const current = response;
    if (!current) return [];
    const rows: GrpcResponseRow[] = (current.messages ?? []).map((message) => ({
      kind: 'message',
      key: `message-${message.index}-${message.timestamp}`,
      timestamp: message.timestamp || current.timestamp || 0,
      sortIndex: message.index,
      message,
      preview: compactGrpcJson(message.body),
      body: prettyGrpcJson(message.body),
    }));
    const terminalTimestamp = current.timestamp || Math.max(0, ...rows.map((row) => row.timestamp)) + 1 || Date.now();
    if (isGrpcCancelled(current.grpcCode, current.error)) {
      rows.push({
        kind: 'cancelled',
        key: `cancelled-${terminalTimestamp}`,
        timestamp: terminalTimestamp,
        sortIndex: Number.MAX_SAFE_INTEGER,
        title: 'Operation cancelled',
        detail: 'Cancelled on client',
      });
    } else if (current.error) {
      rows.push({
        kind: 'error',
        key: `error-${terminalTimestamp}`,
        timestamp: terminalTimestamp,
        sortIndex: Number.MAX_SAFE_INTEGER,
        title: 'Operation failed',
        detail: friendlyGrpcError(current.error),
      });
    }
    return rows.sort((a, b) => (b.timestamp - a.timestamp) || (b.sortIndex - a.sortIndex));
  });
  let filteredGrpcRows = $derived.by(() => {
    const query = vm.responseSearch.trim().toLowerCase();
    if (!query) return grpcRows;
    return grpcRows.filter((row) => grpcRowSearchText(row).toLowerCase().includes(query));
  });

  $effect(() => {
    if (vm.responseSearchOpen) setTimeout(() => responseSearchInput?.focus(), 0);
  });

  function grpcStatusClass(code: string) {
    if (code === 'OK') return 'status-2xx';
    if (code === 'STREAMING') return 'status-3xx';
    if (code === 'CANCELLED' || code === 'DEADLINE_EXCEEDED' || code === 'UNAVAILABLE') return 'status-5xx';
    return 'status-4xx';
  }

  function isGrpcCancelled(code = '', error = '') {
    const normalizedCode = code.toUpperCase();
    const normalizedError = error.toLowerCase();
    return normalizedCode === 'CANCELLED' || normalizedError.includes('request canceled') || normalizedError.includes('context canceled');
  }

  function friendlyGrpcError(error = '') {
    if (isGrpcCancelled('', error)) return 'Request canceled';
    return error.replace(/^gRPC\s+Canceled:\s*context canceled$/i, 'Request canceled');
  }

  function compactGrpcJson(body = '') {
    const trimmed = body.trim();
    if (!trimmed) return '{}';
    try { return JSON.stringify(JSON.parse(trimmed)); } catch { return trimmed.replace(/\s+/g, ' '); }
  }

  function prettyGrpcJson(body = '') {
    const trimmed = body.trim();
    if (!trimmed) return '{}';
    try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch { return trimmed; }
  }

  function formatGrpcTime(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const base = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  }

  function grpcMessageDirection(message: GrpcMessage) {
    return message.direction === 'outgoing' ? 'outgoing' : 'incoming';
  }

  function grpcRowBadgeClass(row: GrpcResponseRow) {
    if (row.kind !== 'message') return 'sse-badge-error';
    return grpcMessageDirection(row.message) === 'outgoing' ? 'sse-badge-notification' : 'sse-badge-default';
  }

  function grpcRowBadgeLabel(row: GrpcResponseRow) {
    if (row.kind !== 'message') return row.kind === 'cancelled' ? 'cancelled' : 'error';
    return grpcMessageDirection(row.message) === 'outgoing' ? 'sent' : 'received';
  }

  function grpcRowSearchText(row: GrpcResponseRow) {
    if (row.kind === 'message') {
      return `${grpcRowBadgeLabel(row)} ${row.preview} ${row.body}`;
    }
    return `${grpcRowBadgeLabel(row)} ${row.title} ${row.detail} ${grpcTrailerSummary()}`;
  }

  function rowExpanded(key: string) {
    return expandedIds.has(key);
  }

  function toggleRow(key: string) {
    expandedIds = expandedIds.has(key)
      ? new Set([...expandedIds].filter(item => item !== key))
      : new Set([...expandedIds, key]);
  }

  function renderGrpcBodyHtml(body: string) {
    return renderResponseBodyLines(body, 'json', vm.responseSearch, -1).map(line => line.html).join('\n');
  }

  function grpcTrailerSummary() {
    const count = response?.trailers?.length ?? 0;
    return count > 0 ? `${count} trailer${count === 1 ? '' : 's'} received.` : 'No trailer received.';
  }

  function onGrpcSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') vm.responseSearchOpen = false;
  }
</script>

<div class="response-area ws-panel grpc-response-area">
  {#if vm.loading && !response}
    <div class="response-placeholder response-loading-state" role="status" aria-label="Invoking gRPC method">
      <span class="response-waiting-bird"><KurloBird mode="flying" envelope size="3.25rem" /></span>
    </div>

  {:else if vm.requestError && !response}
    <div class="response-placeholder error" role="textbox" aria-readonly="true" tabindex="0">
      <div class="request-error-shell">
        <div class="request-error-title">Could not invoke method</div>
        <div class="request-error-card">
          <svg width="1.25rem" height="1.25rem" viewBox="0 0 20 20" fill="none">
            <path d="M10 2l8 14H2L10 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M10 7v4M10 14v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <span>{vm.requestError}</span>
        </div>
      </div>
    </div>

  {:else if response}
    <div class="response-status-bar">
      <div class="status-left">
        <span class="status-badge {grpcStatusClass(response.skipped ? 'STREAMING' : response.grpcCode)}">
          {response.skipped ? 'SKIPPED' : response.grpcCode || 'UNKNOWN'}
        </span>
        {#if response.skipped && response.skipReason}<span class="status-meta">{response.skipReason}</span>{/if}
        <span class="status-meta">{response.duration} ms</span>
        <span class="status-meta">{formatSize(response.size)}</span>
        {#if response.method?.fullName}<span class="status-meta grpc-status-method">{response.method.fullName}</span>{/if}
        {#if responseTestSummary}
          <span class="test-summary-pill" class:all-passed={responseTestSummary.allPassed}>{responseTestSummary.passed}/{responseTestSummary.total} tests</span>
        {/if}
      </div>
      <div class="status-right">
        {#if vm.grpcResponseTab === 'messages' && vm.responseSearchOpen}
          <div class="field field-md field-wrap response-search-box">
            <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
              <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
            </svg>
            <input
              bind:this={responseSearchInput}
              bind:value={vm.responseSearch}
              oninput={() => (vm.responseSearchIndex = 0)}
              onkeydown={onGrpcSearchKeydown}
              placeholder="Search"
              aria-label="Search gRPC messages"
              type="search"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
              spellcheck={false}
            />
            <span class="response-search-count">{filteredGrpcRows.length}/{grpcRows.length}</span>
          </div>
        {/if}
        <div class="resp-actions">
          {#if vm.grpcResponseTab === 'messages'}
            <button class="btn btn-icon" aria-label="Search response" aria-pressed={vm.responseSearchOpen} onclick={() => (vm.responseSearchOpen = !vm.responseSearchOpen)} type="button">
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
                <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
                <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
              </svg>
            </button>
          {/if}
          <button class="btn btn-icon" class:feedback-ok={vm.copiedBody} aria-label={vm.copiedBody ? 'Copied response' : 'Copy response'} onclick={vm.copyGrpcResponseBody} type="button">
            {#if vm.copiedBody}
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            {:else}
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><rect x="3" y="1" width="8" height="9" rx="1.2" stroke="currentColor" stroke-width="1.2"/><path d="M1 3.5v7a1.2 1.2 0 001.2 1.2H8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            {/if}
          </button>
          <button class="btn btn-icon" class:feedback-ok={vm.savedResponse} aria-label={vm.savedResponse ? 'Saved response' : 'Save to file'} onclick={vm.saveGrpcResponseFile} type="button">
            {#if vm.savedResponse}
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            {:else}
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M6.5 2v7M4 7l2.5 2.5L9 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            {/if}
          </button>
        </div>
      </div>
      <div class="tab-bar response-mini-tabs" role="tablist" use:tabListKeyboard>
        <button class="tab" role="tab" class:active={vm.grpcResponseTab === 'messages'} aria-selected={vm.grpcResponseTab === 'messages'} aria-controls="grpc-response-messages" tabindex={vm.grpcResponseTab === 'messages' ? 0 : -1} onclick={() => vm.setActiveGrpcResponseTab('messages')} type="button">
          Messages{#if response.messages?.length}<span class="badge">{response.messages.length}</span>{/if}
        </button>
        <button class="tab" role="tab" class:active={vm.grpcResponseTab === 'metadata'} aria-selected={vm.grpcResponseTab === 'metadata'} aria-controls="grpc-response-metadata" tabindex={vm.grpcResponseTab === 'metadata' ? 0 : -1} onclick={() => vm.setActiveGrpcResponseTab('metadata')} type="button">
          Metadata{#if response.headers?.length}<span class="badge">{response.headers.length}</span>{/if}
        </button>
        <button class="tab" role="tab" class:active={vm.grpcResponseTab === 'trailers'} aria-selected={vm.grpcResponseTab === 'trailers'} aria-controls="grpc-response-trailers" tabindex={vm.grpcResponseTab === 'trailers' ? 0 : -1} onclick={() => vm.setActiveGrpcResponseTab('trailers')} type="button">
          Trailers{#if response.trailers?.length}<span class="badge">{response.trailers.length}</span>{/if}
        </button>
        {#if hasScripts}
          <button role="tab" class:active={vm.grpcResponseTab === 'scripts'} class="tab tab-script" aria-selected={vm.grpcResponseTab === 'scripts'} aria-controls="grpc-response-scripts" tabindex={vm.grpcResponseTab === 'scripts' ? 0 : -1} onclick={() => vm.setActiveGrpcResponseTab('scripts')} type="button">
            Test results
            {#if responseTestSummary}
              <span class="badge" class:badge-pass={responseTestSummary.allPassed} class:badge-fail={!responseTestSummary.allPassed}>{responseTestSummary.passed}/{responseTestSummary.total}</span>
            {/if}
          </button>
        {/if}
      </div>
    </div>

    {#if vm.grpcResponseTab === 'messages'}
      <div class="response-tab-panel" id="grpc-response-messages" role="tabpanel">
        {#if grpcRows.length === 0}
          <div class="response-placeholder response-empty-state" role="status">
            <span class="response-placeholder-text">{response.skipped ? 'Request skipped before sending' : 'No response messages'}</span>
          </div>
        {:else if filteredGrpcRows.length === 0 && vm.responseSearch}
          <div class="response-placeholder response-empty-state" role="status">
            <span class="response-placeholder-text">No messages match "{vm.responseSearch}"</span>
          </div>
        {:else}
          <div class="sse-event-list ws-message-list grpc-message-list" role="log" aria-live="polite">
            {#each filteredGrpcRows as row (row.key)}
              {@const expanded = rowExpanded(row.key)}
              {@const direction = row.kind === 'message' ? grpcMessageDirection(row.message) : 'system'}
              <div
                class="sse-event-row"
                class:sse-event-system={row.kind !== 'message'}
                class:sse-event-error={row.kind === 'cancelled' || row.kind === 'error'}
              >
                <button
                  class="sse-event-main"
                  type="button"
                  aria-label={row.kind === 'message' ? `${direction === 'outgoing' ? 'Sent' : 'Received'} gRPC message` : row.title}
                  onclick={() => toggleRow(row.key)}
                >
                  <span
                    class="sse-event-arrow ws-event-arrow"
                    class:incoming={direction === 'incoming'}
                    class:outgoing={direction === 'outgoing'}
                    class:system={direction === 'system'}
                    aria-hidden="true"
                  >
                    {#if row.kind === 'message'}
                      {#if direction === 'outgoing'}
                        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
                          <path d="M6.5 11V2M3 5l3.5-3L10 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                      {:else}
                        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
                          <path d="M6.5 2v9M3 8l3.5 3L10 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                      {/if}
                    {:else}
                      <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
                        <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.2"/>
                        <path d="M6.5 4v3.5M6.5 9.5v.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                      </svg>
                    {/if}
                  </span>
                  <span class="sse-badge {grpcRowBadgeClass(row)}">{grpcRowBadgeLabel(row)}</span>
                  <span class="sse-event-preview">
                    {row.kind === 'message' ? row.preview : row.title}
                  </span>
                  <span class="sse-event-time">{formatGrpcTime(row.timestamp)}</span>
                  <span class="sse-expand-chevron" style="transform: rotate({expanded ? 180 : 0}deg)" aria-hidden="true">
                    <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none">
                      <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                  </span>
                </button>
                {#if expanded}
                  <div class="sse-event-body">
                    {#if row.kind === 'message'}
                      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                      <pre class="sse-event-data-viewer sse-event-pre sse-event-data-json"><code>{@html renderGrpcBodyHtml(row.body)}</code></pre>
                    {:else if row.kind === 'cancelled'}
                      <div class="rt-handshake grpc-system-detail">
                        <p>You have cancelled the execution of the method.</p>
                        <p class="grpc-system-reason">{row.detail}</p>
                        <p>{grpcTrailerSummary()}</p>
                      </div>
                    {:else}
                      <div class="rt-handshake grpc-system-detail">
                        <p class="grpc-system-reason">{row.detail}</p>
                        <p>{grpcTrailerSummary()}</p>
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

    {:else if vm.grpcResponseTab === 'metadata'}
      <div class="response-headers-table" id="grpc-response-metadata" role="tabpanel">
        {#if response.headers?.length}
          {#each response.headers as h, eachIndex (eachIndex)}
            <div class="resp-header-row">
              <span class="resp-header-key">{h.key}</span>
              <span class="resp-header-val">{h.value}</span>
            </div>
          {/each}
        {:else}
          <div class="response-placeholder response-empty-state" role="status">
            <span class="response-placeholder-text">No response metadata</span>
          </div>
        {/if}
      </div>

    {:else if vm.grpcResponseTab === 'trailers'}
      <div class="response-headers-table" id="grpc-response-trailers" role="tabpanel">
        {#if response.trailers?.length}
          {#each response.trailers as h, eachIndex (eachIndex)}
            <div class="resp-header-row">
              <span class="resp-header-key">{h.key}</span>
              <span class="resp-header-val">{h.value}</span>
            </div>
          {/each}
        {:else}
          <div class="response-placeholder response-empty-state" role="status">
            <span class="response-placeholder-text">No response trailers</span>
          </div>
        {/if}
      </div>

    {:else if vm.grpcResponseTab === 'scripts'}
      <div class="test-results-panel" id="grpc-response-scripts" role="tabpanel">
        {#if response.preRequestResult?.error || response.preRequestResult?.logs?.length}
          <div class="script-result-block">
            <div class="script-result-header">
              Pre-request
              {#if response.preRequestResult.error}
                <span class="script-error-badge">Error</span>
              {:else}
                <span class="script-ok-badge">OK</span>
              {/if}
            </div>
            {#if response.preRequestResult.error}
              <div class="script-error-msg">{response.preRequestResult.error}</div>
            {/if}
            {#each (response.preRequestResult.logs ?? []) as log, eachIndex (eachIndex)}
              <div class="script-log-row"><span class="log-icon">›</span><span class="log-msg">{log}</span></div>
            {/each}
          </div>
        {/if}

        {#if response.testResult?.tests?.length || response.testResult?.error || response.testResult?.logs?.length}
          <div class="script-result-block">
            <div class="script-result-header">
              Tests
              {#if responseTestSummary}
                <span class:script-ok-badge={responseTestSummary.allPassed} class:script-fail-badge={!responseTestSummary.allPassed}>{responseTestSummary.passed}/{responseTestSummary.total} passed</span>
              {/if}
            </div>
            {#if response.testResult.error}
              <div class="script-error-msg">{response.testResult.error}</div>
            {/if}
            {#each (response.testResult.tests ?? []) as t, eachIndex (eachIndex)}
              <div class="test-row" class:pass={t.passed} class:fail={!t.passed}>
                <span class="test-icon">
                  {#if t.passed}
                    <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M4 6.5l2 2 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  {:else}
                    <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.5l4 4M8.5 4.5l-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
                  {/if}
                </span>
                <span class="test-name">{t.name}</span>
                {#if t.error}<span class="test-err">{t.error}</span>{/if}
              </div>
            {/each}
            {#each (response.testResult.logs ?? []) as log, eachIndex (eachIndex)}
              <div class="script-log-row"><span class="log-icon">›</span><span class="log-msg">{log}</span></div>
            {/each}
          </div>
        {/if}

        {#if !hasScripts}
          <div class="test-results-empty">No scripts ran for this request.</div>
        {/if}
      </div>
    {/if}

  {:else}
    <div class="response-placeholder response-empty-state" role="status">
      <svg width="2rem" height="2rem" viewBox="0 0 32 32" fill="none" opacity="0.35">
        <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="1.5"/>
        <path d="M12 16h8M16 12l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="response-placeholder-text">Invoke a method to see the response</span>
      {#if vm.shortcutCombo('send-request')}<span class="response-placeholder-hint"><Keycaps combo={vm.shortcutCombo('send-request')} runtime={vm.appRuntime} /> to invoke</span>{/if}
    </div>
  {/if}
</div>

<style>
  .grpc-status-method {
    flex: 1 1 auto;
    min-width: 0;
    max-width: min(36vw, 28.75rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grpc-system-detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-2-5);
    padding: var(--space-2-5) var(--space-3);
    color: var(--text-2);
    font-size: var(--text-label);
    line-height: var(--leading-normal);
  }

  .grpc-system-detail p {
    margin: 0;
  }

  .grpc-system-reason {
    color: var(--s5xx);
  }
</style>
