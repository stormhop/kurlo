<script lang="ts">
  import { rem } from '../uiScale';
  import { vm } from '../stores/app.svelte';
  import { activeCount, guardTrailing, removeRow } from '../utils';
  import VariableInput from './VariableInput.svelte';
</script>

<div class="request-section-bar">
  <span class="request-section-title">Metadata</span>
  <span class="request-section-meta">{activeCount(vm.grpcMetadata)} custom</span>
</div>

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
  {#each vm.grpcMetadata as row, i (row.id)}
    <div class="kv-row" class:inactive-row={!row.enabled && (row.key || row.value || row.description)}>
      <input type="checkbox" class="check" bind:checked={row.enabled} aria-label="Enable" disabled={!row.key && !row.value} />
      <VariableInput className="field field-bare kv-input" bind:value={row.key} suggestions={vm.variableSuggestions} placeholder="Metadata key" oninput={() => guardTrailing(vm.grpcMetadata, i)} />
      <VariableInput className="field field-bare kv-input" bind:value={row.value} suggestions={vm.variableSuggestions} placeholder="Value" oninput={() => guardTrailing(vm.grpcMetadata, i)} />
      <input class="field field-bare kv-input kv-desc" bind:value={row.description} placeholder="Description" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} />
      <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => removeRow(vm.grpcMetadata, i)} aria-label="Remove">✕</button>
    </div>
  {/each}
</div>
