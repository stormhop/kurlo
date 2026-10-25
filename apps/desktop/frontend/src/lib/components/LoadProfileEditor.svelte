<script lang="ts">
  import {
    LOAD_PRESETS,
    executorDurationMs,
    executorModel,
    executorPeak,
    executorTarget,
    formatDuration,
    parseDuration,
    presetExecutor,
    stagesToPolyline,
    switchExecutorModel,
    type LoadModel,
    type LoadPreset,
  } from '../loadPresets';
  import type { SavedRequest } from '../types/models';
  import { newEntityId, requestTabLabel } from '../utils';
  import type { LoadExecutor, LoadStage, LoadTest, LoadThreshold } from '../wire';
  import Select from './Select.svelte';

  let {
    draft = $bindable(),
    requests,
    disabled = false,
  }: {
    draft: LoadTest;
    requests: SavedRequest[];
    disabled?: boolean;
  } = $props();

  const PREVIEW_WIDTH = 600;
  const PREVIEW_HEIGHT = 160;
  const METRICS = [
    { value: 'http_req_duration', label: 'Response time' },
    { value: 'http_req_failed', label: 'Failed requests' },
    { value: 'checks', label: 'Checks passed' },
  ];
  const DURATION_STATS = ['p(95)', 'p(99)', 'p(90)', 'med', 'avg', 'max', 'min'].map(value => ({ value, label: value === 'med' ? 'median' : value }));
  const OPS = ['<', '<=', '>', '>='].map(value => ({ value, label: value }));

  let target = $state(executorTarget(draft.scenarios[0]?.executor ?? { type: 'constant-vus' }));

  const executor = $derived<LoadExecutor>(draft.scenarios[0]?.executor ?? { type: 'constant-vus' });
  const model = $derived(executorModel(executor));
  const ramping = $derived(executor.type.startsWith('ramping'));
  const unit = $derived(model === 'rate' ? 'iterations/s' : 'users');
  const polyline = $derived(stagesToPolyline(executor, PREVIEW_WIDTH, PREVIEW_HEIGHT));
  const peak = $derived(executorPeak(executor));
  const totalMs = $derived(executorDurationMs(executor));
  const steps = $derived(draft.scenarios[0]?.steps ?? []);
  const stepOptions = $derived([
    { value: '', label: 'All steps' },
    ...steps.map((step, index) => {
      const request = requests.find(candidate => candidate.id === step.requestId);
      return { value: step.id, label: `${index + 1} · ${request ? requestTabLabel(request) : 'Missing request'}` };
    }),
  ]);

  function setExecutor(next: LoadExecutor) {
    if (!draft.scenarios.length) {
      draft.scenarios = [{ id: newEntityId('scenario'), name: 'Flow', executor: next, steps: [] }];
      return;
    }
    draft.scenarios[0].executor = next;
  }

  function applyPreset(preset: LoadPreset) {
    setExecutor(presetExecutor(preset, model, target));
  }

  function setModel(next: LoadModel) {
    setExecutor(switchExecutorModel(executor, next));
  }

  function setShape(nextRamping: boolean) {
    if (nextRamping === ramping) return;
    const amount = executorPeak(executor) || target;
    const duration = executorDurationMs(executor) || 60000;
    const pool = model === 'rate' ? { preAllocatedVUs: executor.preAllocatedVUs || 10, maxVUs: executor.maxVUs || 50 } : {};
    if (nextRamping) {
      const stages: LoadStage[] = [
        { durationMs: Math.min(60000, duration), target: amount },
        { durationMs: duration, target: amount },
        { durationMs: Math.min(30000, duration), target: 0 },
      ];
      setExecutor({ type: model === 'rate' ? 'ramping-arrival-rate' : 'ramping-vus', stages, ...pool });
    } else {
      setExecutor(model === 'rate'
        ? { type: 'constant-arrival-rate', rate: amount, durationMs: duration, ...pool }
        : { type: 'constant-vus', vus: amount, durationMs: duration });
    }
  }

  function inputValue(event: Event): string {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : '';
  }

  function inputCount(event: Event): number {
    const value = Math.round(Number(inputValue(event)));
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function durationInput(event: Event, current: number, apply: (ms: number) => void) {
    const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : null;
    const ms = parseDuration(inputValue(event));
    if (ms === null || ms <= 0) {
      if (input) input.value = formatDuration(current);
      return;
    }
    apply(ms);
    if (input) input.value = formatDuration(ms);
  }

  function setAmount(value: number) {
    if (model === 'rate') executor.rate = value;
    else executor.vus = value;
  }

  function setPool(key: 'preAllocatedVUs' | 'maxVUs', value: number) {
    if (value) executor[key] = value;
    else delete executor[key];
  }

  function addStage() {
    const last = executor.stages?.at(-1);
    executor.stages = [...(executor.stages ?? []), { durationMs: 60000, target: last?.target ?? target }];
  }

  function removeStage(index: number) {
    executor.stages = (executor.stages ?? []).filter((_, i) => i !== index);
  }

  function isRate(threshold: LoadThreshold) {
    return threshold.metric !== 'http_req_duration';
  }

  function thresholdValueText(threshold: LoadThreshold) {
    return isRate(threshold) ? String(Math.round(threshold.value * 10000) / 100) : String(threshold.value);
  }

  function setThresholdValue(threshold: LoadThreshold, text: string) {
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) return;
    threshold.value = isRate(threshold) ? value / 100 : value;
  }

  function setMetric(threshold: LoadThreshold, metric: string) {
    if (metric === threshold.metric) return;
    threshold.metric = metric;
    if (metric === 'http_req_duration') {
      threshold.stat = 'p(95)';
      threshold.op = '<';
      threshold.value = 500;
    } else {
      threshold.stat = 'rate';
      threshold.op = metric === 'checks' ? '>' : '<';
      threshold.value = metric === 'checks' ? 0.99 : 0.01;
    }
  }

  function setThresholdStep(threshold: LoadThreshold, step: string) {
    if (step) threshold.step = step;
    else delete threshold.step;
  }

  function setAbort(threshold: LoadThreshold, abort: boolean) {
    if (abort) threshold.abortOnFail = true;
    else delete threshold.abortOnFail;
  }

  function addThreshold() {
    draft.thresholds = [...(draft.thresholds ?? []), { metric: 'http_req_duration', stat: 'p(95)', op: '<', value: 500 }];
  }

  function removeThreshold(index: number) {
    draft.thresholds = (draft.thresholds ?? []).filter((_, i) => i !== index);
  }
