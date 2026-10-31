<script lang="ts">
  import { useClock } from '../clock.svelte';
  const now = useClock();
  import type { Collection, CollectionRunnerResult, SavedRequest } from '../types/models';
  import { MAX_RUNNER_CONCURRENCY, MIN_RUNNER_CONCURRENCY } from '../concurrency';
  import Select from './Select.svelte';
  import { requestKindShortLabel } from '../utils';
  import { relativeTime } from '../collectionRuns';

  let {
    collections,
    selectedCollectionId,
    filteredRequests,
    selectedRequestIds,
    selectedCount,
    delayMs,
    includeTags,
    excludeTags,
    iterations,
    dataFileName,
    dataRowCount,
    dataError,
    parallel,
    concurrency,
    running,
    title,
    results,
    summary,
    lastRunAt = 0,
    methodColor,
    requestTabLabel,
    requestTransportLabel,
    requestTags,
    isRequestSkipped,
    onSelectCollection,
    onSetDelayMs,
    onSetIncludeTags,
    onSetExcludeTags,
    onSetIterations,
    onSelectDataFile,
    onClearDataFile,
    onSetParallel,
    onSetConcurrency,
    onToggleRequest,
    onSelectAll,
    onDeselectAll,
    onReset,
    onDownloadReport,
    onRun,
    onStop,
  }: {
    collections: Collection[];
    selectedCollectionId: string;
    filteredRequests: SavedRequest[];
    selectedRequestIds: Set<string>;
    selectedCount: number;
    delayMs: number;
    includeTags: string;
    excludeTags: string;
    iterations: number;
    dataFileName: string;
    dataRowCount: number;
    dataError: string;
    parallel: boolean;
    concurrency: number;
    running: boolean;
    title: string;
    results: CollectionRunnerResult[];
    summary: { total: number; completed: number; passed: number; failed: number; skipped: number; testsPassed: number; testsTotal: number; duration: number; allPassed: boolean };
    lastRunAt?: number;
    methodColor: (method: string) => string;
    requestTabLabel: (request: SavedRequest) => string;
    requestTransportLabel: (request: SavedRequest) => string;
    requestTags: (request: SavedRequest) => string[];
    isRequestSkipped: (request: SavedRequest) => boolean;
    onSelectCollection: (collectionId: string) => void;
    onSetDelayMs: (value: string | number) => void;
    onSetIncludeTags: (value: string) => void;
    onSetExcludeTags: (value: string) => void;
    onSetIterations: (value: string | number) => void;
    onSelectDataFile: () => void | Promise<void>;
    onClearDataFile: () => void;
    onSetParallel: (value: boolean) => void;
    onSetConcurrency: (value: string | number) => void;
    onToggleRequest: (requestId: string) => void;
    onSelectAll: () => void;
    onDeselectAll: () => void;
    onReset: () => void;
    onDownloadReport: () => void | Promise<void>;
    onRun: () => void | Promise<void>;
    onStop: () => void;
  } = $props();

  let selectedSet = $derived(selectedRequestIds);
  let collectionOptions = $derived(collections.map(collection => ({ value: collection.id, label: collection.name })));
  let runnableCount = $derived(filteredRequests.filter(request => !isRequestSkipped(request)).length);
  let runCount = $derived(selectedCount * Math.max(1, iterations));
  let hasResults = $derived(results.length > 0);
  const RUNNER_REQUEST_PAGE_SIZE = 100;
  const RUNNER_RESULT_PAGE_SIZE = 100;
  let requestPage = $state(0);
  let resultPage = $state(0);
  let requestPageCount = $derived(pageCount(filteredRequests.length, RUNNER_REQUEST_PAGE_SIZE));
  let failedOnly = $state(false);
  let failedCount = $derived(results.filter(isFailure).length);
  let shownResults = $derived(failedOnly && failedCount ? results.filter(isFailure) : results);
  let resultPageCount = $derived(pageCount(shownResults.length, RUNNER_RESULT_PAGE_SIZE));
  let visibleRequests = $derived(filteredRequests.slice(requestPage * RUNNER_REQUEST_PAGE_SIZE, (requestPage + 1) * RUNNER_REQUEST_PAGE_SIZE));
  let visibleResults = $derived(shownResults.slice(resultPage * RUNNER_RESULT_PAGE_SIZE, (resultPage + 1) * RUNNER_RESULT_PAGE_SIZE));

  $effect(() => {
    filteredRequests.length;
    if (requestPage >= requestPageCount) requestPage = Math.max(0, requestPageCount - 1);
  });

  $effect(() => {
    shownResults.length;
    if (resultPage >= resultPageCount) resultPage = Math.max(0, resultPageCount - 1);
  });

  function isFailure(result: CollectionRunnerResult) {
    return result.status === 'failed' || result.status === 'error';
  }

  function folderOf(request: SavedRequest) {
    return request.folderPath.join(' / ');
  }

  function pageCount(total: number, size: number): number {
    return Math.max(1, Math.ceil(total / size));
  }

  function inputValue(event: Event): string {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : '';
  }

  function inputChecked(event: Event): boolean {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.checked : false;
  }

  function rangeLabel(page: number, size: number, total: number): string {
    if (!total) return '0 of 0';
    const start = page * size + 1;
    const end = Math.min(total, (page + 1) * size);
    return `${start}-${end} of ${total}`;
  }

  function statusLabel(result: CollectionRunnerResult) {
    if (result.status === 'queued') return 'Queued';
    if (result.status === 'running') return 'Running';
    if (result.status === 'skipped') return 'Skipped';
    if (result.status === 'error') return 'Error';
    return result.status === 'passed' ? 'Passed' : 'Failed';
  }
