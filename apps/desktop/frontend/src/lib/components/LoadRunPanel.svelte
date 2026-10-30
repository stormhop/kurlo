<script lang="ts">
  import { executorPoints, formatDuration } from '../loadPresets';
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
    onStop,
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
    onStop: () => void;
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
  const failedThresholds = $derived(result?.thresholds.filter(threshold => !threshold.ok).length ?? 0);
  const steps = $derived(loadTest.scenarios[0]?.steps ?? []);

  $effect(() => {
    void logLines.length;
    if (follow && logBox) logBox.scrollTop = logBox.scrollHeight;
  });

  function stepLabel(stepId: string) {
    const index = steps.findIndex(step => step.id === stepId);
    const step = steps[index];
    const request = step ? requests.find(candidate => candidate.id === step.requestId) : undefined;
    if (!step) return 'Removed step';
    return `${index + 1} · ${request ? requestTabLabel(request) : 'Missing request'}`;
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

  function actual(metric: string, value: number, has: boolean) {
    if (!has) return '—';
    return metric === 'http_req_duration' ? ms(value) : pct(value);
  }
</script>

<div class="loadrun">
  {#if running}
    <section class="loadtest-card loadrun-progress" aria-label="Run progress">
      <div class="loadtest-row loadrun-progress-head">
        <strong>{run.stopping ? 'Stopping…' : stage || 'Running'}</strong>
        <span class="loadrun-clock">{formatDuration(elapsed)} / {formatDuration(run.plannedMs)}</span>
      </div>
      <div class="loadrun-bar" role="progressbar" aria-label="Run progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}>
        <span style={`width: ${percent}%`}></span>
      </div>
      <div class="loadrun-figures">
        <div><span class="loadtest-label">Virtual users</span><strong>{run.progress.vus}<small> / {run.progress.maxVUs}</small></strong></div>
        <div><span class="loadtest-label">Completed iterations</span><strong>{count(run.progress.iterations)}</strong></div>
        <div><span class="loadtest-label">Interrupted</span><strong>{count(run.progress.interrupted)}</strong></div>
      </div>
      <div class="loadtest-row">
        <button class="btn btn-secondary" type="button" disabled={!run.dashboardUrl} onclick={() => onOpenDashboard(run.dashboardUrl)}>Open k6 live dashboard</button>
        <button class="btn btn-secondary btn-danger" type="button" disabled={run.stopping} onclick={onStop}>{run.stopping ? 'Stopping…' : 'Stop'}</button>
        <span class="loadtest-hint">k6 {run.k6Version}</span>
      </div>
    </section>
  {:else if result}
    <section class="loadrun-banner" class:failed={result.status !== 'passed'} role="status">
      <span class="tag" class:tag-success={result.status === 'passed'} class:tag-danger={result.status === 'failed' || result.status === 'error'} class:tag-warning={result.status === 'stopped'}>{STATUS_LABELS[result.status] ?? result.status}</span>
      <div class="loadrun-banner-text">
        <strong>
          {#if result.status === 'failed'}{failedThresholds} of {result.thresholds.length} pass criteria not met
          {:else if result.status === 'passed'}All pass criteria met
          {:else if result.status === 'stopped'}Stopped before the end
          {:else}The run did not finish{/if}
        </strong>
        <span class="loadtest-hint">{when(result.finishedAt)} · {formatDuration(result.finishedAt - result.startedAt)}{result.environment ? ` · ${result.environment}` : ''} · k6 {result.k6Version}{result.exitCode ? ` · exit code ${result.exitCode}` : ''}</span>
        {#if result.error}<span class="loadrun-error">{result.error}</span>{/if}
      </div>
      <div class="loadtest-row">
        <button class="btn btn-secondary" type="button" disabled={!result.hasReport} title={result.hasReport ? '' : 'k6 writes the HTML report only for runs long enough to chart'} onclick={onOpenReport}>Open HTML report</button>
        <button class="btn btn-secondary" type="button" disabled={!result.hasSummary} onclick={onSaveSummary}>Save summary JSON</button>
      </div>
    </section>

    {#if result.hasSummary}
      <div class="loadrun-figures loadrun-totals">
        <div><span class="loadtest-label">Requests</span><strong>{count(result.totals.requests)}</strong><span class="loadtest-hint">{result.totals.rps.toFixed(1)} / s</span></div>
        <div><span class="loadtest-label">p95 response time</span><strong>{ms(result.totals.p95)}</strong><span class="loadtest-hint">median {ms(result.totals.med)}</span></div>
        <div><span class="loadtest-label">Failed requests</span><strong>{pct(result.totals.failedRate)}</strong><span class="loadtest-hint">{count(result.totals.failedCount)} requests</span></div>
        <div><span class="loadtest-label">Checks passed</span><strong>{result.totals.checksPassed + result.totals.checksFailed ? pct(result.totals.checksPassed / (result.totals.checksPassed + result.totals.checksFailed)) : '—'}</strong><span class="loadtest-hint">{count(result.totals.checksFailed)} failed</span></div>
        <div><span class="loadtest-label">Iterations</span><strong>{count(result.totals.iterations)}</strong><span class="loadtest-hint">{count(result.totals.interrupted)} interrupted · {result.totals.maxVUs} users</span></div>
      </div>

      {#if result.thresholds.length}
        <section class="loadtest-section">
          <h2 class="loadtest-section-title">Pass criteria</h2>
          <div class="loadrun-table-wrap">
            <table class="loadrun-table">
              <thead><tr><th>Criterion</th><th>Limit</th><th>Actual</th><th>Result</th></tr></thead>
              <tbody>
                {#each result.thresholds as threshold (`${threshold.metric}|${threshold.stepId}|${threshold.expression}`)}
                  <tr class:bad={!threshold.ok}>
                    <td>{thresholdName(threshold.metric, threshold.stepId, threshold.expression)}</td>
                    <td class="num">{thresholdLimit(threshold.metric, threshold.stepId, threshold.expression)}</td>
                    <td class="num">{actual(threshold.metric, threshold.actual, threshold.hasActual)}</td>
                    <td>{threshold.ok ? 'Met' : 'Not met'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>
      {/if}

      <section class="loadtest-section">
        <h2 class="loadtest-section-title">By step</h2>
        <div class="loadrun-table-wrap">
          <table class="loadrun-table">
            <thead><tr><th>Step</th><th>Requests</th><th>Median</th><th>p95</th><th>p99</th><th>Failed</th><th>Checks</th></tr></thead>
            <tbody>
              {#each result.steps as step (step.stepId)}
                <tr class:bad={step.failedRate > 0}>
                  <td>{stepLabel(step.stepId)}</td>
                  <td class="num">{count(step.requests)}</td>
                  <td class="num">{step.requests ? ms(step.med) : '—'}</td>
                  <td class="num">{step.requests ? ms(step.p95) : '—'}</td>
                  <td class="num">{step.requests ? ms(step.p99) : '—'}</td>
                  <td class="num">{step.requests ? pct(step.failedRate) : '—'}</td>
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
    <section class="loadtest-section">
      <div class="loadtest-row loadrun-log-head">
        <h2 class="loadtest-section-title">k6 output</h2>
        <label class="check-label"><input class="check" type="checkbox" bind:checked={follow} />Follow</label>
      </div>
      <pre class="loadrun-log" bind:this={logBox} aria-label="k6 output">{logLines.join('\n')}</pre>
    </section>
  {/if}
</div>
