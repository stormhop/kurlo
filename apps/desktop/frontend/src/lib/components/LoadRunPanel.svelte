<script lang="ts">
  import { executorModel, executorPoints, formatDuration } from '../loadPresets';
  import LoadShapeChart from './LoadShapeChart.svelte';
  import type { SavedRequest } from '../types/models';
  import { requestTabLabel } from '../utils';
  import type { LoadRunResult, LoadRunState, LoadTest, LoadThreshold } from '../wire';

  let {
    loadTest,
    requests,
    run,
    logLines,
    result,
    otherRunning = false,
    disabled = false,
    onRun,
    onOpenDashboard,
    onOpenReport,
    onSaveSummary,
  }: {
    loadTest: LoadTest;
    requests: SavedRequest[];
    run: LoadRunState;
    logLines: string[];
    result: LoadRunResult | null;
    otherRunning?: boolean;
    disabled?: boolean;
    onRun: () => void;
    onOpenDashboard: (url: string) => void;
    onOpenReport: () => void;
    onSaveSummary: () => void;
  } = $props();

  const STATUS_LABELS: Record<string, string> = {
    passed: 'Passed',
    failed: 'Failed',
    stopped: 'Stopped',
    error: 'Did not finish',
  };
  const METRIC_LABELS: Record<string, string> = {
    http_req_duration: 'Response time',
    http_req_failed: 'Failed requests',
    checks: 'Checks passed',
  };

  let logBox = $state<HTMLPreElement | undefined>();
  let follow = $state(true);
  let logOpen = $state<boolean | null>(null);

  const running = $derived(run.running && run.loadTestId === loadTest.id);
  const elapsed = $derived(run.progress.elapsedMs);
  const percent = $derived(run.plannedMs > 0 ? Math.min(100, Math.round(elapsed / run.plannedMs * 100)) : 0);
  const stage = $derived.by(() => {
    const executor = loadTest.scenarios[0]?.executor;
    if (!executor?.stages?.length) return '';
    const points = executorPoints(executor);
    const index = points.findIndex(point => point.ms > elapsed);
    const current = index <= 0 ? executor.stages.length : index;
    return `Stage ${Math.min(current, executor.stages.length)} of ${executor.stages.length}`;
  });
  const executor = $derived(loadTest.scenarios[0]?.executor);
  const unit = $derived(executor && executorModel(executor) === 'rate' ? 'iterations/s' : 'users');
  const remaining = $derived(Math.max(0, run.plannedMs - elapsed));
  const headline = $derived.by(() => {
    if (run.stopping) return 'Stopping…';
    if (!executor) return 'Running';
    if (!executor.stages?.length) return `Holding at ${executor.vus ?? executor.rate ?? 0} ${unit}`;
    const points = executorPoints(executor);
    const index = Math.max(1, Math.min(points.length - 1, points.findIndex(point => point.ms > elapsed)));
    const from = points[index - 1]?.value ?? 0;
    const to = points[index]?.value ?? 0;
    if (to > from) return `Ramping up to ${to} ${unit}`;
    if (to < from) return `Ramping down to ${to} ${unit}`;
    return `Holding at ${to} ${unit}`;
  });
  const showLog = $derived(logOpen ?? running);
  const slowestStep = $derived(Math.max(1, ...(result?.steps ?? []).filter(step => step.requests).map(step => step.p95)));
  const failedThresholds = $derived(result?.thresholds.filter(threshold => !threshold.ok).length ?? 0);
  const steps = $derived(loadTest.scenarios[0]?.steps ?? []);

  $effect(() => {
    void logLines.length;
    if (follow && showLog && logBox) logBox.scrollTop = logBox.scrollHeight;
  });

  function stepLabel(stepId: string) {
    const index = steps.findIndex(step => step.id === stepId);
    const step = steps[index];
    const request = step ? requests.find(candidate => candidate.id === step.requestId) : undefined;
    if (!step) return 'Removed step';
    return `${index + 1} · ${request ? requestTabLabel(request) : 'Missing request'}`;
  }

  function clock(value: number) {
    const total = Math.max(0, Math.floor(value / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const seconds = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
  }

  function roughlyLeft(value: number) {
    const seconds = Math.ceil(value / 1000);
    if (seconds <= 0) return 'finishing';
    if (seconds < 60) return `about ${seconds} s left`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `about ${minutes} min left`;
    const hours = Math.floor(minutes / 60);
    return `about ${hours} h ${minutes % 60} min left`;
  }

  function ms(value: number) {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
    if (value >= 10) return `${Math.round(value)} ms`;
    return `${value.toFixed(1)} ms`;
  }

  function pct(value: number) {
    if (value !== 0 && Math.abs(value) < 0.001) return `${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(value * 100)}%`;
    return `${(Math.round(value * 1000) / 10).toFixed(1)}%`;
  }

  function count(value: number) {
    return new Intl.NumberFormat('en-US').format(value);
  }

  function when(timestamp: number) {
    return new Date(timestamp).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', hour12: false });
  }

  function thresholdOf(metric: string, stepId: string | undefined, expression: string): LoadThreshold | undefined {
    const parts = /^(.*?)(<=|>=|<|>|==|!=)(.+)$/.exec(expression);
    if (!parts) return undefined;
    return loadTest.thresholds?.find(threshold => threshold.metric === metric && (threshold.step ?? '') === (stepId ?? '') && threshold.stat === parts[1] && threshold.op === parts[2] && threshold.value === Number(parts[3]));
  }

  function thresholdName(metric: string, stepId: string | undefined, expression: string) {
    const threshold = thresholdOf(metric, stepId, expression);
    const stat = threshold && threshold.stat !== 'rate' ? ` ${threshold.stat === 'med' ? 'median' : threshold.stat}` : '';
    return `${METRIC_LABELS[metric] ?? metric}${stat} · ${stepId ? stepLabel(stepId) : 'all steps'}`;
  }

  function thresholdLimit(metric: string, stepId: string | undefined, expression: string) {
    const threshold = thresholdOf(metric, stepId, expression);
    if (!threshold) return expression;
    return `${threshold.op} ${metric === 'http_req_duration' ? ms(threshold.value) : pct(threshold.value)}`;
  }

  function meter(metric: string, stepId: string | undefined, expression: string, value: number, has: boolean) {
    const threshold = thresholdOf(metric, stepId, expression);
    if (!threshold || !has || !Number.isFinite(value)) return null;
    const scale = Math.max(value, threshold.value) * 1.25 || 1;
    return { value: Math.min(100, value / scale * 100), limit: Math.min(100, threshold.value / scale * 100) };
  }

  function actual(metric: string, value: number, has: boolean) {
    if (!has) return '—';
    return metric === 'http_req_duration' ? ms(value) : pct(value);
  }
</script>

<div class="loadrun">
  {#if running}
    <section class="loadtest-card loadrun-progress" aria-label="Run progress">
      <div class="loadrun-progress-head">
        <div class="loadrun-progress-title">
          <span class="loadtest-label">{stage || 'Running'}</span>
          <strong>{headline}</strong>
        </div>
        <div class="loadrun-progress-time">
          <span class="loadrun-clock">{clock(elapsed)} <span class="loadrun-clock-total">/ {clock(run.plannedMs)}</span></span>
          {#if run.plannedMs > 0}<span class="loadtest-hint">{roughlyLeft(remaining)}</span>{/if}
        </div>
      </div>
      {#if executor}
        <LoadShapeChart {executor} {unit} label={`Planned load with progress at ${formatDuration(elapsed)} of ${formatDuration(run.plannedMs)}`} progressMs={elapsed} />
      {/if}
      <div class="loadrun-bar" role="progressbar" aria-label="Run progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}>
        <span style={`width: ${percent}%`}></span>
      </div>
      <div class="loadrun-figures loadrun-tiles">
        <div><span class="loadtest-label">Virtual users</span><strong>{run.progress.vus}<small> / {run.progress.maxVUs}</small></strong></div>
        <div><span class="loadtest-label">Completed iterations</span><strong>{count(run.progress.iterations)}</strong></div>
        <div><span class="loadtest-label">Interrupted</span><strong>{count(run.progress.interrupted)}</strong></div>
      </div>
      <div class="loadtest-row">
        <button class="btn btn-secondary" type="button" disabled={!run.dashboardUrl} onclick={() => onOpenDashboard(run.dashboardUrl)}>Open k6 live dashboard</button>
        <span class="loadtest-hint loadrun-grow">Response times and checks per second are on the dashboard; the summary shows up here when the run ends.</span>
        <span class="loadtest-hint">k6 {run.k6Version}</span>
      </div>
    </section>
  {:else if result}
    <section class="loadrun-banner" class:failed={result.status !== 'passed'} class:stopped={result.status === 'stopped'} role="status">
      <span class="loadrun-banner-icon" aria-hidden="true">
        {#if result.status === 'passed'}
          <svg width="1.125rem" height="1.125rem" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
        {:else if result.status === 'stopped'}
          <svg width="1.125rem" height="1.125rem" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>
        {:else}
          <svg width="1.125rem" height="1.125rem" viewBox="0 0 16 16" fill="none"><path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
        {/if}
      </span>
      <div class="loadrun-banner-text">
        <div class="loadrun-banner-heading">
          <span class="tag" class:tag-success={result.status === 'passed'} class:tag-danger={result.status === 'failed' || result.status === 'error'} class:tag-warning={result.status === 'stopped'}>{STATUS_LABELS[result.status] ?? result.status}</span>
          <strong>
            {#if result.status === 'failed'}{failedThresholds} of {result.thresholds.length} pass criteria not met
            {:else if result.status === 'passed'}All pass criteria met
            {:else if result.status === 'stopped'}Stopped before the end
            {:else}The run did not finish{/if}
          </strong>
        </div>
        <span class="loadtest-hint">{when(result.finishedAt)} · {formatDuration(result.finishedAt - result.startedAt)}{result.environment ? ` · ${result.environment}` : ''} · k6 {result.k6Version}{result.exitCode ? ` · exit code ${result.exitCode}` : ''}</span>
        {#if result.error}<span class="loadrun-error">{result.error}</span>{/if}
      </div>
      <div class="loadtest-row">
        <button class="btn btn-secondary" type="button" disabled={!result.hasReport} title={result.hasReport ? '' : 'k6 writes the HTML report only for runs long enough to chart'} onclick={onOpenReport}>Open HTML report</button>
        <button class="btn btn-secondary" type="button" disabled={!result.hasSummary} onclick={onSaveSummary}>Save summary JSON</button>
      </div>
    </section>
    {#if result.hasSummary}
      {#if result.thresholds.length}
        <section class="loadtest-section">
          <h2 class="loadtest-section-title">Pass criteria</h2>
          <div class="loadrun-table-wrap">
            <table class="loadrun-table loadrun-criteria">
              <thead><tr><th>Criterion</th><th>Limit</th><th>Actual</th><th>Result</th></tr></thead>
              <tbody>
                {#each result.thresholds as threshold (`${threshold.metric}|${threshold.stepId}|${threshold.expression}`)}
                  {@const gauge = meter(threshold.metric, threshold.stepId, threshold.expression, threshold.actual, threshold.hasActual)}
                  <tr class:bad={!threshold.ok}>
                    <td>{thresholdName(threshold.metric, threshold.stepId, threshold.expression)}</td>
                    <td class="num">{thresholdLimit(threshold.metric, threshold.stepId, threshold.expression)}</td>
                    <td class="num">{actual(threshold.metric, threshold.actual, threshold.hasActual)}</td>
                    <td>
                      <span class="loadrun-verdict">
                        <span class="loadrun-verdict-label">{threshold.ok ? 'Met' : 'Not met'}</span>
                        {#if gauge}
                          <span class="loadrun-meter" aria-hidden="true"><span class="loadrun-meter-value" style={`width: ${gauge.value}%`}></span><span class="loadrun-meter-limit" style={`left: ${gauge.limit}%`}></span></span>
                        {/if}
                      </span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>
      {/if}
      <div class="loadrun-figures loadrun-totals">
        <div><span class="loadtest-label">Requests</span><strong>{count(result.totals.requests)}</strong><span class="loadtest-hint">{result.totals.rps.toFixed(1)} / s</span></div>
        <div><span class="loadtest-label">p95 response time</span><strong>{ms(result.totals.p95)}</strong><span class="loadtest-hint">median {ms(result.totals.med)}</span></div>
        <div><span class="loadtest-label">Failed requests</span><strong>{pct(result.totals.failedRate)}</strong><span class="loadtest-hint">{count(result.totals.failedCount)} requests</span></div>
        <div><span class="loadtest-label">Checks passed</span><strong>{result.totals.checksPassed + result.totals.checksFailed ? pct(result.totals.checksPassed / (result.totals.checksPassed + result.totals.checksFailed)) : '—'}</strong><span class="loadtest-hint">{count(result.totals.checksFailed)} failed</span></div>
        <div><span class="loadtest-label">Iterations</span><strong>{count(result.totals.iterations)}</strong><span class="loadtest-hint">{count(result.totals.interrupted)} interrupted · {result.totals.maxVUs} users</span></div>
      </div>
      <section class="loadtest-section">
        <h2 class="loadtest-section-title">By step</h2>
        <div class="loadrun-table-wrap">
          <table class="loadrun-table">
            <thead><tr><th>Step</th><th>Requests</th><th>Median</th><th>p95</th><th>p99</th><th>Failed</th><th>Checks</th></tr></thead>
            <tbody>
              {#each result.steps as step (step.stepId)}
                <tr class:loadrun-step-failing={step.failedRate > 0}>
                  <td>{stepLabel(step.stepId)}</td>
                  <td class="num">{count(step.requests)}</td>
                  <td class="num">{step.requests ? ms(step.med) : '—'}</td>
                  <td class="num loadrun-p95">{#if step.requests}<span class="loadrun-p95-bar" style={`width: ${Math.max(2, step.p95 / slowestStep * 100)}%`} aria-hidden="true"></span>{/if}{step.requests ? ms(step.p95) : '—'}</td>
                  <td class="num">{step.requests ? ms(step.p99) : '—'}</td>
                  <td class="num" class:loadrun-cell-bad={step.failedRate > 0}>{step.requests ? pct(step.failedRate) : '—'}</td>
                  <td class="num">{step.checksPassed + step.checksFailed ? pct(step.checksRate) : '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <span class="loadtest-hint">Only the last run is kept. Save the summary or the HTML report to keep it.</span>
      </section>
    {/if}
  {:else}
    <div class="empty-state loadtest-empty">
      <p class="empty-state-title">No runs yet</p>
      <p class="empty-state-text">Run the test with k6 on this computer. The summary of the last run shows up here.</p>
      <button class="btn btn-primary" type="button" disabled={disabled || otherRunning} onclick={onRun}>Run with k6</button>
    </div>
  {/if}
  {#if running || logLines.length}
    <section class="loadrun-log-panel" aria-label="k6 output">
      <div class="loadrun-log-head">
        <button class="btn btn-ghost btn-sm loadrun-log-toggle" type="button" aria-expanded={showLog} onclick={() => (logOpen = !showLog)}>
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
          k6 output
        </button>
        <span class="loadtest-hint loadrun-grow">{count(logLines.length)} {logLines.length === 1 ? 'line' : 'lines'}</span>
        {#if showLog}<label class="check-label"><input class="check" type="checkbox" bind:checked={follow} />Follow</label>{/if}
      </div>
      <pre class="loadrun-log" bind:this={logBox} hidden={!showLog || !logLines.length} aria-label="k6 output">{logLines.join('\n')}</pre>
    </section>
  {/if}
</div>