</script>

<section class="collection-runner-workspace" aria-label="Collection runner">
  <aside class="collection-runner-config">
    <div class="runner-group">
      <div class="runner-section-title">What to run</div>
      <label class="runner-field">
        <span>Collection</span>
        <Select
          value={selectedCollectionId}
          options={collectionOptions}
          className="runner-select"
          disabled={running || !collections.length}
          onChange={onSelectCollection}
        />
      </label>
      <label class="runner-field">
        <span>Only requests tagged</span>
        <input class="field" value={includeTags} placeholder="e.g. smoke, regression" aria-label="Include tags" oninput={(event) => onSetIncludeTags(inputValue(event))} disabled={running} />
      </label>
      <label class="runner-field">
        <span>Skip requests tagged</span>
        <input class="field" value={excludeTags} placeholder="e.g. slow, local" aria-label="Exclude tags" oninput={(event) => onSetExcludeTags(inputValue(event))} disabled={running} />
      </label>
    </div>
    <div class="runner-group">
      <div class="runner-section-title">How many times</div>
      <div class="runner-file-row">
        <button class="btn btn-secondary btn-lg runner-file-btn" type="button" onclick={onSelectDataFile} disabled={running}>
          <svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M3 1.5h5l3 3V12H3V1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
            <path d="M8 1.7V4.5h2.8" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
          <span class="runner-file-copy">
            <span>{dataFileName || 'Run with a CSV or JSON file'}</span>
            {#if dataFileName}<small>{dataRowCount} row{dataRowCount === 1 ? '' : 's'} loaded</small>{/if}
          </span>
        </button>
        {#if dataFileName}
          <button class="btn btn-secondary btn-icon btn-lg runner-file-clear" type="button" aria-label="Remove runner data file" onclick={onClearDataFile} disabled={running}>
            ×
          </button>
        {/if}
      </div>
      {#if dataError}
        <div class="runner-file-error">{dataError}</div>
      {/if}
      <label class="runner-field">
        <span>Iterations</span>
        <input class="field" type="number" min="1" step="1" value={iterations} oninput={(event) => onSetIterations(inputValue(event))} disabled={running || dataRowCount > 0} />
        {#if dataRowCount > 0}<small class="runner-field-note">One iteration per data row.</small>{/if}
      </label>
    </div>
    <div class="runner-group">
      <div class="runner-section-title">Order &amp; pacing</div>
      <div class="segmented runner-order" role="radiogroup" aria-label="Order">
        <button class="segmented-item" type="button" role="radio" aria-checked={!parallel} disabled={running} onclick={() => onSetParallel(false)}>One by one</button>
        <button class="segmented-item" type="button" role="radio" aria-checked={parallel} disabled={running} onclick={() => onSetParallel(true)}>In parallel</button>
      </div>
      {#if parallel}
        <label class="runner-field">
          <span>Max concurrent requests</span>
          <input class="field"
            type="number"
            min={MIN_RUNNER_CONCURRENCY}
            max={MAX_RUNNER_CONCURRENCY}
            step="1"
            value={concurrency}
            oninput={(event) => onSetConcurrency(inputValue(event))}
            disabled={running}
          />
        </label>
        <p class="runner-hint">
          Requests in an iteration run at the same time, so a test that saves a variable
          may not have finished before the next request reads it. Keep chained requests one by one.
        </p>
      {/if}
      <label class="runner-field">
        <span>Delay between requests (ms)</span>
        <input class="field" type="number" min="0" step="1" value={delayMs || ''} placeholder="0" oninput={(event) => onSetDelayMs(inputValue(event))} disabled={running} />
      </label>
    </div>
    <div class="runner-actions">
      <button class="btn btn-ghost" type="button" onclick={onReset} disabled={running}>Reset settings</button>
    </div>
  </aside>
  <section class="collection-runner-main">
    <header class="runner-page-head">
      <div class="runner-page-title">
        <h1>{title}</h1>
        <p><b>{selectedCount}</b> of {runnableCount} {runnableCount === 1 ? 'request' : 'requests'} × <b>{Math.max(1, iterations)}</b> {iterations === 1 ? 'iteration' : 'iterations'} = <b>{runCount}</b> {runCount === 1 ? 'call' : 'calls'} · {parallel ? 'in parallel' : 'one by one'}{delayMs ? ` · ${delayMs} ms apart` : ''}</p>
      </div>
      <div class="runner-page-actions">
        {#if hasResults}
          <button class="btn btn-secondary runner-report-btn" type="button" onclick={onDownloadReport} disabled={running}>
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2v7m0 0 3-3m-3 3L5 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M3 11.5V13h10v-1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Download report
          </button>
        {/if}
        {#if running}
          <button class="btn btn-secondary btn-danger" type="button" onclick={onStop}>Stop</button>
        {:else}
          <button class="btn btn-primary runner-run-btn" type="button" onclick={onRun} disabled={!selectedCount || !collections.length}>
            <svg width="0.75rem" height="0.75rem" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l11-7z"/></svg>
            Run {runCount} request{runCount === 1 ? '' : 's'}
          </button>
        {/if}
      </div>
    </header>
    <div class="runner-page-body">
    {#if hasResults}
      {@const verdict = running ? 'running' : summary.allPassed ? 'pass' : summary.failed > 0 ? 'fail' : 'stopped'}
      <section class="runner-results-panel" aria-label="Run results">
        <div class="runner-results-summary">
          <div class="runner-verdict {verdict}">
            <span class="runner-verdict-icon" aria-hidden="true">
              {#if verdict === 'pass'}
                <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
              {:else if verdict === 'fail'}
                <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none"><path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
              {:else if verdict === 'running'}
                <svg width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l11-7z" /></svg>
              {:else}
                <svg width="0.75rem" height="0.75rem" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /></svg>
              {/if}
            </span>
            <span class="runner-stat">
              <span>Result</span>
              <strong class:pass={summary.allPassed && !running} class:fail={summary.failed > 0}>{running ? 'Running' : summary.allPassed ? 'Passed' : summary.skipped ? 'Stopped' : 'Failed'}</strong>
            </span>
          </div>
          <div class="runner-stat">
            <span>Requests</span>
            <strong>{summary.completed}/{summary.total}</strong>
          </div>
          <div class="runner-stat">
            <span>Checks</span>
            <strong>{summary.testsPassed}/{summary.testsTotal}</strong>
          </div>
          <div class="runner-stat">
            <span>Duration</span>
            <strong>{summary.duration} ms</strong>
          </div>
          <div class="runner-progress-wrap">
            <div class="runner-progress" aria-hidden="true">
              <span class="runner-progress-pass" style={`width: ${summary.total ? (summary.passed / summary.total) * 100 : 0}%`}></span>
              <span class="runner-progress-fail" style={`width: ${summary.total ? (summary.failed / summary.total) * 100 : 0}%`}></span>
            </div>
            <span class="runner-progress-legend"><span class="pass">{summary.passed} passed</span>{#if summary.failed}{' · '}<span class="fail">{summary.failed} failed</span>{/if}</span>
          </div>
        </div>
        <div class="runner-results-toolbar">
          <div class="segmented runner-results-filter" role="radiogroup" aria-label="Show results">
            <button class="segmented-item" type="button" role="radio" aria-checked={!failedOnly || !failedCount} onclick={() => (failedOnly = false)}>All {results.length}</button>
            <button class="segmented-item" type="button" role="radio" aria-checked={failedOnly && failedCount > 0} disabled={!failedCount} onclick={() => (failedOnly = true)}>Failed {failedCount}</button>
          </div>
          {#if lastRunAt && !running}
            <p class="runner-last-run" title={new Date(lastRunAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' })}>Last run {relativeTime(lastRunAt, now())}</p>
          {/if}
        </div>
        {#if shownResults.length > RUNNER_RESULT_PAGE_SIZE}
          <div class="runner-pagination runner-results-pagination" aria-label="Runner result pages">
            <span>Results {rangeLabel(resultPage, RUNNER_RESULT_PAGE_SIZE, shownResults.length)}</span>
            <div class="runner-page-buttons">
              <button class="btn btn-secondary btn-sm" type="button" onclick={() => (resultPage = Math.max(0, resultPage - 1))} disabled={resultPage === 0}>Prev</button>
              <span>{resultPage + 1}/{resultPageCount}</span>
              <button class="btn btn-secondary btn-sm" type="button" onclick={() => (resultPage = Math.min(resultPageCount - 1, resultPage + 1))} disabled={resultPage + 1 >= resultPageCount}>Next</button>
            </div>
          </div>
        {/if}
        <div class="runner-results-table">
          <div class="runner-result-row runner-result-head" aria-hidden="true">
            <span></span><span>Request</span><span>Status</span><span>Time</span><span>Checks</span>
          </div>
          {#each visibleResults as result (result.runId)}
            <div class="runner-result-row" data-testid="runner-result-row" class:running={result.status === 'running'} class:pass={result.status === 'passed'} class:fail={result.status === 'failed' || result.status === 'error'}>
              <span class="collection-method {methodColor(result.method)}" title={result.method}>{requestKindShortLabel(result.method)}</span>
              <div class="runner-request-main">
                <span>{result.name}</span>
                {#if iterations > 1}<small>iteration {result.iteration}</small>{/if}
              </div>
              <span class="runner-code-status">
                <span class="runner-code">{result.statusCode || '—'}</span>
                <span class="runner-status">{statusLabel(result)}</span>
              </span>
              <span class="runner-time">{result.duration ? `${result.duration} ms` : '—'}</span>
              <span class="runner-tests">{result.testsTotal ? `${result.testsPassed}/${result.testsTotal}` : '—'}</span>
              {#if result.error}<span class="runner-error">{result.error}</span>{/if}
              {#if result.tests?.some(test => !test.passed)}
                <ul class="runner-failures">
                  {#each result.tests.filter(test => !test.passed) as test, eachIndex (eachIndex)}
                    <li><span class="runner-failure-mark">Failed</span> {test.name}{#if test.error}<span class="runner-failure-detail">{test.error}</span>{/if}</li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}
    <section class="runner-selection" aria-label="Requests to run">
      <div class="runner-selection-head">
        <strong>Requests to run</strong>
        <span class="runner-selection-count">{selectedCount} of {runnableCount} selected</span>
        <div class="runner-selection-actions">
          <button class="btn btn-ghost btn-sm" type="button" onclick={onSelectAll} disabled={running || !runnableCount}>Select all</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick={onDeselectAll} disabled={running || !selectedCount}>Deselect all</button>
        </div>
      </div>
      {#if filteredRequests.length > RUNNER_REQUEST_PAGE_SIZE}
        <div class="runner-pagination" aria-label="Runner request pages">
          <span>Requests {rangeLabel(requestPage, RUNNER_REQUEST_PAGE_SIZE, filteredRequests.length)}</span>
          <div class="runner-page-buttons">
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => (requestPage = Math.max(0, requestPage - 1))} disabled={requestPage === 0}>Prev</button>
            <span>{requestPage + 1}/{requestPageCount}</span>
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => (requestPage = Math.min(requestPageCount - 1, requestPage + 1))} disabled={requestPage + 1 >= requestPageCount}>Next</button>
          </div>
        </div>
      {/if}
      <div class="runner-request-list">
        {#if !collections.length}
          <div class="empty-state runner-empty"><span class="empty-state-title">No collections in this workspace</span></div>
        {:else if !filteredRequests.length}
          <div class="empty-state runner-empty"><span class="empty-state-title">No requests match the current filters</span></div>
        {:else}
          {#each visibleRequests as request, index (request.id)}
            {@const skipped = isRequestSkipped(request)}
            {@const tags = requestTags(request)}
            {@const transportLabel = requestTransportLabel(request)}
            {@const folder = folderOf(request)}
            {#if folder && (index === 0 || folderOf(visibleRequests[index - 1]) !== folder)}
              <div class="runner-folder">{folder}</div>
            {/if}
            <label class="runner-request-row" data-testid="runner-request-row" class:selected={selectedSet.has(request.id)} class:skipped={skipped}>
              <input
                type="checkbox"
                class="check"
                checked={selectedSet.has(request.id)}
                disabled={running || skipped}
                aria-label={`Select ${requestTabLabel(request)}`}
                onchange={() => onToggleRequest(request.id)}
              />
              <span class="collection-method {methodColor(transportLabel)}" title={transportLabel}>{requestKindShortLabel(transportLabel)}</span>
              <span class="runner-request-copy">
                <strong>{requestTabLabel(request)}</strong>
                <small>{request.url}</small>
              </span>
              <span class="runner-request-tags">
                {#if skipped}
                  <span class="runner-not-runnable">can't run here</span>
                {:else}
                  {#each tags.slice(0, 3) as tag (tag)}<span>{tag}</span>{/each}
                {/if}
              </span>
            </label>
          {/each}
        {/if}
      </div>
    </section>
    </div>
  </section>
</section>
