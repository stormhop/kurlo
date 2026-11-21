<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import SecretStatusPill from './SecretStatusPill.svelte';
  import SecretProviderForm from './SecretProviderForm.svelte';
  import AddSecretProviderModal from './AddSecretProviderModal.svelte';
  import SecretProviderTrustModal from './SecretProviderTrustModal.svelte';
  import { vm } from '../stores/app.svelte';
  import {
    checkAllSecretProviders, clearSecretValues, loadSecretProviders, secretProviders, selectSecretProvider, startSecretProviderDraft, trustProvider,
  } from '../stores/secretProviders.svelte';
  import { secretProviderState, secretProviderSummary, type SecretProviderType } from '../secretProviderTypes';
  import type { SecretProviderView } from '../wire';

  $effect(() => {
    const workspaceId = vm.activeWorkspaceId;
    if (workspaceId && secretProviders.workspaceId !== workspaceId) void loadSecretProviders(workspaceId, { check: true });
  });

  const selected = $derived(secretProviders.providers.find(provider => provider.id === secretProviders.selectedId));
  const trustTarget = $derived(secretProviders.providers.find(provider => provider.id === secretProviders.trustPromptId));
  let trustBusy = $state(false);
  let trustError = $state('');

  async function confirmTrust() {
    if (!trustTarget) return;
    trustBusy = true;
    trustError = await trustProvider(trustTarget.id);
    trustBusy = false;
  }

  function dismissTrust() {
    secretProviders.trustPromptId = '';
    trustError = '';
  }

  async function refreshSecrets() {
    await clearSecretValues();
    await checkAllSecretProviders();
  }

  function openEnvironment(environmentId: string) {
    vm.openEnvironment(environmentId);
  }

  function credentialNote(provider: SecretProviderView) {
    const status = secretProviders.statuses[provider.id];
    if (!provider.valid) return provider.problem ?? '';
    if (!provider.trusted) return provider.trustChanged ? 'Settings changed in workspace.yml' : 'Added from workspace.yml';
    if (status === 'checking') return 'Checking…';
    if (status && !status.ok) return status.message ?? '';
    if (status?.detail) return status.detail;
    if (status?.ok) return status.expiresInSeconds ? `Signed in · valid for ${Math.max(1, Math.round(status.expiresInSeconds / 3600))} h` : 'Signed in';
    return provider.savedCredentials.length ? 'Credentials saved on this device' : 'Not checked yet';
  }

  function usageNote(provider: SecretProviderView) {
    const usage = provider.usedBy ?? [];
    if (!usage.length) return 'Not used yet';
    const environments = [...new Set(usage.map(item => item.environmentName))];
    return `${usage.length} ${usage.length === 1 ? 'variable' : 'variables'} in ${environments.join(', ')}`;
  }
</script>

<section class="secret-workspace" aria-label="Secret providers">
  {#if secretProviders.draft}
    <SecretProviderForm type={secretProviders.draft.type} onOpenEnvironment={openEnvironment} />
  {:else if selected}
    <SecretProviderForm provider={selected} type={selected.type as SecretProviderType} onOpenEnvironment={openEnvironment} />
  {:else}
    <div class="secret-page-head">
      <div class="secret-page-title">
        <h1>Secret providers</h1>
        <p>Variables can take their values from Vault, 1Password and cloud secret stores. Provider settings live in <code>workspace.yml</code> and are shared through Git. Credentials and trust stay on this device.</p>
      </div>
      <div class="overview-actions">
        <button class="btn btn-secondary" type="button" onclick={refreshSecrets} disabled={!secretProviders.providers.length}><MenuIcon name="refresh" />Refresh secrets</button>
        <button class="btn btn-primary" type="button" onclick={() => (secretProviders.addOpen = true)}><AddCloseIcon add /> Add provider</button>
      </div>
    </div>
    {#if secretProviders.error}
      <div class="secret-banner secret-banner-error" role="alert"><MenuIcon name="warning" /><span>{secretProviders.error}</span></div>
    {/if}
    {#if secretProviders.providers.length}
      <div class="secret-provider-list">
        {#each secretProviders.providers as provider (provider.id)}
          {@const providerState = secretProviderState(provider, secretProviders.statuses[provider.id])}
          <div class="secret-provider-row">
            <button class="secret-provider-open" type="button" onclick={() => selectSecretProvider(provider.id)}>
              <ProviderLogo type={provider.type} size="lg" />
              <span class="secret-provider-main">
                <span class="secret-provider-name">{provider.name || provider.id} <SecretStatusPill state={providerState} /></span>
                <span class="secret-provider-desc">{secretProviderSummary(provider)}</span>
              </span>
              <span class="secret-provider-meta">
                <span>{credentialNote(provider)}</span>
                <small>{usageNote(provider)}</small>
              </span>
            </button>
            {#if providerState === 'untrusted' && provider.valid}
              <button class="btn btn-secondary btn-sm" type="button" onclick={() => (secretProviders.trustPromptId = provider.id)}><MenuIcon name="shield" />Review</button>
            {:else if providerState === 'signin' || providerState === 'nocli' || providerState === 'error'}
              <button class="btn btn-secondary btn-sm" type="button" onclick={() => selectSecretProvider(provider.id)}>{providerState === 'signin' ? 'Sign in' : 'Open'}</button>
            {/if}
          </div>
        {/each}
      </div>
      <div class="secret-info-cards">
        <div class="secret-info-card">
          <MenuIcon name="refresh" />
          <div>
            <div class="secret-info-title">In-memory cache</div>
            <p>{secretProviders.cachedValues} {secretProviders.cachedValues === 1 ? 'value' : 'values'} in memory. Nothing is written to disk. Values expire after each provider's cache time.</p>
            <button class="btn btn-secondary btn-sm" type="button" onclick={clearSecretValues}>Clear cache</button>
          </div>
        </div>
        <div class="secret-info-card">
          <MenuIcon name="lock" />
          <div>
            <div class="secret-info-title">Agent and MCP</div>
            <p>Requests sent by the agent use linked values and show them as <code>[secret]</code>. The agent cannot add or change providers or links.</p>
          </div>
        </div>
      </div>
    {:else if secretProviders.loaded}
      <div class="empty-state secret-empty">
        <MenuIcon name="key" />
        <span class="empty-state-title">No secret providers yet</span>
        <small class="empty-state-text">Link variables to Vault, 1Password, AWS, Google Cloud, Azure and more. Only references go into Git, values stay in memory.</small>
        <button class="btn btn-primary" type="button" onclick={() => (secretProviders.addOpen = true)}><AddCloseIcon add /> Add provider</button>
      </div>
    {/if}
  {/if}
  {#if secretProviders.notice}
    <div class="secret-toast" role="status">{secretProviders.notice}</div>
  {/if}
</section>

{#if secretProviders.addOpen}
  <AddSecretProviderModal onChoose={startSecretProviderDraft} onDismiss={() => (secretProviders.addOpen = false)} />
{/if}
{#if trustTarget}
  <SecretProviderTrustModal provider={trustTarget} busy={trustBusy} error={trustError} onTrust={confirmTrust} onDismiss={dismissTrust} />
{/if}
