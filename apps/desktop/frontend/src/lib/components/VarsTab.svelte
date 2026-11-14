<script lang="ts">
  import { rem } from '../uiScale';
  import { vm } from '../stores/app.svelte';
  import { activeCount, guardTrailing, removeRow } from '../utils';
  import { requestTypeSupportsAssertions } from '../assertions';
  import VariableInput from './VariableInput.svelte';

  let showPostResponse = $derived(requestTypeSupportsAssertions(vm.requestType) && vm.method !== 'SSE');
</script>

<div class="request-vars-heading">
  <span class="request-section-title">Pre Request</span>
  <span class="request-section-meta">{activeCount(vm.requestVars)} set before the request</span>
</div>

<div class="kv-table headers-kv-table request-vars-table" style="--kw: {rem(vm.kvKeyW)}; --vw: {rem(vm.kvValW)}">
  <div class="kv-head">
    <span></span>
    <span class="kv-head-cell">Name</span>
    <span class="kv-head-cell">Value</span>
    <span class="kv-head-cell">Description</span>
    <span></span>
  </div>
  <button class="kv-col-resizer kv-col-resizer--key" type="button" onmousedown={(e) => vm.startColResize('key', e)} aria-label="Resize name column"></button>
  <button class="kv-col-resizer kv-col-resizer--value" type="button" onmousedown={(e) => vm.startColResize('val', e)} aria-label="Resize value column"></button>
  {#each vm.requestVars as row, i (row.id)}
    <div class="kv-row" class:inactive-row={!row.enabled && (row.key || row.value || row.description)}>
      <input type="checkbox" class="check" bind:checked={row.enabled} aria-label="Enable variable" disabled={!row.key && !row.value} />
      <input class="field field-bare kv-input" bind:value={row.key} placeholder="userId" oninput={() => guardTrailing(vm.requestVars, i)} spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="none" />
      <VariableInput className="field field-bare kv-input" bind:value={row.value} suggestions={vm.variableSuggestions} placeholder="Value" oninput={() => guardTrailing(vm.requestVars, i)} />
      <input class="field field-bare kv-input kv-desc" bind:value={row.description} placeholder="Description" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} />
      <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => removeRow(vm.requestVars, i)} aria-label="Remove variable">✕</button>
    </div>
  {/each}
</div>

{#if showPostResponse}
  <div class="request-vars-heading request-vars-heading--next">
    <span class="request-section-title">Post Response</span>
    <span class="request-section-meta">{activeCount(vm.postResponseVars)} set from the response</span>
  </div>

  <div class="kv-table headers-kv-table request-vars-table" style="--kw: {rem(vm.kvKeyW)}; --vw: {rem(vm.kvValW)}">
    <div class="kv-head">
      <span></span>
      <span class="kv-head-cell">Name</span>
      <span class="kv-head-cell">Expression</span>
      <span class="kv-head-cell">Description</span>
      <span></span>
    </div>
    <button class="kv-col-resizer kv-col-resizer--key" type="button" onmousedown={(e) => vm.startColResize('key', e)} aria-label="Resize name column"></button>
    <button class="kv-col-resizer kv-col-resizer--value" type="button" onmousedown={(e) => vm.startColResize('val', e)} aria-label="Resize expression column"></button>
    {#each vm.postResponseVars as row, i (row.id)}
      <div class="kv-row" class:inactive-row={!row.enabled && (row.key || row.value || row.description)}>
        <input type="checkbox" class="check" bind:checked={row.enabled} aria-label="Enable variable" disabled={!row.key && !row.value} />
        <input class="field field-bare kv-input" bind:value={row.key} placeholder="token" oninput={() => guardTrailing(vm.postResponseVars, i)} spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="none" />
        <input class="field field-bare kv-input field-mono" bind:value={row.value} placeholder="res.body.token" oninput={() => guardTrailing(vm.postResponseVars, i)} spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="none" />
        <input class="field field-bare kv-input kv-desc" bind:value={row.description} placeholder="Description" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} />
        <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => removeRow(vm.postResponseVars, i)} aria-label="Remove variable">✕</button>
      </div>
    {/each}
  </div>
{/if}
