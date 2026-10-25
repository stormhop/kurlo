<script lang="ts">
  import { formatDuration, parseDuration } from '../loadPresets';
  import type { LoadTest } from '../wire';

  let {
    draft = $bindable(),
    disabled = false,
  }: {
    draft: LoadTest;
    disabled?: boolean;
  } = $props();

  const MODES = [
    { value: 'per-vu', label: 'One row per user', hint: 'Each virtual user keeps its own row, for example its own login.' },
    { value: 'per-iteration', label: 'Next row each iteration', hint: 'Every run of the flow takes the next row, across all users.' },
    { value: 'random', label: 'Random row', hint: 'Every run of the flow takes a random row.' },
  ];

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
    <label class="loadtest-field">
      <span class="loadtest-label">File</span>
      <input class="field field-mono loadtest-path" value={draft.data?.path ?? ''} placeholder="data/users.csv" spellcheck="false" {disabled} oninput={(event) => setPath(inputValue(event))} />
    </label>
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
      <input class="field field-mono loadtest-duration" value={draft.settings.timeoutMs ? formatDuration(draft.settings.timeoutMs) : ''} placeholder="60s" spellcheck="false" {disabled} onchange={setRequestTimeout} />
    </label>
    <label class="check-label">
      <input class="check" type="checkbox" checked={Boolean(draft.settings.insecure)} {disabled} onchange={(event) => setInsecure(event.currentTarget.checked)} />
      Skip TLS certificate checks
    </label>
  </section>
</div>
