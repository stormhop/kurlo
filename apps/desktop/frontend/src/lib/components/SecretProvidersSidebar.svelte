<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import { vm } from '../stores/app.svelte';
  import { loadSecretProviders, secretProviders } from '../stores/secretProviders.svelte';
  import { SECRET_PROVIDER_STATE_LABELS, secretProviderState, secretProviderSummary } from '../secretProviderTypes';
  import { openAddSecretProvider, openSecretProviders } from '../secretProvidersNav';

  let { workspaceBlocked = false, active = false }: { workspaceBlocked?: boolean; active?: boolean } = $props();

  $effect(() => {
    const workspaceId = vm.activeWorkspaceId;
    if (workspaceId && !workspaceBlocked && secretProviders.workspaceId !== workspaceId) void loadSecretProviders(workspaceId);
  });
</script>

<div class="secret-sidebar">
  <div class="collections-head">
    <button class="secret-sidebar-title" type="button" class:active={active && !secretProviders.selectedId && !secretProviders.draft} onclick={() => openSecretProviders()} disabled={workspaceBlocked}>Secret providers</button>
    <div class="collections-head-actions">
      <button class="btn btn-ghost btn-icon btn-sm collection-add" type="button" onclick={openAddSecretProvider} aria-label="Add secret provider" disabled={workspaceBlocked}><AddCloseIcon add /></button>
    </div>
  </div>
  {#if secretProviders.providers.length}
    <div class="secret-sidebar-list">
      {#each secretProviders.providers as provider (provider.id)}
        {@const providerState = secretProviderState(provider, secretProviders.statuses[provider.id])}
        <button class="secret-sidebar-item" class:active={active && secretProviders.selectedId === provider.id} type="button" onclick={() => openSecretProviders(provider.id)} disabled={workspaceBlocked}>
          <ProviderLogo type={provider.type} size="sm" />
          <span class="secret-sidebar-text">
            <span>{provider.name || provider.id}</span>
            <small>{secretProviderSummary(provider)}</small>
          </span>
          <span class="secret-status-dot secret-status-{providerState}" role="img" aria-label={SECRET_PROVIDER_STATE_LABELS[providerState]}></span>
        </button>
      {/each}
    </div>
  {:else}
    <button class="secret-sidebar-empty" type="button" onclick={openAddSecretProvider} disabled={workspaceBlocked}>Link variables to Vault, 1Password, AWS and more</button>
  {/if}
</div>