</script>

<div class="loadtest-profile">
  <section class="loadtest-section">
    <h2 class="loadtest-section-title">Start from a preset</h2>
    <div class="loadtest-presets">
      {#each LOAD_PRESETS as preset (preset.id)}
        <button class="option-card loadtest-preset" type="button" {disabled} onclick={() => applyPreset(preset.id)}>
          <strong>{preset.label}</strong>
          <span>{preset.hint}</span>
        </button>
      {/each}
      <label class="loadtest-target">
        <span class="loadtest-label">Normal load</span>
        <span class="loadtest-row">
          <input class="field field-mono loadtest-number" type="number" min="1" value={target} aria-label="Normal load" {disabled} oninput={(event) => (target = inputCount(event) || target)} />
          <span class="loadtest-hint">{unit}</span>
        </span>
      </label>
    </div>
  </section>

  <section class="loadtest-section">
    <h2 class="loadtest-section-title">Load</h2>
    <div class="loadtest-row loadtest-model-row">
      <div class="segmented segmented-md" role="radiogroup" aria-label="Load model">
        <button class="segmented-item" type="button" role="radio" aria-checked={model === 'vus'} {disabled} onclick={() => setModel('vus')}>Virtual users</button>
        <button class="segmented-item" type="button" role="radio" aria-checked={model === 'rate'} {disabled} onclick={() => setModel('rate')}>Iterations per second</button>
      </div>
      <div class="segmented segmented-md" role="radiogroup" aria-label="Shape">
        <button class="segmented-item" type="button" role="radio" aria-checked={!ramping} {disabled} onclick={() => setShape(false)}>Constant</button>
        <button class="segmented-item" type="button" role="radio" aria-checked={ramping} {disabled} onclick={() => setShape(true)}>Stages</button>
      </div>
    </div>
    <p class="loadtest-hint">
      {model === 'vus'
        ? 'Virtual users loop through the flow. If the server slows down, fewer requests go out.'
        : 'The flow starts at a fixed rate however slow the server gets; extra users are added to keep up.'}
    </p>

    <div class="loadtest-load-grid">
      <div class="loadtest-card">
        {#if ramping}
          <div class="loadtest-stages" role="table" aria-label="Stages">
            <div class="loadtest-stage loadtest-stage-head" role="row">
              <span role="columnheader">Stage</span>
              <span role="columnheader">Duration</span>
              <span role="columnheader">Target {unit}</span>
              <span role="columnheader"></span>
            </div>
            {#each executor.stages ?? [] as stage, index (index)}
              <div class="loadtest-stage" role="row">
                <span role="cell">{index + 1}</span>
                <span role="cell"><input class="field field-mono loadtest-duration" value={formatDuration(stage.durationMs)} aria-label={`Stage ${index + 1} duration`} spellcheck="false" {disabled} onchange={(event) => durationInput(event, stage.durationMs, ms => (stage.durationMs = ms))} /></span>
                <span role="cell"><input class="field field-mono loadtest-number" type="number" min="0" value={stage.target} aria-label={`Stage ${index + 1} target`} {disabled} oninput={(event) => (stage.target = Math.max(0, Math.round(Number(inputValue(event)) || 0)))} /></span>
                <span role="cell"><button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label={`Remove stage ${index + 1}`} {disabled} onclick={() => removeStage(index)}>✕</button></span>
              </div>
            {/each}
          </div>
          <button class="btn btn-dashed btn-sm loadtest-inline-add" type="button" {disabled} onclick={addStage}>+ Add stage</button>
        {:else}
          <div class="loadtest-row">
            <label class="loadtest-field">
              <span class="loadtest-label">{model === 'rate' ? 'Iterations per second' : 'Virtual users'}</span>
              <input class="field field-mono loadtest-number" type="number" min="1" value={model === 'rate' ? executor.rate ?? 0 : executor.vus ?? 0} {disabled} oninput={(event) => setAmount(inputCount(event))} />
            </label>
            <label class="loadtest-field">
              <span class="loadtest-label">Duration</span>
              <input class="field field-mono loadtest-duration" value={formatDuration(executor.durationMs ?? 0)} spellcheck="false" {disabled} onchange={(event) => durationInput(event, executor.durationMs ?? 0, ms => (executor.durationMs = ms))} />
            </label>
          </div>
        {/if}
        {#if model === 'rate'}
          <div class="loadtest-row">
            <label class="loadtest-field">
              <span class="loadtest-label">Users prepared</span>
              <input class="field field-mono loadtest-number" type="number" min="1" value={executor.preAllocatedVUs ?? 0} {disabled} oninput={(event) => setPool('preAllocatedVUs', inputCount(event))} />
            </label>
            <label class="loadtest-field">
              <span class="loadtest-label">Users at most</span>
              <input class="field field-mono loadtest-number" type="number" min="1" value={executor.maxVUs ?? 0} {disabled} oninput={(event) => setPool('maxVUs', inputCount(event))} />
            </label>
          </div>
        {/if}
      </div>

      <figure class="loadtest-card loadtest-preview">
        <figcaption class="loadtest-row">
          <span class="loadtest-label">Preview</span>
          <span class="loadtest-hint">Peak {peak} {unit} · {formatDuration(totalMs)} total</span>
        </figcaption>
        <svg viewBox={`-2 -6 ${PREVIEW_WIDTH + 4} ${PREVIEW_HEIGHT + 12}`} role="img" aria-label={`Load over time, peak ${peak} ${unit} over ${formatDuration(totalMs)}`} preserveAspectRatio="none">
          <line x1="0" y1={PREVIEW_HEIGHT} x2={PREVIEW_WIDTH} y2={PREVIEW_HEIGHT} class="loadtest-axis" />
          <polygon points={`0,${PREVIEW_HEIGHT} ${polyline} ${PREVIEW_WIDTH},${PREVIEW_HEIGHT}`} class="loadtest-area" />
          <polyline points={polyline} class="loadtest-line" />
        </svg>
      </figure>
    </div>
  </section>

  <section class="loadtest-section">
    <h2 class="loadtest-section-title">Pass criteria</h2>
    <p class="loadtest-hint">If any of these is not met, the run fails.</p>
    {#each draft.thresholds ?? [] as threshold, index (index)}
      <div class="loadtest-row loadtest-threshold">
        <Select ariaLabel="Metric" value={threshold.metric} options={METRICS} {disabled} onChange={(value) => setMetric(threshold, value)} />
        {#if !isRate(threshold)}
          <Select ariaLabel="Statistic" value={threshold.stat} options={DURATION_STATS} {disabled} onChange={(value) => (threshold.stat = value)} />
        {/if}
        <Select className="loadtest-op" ariaLabel="Comparison" value={threshold.op} options={OPS} {disabled} onChange={(value) => (threshold.op = value)} />
        <input class="field field-mono loadtest-number" type="number" min="0" step="any" value={thresholdValueText(threshold)} aria-label="Limit" {disabled} oninput={(event) => setThresholdValue(threshold, inputValue(event))} />
        <span class="loadtest-hint">{isRate(threshold) ? '%' : 'ms'}</span>
        <Select ariaLabel="Applies to" value={threshold.step ?? ''} options={stepOptions} {disabled} onChange={(value) => setThresholdStep(threshold, value)} />
        <label class="check-label">
          <input class="check" type="checkbox" checked={Boolean(threshold.abortOnFail)} {disabled} onchange={(event) => setAbort(threshold, event.currentTarget.checked)} />
          Stop the test early
        </label>
        <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Remove threshold" {disabled} onclick={() => removeThreshold(index)}>✕</button>
      </div>
    {/each}
    <button class="btn btn-dashed btn-sm loadtest-inline-add" type="button" {disabled} onclick={addThreshold}>+ Add threshold</button>
  </section>
</div>
