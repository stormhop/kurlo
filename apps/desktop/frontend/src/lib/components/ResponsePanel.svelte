<script lang="ts">
  import ScriptResults from './ScriptResults.svelte';
  import LinkedSecretFailurePanel from './LinkedSecretFailurePanel.svelte';
  import { scriptProblemCount } from '../scriptLogs';
  import { untrack } from 'svelte';
  import { vm } from '../stores/app.svelte';
  import Keycaps from './Keycaps.svelte';
  import { tabListKeyboard } from '../a11y';
  import type { ResponseRenderMode } from '../response-render';
  import type { HttpResponse } from '../backend';
  import ResponseBodyViewer from './ResponseBodyViewer.svelte';
  import KurloBird from './KurloBird.svelte';
  import ResponseTimeTooltip from './ResponseTimeTooltip.svelte';
  import ResponseTimelinePanel from './ResponseTimelinePanel.svelte';
  import ResponseDiffPanel from './ResponseDiffPanel.svelte';
  import ResponsePreviewPanel from './ResponsePreviewPanel.svelte';
  import { responseMediaType, responsePreviewFor } from '../responsePreview';
  import type { ResponseDiff } from '../responseDiff';
  import Select from './Select.svelte';
  import { RESPONSE_FORMAT_CHOICES, RESPONSE_FORMAT_LABELS, isResponseFormatChoice } from '../responseFormat';
  import { foldAllRegions, responseFoldRegions } from '../responseFolding';
  import { httpStatusInfo } from '../httpStatus';
  import { fixedPopover } from '../fixedPopover';
  import { cookieExpiry, responseCookies } from '../setCookie';

  type ResponseTab = 'body' | 'headers' | 'cookies' | 'test-results' | 'timeline' | 'diff' | 'preview';

  let {
    loading,
    requestError,
    response,
    responseTab,
    responseSearchOpen = $bindable(false),
    responseSearch = $bindable(''),
    responseSearchIndex = $bindable(0),
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
  let responseFilterInput = $state<HTMLInputElement | undefined>();
  let canFilter = $derived(Boolean(response?.body && !response.bodyIsBinary && !response.error && vm.isJsonResponse(response)));
  let filterResult = $derived(vm.responseFilterResult);
  let filterStatus = $derived.by(() => {
    if (!filterResult) return '';
    if (!filterResult.ok) return filterResult.error;
    const count = filterResult.matches.length;
    return count === 1 ? '1 match' : `${count} matches`;
  });
  let responsePreview = $derived(responsePreviewFor(response));
  let showFormatSelect = $derived(Boolean(responseTab === 'body' && response?.body && !response.bodyIsBinary && !response.error && !responseBodyIsPaged));
  let resolvedFormat = $derived(vm.responseFormat);
  let statusInfo = $derived(response ? httpStatusInfo(response.statusCode) : null);
  let statusClassLabel = $derived(response ? `${Math.floor(response.statusCode / 100)}xx` : '');
  let contentEncoding = $derived(response?.headers?.find(header => header.key.toLowerCase() === 'content-encoding')?.value ?? '');
  let sizeRows = $derived.by(() => {
    if (!response) return [];
    const rows: Array<{ label: string; value: string }> = [];
    if (response.headersSize) rows.push({ label: 'Headers', value: formatSize(response.headersSize) });
    if (response.encodedBodySize) {
      rows.push({ label: `Body${contentEncoding ? ` (${contentEncoding})` : ' (compressed)'}`, value: formatSize(response.encodedBodySize) });
      rows.push({ label: 'Body (uncompressed)', value: formatSize(response.size) });
    } else {
      rows.push({ label: 'Body', value: formatSize(response.size) });
    }
    return rows;
  });
  let sizeTotal = $derived(response ? (response.headersSize ?? 0) + (response.encodedBodySize || response.size) : 0);
  let cookies = $derived(responseCookies(response?.headers));

  $effect(() => {
    if (responseTab === 'cookies' && response && !cookies.length) setResponseTab('headers');
  });

  const WRAP_STORAGE_KEY = 'kurlo.responseWrap.v1';
  let wrapLines = $state(readWrapPreference());

  function readWrapPreference() {
    try {
      return localStorage.getItem(WRAP_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  }

  function toggleWrapLines() {
    wrapLines = !wrapLines;
    try {
      localStorage.setItem(WRAP_STORAGE_KEY, wrapLines ? 'true' : 'false');
    } catch {}
  }

  let foldedLines = $state(new Set<number>());
  let foldRegions = $derived(showFormatSelect ? responseFoldRegions(responseDisplayBody, responseRenderMode) : new Map());
  let canFold = $derived(foldRegions.size > 0);
  let anyFolded = $derived(foldedLines.size > 0);

  function toggleFoldAll() {
    foldedLines = anyFolded ? new Set() : foldAllRegions(foldRegions);
  }
  let formatOptions = $derived(RESPONSE_FORMAT_CHOICES.map(choice => ({
    value: choice,
    label: choice === 'auto' ? `Auto · ${RESPONSE_FORMAT_LABELS[resolvedFormat.detected]}` : RESPONSE_FORMAT_LABELS[choice],
  })));

  function testSummaryFor(tests: Array<{ passed: boolean }>) {
    if (!tests.length) return null;
    const passed = tests.filter(test => test.passed).length;
    return { passed, total: tests.length, allPassed: passed === tests.length };
  }

  let preRequestTests = $derived(response?.preRequestResult?.tests ?? []);
  let scriptProblems = $derived(scriptProblemCount(response?.preRequestResult, response?.testResult));
  let scriptLogCount = $derived((response?.preRequestResult?.logs?.length ?? 0) + (response?.testResult?.logs?.length ?? 0));
  let hasScriptOutput = $derived(Boolean(scriptProblems || scriptLogCount || response?.preRequestResult?.tests?.length || response?.testResult?.tests?.length));
  let scriptErrorMessage = $derived(
    response?.preRequestResult?.error
      ? `Pre-request script failed: ${response.preRequestResult.error}`
      : response?.testResult?.error
        ? `Post-response script failed: ${response.testResult.error}`
        : '',
  );
  let allTestSummary = $derived(testSummaryFor([...preRequestTests, ...(response?.testResult?.tests ?? [])]));
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

  $effect(() => {
    if (vm.responseFilterOpen) setTimeout(() => responseFilterInput?.focus(), 0);
  });

  let waitingSince = $state(0);
  let waitingNow = $state(0);
  let waitingSeconds = $derived(Math.max(0, (waitingNow - waitingSince) / 1000));

  $effect(() => {
    if (!loading || response) return;
    const startedAt = performance.now();
    waitingSince = startedAt;
    waitingNow = startedAt;
    const timer = setInterval(() => { waitingNow = performance.now(); }, 100);
    return () => clearInterval(timer);
  });

  let responseArrived = $state(false);
  let wasLoading = untrack(() => loading);

  $effect(() => {
    const isLoading = loading;
    const arrived = wasLoading && !isLoading && untrack(() => Boolean(response) && !requestError);
    wasLoading = isLoading;
    if (!arrived) return;
    responseArrived = true;
    const timer = setTimeout(() => { responseArrived = false; }, 700);
    return () => clearTimeout(timer);
  });

  function selectResponseText(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== 'a') return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
    const area = event.currentTarget as HTMLElement;
    const scope = area.querySelector<HTMLElement>('.response-body-viewer') ?? area.querySelector<HTMLElement>('[role="tabpanel"]');
    event.preventDefault();
    const selection = window.getSelection();
    if (!scope || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(scope);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function scopeSelectAll(node: HTMLElement) {
    node.addEventListener('keydown', selectResponseText);
    return { destroy() { node.removeEventListener('keydown', selectResponseText); } };
  }

</script>

<div class="response-area" class:loading={loading && Boolean(response)} aria-busy={loading} tabindex="-1" use:scopeSelectAll>
  {#if loading}
    <div class="response-loading-progress" aria-hidden="true"><span></span></div>
  {/if}

  {#if loading && !response}
    <div class="response-placeholder response-loading-state" role="status" aria-label="Sending request">
      <span class="response-waiting-bird"><KurloBird mode="flying" envelope size="3.25rem" /></span>
      {#if waitingSeconds >= 1}<span class="response-placeholder-hint response-waiting-time">{waitingSeconds.toFixed(1)} s</span>{/if}
    </div>

  {:else if response?.linkedSecretFailures?.length}
    <div class="secret-failure-host">
      <LinkedSecretFailurePanel failures={response.linkedSecretFailures} onRetry={() => vm.runActiveRequest()} />
    </div>
  {:else if requestError}
    <div class="response-placeholder error" class:has-script-output={hasScriptOutput} role="textbox" aria-readonly="true" tabindex="0">
      <div class="request-error-shell">
        <div class="request-error-title">Could not send request</div>
        <div class="request-error-card">
          <svg width="1.25rem" height="1.25rem" viewBox="0 0 20 20" fill="none">
            <path d="M10 2l8 14H2L10 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M10 7v4M10 14v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <span>{requestError}</span>
        </div>
        {#if hasScriptOutput}
          <div class="request-error-scripts" aria-label="Script output">
            <ScriptResults preRequestResult={response?.preRequestResult} testResult={response?.testResult} />
          </div>
        {/if}
      </div>
    </div>

  {:else if response}
    <div class="response-status-bar">
      <div class="status-left">
        <span class="resp-info" use:fixedPopover>
          <span class="status-badge {statusClass(response.statusCode)}" class:status-arrived={responseArrived} tabindex="0" role="button" aria-describedby={statusInfo ? 'response-status-info' : undefined}>
            {response.statusCode} {response.status.replace(String(response.statusCode), '').trim()}
          </span>
          {#if statusInfo}
            <span class="resp-info-popover" id="response-status-info" role="tooltip">
              <span class="resp-info-title"><span class="resp-info-chip {statusClass(response.statusCode)}">{statusClassLabel}</span>{statusInfo.title}</span>
              <span class="resp-info-text">{statusInfo.description}</span>
            </span>
          {/if}
        </span>
        <ResponseTimeTooltip timings={response.timings} total={response.duration} />
        <span class="resp-info" use:fixedPopover>
          <span class="status-meta" tabindex="0" role="button" aria-describedby="response-size-info">{formatSize(response.size)}</span>
          <span class="resp-info-popover resp-size-popover" id="response-size-info" role="tooltip">
            <span class="resp-info-title resp-size-head"><span>Response size</span><span class="resp-size-value">{formatSize(sizeTotal)}</span></span>
            {#each sizeRows as row (row.label)}
              <span class="resp-size-row"><span>{row.label}</span><span class="resp-size-value">{row.value}</span></span>
            {/each}
            {#if response.encodedBodySize}
              <span class="resp-info-text">Kurlo shows and saves the uncompressed body.</span>
            {/if}
          </span>
        </span>
        {#if allTestSummary}
          <span class="test-summary-pill" class:all-passed={allTestSummary.allPassed}>{allTestSummary.passed}/{allTestSummary.total} tests</span>
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
          {#if showFormatSelect}
            <Select
              value={vm.responseFormatChoice}
              options={formatOptions}
              className="response-format-select"
              ariaLabel="Response format"
              floating
              onChange={value => { if (isResponseFormatChoice(value)) { responseSearchIndex = 0; vm.setResponseFormat(value); } }}
            />
          {/if}
          {#if showFormatSelect && !responseBodyVirtualized}
            <button class="btn btn-icon" aria-label="Wrap lines" aria-pressed={wrapLines} onclick={toggleWrapLines} type="button">
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M1.5 3h10M1.5 6.5h8a2 2 0 010 4H7M1.5 10h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 9l-1.2 1.5L8 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          {/if}
          {#if showFormatSelect && canFold}
            <button class="btn btn-icon" aria-label={anyFolded ? 'Unfold all' : 'Fold all'} onclick={toggleFoldAll} type="button">
              {#if anyFolded}
                <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M4 4.5l2.5-2.5L9 4.5M4 8.5l2.5 2.5L9 8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {:else}
                <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M4 2l2.5 2.5L9 2M4 11l2.5-2.5L9 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {/if}
            </button>
          {/if}
          <button class="btn btn-icon" aria-label="Search response" aria-pressed={responseSearchOpen} onclick={toggleResponseSearch} type="button">
            <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none">
              <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
              <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
            </svg>
          </button>
          {#if canFilter}
            <button class="btn btn-icon" aria-label="Filter response" aria-pressed={vm.responseFilterOpen} onclick={() => { vm.toggleResponseFilter(); if (responseTab !== 'body') setResponseTab('body'); }} type="button">
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <path d="M1.75 2.25h9.5L7.5 6.75v3.5l-2 1v-4.5L1.75 2.25z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
              </svg>
            </button>
          {/if}
          <button class="btn btn-icon" class:feedback-ok={copiedBody} aria-label={copiedBody ? 'Copied response' : 'Copy response'} onclick={copyResponseBody} type="button">
            {#if copiedBody}
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            {:else}
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><rect x="3" y="1" width="8" height="9" rx="1.2" stroke="currentColor" stroke-width="1.2"/><path d="M1 3.5v7a1.2 1.2 0 001.2 1.2H8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            {/if}
          </button>
          {#if saveResponseAsExample}
            <button
              class="btn btn-icon"
              aria-label="Save as example"
              onclick={saveResponseAsExample}
              type="button"
            >
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <path d="M3.5 1.5h6a1 1 0 011 1v9l-4-2.2-4 2.2v-9a1 1 0 011-1z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
              </svg>
            </button>
          {/if}
          <button class="btn btn-icon" class:feedback-ok={savedResponse} aria-label={savedResponse ? 'Saved response' : 'Save to file'} onclick={saveResponseFile} type="button">
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
        {#if cookies.length}
          <button class="tab" role="tab" class:active={responseTab === 'cookies'} aria-selected={responseTab === 'cookies'} aria-controls="response-panel-cookies" tabindex={responseTab === 'cookies' ? 0 : -1} onclick={() => setResponseTab('cookies')} type="button">
            Cookies<span class="badge">{cookies.length}</span>
          </button>
        {/if}
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
        {#if response.testResult?.tests?.length || response.preRequestResult?.tests?.length || response.preRequestResult?.logs?.length || response.testResult?.logs?.length || response.preRequestResult?.error || response.testResult?.error}
          <button role="tab" class:active={responseTab === 'test-results'} class="tab tab-script" aria-selected={responseTab === 'test-results'} aria-controls="response-panel-scripts" tabindex={responseTab === 'test-results' ? 0 : -1} onclick={() => setResponseTab('test-results')} type="button">
            Scripts
            {#if scriptProblems}
              <span class="badge badge-fail" aria-label={`${scriptProblems} script ${scriptProblems === 1 ? 'error' : 'errors'}`}>{scriptProblems}</span>
            {:else if allTestSummary}
              <span class="badge" class:badge-pass={allTestSummary.allPassed} class:badge-fail={!allTestSummary.allPassed}>{allTestSummary.passed}/{allTestSummary.total}</span>
            {:else if scriptLogCount}
              <span class="badge">{scriptLogCount}</span>
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
        {#if scriptErrorMessage}
          <div class="response-warning script-error-banner" role="alert">
            <span>{scriptErrorMessage}</span>
            <button class="btn btn-ghost btn-xs" type="button" onclick={() => setResponseTab('test-results')}>Open Scripts</button>
          </div>
        {/if}
        {#if resolvedFormat.fallback && !response.error}
          <div class="response-warning response-format-fallback" role="status">
            This response is not valid {RESPONSE_FORMAT_LABELS[vm.responseFormatChoice]}, so it is shown as text.
          </div>
        {/if}
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
        {#if vm.responseFilterOpen && canFilter}
          <div class="response-filter-bar">
            <div class="field field-md field-wrap field-mono response-filter-field" class:invalid={filterResult && !filterResult.ok}>
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <path d="M1.75 2.25h9.5L7.5 6.75v3.5l-2 1v-4.5L1.75 2.25z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
              </svg>
              <input
                bind:this={responseFilterInput}
                value={vm.responseFilter}
                oninput={event => { responseSearchIndex = 0; vm.setResponseFilter(event.currentTarget.value); }}
                onkeydown={vm.onResponseFilterKeydown}
                placeholder="$.items[*].id  or  .items[].id"
                aria-label="Filter response with JSONPath"
                aria-describedby="response-filter-status"
                aria-invalid={filterResult && !filterResult.ok ? true : undefined}
                autocomplete="off"
                autocorrect="off"
                autocapitalize="none"
                spellcheck={false}
              />
            </div>
            <span id="response-filter-status" class="response-filter-status" class:error={filterResult && !filterResult.ok} role="status">{filterStatus}</span>
            <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label="Close filter" onclick={() => vm.toggleResponseFilter()}>
              <svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            </button>
          </div>
        {/if}
        {#if filterResult?.ok && filterResult.matches.length === 0}
          <div class="response-placeholder response-empty-state" role="status">
            <span class="response-placeholder-text">Nothing matches this filter</span>
          </div>
        {:else}
        {#if responseBodyIsPaged && !filterResult?.ok}
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
          bind:folded={foldedLines}
          wrap={wrapLines}
        />
        {/if}
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

    {:else if responseTab === 'cookies'}
      <div class="response-cookies" id="response-panel-cookies" role="tabpanel">
        <table class="response-cookies-table">
          <thead>
            <tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Expires</th><th>Attributes</th></tr>
          </thead>
          <tbody>
            {#each cookies as cookie, eachIndex (eachIndex)}
              {@const expiry = cookieExpiry(cookie)}
              <tr>
                <td class="cookie-name">{cookie.name}</td>
                <td class="cookie-value">{cookie.value}</td>
                <td class:cookie-muted={!cookie.domain}>{cookie.domain || 'Host only'}</td>
                <td class:cookie-muted={!cookie.path}>{cookie.path || 'Default'}</td>
                <td class:cookie-muted={expiry === 'Session'} class:cookie-expired={expiry === 'Expired'}>{expiry}</td>
                <td>
                  <span class="cookie-flags">
                    {#if cookie.httpOnly}<span class="tag">HttpOnly</span>{/if}
                    {#if cookie.secure}<span class="tag">Secure</span>{/if}
                    {#if cookie.sameSite}<span class="tag">SameSite={cookie.sameSite}</span>{/if}
                    {#if cookie.partitioned}<span class="tag">Partitioned</span>{/if}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
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
        <ScriptResults preRequestResult={response.preRequestResult} testResult={response.testResult} />
      </div>
    {/if}

  {:else}
    <div class="response-placeholder response-empty-state response-idle" role="status">
      <KurloBird size="3rem" />
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
