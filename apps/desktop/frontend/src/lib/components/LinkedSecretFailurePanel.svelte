<script lang="ts">
  import MenuIcon from './MenuIcon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import { vm } from '../stores/app.svelte';
  import { checkAllSecretProviders, clearSecretValues, loadSecretProviders, secretProviders } from '../stores/secretProviders.svelte';
  import { openSecretProviderTrust, openSecretProviders } from '../secretProvidersNav';
  import { secretKindAction } from '../secretProviderTypes';
  import { effectiveEnvironmentRows } from '../environmentInheritance';
  import { linkedSecretRef } from '../linkedSecrets';
  import type { LinkedSecretFailure } from '../wire';

  let { failures, onRetry }: { failures: LinkedSecretFailure[]; onRetry: () => void } = $props();

  $effect(() => {
    const workspaceId = vm.activeWorkspaceId;
    if (workspaceId && secretProviders.workspaceId !== workspaceId) void loadSecretProviders(workspaceId);
  });

  function variablesFor(failure: LinkedSecretFailure) {
    const environment = vm.activeEnvironment;
    if (!environment) return [];
    const keys: string[] = [];
    for (const [key, { row }] of effectiveEnvironmentRows(vm.environments, environment.id)) {
      const ref = linkedSecretRef(row);
      if (ref && ref.provider === failure.provider && ref.path === failure.path && (ref.field ?? '') === (failure.field ?? '') && (ref.version ?? '') === (failure.version ?? '')) keys.push(key);
    }
    return keys;
  }

  function providerFor(failure: LinkedSecretFailure) {
    return secretProviders.providers.find(provider => provider.id === failure.provider);
  }

  async function retry() {
    await clearSecretValues();
    void checkAllSecretProviders();
    onRetry();
  }

  function openEnvironment() {
    if (vm.activeEnvironmentId) vm.openEnvironment(vm.activeEnvironmentId);
  }
</script>

<div class="secret-failure-panel" role="alert">
  <div class="secret-failure-head">
    <span class="secret-failure-icon"><MenuIcon name="warning" /></span>
    <span class="secret-failure-title">Request not sent</span>
    <span class="secret-failure-sub">{failures.length === 1 ? 'A linked variable could not be resolved.' : `${failures.length} linked variables could not be resolved.`}</span>
  </div>
  <div class="secret-failure-list">
    {#each failures as failure, index (index)}
      {@const provider = providerFor(failure)}
      {@const keys = variablesFor(failure)}
      {@const action = secretKindAction(failure.kind)}
      <div class="secret-failure-row">
        <ProviderLogo type={provider?.type ?? ''} size="lg" />
        <div class="secret-failure-text">
          <div class="secret-failure-ref">
            {#if keys.length}<strong>{keys.join(', ')}</strong>{/if}
            <span>{failure.provider}:{failure.path}{failure.field ? `#${failure.field}` : ''}</span>
          </div>
          <div class="secret-failure-message">{failure.message}</div>
        </div>
        <div class="secret-failure-actions">
          {#if action === 'trust' && provider}
            <button class="btn btn-primary btn-sm" type="button" onclick={() => openSecretProviderTrust(failure.provider)}><MenuIcon name="shield" />Review</button>
          {:else if action === 'signin' || action === 'install' || action === 'open'}
            <button class="btn btn-primary btn-sm" type="button" onclick={() => openSecretProviders(provider ? failure.provider : '')}>{action === 'signin' ? 'Sign in' : action === 'install' ? 'How to fix' : 'Open provider'}</button>
          {:else if action === 'edit'}
            <button class="btn btn-secondary btn-sm" type="button" onclick={openEnvironment} disabled={!vm.activeEnvironmentId}>Edit link</button>
          {/if}
          <button class="btn btn-ghost btn-sm" type="button" onclick={retry}><MenuIcon name="refresh" />Retry</button>
        </div>
      </div>
    {/each}
  </div>
  <span class="secret-failure-note">Kurlo never sends a request with an empty secret.</span>
</div>
