<script lang="ts">
  import LoadValidationMessages from './LoadValidationMessages.svelte';
  import { formatDuration, parseDuration } from '../loadPresets';
  import type { LoadDataPreview, LoadTest } from '../wire';

  let {
    draft = $bindable(),
    disabled = false,
    problems = [],
    onChoose,
    onPreview,
  }: {
    draft: LoadTest;
    disabled?: boolean;
    problems?: string[];
    onChoose: () => Promise<LoadDataPreview | null>;
    onPreview: (path: string) => Promise<LoadDataPreview>;
  } = $props();

  const MODES = [
    { value: 'per-vu', label: 'One row per user', hint: 'Each virtual user keeps its own row, for example its own login.' },
    { value: 'per-iteration', label: 'Next row each iteration', hint: 'Every run of the flow takes the next row, across all users.' },
    { value: 'random', label: 'Random row', hint: 'Every run of the flow takes a random row.' },
  ];

  let preview = $state<LoadDataPreview | null>(null);
  let loading = $state(false);
  let choosing = $state(false);
  let selectionError = $state('');
  let request = 0;

  const dataPath = $derived(draft.data?.path.trim() ?? '');

  $effect(() => {
    const path = dataPath;
    const current = ++request;
    preview = null;
    selectionError = '';
    loading = Boolean(path);
    if (!path) return;
    const timer = setTimeout(() => {
      void onPreview(path).then(result => {
        if (current !== request) return;
        preview = result;
        loading = false;
      }).catch(() => {
        if (current !== request) return;
        selectionError = 'Could not read the test data file.';
        loading = false;
      });
    }, 300);
    return () => { clearTimeout(timer); request++; };
  });

  async function choose() {
    choosing = true;
    selectionError = '';
    try {
      const selected = await onChoose();
      if (!selected) return;
      if (selected.error) selectionError = selected.error;
      else {
        request++;
        setPath(selected.path);
        preview = selected;
        loading = false;
      }
    } catch {
      selectionError = 'Could not open the test data file.';
    } finally {
      choosing = false;
    }
  }

  const mode = $derived(draft.data?.mode ?? 'per-vu');

  function inputValue(event: Event): string {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : '';
  }

  function setPath(path: string) {
    if (!path.trim()) {
      delete draft.data;
      return;
    }
    draft.data = { path, mode };
  }

  function setMode(next: string) {
    if (draft.data) draft.data = { ...draft.data, mode: next };
  }

  function setRequestTimeout(event: Event) {
    const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : null;
    const text = inputValue(event).trim();
    const ms = text ? parseDuration(text) : 0;
    if (ms === null) {
      if (input) input.value = draft.settings.timeoutMs ? formatDuration(draft.settings.timeoutMs) : '';
      return;
    }
    const settings = { ...draft.settings };
    delete settings.timeoutMs;
    draft.settings = ms > 0 ? { ...settings, timeoutMs: ms } : settings;
    if (input) input.value = ms > 0 ? formatDuration(ms) : '';
  }

  function setInsecure(insecure: boolean) {
    const settings = { ...draft.settings };
    delete settings.insecure;
    draft.settings = insecure ? { ...settings, insecure: true } : settings;
  }
</script>

<div class="loadtest-data">
  <section class="loadtest-section">
    <h2 class="loadtest-section-title">Test data</h2>
    <p class="loadtest-hint">A CSV or JSON file in the workspace folder. Each column becomes a variable, so <code>{'{{'}email{'}}'}</code> in a request takes the value from the row.</p>
    <div class="loadtest-row loadtest-data-file">
    <label class="loadtest-field">
      <span class="loadtest-label">File</span>
      <input class="field field-mono loadtest-path" value={draft.data?.path ?? ''} placeholder="data/users.csv" aria-invalid={problems.some(problem => !problem.includes('timeout')) || Boolean(selectionError || preview?.error)} spellcheck="false" {disabled} oninput={(event) => setPath(inputValue(event))} />
    </label>
    <button class="btn btn-secondary" type="button" disabled={disabled || choosing} onclick={choose}>{choosing ? 'Opening…' : 'Choose file…'}</button>
    </div>
    <LoadValidationMessages problems={problems.filter(problem => !problem.includes('timeout'))} />
    {#if loading}<p class="loadtest-hint" role="status">Reading test data…</p>{/if}
    {#if selectionError || preview?.error}<p class="k6-export-error" role="alert">{selectionError || preview?.error}</p>{/if}
    {#if preview && !preview.error}
      <p class="loadtest-hint" role="status">{preview.total} rows · showing first {preview.rows.length}</p>
      <div class="loadrun-table-wrap loadtest-data-preview">
        <table class="loadrun-table" aria-label="Test data preview">
          <thead><tr>{#each preview.columns as column (column)}<th>{column}</th>{/each}</tr></thead>
          <tbody>{#each preview.rows as row, index (index)}<tr>{#each preview.columns as column, columnIndex (column)}<td title={row[columnIndex] ?? ''}>{row[columnIndex] ?? ''}</td>{/each}</tr>{/each}</tbody>
        </table>
      </div>
    {/if}
    {#if draft.data}
      <div class="loadtest-field">
        <span class="loadtest-label">Rows</span>
        <div class="segmented segmented-md" role="radiogroup" aria-label="Rows">
          {#each MODES as option (option.value)}
            <button class="segmented-item" type="button" role="radio" aria-checked={mode === option.value} {disabled} onclick={() => setMode(option.value)}>{option.label}</button>
          {/each}
        </div>
        <span class="loadtest-hint">{MODES.find(option => option.value === mode)?.hint ?? ''}</span>
      </div>
    {/if}
  </section>

  <section class="loadtest-section">
    <h2 class="loadtest-section-title">Request options</h2>
    <label class="loadtest-field">
      <span class="loadtest-label">Timeout per request</span>
      <input class="field field-mono loadtest-duration" value={draft.settings.timeoutMs ? formatDuration(draft.settings.timeoutMs) : ''} placeholder="60s" aria-invalid={problems.some(problem => problem.includes('timeout'))} spellcheck="false" {disabled} onchange={setRequestTimeout} />
    </label>
    <LoadValidationMessages problems={problems.filter(problem => problem.includes('timeout'))} />
    <label class="check-label">
      <input class="check" type="checkbox" checked={Boolean(draft.settings.insecure)} {disabled} onchange={(event) => setInsecure(event.currentTarget.checked)} />
      Skip TLS certificate checks
    </label>
  </section>
</div>
