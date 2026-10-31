<script lang="ts">
  import { loadStepErrors, loadExtractErrors, loadCheckErrors, loadStepStructuralErrors } from '../loadFlowErrors';
  import { formatDuration, parseDuration } from '../loadPresets';
  import { loadTestStep } from '../stores/features/loadTests';
  import type { SavedRequest } from '../types/models';
  import { methodColor, newEntityId, requestTabLabel } from '../utils';
  import type { LoadCheck, LoadExtract, LoadStep, LoadTest } from '../wire';
  import Select from './Select.svelte';
  import LoadValidationMessages from './LoadValidationMessages.svelte';

  let {
    draft = $bindable(),
    requests,
    disabled = false,
    problems = [],
    onOpenRequest,
  }: {
    draft: LoadTest;
    requests: SavedRequest[];
    disabled?: boolean;
    problems?: string[];
    onOpenRequest: (requestId: string) => void;
  } = $props();

  const EXTRACT_SOURCES = [
    { value: 'json', label: 'JSON path' },
    { value: 'header', label: 'Header' },
    { value: 'regex', label: 'Regex' },
  ];
  const EMPTY_FLOW_PROBLEM = 'Add at least one request to the flow.';
  const CHECK_TYPES = [
    { value: 'status', label: 'Status is' },
    { value: 'jsonExists', label: 'JSON field exists' },
    { value: 'bodyContains', label: 'Body contains' },
  ];

  let selectedStepId = $state('');
  let addMenuOpen = $state(false);
  let picked = $state<string[]>([]);
  let requestMenuStepId = $state('');

  const steps = $derived(draft.scenarios[0]?.steps ?? []);
  const selectedIndex = $derived(steps.findIndex(step => step.id === selectedStepId));
  const selected = $derived(selectedIndex >= 0 ? steps[selectedIndex] : undefined);
  const selectedProblems = $derived(loadStepErrors(problems, selectedIndex));

  $effect(() => {
    if (selectedIndex < 0 && steps.length) selectedStepId = steps[0].id;
  });

  $effect(() => {
    if (disabled || !steps.some(step => step.id === requestMenuStepId)) requestMenuStepId = '';
  });

  function fitRequestMenu(menu: HTMLDivElement) {
    const container = menu.parentElement;
    const trigger = container?.querySelector<HTMLButtonElement>('[data-request-picker-trigger]') ?? container?.querySelector('button');
    if (!container || !trigger) return;

    function fit() {
      if (!container || !trigger) return;
      const anchor = trigger.getBoundingClientRect();
      const parent = container.getBoundingClientRect();
      let top = 0;
      let bottom = window.innerHeight;
      let left = 0;
      let right = window.innerWidth;
      let ancestor = container.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        const bounds = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
        ancestor = ancestor.parentElement;
      }
      const gap = 4;
      const margin = 8;
      const below = Math.max(0, bottom - anchor.bottom - gap - margin);
      const above = Math.max(0, anchor.top - top - gap - margin);
      const upwards = menu.scrollHeight > below && above > below;
      menu.style.top = upwards ? 'auto' : `${anchor.bottom - parent.top + gap}px`;
      menu.style.bottom = upwards ? `${parent.bottom - anchor.top + gap}px` : 'auto';
      menu.style.maxHeight = `${Math.min(320, upwards ? above : below)}px`;
      menu.style.maxWidth = `${Math.max(0, right - Math.max(left, parent.left) - margin)}px`;
    }

    function onScroll(event: Event) {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      fit();
    }

    fit();
    window.addEventListener('resize', fit);
    document.addEventListener('scroll', onScroll, true);
    return {
      destroy() {
        window.removeEventListener('resize', fit);
        document.removeEventListener('scroll', onScroll, true);
      },
    };
  }

  function closeRequestMenu(event: PointerEvent) {
    if (!(event.target instanceof Element) || !event.target.closest('.loadtest-step')) requestMenuStepId = '';
    if (!(event.target instanceof Element) || !event.target.closest('.loadtest-add')) addMenuOpen = false;
  }

  function selectStep(step: LoadStep) {
    selectedStepId = step.id;
    addMenuOpen = false;
    requestMenuStepId = '';
  }

  function toggleRequestMenu(step: LoadStep) {
    selectedStepId = step.id;
    addMenuOpen = false;
    requestMenuStepId = requestMenuStepId === step.id ? '' : step.id;
  }

  function replaceRequest(step: LoadStep, requestId: string) {
    step.requestId = requestId;
    requestMenuStepId = '';
  }

  function requestFor(step: LoadStep) {
    return requests.find(request => request.id === step.requestId);
  }

  function methodOf(request: SavedRequest | undefined) {
    if (!request) return '?';
    return request.requestType === 'graphql' ? 'GQL' : request.method;
  }

  function hasScript(request: SavedRequest | undefined) {
    if (!request) return false;
    return [request.preRequestScript, request.testScript, request.preRequestScriptJs, request.testScriptJs]
      .some(script => Boolean(script?.trim()));
  }

  function ensureScenario() {
    if (!draft.scenarios.length) {
      draft.scenarios = [{ id: newEntityId('scenario'), name: 'Flow', executor: { type: 'constant-vus', vus: 2, durationMs: 60000 }, steps: [] }];
    }
    return draft.scenarios[0];
  }

  function addStep(requestId: string) {
    addMenuOpen = false;
    requestMenuStepId = '';
    const step = loadTestStep(requestId);
    ensureScenario().steps.push(step);
    selectedStepId = step.id;
  }

  function partial(input: HTMLInputElement, value: boolean) {
    input.indeterminate = value;
    return { update(next: boolean) { input.indeterminate = next; } };
  }

  function togglePick(requestId: string) {
    picked = picked.includes(requestId) ? picked.filter(id => id !== requestId) : [...picked, requestId];
  }

  function togglePickAll() {
    picked = picked.length === requests.length ? [] : [...picked, ...requests.map(request => request.id).filter(id => !picked.includes(id))];
  }

  function addPicked() {
    addMenuOpen = false;
    requestMenuStepId = '';
    const scenario = ensureScenario();
    const added = picked.filter(id => requests.some(request => request.id === id)).map(id => loadTestStep(id));
    scenario.steps.push(...added);
    selectedStepId = added[0]?.id ?? selectedStepId;
    picked = [];
  }

  function moveStep(index: number, offset: number) {
    requestMenuStepId = '';
    const list = ensureScenario().steps;
    const target = index + offset;
    if (target < 0 || target >= list.length) return;
    const [step] = list.splice(index, 1);
    list.splice(target, 0, step);
  }

  function removeStep(index: number) {
    const list = ensureScenario().steps;
    const [removed] = list.splice(index, 1);
    if (removed && draft.thresholds) draft.thresholds = draft.thresholds.filter(threshold => threshold.step !== removed.id);
    if (removed?.id === selectedStepId) selectedStepId = list[Math.min(index, list.length - 1)]?.id ?? '';
  }

  function waitLabel(step: LoadStep): string {
    if (!step.thinkTimeMs && !step.thinkJitterMs) return '';
    return `wait ${formatDuration(step.thinkTimeMs ?? 0)}${step.thinkJitterMs ? ` ± ${formatDuration(step.thinkJitterMs)}` : ''}`;
  }

  function savedNames(step: LoadStep): string[] {
    return (step.extract ?? []).map(extract => extract.var || '?');
  }

  function usedNames(index: number): string[] {
    const request = requestFor(steps[index]);
    if (!request) return [];
    const earlier = new Set(steps.slice(0, index).flatMap(step => (step.extract ?? []).map(extract => extract.var).filter(Boolean)));
    if (!earlier.size) return [];
    const text = JSON.stringify(request);
    return [...earlier].filter(name => text.includes(`{{${name}}}`));
  }

  function phaseStarts(index: number): boolean {
    return index === 0 || Boolean(steps[index - 1].once) !== Boolean(steps[index].once);
  }

  function checkLabel(check: LoadCheck): string {
    if (check.type === 'status') return `status ${check.value || '?'}`;
    if (check.type === 'jsonExists') return `${check.path || '$'} exists`;
    return `body has “${check.value ?? ''}”`;
  }

  function inputValue(event: Event): string {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : '';
  }

  function setDuration(step: LoadStep, key: 'thinkTimeMs' | 'thinkJitterMs', event: Event) {
    const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : null;
    const ms = parseDuration(inputValue(event));
    if (ms === null) {
      if (input) input.value = formatDuration(step[key] ?? 0);
      return;
    }
    if (ms > 0) step[key] = ms;
    else delete step[key];
    if (input) input.value = formatDuration(ms);
  }

  function setOnce(step: LoadStep, once: boolean) {
    if (once) step.once = true;
    else delete step.once;
  }

  function addExtract(step: LoadStep) {
    const extract: LoadExtract = { var: '', from: 'json', path: '$.' };
    step.extract = [...(step.extract ?? []), extract];
  }

  function removeExtract(step: LoadStep, index: number) {
    step.extract = (step.extract ?? []).filter((_, i) => i !== index);
  }

  function addCheck(step: LoadStep) {
    step.checks = [...(step.checks ?? []), { type: 'status', value: '200' }];
  }

  function removeCheck(step: LoadStep, index: number) {
    step.checks = (step.checks ?? []).filter((_, i) => i !== index);
  }

  function setCheckType(check: LoadCheck, type: string) {
    check.type = type;
    delete check.path;
    delete check.value;
    if (type === 'status') check.value = '200';
    if (type === 'jsonExists') check.path = '$.';
  }

  function setCheckInput(check: LoadCheck, value: string) {
    if (check.type === 'jsonExists') check.path = value;
    else check.value = value;
  }
