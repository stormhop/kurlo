<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import { trapFocus } from '../a11y';
  import { portal } from '../portal';
  import { exportSecretProviderEnv, previewSecretProviderEnv } from '../secretProvidersBackend';
  import { showSecretNotice } from '../stores/secretProviders.svelte';
  import type { SecretEnvExportResult, SecretProviderView } from '../wire';

  let {
    workspaceId,
    provider,
    onDismiss,
  }: {
    workspaceId: string;
    provider: SecretProviderView;
    onDismiss: () => void;
  } = $props();

  let preview = $state<SecretEnvExportResult | null>(null);
  let busy = $state(false);
  let error = $state('');

  $effect(() => {
    const id = provider.id;
    void previewSecretProviderEnv(workspaceId, id).then(result => { preview = result; });
  });

  const missing = $derived(preview?.variables.filter(variable => !variable.saved && variable.credential !== 'sessionToken') ?? []);
  const saved = $derived(preview?.variables.filter(variable => variable.saved) ?? []);

  async function save() {
    busy = true;
    error = '';
    const result = await exportSecretProviderEnv(workspaceId, provider.id);
    busy = false;
    if (result.error) {
      error = result.error;
      return;
    }
    if (result.path) {
      showSecretNotice(`Saved ${result.path}`);
      onDismiss();
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
    }
  }
</script>

<div class="dialog-backdrop" role="presentation" use:portal onmousedown={(event) => event.target === event.currentTarget && onDismiss()} onkeydown={onKeydown}>
  <div class="modal secret-trust-modal" role="dialog" aria-modal="true" aria-labelledby="secret-env-title" aria-describedby="secret-env-intro" tabindex="-1" use:trapFocus>
    <div class="modal-head dialog-head">
      <h2 class="modal-title" id="secret-env-title">Export credentials for CI</h2>
      <button type="button" class="btn btn-ghost btn-icon dialog-close" onclick={onDismiss} aria-label="Close dialog"><AddCloseIcon /></button>
    </div>
    <div class="secret-trust-body">
      {#if !preview}
        <p id="secret-env-intro">Reading the credentials of {provider.name || provider.id}…</p>
      {:else if !preview.ok}
        <p id="secret-env-intro">{preview.error}</p>
      {:else}
        <p id="secret-env-intro"><code>kurlo run</code> and <code>kurlo load run</code> read these variables from the environment of the CI job. Add each one as a CI secret, or load the file before the run.</p>
        <div class="secret-trust-config" aria-label="Variables in the file">
          <div class="secret-trust-config-head">{provider.id}.ci.env</div>
          {#each preview.variables as variable (variable.name)}
            <div class="secret-trust-config-row"><span>{variable.name}</span><span>{variable.saved ? 'saved on this device' : variable.credential === 'sessionToken' ? 'not saved · left out' : 'not saved · left empty'}</span></div>
          {/each}
        </div>
        {#if saved.length}
          <div class="secret-banner secret-banner-warn">
            <MenuIcon name="warning" />
            <span>The file holds {saved.length === 1 ? 'this credential' : 'these credentials'} in plain text. Keep it out of Git and delete it once the CI secrets are set.</span>
          </div>
        {/if}
        {#if missing.length}
          <p class="secret-env-note">Fill in {missing.map(variable => variable.name).join(', ')} yourself: {missing.length === 1 ? 'it is' : 'they are'} not saved in Kurlo on this device.</p>
        {/if}
      {/if}
      {#if error}<div class="secret-banner secret-banner-error" role="alert"><MenuIcon name="warning" /><span>{error}</span></div>{/if}
    </div>
    <div class="modal-foot dialog-actions">
      <button class="btn btn-secondary btn-lg" type="button" onclick={onDismiss} disabled={busy}>Cancel</button>
      <button class="btn btn-primary btn-lg" type="button" onclick={save} disabled={busy || !preview?.ok} data-autofocus=""><MenuIcon name="export" />{busy ? 'Saving…' : 'Save .env file'}</button>
    </div>
  </div>
</div>
