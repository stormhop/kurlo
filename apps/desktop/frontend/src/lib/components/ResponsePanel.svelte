<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import Keycaps from './Keycaps.svelte';
  import { tabListKeyboard } from '../a11y';
  import type { ResponseRenderMode } from '../response-render';
  import type { HttpResponse } from '../backend';
  import ResponseBodyViewer from './ResponseBodyViewer.svelte';
  import ResponseTimeTooltip from './ResponseTimeTooltip.svelte';
  import ResponseTimelinePanel from './ResponseTimelinePanel.svelte';
  import ResponseDiffPanel from './ResponseDiffPanel.svelte';
  import ResponsePreviewPanel from './ResponsePreviewPanel.svelte';
  import { responseMediaType, responsePreviewFor } from '../responsePreview';
  import type { ResponseDiff } from '../responseDiff';

  type ResponseTab = 'body' | 'headers' | 'test-results' | 'timeline' | 'diff' | 'preview';

  let {
    loading,
    requestError,
    response,
    responseTab,
    responseSearchOpen = $bindable(false),
    responseSearch = $bindable(''),
    responseSearchIndex = $bindable(0),
    responseTestSummary,
    responseDiffSummary = null,
    diffBaseline = null,
    diffBaselineLabel = 'previous',
    diffBaselineOptions = [],
    diffBaselineExampleId = '',
    onSelectDiffBaseline = () => {},
    responseSearchTotal,
    responseDisplayBody,
    responseRenderMode,
    responseBodyIsPaged,
    responseBodyVirtualized,
    responseBodyPage,
    responseBodyPageCount,
    responseBodyPageLabel,
    copiedBody,
    savedResponse,
    appRuntime = '',
    statusClass,
    formatSize,
    onResponseSearchKeydown,
    prevResponseMatch,
    nextResponseMatch,
    previousResponseBodyPage,
    nextResponseBodyPage,
    toggleResponseSearch,
    copyResponseBody,
    saveResponseFile,
    loadResponseFromFile,
    setResponseTab,
    saveResponseAsExample = null,
    clearResponseDiffBaseline = () => {},
  }: {
    loading: boolean;
    requestError: string;
    response: HttpResponse | null;
    responseTab: ResponseTab;
    responseSearchOpen: boolean;
    responseSearch: string;
    responseSearchIndex: number;
    responseTestSummary: { passed: number; total: number; allPassed: boolean } | null;
    responseDiffSummary?: ResponseDiff | null;
    diffBaseline?: HttpResponse | null;
    diffBaselineLabel?: string;
    diffBaselineOptions?: Array<{ id: string; label: string }>;
    diffBaselineExampleId?: string;
    onSelectDiffBaseline?: (exampleId: string) => void;
    responseSearchTotal: number;
    responseDisplayBody: string;
    responseRenderMode: ResponseRenderMode;
    responseBodyIsPaged: boolean;
    responseBodyVirtualized: boolean;
    responseBodyPage: number;
    responseBodyPageCount: number;
    responseBodyPageLabel: string;
    copiedBody: boolean;
    savedResponse: boolean;
    appRuntime?: string;
    statusClass: (statusCode: number) => string;
    formatSize: (size: number) => string;
    onResponseSearchKeydown: (event: KeyboardEvent) => void;
    prevResponseMatch: () => void;
    nextResponseMatch: () => void;
    previousResponseBodyPage: () => void;
    nextResponseBodyPage: () => void;
    toggleResponseSearch: () => void;
    copyResponseBody: () => void;
    saveResponseFile: () => void;
    loadResponseFromFile: () => void;
    setResponseTab: (tab: ResponseTab) => void;
    saveResponseAsExample?: (() => void) | null;
    clearResponseDiffBaseline?: () => void;
  } = $props();

  let responseSearchInput = $state<HTMLInputElement | undefined>();
  let responsePreview = $derived(responsePreviewFor(response));
  let browserHiddenHeaders = $derived(new Set((response?.browserHiddenHeaders ?? []).map(name => name.toLowerCase())));
  let binaryBodyDescription = $derived.by(() => {
    const type = response?.bodySniffedType || responseMediaType(response as HttpResponse);
    const size = response ? formatSize(response.size) : '';
    if (type && size) return `${type}, ${size}.`;
    if (type) return `${type}.`;
    return size ? `${size}.` : '';
  });

  $effect(() => {
    if (responseSearchOpen) setTimeout(() => responseSearchInput?.focus(), 0);
  });

