<script lang="ts">
  import Select from './Select.svelte';
  import { vm } from '../stores/app.svelte';

  let { disabled }: { disabled: boolean } = $props();
</script>

<div class="kafka-mode">
  <Select size="md" floating {disabled} ariaLabel="Kafka operation" bind:value={vm.kafka.mode}
    options={[{ value: 'produce', label: 'Produce' }, { value: 'consume', label: 'Consume' }]}
    onChange={() => { if (vm.requestTab === 'headers' && vm.kafka.mode === 'consume') vm.requestTab = 'body'; }} />
</div>

<style>
  .kafka-mode {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    height: 2.125rem;
    padding-inline: var(--space-1);
    border-right: 0.0625rem solid var(--border-subtle);
  }

  .kafka-mode :global(.app-select-trigger) {
    border-color: transparent;
    background: transparent;
    font-size: var(--text-label);
    font-weight: var(--weight-medium);
  }

  .kafka-mode :global(.app-select-trigger:hover:not(:disabled)) {
    background: var(--hover);
  }
</style>
