<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import Select from './Select.svelte';
  import VariableInput from './VariableInput.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import {
    ASSERTION_OPERATORS, ASSERTION_TARGET_SUGGESTIONS, MAX_ASSERTIONS,
    assertionNeedsValue, assertionOperatorOption, newAssertionRow,
    type AssertionOperator, type AssertionRow,
  } from '../assertions';

  const operatorOptions = ASSERTION_OPERATORS.map(option => ({ value: option.value, label: option.label }));

  const presets: { label: string; row: Partial<Omit<AssertionRow, 'id'>> }[] = [
    { label: 'Status is 200', row: { target: 'status', operator: 'eq', value: '200' } },
    { label: 'Status is 2xx', row: { target: 'status', operator: 'lt', value: '300' } },
    { label: 'Faster than 1 s', row: { target: 'responseTime', operator: 'lt', value: '1000' } },
    { label: 'JSON response', row: { target: 'header.Content-Type', operator: 'contains', value: 'application/json' } },
    { label: 'Field exists', row: { target: 'body.id', operator: 'exists', value: '' } },
  ];

  const full = $derived(vm.assertions.length >= MAX_ASSERTIONS);

  function add(row: Partial<Omit<AssertionRow, 'id'>> = {}) {
    if (full) return;
    vm.assertions = [...vm.assertions, newAssertionRow(row)];
  }

  function remove(id: number) {
    vm.assertions = vm.assertions.filter(row => row.id !== id);
  }

  function setOperator(row: AssertionRow, value: string) {
    row.operator = value as AssertionOperator;
    if (!assertionNeedsValue(row.operator)) row.value = '';
  }
</script>

<div class="assertions">
  <div class="script-ref">
    <span class="ref-title">Add</span>
    {#each presets as preset (preset.label)}
      <button class="btn btn-secondary btn-sm script-snippet" type="button" disabled={full} onclick={() => add(preset.row)}>{preset.label}</button>
    {/each}
  </div>
  {#if vm.assertions.length}
    <div class="assertions-table" role="table" aria-label="Assertions">
      <div class="assertions-row assertions-head" role="row">
        <span role="columnheader"><span class="sr-only">Enabled</span></span>
        <span class="kv-head-cell" role="columnheader">Target</span>
        <span class="kv-head-cell" role="columnheader">Check</span>
        <span class="kv-head-cell" role="columnheader">Expected</span>
        <span role="columnheader"><span class="sr-only">Remove</span></span>
      </div>
      {#each vm.assertions as row (row.id)}
        <div class="assertions-row" role="row" data-testid="assertion-row" class:inactive-row={!row.enabled}>
          <span role="cell"><input type="checkbox" class="check" bind:checked={row.enabled} aria-label="Enable assertion" /></span>
          <span role="cell">
            <VariableInput
              className="field field-bare kv-input"
              bind:value={row.target}
              suggestions={vm.variableSuggestions}
              placeholder="status, header.Name, body.path"
              ariaLabel="Assertion target"
              pickerOptions={ASSERTION_TARGET_SUGGESTIONS}
              pickerLabel="Targets"
            />
          </span>
          <span role="cell">
            <Select value={row.operator} options={operatorOptions} className="assertions-operator" ariaLabel="Assertion check" onChange={value => setOperator(row, value)} />
          </span>
          <span role="cell">
            {#if assertionNeedsValue(row.operator)}
              <VariableInput
                className="field field-bare kv-input"
                bind:value={row.value}
                suggestions={vm.variableSuggestions}
                placeholder={assertionOperatorOption(row.operator)?.placeholder ?? 'Value'}
                ariaLabel="Expected value"
              />
            {:else}
              <span class="assertions-no-value">—</span>
            {/if}
          </span>
          <span role="cell"><button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => remove(row.id)} aria-label="Remove assertion">✕</button></span>
        </div>
      {/each}
    </div>
  {:else}
    <p class="assertions-empty">Check the response without code: pick a target such as <code>status</code>, <code>header.Content-Type</code> or <code>body.data.id</code>, a check, and the expected value. Results appear with the tests.</p>
  {/if}
  <div class="assertions-actions">
    <button class="btn btn-secondary btn-sm" type="button" onclick={() => add()} disabled={full}><AddCloseIcon add /> Assertion</button>
    {#if full}<span class="assertions-limit">Up to {MAX_ASSERTIONS} assertions per request.</span>{/if}
  </div>
</div>

<style>
  .assertions {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .assertions-table,
  .assertions-empty,
  .assertions-actions {
    margin: 0 var(--space-4);
  }

  .assertions-table,
  .assertions-empty {
    margin-top: var(--space-1);
  }

  .assertions-actions {
    margin-bottom: var(--space-3);
  }

  .assertions-table {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: clip;
  }

  .assertions-row {
    display: grid;
    grid-template-columns: 2rem minmax(0, 1.3fr) minmax(9rem, 0.9fr) minmax(0, 1.3fr) 2rem;
    align-items: center;
    min-height: var(--control-md);
    border-top: 1px solid var(--border-subtle);
  }

  .assertions-row > span {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .assertions-row > span:first-child,
  .assertions-row > span:last-child {
    justify-content: center;
  }

  .assertions-row > span:not(:first-child):not(:last-child) > :global(*) {
    flex: 1 1 auto;
    min-width: 0;
  }

  .assertions-head {
    border-top: none;
    background: var(--surface);
  }

  .assertions-row :global(.assertions-operator) {
    width: 100%;
  }

  .assertions-row :global(.assertions-operator .app-select-trigger) {
    width: 100%;
    border-color: transparent;
    background: transparent;
  }

  .assertions-row :global(.assertions-operator .app-select-trigger:hover),
  .assertions-row :global(.assertions-operator.open .app-select-trigger) {
    background: var(--hover);
  }

  .assertions-row.inactive-row :global(.kv-input) {
    color: var(--text-3);
  }

  .assertions-no-value {
    padding: 0 var(--space-2);
    color: var(--text-3);
  }

  .assertions-empty {
    color: var(--text-2);
    font-size: var(--text-label);
    line-height: var(--leading-relaxed);
  }

  .assertions-empty code {
    font-family: var(--font-mono);
    font-size: var(--text-code);
  }

  .assertions-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .assertions-limit {
    color: var(--text-3);
    font-size: var(--text-caption);
  }
</style>
