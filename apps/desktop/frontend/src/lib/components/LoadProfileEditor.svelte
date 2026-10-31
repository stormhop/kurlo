<script lang="ts">
  import {
    LOAD_PRESETS,
    matchingLoadPreset,
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
  import LoadShapeChart from './LoadShapeChart.svelte';
  import LoadValidationMessages from './LoadValidationMessages.svelte';

  let {
    draft = $bindable(),
    requests,
    disabled = false,
    problems = [],
  }: {
    draft: LoadTest;
    requests: SavedRequest[];
    disabled?: boolean;
    problems?: string[];
  } = $props();

  const MODELS: Array<{ value: LoadModel; label: string; hint: string }> = [
    { value: 'vus', label: 'Virtual users', hint: 'Users loop through the flow. If the server slows down, fewer requests go out.' },
    { value: 'rate', label: 'Iterations per second', hint: 'The flow starts at a fixed rate however slow the server gets; users are added to keep up.' },
  ];
  const METRICS = [
    { value: 'http_req_duration', label: 'Response time' },
    { value: 'http_req_failed', label: 'Failed requests' },
    { value: 'checks', label: 'Checks passed' },
  ];
  const DURATION_STATS = ['p(95)', 'p(99)', 'p(90)', 'med', 'avg', 'max', 'min'].map(value => ({ value, label: value === 'med' ? 'median' : value }));
  const OPS = ['<', '<=', '>', '>='].map(value => ({ value, label: value }));

  let highlightedStage = $state(-1);
  let target = $state(executorTarget(draft.scenarios[0]?.executor ?? { type: 'constant-vus' }));

  const executor = $derived<LoadExecutor>(draft.scenarios[0]?.executor ?? { type: 'constant-vus' });
  const model = $derived(executorModel(executor));
  const activePreset = $derived(matchingLoadPreset(executor));
  const amountProblem = $derived(model === 'rate' ? 'Set how many iterations start per second.' : 'Set the number of virtual users.');
  const ramping = $derived(executor.type.startsWith('ramping'));
  const unit = $derived(model === 'rate' ? 'iterations/s' : 'users');
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

  function presetShape(preset: LoadPreset) {
    return stagesToPolyline(presetExecutor(preset, model, target), 100, 22);
  }

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
    <div class="loadtest-section-head">
      <h2 class="loadtest-section-title">Start from a preset</h2>
      <span class="loadtest-hint loadtest-section-note">The shape scales from your normal load.</span>
      <label class="loadtest-target">
        <span class="loadtest-hint">Normal load</span>
        <input class="field field-mono loadtest-number" type="number" min="1" value={target} aria-label="Normal load" {disabled} oninput={(event) => (target = inputCount(event) || target)} />
        <span class="loadtest-hint">{unit}</span>
      </label>
    </div>
    <div class="loadtest-presets">
      {#each LOAD_PRESETS as preset (preset.id)}
        <button class="option-card loadtest-preset" class:active={activePreset === preset.id} aria-pressed={activePreset === preset.id} type="button" {disabled} onclick={() => applyPreset(preset.id)}>
          <svg class="loadtest-preset-shape" viewBox="-1 -1 102 24" preserveAspectRatio="none" aria-hidden="true"><polyline points={presetShape(preset.id)} /></svg>
          <strong>{preset.label}</strong>
          <span>{preset.hint}</span>
        </button>
      {/each}
      <div class="option-card loadtest-preset loadtest-preset-custom" class:active={!activePreset} aria-current={activePreset ? undefined : 'true'}>
        <svg class="loadtest-preset-shape" viewBox="-1 -1 102 24" preserveAspectRatio="none" aria-hidden="true"><polyline points={stagesToPolyline(executor, 100, 22)} /></svg>
        <strong>Custom</strong>
        <span>{activePreset ? 'change any value to make it your own' : 'your own settings, not a preset'}</span>
      </div>
    </div>
  </section>
  <section class="loadtest-section">
    <div class="loadtest-section-head">
      <h2 class="loadtest-section-title">Load</h2>
      <div class="segmented segmented-md loadtest-shape-switch" role="radiogroup" aria-label="Shape">
        <button class="segmented-item" type="button" role="radio" aria-checked={!ramping} {disabled} onclick={() => setShape(false)}>Constant</button>
        <button class="segmented-item" type="button" role="radio" aria-checked={ramping} {disabled} onclick={() => setShape(true)}>Stages</button>
      </div>
    </div>
    <div class="loadtest-models" role="radiogroup" aria-label="Load model">
      {#each MODELS as option (option.value)}
        <button class="option-card loadtest-model" class:active={model === option.value} type="button" role="radio" aria-checked={model === option.value} aria-label={option.label} {disabled} onclick={() => setModel(option.value)}>
          <span class="loadtest-radio-dot" aria-hidden="true"></span>
          <span class="loadtest-model-copy">
            <strong>{option.label}</strong>
            <span>{option.hint}</span>
          </span>
        </button>
      {/each}
    </div>
    <figure class="loadtest-card loadtest-preview">
      <figcaption class="loadtest-row">
        <span class="loadtest-label">{model === 'rate' ? 'Iterations per second over time' : 'Users over time'}</span>
        <span class="loadtest-hint">Peak {peak} {unit} · {formatDuration(totalMs)} total</span>
      </figcaption>
      <LoadShapeChart {executor} {unit} label={`Load over time, peak ${peak} ${unit} over ${formatDuration(totalMs)}`} highlight={highlightedStage} />
    </figure>
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
            {@const previous = index ? executor.stages?.[index - 1]?.target ?? 0 : 0}
            <div class="loadtest-stage" class:active={highlightedStage === index} role="row" tabindex="-1" onmouseenter={() => (highlightedStage = index)} onmouseleave={() => (highlightedStage = -1)} onfocusin={() => (highlightedStage = index)} onfocusout={() => (highlightedStage = -1)}>
              <span role="cell" class="loadtest-stage-name">{index + 1}<small>{previous} → {stage.target}</small></span>
              <span role="cell"><input class="field field-mono loadtest-duration" value={formatDuration(stage.durationMs)} aria-label={`Stage ${index + 1} duration`} aria-invalid={problems.includes(`Stage ${index + 1} needs a duration.`)} spellcheck="false" {disabled} onchange={(event) => durationInput(event, stage.durationMs, ms => (stage.durationMs = ms))} /></span>
              <span role="cell"><input class="field field-mono loadtest-number" type="number" min="0" value={stage.target} aria-label={`Stage ${index + 1} target`} {disabled} oninput={(event) => (stage.target = Math.max(0, Math.round(Number(inputValue(event)) || 0)))} /></span>
              <span role="cell"><button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label={`Remove stage ${index + 1}`} {disabled} onclick={() => removeStage(index)}>✕</button></span>
            </div>
            <LoadValidationMessages problems={problems.filter(problem => problem.startsWith(`Stage ${index + 1} `) || problem.startsWith(`Stage ${index + 1}:`))} />
          {/each}
        </div>
        <button class="btn btn-dashed btn-sm loadtest-inline-add" type="button" {disabled} onclick={addStage}>+ Add stage</button>
      {:else}
        <div class="loadtest-parameter-grid">
          <label class="loadtest-field">
            <span class="loadtest-label">{model === 'rate' ? 'Iterations per second' : 'Virtual users'}</span>
            <input class="field field-mono loadtest-number" type="number" min="1" value={model === 'rate' ? executor.rate ?? 0 : executor.vus ?? 0} aria-label={model === 'rate' ? 'Iterations per second' : 'Virtual users'} aria-invalid={problems.includes(amountProblem)} {disabled} oninput={(event) => setAmount(inputCount(event))} />
            <LoadValidationMessages problems={problems.filter(problem => problem === amountProblem)} />
          </label>
          <label class="loadtest-field">
            <span class="loadtest-label">Duration</span>
            <input class="field field-mono loadtest-duration" value={formatDuration(executor.durationMs ?? 0)} aria-label="Duration" aria-invalid={problems.includes('Set how long the test runs.')} spellcheck="false" {disabled} onchange={(event) => durationInput(event, executor.durationMs ?? 0, ms => (executor.durationMs = ms))} />
            <LoadValidationMessages problems={problems.filter(problem => problem === 'Set how long the test runs.')} />
          </label>
        </div>
      {/if}
      {#if model === 'rate'}
        <div class="loadtest-parameter-grid">
          <label class="loadtest-field">
            <span class="loadtest-label">Users prepared</span>
            <input class="field field-mono loadtest-number" type="number" min="1" value={executor.preAllocatedVUs ?? 0} aria-label="Users prepared" aria-invalid={problems.includes('Set how many virtual users to prepare.')} {disabled} oninput={(event) => setPool('preAllocatedVUs', inputCount(event))} />
            <LoadValidationMessages problems={problems.filter(problem => problem === 'Set how many virtual users to prepare.')} />
          </label>
          <label class="loadtest-field">
            <span class="loadtest-label">Users at most</span>
            <input class="field field-mono loadtest-number" type="number" min="1" value={executor.maxVUs ?? 0} aria-label="Users at most" aria-invalid={problems.includes('The virtual user limit is lower than the number prepared.')} {disabled} oninput={(event) => setPool('maxVUs', inputCount(event))} />
            <LoadValidationMessages problems={problems.filter(problem => problem === 'The virtual user limit is lower than the number prepared.')} />
          </label>
        </div>
      {/if}
      <LoadValidationMessages problems={problems.filter(problem => !problem.startsWith('Threshold ') && !problem.startsWith('Stage ') && ![amountProblem, 'Set how long the test runs.', 'Set how many virtual users to prepare.', 'The virtual user limit is lower than the number prepared.'].includes(problem))} />
    </div>
  </section>
  <section class="loadtest-section">
    <div class="loadtest-section-head">
      <h2 class="loadtest-section-title">Pass criteria</h2>
      <span class="loadtest-hint loadtest-section-note">The run fails if any of these is not met.</span>
    </div>
    {#each draft.thresholds ?? [] as threshold, index (index)}
      <div class="loadtest-threshold">
        <div class="loadtest-threshold-line">
          {#if !isRate(threshold)}
            <Select className="loadtest-stat" ariaLabel="Statistic" value={threshold.stat} options={DURATION_STATS} {disabled} onChange={(value) => (threshold.stat = value)} />
          {/if}
          <Select className="loadtest-metric" ariaLabel="Metric" value={threshold.metric} options={METRICS} {disabled} onChange={(value) => setMetric(threshold, value)} />
          <span class="loadtest-word">of</span>
          <Select className="loadtest-applies" ariaLabel="Applies to" value={threshold.step ?? ''} options={stepOptions} {disabled} onChange={(value) => setThresholdStep(threshold, value)} />
          <span class="loadtest-word">must be</span>
          <Select className="loadtest-op" ariaLabel="Comparison" value={threshold.op} options={OPS} {disabled} onChange={(value) => (threshold.op = value)} />
          <input class="field field-mono loadtest-number" type="number" min="0" step="any" value={thresholdValueText(threshold)} aria-label="Limit" aria-invalid={problems.includes(`Threshold ${index + 1}: the limit is out of range.`)} {disabled} oninput={(event) => setThresholdValue(threshold, inputValue(event))} />
          <span class="loadtest-word">{isRate(threshold) ? '%' : 'ms'}</span>
          <span class="loadtest-threshold-end">
            <label class="check-label">
              <input class="check" type="checkbox" checked={Boolean(threshold.abortOnFail)} {disabled} onchange={(event) => setAbort(threshold, event.currentTarget.checked)} />
              Stop the test early
            </label>
            <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Remove threshold" {disabled} onclick={() => removeThreshold(index)}>✕</button>
          </span>
        </div>
        <LoadValidationMessages problems={problems.filter(problem => problem.startsWith(`Threshold ${index + 1}:`) || problem.startsWith(`Threshold ${index + 1} `))} />
      </div>
    {/each}
    <button class="btn btn-dashed btn-sm loadtest-inline-add" type="button" {disabled} onclick={addThreshold}>+ Add threshold</button>
  </section>
</div>
