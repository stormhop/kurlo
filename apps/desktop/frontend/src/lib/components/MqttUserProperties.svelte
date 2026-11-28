<script lang="ts">
  import type { MqttProperty } from '../mqtt';
  import { vm } from '../stores/app.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import VariableInput from './VariableInput.svelte';

  let { rows = $bindable(), label = 'User properties' }: { rows: MqttProperty[]; label?: string } = $props();

  function add() {
    rows = [...rows, { key: '', value: '', enabled: true }];
  }
</script>

<div class="user-props" role="group" aria-label={label}>
  {#if rows.length}
    <div class="prop-row prop-head" aria-hidden="true"><span></span><span>Key</span><span>Value</span><span></span></div>
    {#each rows as row, i (i)}
      <div class="prop-row">
        <input class="check" type="checkbox" aria-label="Send this property" bind:checked={row.enabled} />
        <VariableInput ariaLabel={label + ' key ' + (i + 1)} className="field field-md" bind:value={row.key} suggestions={vm.variableSuggestions} placeholder="Key" />
        <VariableInput ariaLabel={label + ' value ' + (i + 1)} className="field field-md" bind:value={row.value} suggestions={vm.variableSuggestions} placeholder="Value" />
        <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Remove property" onclick={() => rows = rows.filter((_, j) => j !== i)}><AddCloseIcon /></button>
      </div>
    {/each}
  {/if}
  <button class="btn btn-ghost btn-sm add-prop" type="button" onclick={add}>Add user property</button>
</div>

<style>
  .user-props { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
  .prop-row { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr) minmax(0, 1.5fr) 1.75rem; align-items: center; gap: var(--space-2); }
  .prop-head { color: var(--text-3); font-size: var(--text-micro); font-weight: var(--weight-medium); }
  .add-prop { align-self: flex-start; }
</style>
