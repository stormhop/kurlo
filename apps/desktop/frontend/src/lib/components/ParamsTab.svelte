<script lang="ts">
  import { rem } from '../uiScale';
  import { vm } from '../stores/app.svelte';
  import { guardTrailing, removeRow, activeCount } from '../utils';
  import VariableInput from './VariableInput.svelte';
  import BulkEditPanel from './BulkEditPanel.svelte';
</script>

<div class="request-section-bar">
  <span class="request-section-title">Query params</span>
  <span class="request-section-meta">{activeCount(vm.params)} active</span>
  <button
    class="btn btn-secondary btn-xs bulk-edit-toggle"
    type="button"
    aria-pressed={vm.bulkEditTables.params}
    onclick={() => (vm.bulkEditTables.params = !vm.bulkEditTables.params)}
  >
    {vm.bulkEditTables.params ? 'Key-value edit' : 'Bulk edit'}
  </button>
</div>
{#if vm.bulkEditTables.params}
  <BulkEditPanel rows={vm.params} apply={(next) => { vm.params = next; vm.syncUrlFromParams(); }} />
{:else}
<div class="kv-table headers-kv-table" style="--kw: {rem(vm.kvKeyW)}; --vw: {rem(vm.kvValW)}">
  <div class="kv-head">
    <span></span>
    <span class="kv-head-cell">Key</span>
    <span class="kv-head-cell">Value</span>
    <span class="kv-head-cell">Description</span>
    <span></span>
  </div>
  <button class="kv-col-resizer kv-col-resizer--key" type="button" onmousedown={(e) => vm.startColResize('key', e)} aria-label="Resize key column"></button>
  <button class="kv-col-resizer kv-col-resizer--value" type="button" onmousedown={(e) => vm.startColResize('val', e)} aria-label="Resize value column"></button>
  {#each vm.params as row, i (row.id)}
    <div class="kv-row" data-testid="params-row" class:inactive-row={!row.enabled && (row.key || row.value || row.description)}>
      <input type="checkbox" class="check" bind:checked={row.enabled} onchange={() => vm.syncUrlFromParams()} aria-label="Enable" disabled={!row.key && !row.value} />
      <VariableInput className="field field-bare kv-input" bind:value={row.key} suggestions={vm.variableSuggestions} placeholder="Key" oninput={() => { guardTrailing(vm.params, i); vm.syncUrlFromParams(); }} />
      <VariableInput className="field field-bare kv-input" bind:value={row.value} suggestions={vm.variableSuggestions} placeholder="Value" oninput={() => { guardTrailing(vm.params, i); vm.syncUrlFromParams(); }} />
      <input class="field field-bare kv-input kv-desc" bind:value={row.description} placeholder="Description" />
      <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => { removeRow(vm.params, i); vm.syncUrlFromParams(); }} aria-label="Remove">✕</button>
    </div>
  {/each}
</div>
{/if}
{#if vm.pathParams.length && (vm.requestType === 'http' || vm.requestType === 'graphql')}
<section class="path-vars" aria-label="Path variables">
  <div class="request-section-bar">
    <span class="request-section-title">Path variables</span>
    <span class="request-section-meta">{vm.pathParams.filter(r => r.value).length} of {vm.pathParams.length} set</span>
  </div>
  <div class="kv-table headers-kv-table" style="--kw: {rem(vm.kvKeyW)}; --vw: {rem(vm.kvValW)}">
    <div class="kv-head">
      <span></span>
      <span class="kv-head-cell">Key</span>
      <span class="kv-head-cell">Value</span>
      <span class="kv-head-cell">Description</span>
      <span></span>
    </div>
    {#each vm.pathParams as row (row.id)}
      <div class="kv-row" data-testid="path-var-row">
        <span></span>
        <input class="field field-bare kv-input path-var-key" value={row.key} readonly tabindex="-1" aria-label="Path variable name" />
        <VariableInput className="field field-bare kv-input" bind:value={row.value} suggestions={vm.variableSuggestions} placeholder="Value" />
        <input class="field field-bare kv-input kv-desc" bind:value={row.description} placeholder="Description" />
        <span></span>
      </div>
    {/each}
  </div>
</section>
{/if}

<style>
  .path-vars {
    margin-top: var(--space-4);
  }
  .path-var-key {
    color: var(--text-2);
    cursor: default;
  }
</style>
