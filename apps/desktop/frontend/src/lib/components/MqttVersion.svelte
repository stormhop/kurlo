<script lang="ts">
  import Select from './Select.svelte';
  import { vm } from '../stores/app.svelte';
  import { MQTT_VERSIONS } from '../mqtt';

  let { disabled }: { disabled: boolean } = $props();
</script>

<div class="mqtt-version">
  <Select size="md" floating {disabled} ariaLabel="MQTT version" bind:value={vm.mqtt.version}
    options={MQTT_VERSIONS.map(value => ({ value, label: 'MQTT ' + value }))} />
</div>

<style>
  .mqtt-version {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    height: 2.125rem;
    padding-inline: var(--space-1);
    border-right: 0.0625rem solid var(--border-subtle);
  }

  .mqtt-version :global(.app-select-trigger) {
    border-color: transparent;
    background: transparent;
    font-size: var(--text-label);
    font-weight: var(--weight-medium);
  }

  .mqtt-version :global(.app-select-trigger:hover:not(:disabled)) {
    background: var(--hover);
  }
</style>