</script>

<svelte:window onpointerdown={closeRequestMenu} onkeydown={(event) => {
  if (event.key === 'Escape' && (requestMenuStepId || addMenuOpen)) {
    event.preventDefault();
    event.stopPropagation();
    requestMenuStepId = '';
    addMenuOpen = false;
  }
}} />

<div class="loadtest-flow" class:empty={!steps.length}>
  <div class="loadtest-steps">
    {#if steps.length}<p class="loadtest-hint">Every virtual user runs these steps top to bottom, again and again — with the collection's defaults, auth and the chosen environment.</p>{/if}
    {#if steps.length}
      <div class="loadtest-step-list" role="group" aria-label="Steps">
        {#each steps as step, index (step.id)}
          {@const request = requestFor(step)}
          {@const saved = savedNames(step)}
          {@const used = usedNames(index)}
          {@const wait = waitLabel(step)}
          {@const checks = step.checks ?? []}
          {#if phaseStarts(index)}
            <div class="loadtest-phase" class:loadtest-phase-setup={step.once}>{step.once ? 'Setup · once per user' : 'Every iteration'}</div>
          {/if}
          <div class="loadtest-step" class:selected={step.id === selectedStepId} class:first={index === 0} class:last={index === steps.length - 1} onfocusout={(event) => {
              if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) requestMenuStepId = '';
          }}>
            <span class="loadtest-step-rail" aria-hidden="true"><span class="loadtest-step-index" class:once={step.once}>{index + 1}</span></span>
            <div class="loadtest-step-body">
              <div class="loadtest-step-picker">
                <div class="loadtest-step-card">
                  <button
                    class:loadtest-invalid={problems.some(problem => problem.startsWith(`Step ${index + 1}:`) || problem.startsWith(`Step ${index + 1} `))}
                    class="option-card loadtest-step-main"
                    type="button"
                    aria-pressed={step.id === selectedStepId}
                    class:active={step.id === selectedStepId}
                    {disabled}
                    onclick={() => selectStep(step)}
                  >
                    <span class="loadtest-step-line">
                      <span class="loadtest-step-method {methodColor(methodOf(request))}">{methodOf(request)}</span>
                      <span class="loadtest-step-name">{request ? requestTabLabel(request) : 'Missing request'}</span>
                    </span>
                    {#if saved.length || used.length || checks.length || hasScript(request)}
                      <span class="loadtest-step-summary">
                        {#if used.length}<span class="loadtest-chip">uses {used.join(', ')}</span>{/if}
                        {#if saved.length}<span class="loadtest-chip loadtest-chip-accent">saves {saved.join(', ')}</span>{/if}
                        {#if checks.length}<span class="loadtest-chip" title={checks.map(checkLabel).join(' · ')}>{checks.length === 1 ? checkLabel(checks[0]) : `${checks.length} checks`}</span>{/if}
                        {#if hasScript(request)}<span class="loadtest-chip loadtest-chip-warning" title="Pre-request and test scripts are not run in load tests">scripts not run</span>{/if}
                      </span>
                    {/if}
                    {#if wait}<span class="loadtest-step-wait">{wait}</span>{/if}
                  </button>
                  <div class="loadtest-step-actions">
                    <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label={`Replace request for step ${index + 1}`} title="Replace request" aria-haspopup="listbox" aria-expanded={requestMenuStepId === step.id} data-request-picker-trigger {disabled} onclick={() => toggleRequestMenu(step)}>
                      <svg width="1rem" height="1rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 5h10m-3-3 3 3-3 3M13 11H3m3-3-3 3 3 3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" /></svg>
                    </button>
                    <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Move step up" title="Move up" disabled={disabled || index === 0} onclick={() => moveStep(index, -1)}>↑</button>
                    <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Move step down" title="Move down" disabled={disabled || index === steps.length - 1} onclick={() => moveStep(index, 1)}>↓</button>
                    <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Remove step" title="Remove" {disabled} onclick={() => removeStep(index)}>✕</button>
                  </div>
                </div>
                <LoadValidationMessages problems={loadStepStructuralErrors(loadStepErrors(problems, index))} />
              </div>
              {#if requestMenuStepId === step.id}
                <div class="menu loadtest-request-menu" use:fitRequestMenu role="listbox" aria-label="Replace request">
                  {#each requests as candidate (candidate.id)}
                    <button class="menu-item" class:active={candidate.id === step.requestId} type="button" role="option" aria-selected={candidate.id === step.requestId} onmousedown={(event) => event.preventDefault()} onclick={() => replaceRequest(step, candidate.id)}>
                      <span class="loadtest-step-method {methodColor(methodOf(candidate))}">{methodOf(candidate)}</span>
                      <span>{requestTabLabel(candidate)}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <section class="loadtest-start" aria-label="Build the flow">
        <header class="loadtest-start-head">
          <h2>Choose the requests a user makes</h2>
          <p>Every virtual user runs them top to bottom, again and again, with the collection's defaults, auth and the chosen environment. Tick them in the order they should run — you can reorder them later.</p>
        </header>
        {#if requests.length}
          <div class="loadtest-start-toolbar">
            <label class="check-label">
              <input class="check" type="checkbox" checked={picked.length === requests.length} use:partial={picked.length > 0 && picked.length < requests.length} {disabled} onchange={togglePickAll} />
              Select all {requests.length}
            </label>
            <span class="loadtest-hint">{picked.length ? `${picked.length} selected` : 'Nothing selected yet'}</span>
          </div>
          <div class="loadtest-start-list" role="group" aria-label="Requests in this collection">
            {#each requests as request (request.id)}
              {@const order = picked.indexOf(request.id)}
              <label class="loadtest-start-item" class:picked={order >= 0}>
                <input class="check" type="checkbox" checked={order >= 0} {disabled} aria-label={`Add ${requestTabLabel(request)}`} onchange={() => togglePick(request.id)} />
                <span class="loadtest-start-order" aria-hidden="true">{order >= 0 ? order + 1 : ''}</span>
                <span class="loadtest-step-method {methodColor(methodOf(request))}">{methodOf(request)}</span>
                <span class="loadtest-start-name">
                  <span>{requestTabLabel(request)}</span>
                  {#if request.folderPath?.length}<small>{request.folderPath.join(' / ')}</small>{/if}
                </span>
                <code class="loadtest-start-url" title={request.url}>{request.url}</code>
              </label>
            {/each}
          </div>
          <footer class="loadtest-start-foot">
            <button class="btn btn-primary" type="button" disabled={disabled || !picked.length} onclick={addPicked}>{picked.length ? `Add ${picked.length} ${picked.length === 1 ? 'request' : 'requests'} to the flow` : 'Add requests to the flow'}</button>
          </footer>
        {:else}
          <p class="loadtest-start-none">This collection has no HTTP or GraphQL requests yet. Add one to the collection, then come back.</p>
        {/if}
      </section>
    {/if}
    {#if steps.length}<LoadValidationMessages problems={problems.filter(problem => !problem.startsWith('Step ') && problem !== EMPTY_FLOW_PROBLEM)} />{/if}
    <div class="loadtest-add" class:hidden={!steps.length}>
      <button class="btn btn-dashed loadtest-add-button" type="button" aria-expanded={addMenuOpen} disabled={disabled || !requests.length} onclick={() => { requestMenuStepId = ''; addMenuOpen = !addMenuOpen; }}>+ Add request from collection</button>
      {#if addMenuOpen}
        <div class="menu loadtest-add-menu" use:fitRequestMenu role="menu" aria-label="Requests">
          {#each requests as request (request.id)}
            <button class="menu-item" type="button" role="menuitem" onclick={() => addStep(request.id)}>
              <span class="loadtest-step-method {methodColor(methodOf(request))}">{methodOf(request)}</span>{requestTabLabel(request)}
            </button>
          {/each}
        </div>
      {/if}
      {#if !requests.length}<span class="loadtest-hint">This collection has no HTTP or GraphQL requests.</span>{/if}
    </div>
  </div>
  {#if selected}
    {@const step = selected}
    {@const request = requestFor(step)}
    <aside class="loadtest-inspector" aria-label="Step settings">
      <div class="loadtest-inspector-head">
        <span class="loadtest-step-index active" aria-hidden="true">{selectedIndex + 1}</span>
        <div class="loadtest-inspector-title">
          <h2>Step {selectedIndex + 1}</h2>
          <span>{request ? requestTabLabel(request) : 'Missing request'}</span>
        </div>
        {#if request}<button class="btn-link" type="button" onclick={() => onOpenRequest(step.requestId)}>Open request</button>{/if}
      </div>
      <div class="loadtest-field">
        <span class="loadtest-inspector-label">Run</span>
        <div class="segmented loadtest-run-switch" role="radiogroup" aria-label="Run">
          <button class="segmented-item" type="button" role="radio" aria-checked={!step.once} {disabled} onclick={() => setOnce(step, false)}>Every iteration</button>
          <button class="segmented-item" type="button" role="radio" aria-checked={Boolean(step.once)} {disabled} onclick={() => setOnce(step, true)}>Once per user</button>
        </div>
      </div>
      <section class="loadtest-field">
        <div class="loadtest-inspector-label-row">
          <span class="loadtest-inspector-label">Save from response</span>
          <span class="loadtest-hint">later steps use it as <code>{'{{'}name{'}}'}</code></span>
        </div>
        {#each step.extract ?? [] as extract, index (index)}
          {@const errors = loadExtractErrors(selectedProblems, extract)}
          <div class="loadtest-rule">
            <div class="loadtest-rule-line loadtest-extract-line">
              <input class="field field-mono loadtest-var" value={extract.var} placeholder="token" aria-label="Variable name" aria-invalid={errors.name.length > 0} spellcheck="false" {disabled} oninput={(event) => (extract.var = inputValue(event))} />
              <Select className="loadtest-source" ariaLabel="Source" value={extract.from} options={EXTRACT_SOURCES} {disabled} onChange={(value) => (extract.from = value)} />
              <input class="field field-mono loadtest-grow" value={extract.path} placeholder={extract.from === 'header' ? 'X-Request-Id' : extract.from === 'regex' ? 'id=(\\w+)' : '$.access_token'} aria-label="Path" aria-invalid={errors.path.length > 0} spellcheck="false" {disabled} oninput={(event) => (extract.path = inputValue(event))} />
              <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Remove saved value" {disabled} onclick={() => removeExtract(step, index)}>✕</button>
            </div>
            <LoadValidationMessages problems={[...errors.name, ...errors.path, ...errors.source]} />
          </div>
        {/each}
        <button class="btn-link loadtest-inline-add" type="button" {disabled} onclick={() => addExtract(step)}>+ Save a value</button>
      </section>
      <section class="loadtest-field">
        <div class="loadtest-inspector-label-row">
          <span class="loadtest-inspector-label">Checks</span>
          <span class="loadtest-hint">a failed check does not stop the test; it lowers the share of passed checks</span>
        </div>
        {#each step.checks ?? [] as check, index (index)}
          {@const errors = loadCheckErrors(selectedProblems, check)}
          <div class="loadtest-rule">
            <div class="loadtest-rule-line loadtest-check-line">
              <Select className="loadtest-check-type" ariaLabel="Check" value={check.type} options={CHECK_TYPES} {disabled} onChange={(value) => setCheckType(check, value)} />
              <input class="field field-mono loadtest-grow" value={check.type === 'jsonExists' ? check.path ?? '' : check.value ?? ''} aria-label="Expected value" aria-invalid={errors.length > 0} spellcheck="false" {disabled} oninput={(event) => setCheckInput(check, inputValue(event))} />
              <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Remove check" {disabled} onclick={() => removeCheck(step, index)}>✕</button>
            </div>
            <LoadValidationMessages problems={errors} />
          </div>
        {/each}
        <button class="btn-link loadtest-inline-add" type="button" {disabled} onclick={() => addCheck(step)}>+ Add check</button>
      </section>
      <div class="loadtest-field">
        <span class="loadtest-inspector-label">Wait after this step</span>
        <div class="loadtest-row">
          <input class="field field-mono loadtest-duration" value={formatDuration(step.thinkTimeMs ?? 0)} aria-label="Wait" aria-invalid={(step.thinkTimeMs ?? 0) < 0} spellcheck="false" {disabled} onchange={(event) => setDuration(step, 'thinkTimeMs', event)} />
          <span class="loadtest-hint">plus up to</span>
          <input class="field field-mono loadtest-duration" value={formatDuration(step.thinkJitterMs ?? 0)} aria-label="Random extra wait" aria-invalid={(step.thinkJitterMs ?? 0) < 0} spellcheck="false" {disabled} onchange={(event) => setDuration(step, 'thinkJitterMs', event)} />
          <span class="loadtest-hint">at random</span>
        </div>
        <LoadValidationMessages problems={selectedProblems.filter(problem => problem.includes('wait after the step'))} />
      </div>
    </aside>
  {/if}
</div>
