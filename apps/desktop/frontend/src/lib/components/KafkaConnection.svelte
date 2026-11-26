<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import { kafkaDiscovery } from '../stores/kafka.svelte';
  import BirdSpinner from './BirdSpinner.svelte';

  let { disabled = false }: { disabled?: boolean } = $props();
  let generation = 0;
  $effect(() => {
    vm.activeRequestId;
    vm.url;
    vm.activeEnvironmentId;
    vm.kafka.tls;
    vm.kafka.mechanism;
    vm.authType;
    vm.basicUser;
    vm.basicPass;
    vm.bearerToken;
    generation++;
    Object.assign(kafkaDiscovery, { topics: [], busy: false, tested: false, error: '' });
    return () => { generation++; };
  });

  async function inspect() {
    const token = ++generation;
    kafkaDiscovery.busy = true;
    kafkaDiscovery.error = '';
    try {
      const snapshot = vm.snapshotActiveRequest();
      const env = vm.activeEnvironmentValues();
      const req = await vm.ensureValidOAuth2TokenForRequest(snapshot, env);
      const wire = vm.savedRequestToRunnableHttpRequest(req, env, undefined, undefined, req.id, { deferTemplates: true });
      const bridge = window.go?.api?.App;
      if (!bridge?.ListKafkaTopics) throw new Error('Kafka connections require the desktop app');
      const topics = await bridge.ListKafkaTopics(wire);
      if (generation === token) Object.assign(kafkaDiscovery, { topics, tested: true });
    } catch (error) {
      if (generation === token) Object.assign(kafkaDiscovery, { topics: [], tested: false, error: String(error) });
    } finally {
      if (generation === token) kafkaDiscovery.busy = false;
    }
  }

  let state = $derived(kafkaDiscovery.busy ? 'busy' : kafkaDiscovery.tested ? 'ok' : kafkaDiscovery.error ? 'failed' : 'idle');
  let label = $derived(state === 'busy' ? 'Connecting…' : state === 'ok' ? 'Connected' : state === 'failed' ? 'Retry connection' : 'Test connection');
</script>

<div class="kafka-connection">
  <button type="button" class="btn btn-ghost btn-sm connection connection--{state}" disabled={disabled || !vm.url.trim() || kafkaDiscovery.busy} onclick={inspect}>
    {#if state === 'busy'}<BirdSpinner tone="current" />{:else if state !== 'idle'}<span class="connection-dot" aria-hidden="true"></span>{/if}
    {label}
  </button>
</div>

<style>
  .kafka-connection {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    height: 2.125rem;
    padding-inline: var(--space-1);
  }

  .connection {
    gap: var(--space-1-5);
    white-space: nowrap;
  }

  .connection-dot {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 50%;
    background: currentColor;
  }

  .connection--ok { color: var(--success); }
  .connection--failed { color: var(--danger); }
</style>
