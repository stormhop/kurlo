<script lang="ts">
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
  let resultPageCount = $derived(pageCount(results.length, RUNNER_RESULT_PAGE_SIZE));
  let visibleRequests = $derived(filteredRequests.slice(requestPage * RUNNER_REQUEST_PAGE_SIZE, (requestPage + 1) * RUNNER_REQUEST_PAGE_SIZE));
  let visibleResults = $derived(results.slice(resultPage * RUNNER_RESULT_PAGE_SIZE, (resultPage + 1) * RUNNER_RESULT_PAGE_SIZE));

  $effect(() => {
    filteredRequests.length;
    if (requestPage >= requestPageCount) requestPage = Math.max(0, requestPageCount - 1);
  });

  $effect(() => {
    results.length;
    if (resultPage >= resultPageCount) resultPage = Math.max(0, resultPageCount - 1);
  });

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

    <div class="runner-section-title">Timings</div>
    <label class="runner-field">
      <span>Delay between requests (ms)</span>
      <input class="field" type="number" min="0" step="1" value={delayMs || ''} placeholder="e.g. 5" oninput={(event) => onSetDelayMs(inputValue(event))} disabled={running} />
    </label>

    <div class="runner-section-title">Filters</div>
    <div class="runner-filter-grid">
      <label class="runner-field">
        <span>Include tags</span>
        <input class="field" value={includeTags} placeholder="e.g., smoke, regression" oninput={(event) => onSetIncludeTags(inputValue(event))} disabled={running} />
      </label>
      <label class="runner-field">
        <span>Exclude tags</span>
        <input class="field" value={excludeTags} placeholder="e.g., slow, local" oninput={(event) => onSetExcludeTags(inputValue(event))} disabled={running} />
      </label>
    </div>

    <div class="runner-section-title muted">Run with data file</div>
    <div class="runner-file-row">
      <button class="btn btn-secondary btn-lg runner-file-btn" type="button" onclick={onSelectDataFile} disabled={running}>
        <svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3 1.5h5l3 3V12H3V1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M8 1.7V4.5h2.8" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
        {dataFileName || 'Select CSV or JSON file'}
      </button>
      {#if dataFileName}
        <button class="btn btn-secondary btn-icon btn-lg runner-file-clear" type="button" aria-label="Remove runner data file" onclick={onClearDataFile} disabled={running}>
          ×
        </button>
      {/if}
    </div>
    {#if dataFileName}
      <div class="runner-file-status">{dataRowCount} row{dataRowCount === 1 ? '' : 's'} loaded</div>
    {/if}
    {#if dataError}
      <div class="runner-file-error">{dataError}</div>
    {/if}

    <label class="runner-field">
      <span>Iterations</span>
      <input class="field" type="number" min="1" step="1" value={iterations} oninput={(event) => onSetIterations(inputValue(event))} disabled={running || dataRowCount > 0} />
    </label>

    <label class="switch-control runner-toggle">
      <input type="checkbox" checked={parallel} onchange={(event) => onSetParallel(inputChecked(event))} disabled={running} />
      <span class="switch-track"></span>
      <span class="switch-label">Run in parallel</span>
    </label>

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
        may not have finished before the next request reads it. Keep chained requests sequential.
      </p>
    {/if}

    <div class="runner-actions">
      <button class="btn btn-ghost" type="button" onclick={onReset} disabled={running}>Reset settings</button>
    </div>
  </aside>

  <section class="collection-runner-main">
    <header class="runner-page-head">
      <div class="runner-page-title">
        <h1>{title}</h1>
        <p>{selectedCount} of {runnableCount} {runnableCount === 1 ? 'request' : 'requests'} selected · {iterations} {iterations === 1 ? 'iteration' : 'iterations'}{parallel ? ' · in parallel' : ''}</p>
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
      <section class="runner-results-panel" aria-label="Run results">
        {#if lastRunAt && !running}
          <p class="runner-last-run" title={new Date(lastRunAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' })}>Last run {relativeTime(lastRunAt)}</p>
        {/if}
        <div class="runner-results-summary">
          <div class="runner-stat">
            <span>Result</span>
            <strong class:pass={summary.allPassed && !running} class:fail={summary.failed > 0}>{running ? 'Running' : summary.allPassed ? 'Passed' : summary.skipped ? 'Stopped' : 'Failed'}</strong>
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
          <div class="runner-progress" aria-hidden="true">
            <span class="runner-progress-pass" style={`width: ${summary.total ? (summary.passed / summary.total) * 100 : 0}%`}></span>
            <span class="runner-progress-fail" style={`width: ${summary.total ? (summary.failed / summary.total) * 100 : 0}%`}></span>
          </div>
        </div>
        {#if results.length > RUNNER_RESULT_PAGE_SIZE}
          <div class="runner-pagination runner-results-pagination" aria-label="Runner result pages">
            <span>Results {rangeLabel(resultPage, RUNNER_RESULT_PAGE_SIZE, results.length)}</span>
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
          {#each visibleRequests as request (request.id)}
            {@const skipped = isRequestSkipped(request)}
            {@const tags = requestTags(request)}
            {@const transportLabel = requestTransportLabel(request)}
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
                <small>{request.folderPath.length ? request.folderPath.join(' / ') : request.url}</small>
              </span>
              <span class="runner-request-tags">{skipped ? 'not runnable' : tags.slice(0, 3).join(', ')}</span>
            </label>
          {/each}
        {/if}
      </div>
    </section>
    </div>
  </section>
</section>