</script>

<div class="response-area" class:loading={loading && Boolean(response)} aria-busy={loading}>
  {#if loading}
    <div class="response-loading-progress" aria-hidden="true"><span></span></div>
  {/if}

  {#if loading && !response}
    <div class="response-placeholder response-loading-state" role="status">
      <span class="response-placeholder-text">Sending request…</span>
    </div>

  {:else if requestError}
    <div class="response-placeholder error" role="textbox" aria-readonly="true" tabindex="0">
      <div class="request-error-shell">
        <div class="request-error-title">Could not send request</div>
        <div class="request-error-card">
          <svg width="1.25rem" height="1.25rem" viewBox="0 0 20 20" fill="none">
            <path d="M10 2l8 14H2L10 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M10 7v4M10 14v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <span>{requestError}</span>
        </div>
      </div>
    </div>

  {:else if response}
    <div class="response-status-bar">
      <div class="status-left">
        <span class="status-badge {statusClass(response.statusCode)}">
          {response.statusCode} {response.status.replace(String(response.statusCode), '').trim()}
        </span>
        <ResponseTimeTooltip timings={response.timings} total={response.duration} />
        <span class="status-meta">{formatSize(response.size)}</span>
        {#if responseTestSummary}
          <span class="test-summary-pill" class:all-passed={responseTestSummary.allPassed}>{responseTestSummary.passed}/{responseTestSummary.total} tests</span>
        {/if}
      </div>
      <div class="status-right">
        {#if responseSearchOpen}
          <div class="field field-md field-wrap response-search-box">
            <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
              <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
            </svg>
            <input
              bind:this={responseSearchInput}
              bind:value={responseSearch}
              oninput={() => (responseSearchIndex = 0)}
              onkeydown={onResponseSearchKeydown}
              placeholder="Search"
              aria-label="Search response body"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
              spellcheck={false}
            />
            <span class="response-search-count">{responseSearchTotal ? Math.min(Math.max(responseSearchIndex, 0), responseSearchTotal - 1) + 1 : 0}/{responseSearchTotal}</span>
            <button class="btn btn-ghost btn-icon btn-xs response-search-nav" type="button" onclick={prevResponseMatch} disabled={!responseSearchTotal} aria-label="Previous match">↑</button>
            <button class="btn btn-ghost btn-icon btn-xs response-search-nav" type="button" onclick={nextResponseMatch} disabled={!responseSearchTotal} aria-label="Next match">↓</button>
          </div>
        {/if}
        <div class="resp-actions">
          <button class="btn btn-icon" title="Search response" aria-label="Search response" aria-pressed={responseSearchOpen} onclick={toggleResponseSearch} type="button">
            <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
              <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
              <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="btn btn-icon" class:feedback-ok={copiedBody} title={copiedBody ? 'Copied response' : 'Copy response'} aria-label={copiedBody ? 'Copied response' : 'Copy response'} onclick={copyResponseBody} type="button">
            {#if copiedBody}
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            {:else}
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><rect x="3" y="1" width="8" height="9" rx="1.2" stroke="currentColor" stroke-width="1.2"/><path d="M1 3.5v7a1.2 1.2 0 001.2 1.2H8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            {/if}
          </button>
          {#if saveResponseAsExample}
            <button
              class="btn btn-icon"
              title="Save as example"
              aria-label="Save as example"
              onclick={saveResponseAsExample}
              type="button"
            >
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <path d="M3.5 1.5h6a1 1 0 011 1v9l-4-2.2-4 2.2v-9a1 1 0 011-1z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
              </svg>
            </button>
          {/if}
          <button class="btn btn-icon" class:feedback-ok={savedResponse} title={savedResponse ? 'Saved response' : 'Save to file'} aria-label={savedResponse ? 'Saved response' : 'Save to file'} onclick={saveResponseFile} type="button">
            {#if savedResponse}
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            {:else}
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M6.5 2v7M4 7l2.5 2.5L9 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            {/if}
          </button>
        </div>
      </div>
      <div class="tab-bar response-mini-tabs" role="tablist" use:tabListKeyboard>
        <button class="tab" role="tab" class:active={responseTab === 'body'} aria-selected={responseTab === 'body'} aria-controls="response-panel-body" tabindex={responseTab === 'body' ? 0 : -1} onclick={() => setResponseTab('body')} type="button">Body</button>
        {#if responsePreview.kind !== 'none'}
          <button class="tab" role="tab" class:active={responseTab === 'preview'} aria-selected={responseTab === 'preview'} aria-controls="response-panel-preview" tabindex={responseTab === 'preview' ? 0 : -1} onclick={() => setResponseTab('preview')} type="button">Preview</button>
        {/if}
        <button class="tab" role="tab" class:active={responseTab === 'headers'} aria-selected={responseTab === 'headers'} aria-controls="response-panel-headers" tabindex={responseTab === 'headers' ? 0 : -1} onclick={() => setResponseTab('headers')} type="button">
          Headers{#if response.headers?.length}<span class="badge">{response.headers.length}</span>{/if}
        </button>
        {#if diffBaselineOptions.length}
          <button class="tab" role="tab" class:active={responseTab === 'diff'} aria-selected={responseTab === 'diff'} aria-controls="response-panel-diff" tabindex={responseTab === 'diff' ? 0 : -1} onclick={() => setResponseTab('diff')} type="button">
            Diff
            {#if responseDiffSummary && !responseDiffSummary.identical}
              <span class="badge badge-fail">{responseDiffSummary.added + responseDiffSummary.removed}</span>
            {/if}
          </button>
        {/if}
        {#if response.timeline?.length || response.sentRequests?.length}
          <button class="tab" role="tab" class:active={responseTab === 'timeline'} aria-selected={responseTab === 'timeline'} aria-controls="response-panel-timeline" tabindex={responseTab === 'timeline' ? 0 : -1} onclick={() => setResponseTab('timeline')} type="button">Timeline</button>
        {/if}
        {#if response.testResult?.tests?.length || response.preRequestResult?.logs?.length || response.testResult?.logs?.length || response.preRequestResult?.error || response.testResult?.error}
          <button role="tab" class:active={responseTab === 'test-results'} class="tab tab-script" aria-selected={responseTab === 'test-results'} aria-controls="response-panel-scripts" tabindex={responseTab === 'test-results' ? 0 : -1} onclick={() => setResponseTab('test-results')} type="button">
            Scripts
            {#if responseTestSummary}
              <span class="badge" class:badge-pass={responseTestSummary.allPassed} class:badge-fail={!responseTestSummary.allPassed}>{responseTestSummary.passed}/{responseTestSummary.total}</span>
            {/if}
          </button>
        {/if}
      </div>
    </div>

      {#if responseTab === 'body'}
        <div class="response-tab-panel" id="response-panel-body" role="tabpanel">
        {#each response.warnings ?? [] as warning, eachIndex (eachIndex)}
          <div class="response-warning" role="status">{warning}</div>
        {/each}
        {#if response.error}
          <div class="response-error" role="textbox" aria-readonly="true" tabindex="0">{response.error}</div>
      {:else if !response.body && !response.bodyIsBinary}
        <div class="response-placeholder response-empty-state" role="status">
          <span class="response-placeholder-text">Response body is empty</span>
        </div>
      {:else if response.bodyIsBinary}
        <div class="response-binary-body" role="status">
          <svg width="1.625rem" height="1.625rem" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M14 3v5h5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
          <strong>This response is binary</strong>
          <p>
            {binaryBodyDescription}
            Showing it as text would only produce replacement characters, so it is not rendered here.
          </p>
          <div class="response-binary-actions">
            {#if responsePreview.kind !== 'none'}
              <button class="btn btn-primary" type="button" onclick={() => setResponseTab('preview')}>Open preview</button>
            {/if}
            <button class="btn btn-secondary" type="button" onclick={saveResponseFile}>Save to file</button>
          </div>
        </div>
      {:else}
        {#if responseBodyIsPaged}
          <div class="response-page-bar">
            <span>Large response preview</span>
            <small>{responseBodyPageLabel}</small>
            <button class="btn btn-ghost btn-icon btn-xs response-search-nav" type="button" onclick={previousResponseBodyPage} disabled={responseBodyPage <= 0} aria-label="Previous response page">←</button>
            <span class="response-page-count">{responseBodyPage + 1}/{responseBodyPageCount}</span>
            <button class="btn btn-ghost btn-icon btn-xs response-search-nav" type="button" onclick={nextResponseBodyPage} disabled={responseBodyPage + 1 >= responseBodyPageCount} aria-label="Next response page">→</button>
          </div>
        {/if}
        <ResponseBodyViewer
          source={responseDisplayBody}
          mode={responseRenderMode}
          search={responseSearch}
          searchIndex={responseSearchIndex}
          virtualized={responseBodyVirtualized}
          page={responseBodyPage}
        />
        {/if}
        </div>

    {:else if responseTab === 'headers'}
      <div class="response-headers-table" id="response-panel-headers" role="tabpanel">
        {#if browserHiddenHeaders.size}
          <p class="resp-headers-note">Headers marked <em>hidden from page</em> are not readable by the page's JavaScript. A browser exposes a cross-origin response header to script only when the server lists it in <code>Access-Control-Expose-Headers</code>, and never exposes <code>Set-Cookie</code>.</p>
        {/if}
        {#each (response.headers ?? []) as h, eachIndex (eachIndex)}
          {@const hiddenFromPage = browserHiddenHeaders.has(h.key.toLowerCase())}
          <div class="resp-header-row" class:resp-header-hidden={hiddenFromPage}>
            <span class="resp-header-key">{h.key}{#if hiddenFromPage}<span class="tag resp-header-tag">hidden from page</span>{/if}</span>
            <span class="resp-header-val">{h.value}</span>
          </div>
        {/each}
      </div>

    {:else if responseTab === 'preview'}
      <ResponsePreviewPanel preview={responsePreview} {formatSize} />

    {:else if responseTab === 'diff'}
      <ResponseDiffPanel
        diff={responseDiffSummary}
        previous={diffBaseline}
        current={response}
        baselineLabel={diffBaselineLabel}
        options={diffBaselineOptions}
        selectedId={diffBaselineExampleId}
        onSelect={onSelectDiffBaseline}
        onDismiss={clearResponseDiffBaseline}
      />

    {:else if responseTab === 'timeline'}
      <ResponseTimelinePanel
        sentRequests={response.sentRequests ?? []}
        connection={response.connection}
        timeline={response.timeline ?? []}
      />

    {:else if responseTab === 'test-results'}
      <div class="test-results-panel" id="response-panel-scripts" role="tabpanel">
        {#if response.preRequestResult?.error || response.preRequestResult?.logs?.length}
          <div class="script-result-block">
            <div class="script-result-header">
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M1.5 2.5h3l2 8h3.5M7.5 6h2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
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
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l2.5 2.5 6.5-5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
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

        {#if !response.testResult?.tests?.length && !response.testResult?.error && !response.preRequestResult?.error && !response.preRequestResult?.logs?.length && !response.testResult?.logs?.length}
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
      <span class="response-placeholder-text">Send a request to see the response</span>
      {#if vm.shortcutCombo('send-request')}<span class="response-placeholder-hint"><Keycaps combo={vm.shortcutCombo('send-request')} runtime={appRuntime} /> to send</span>{/if}
      <button class="btn btn-secondary response-load-file" type="button" onclick={loadResponseFromFile}>
        <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <path d="M6.5 9V2M4 4.5L6.5 2 9 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2 9.5v1A1.5 1.5 0 003.5 12h6a1.5 1.5 0 001.5-1.5v-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        Load response from file
      </button>
    </div>
  {/if}
</div>
