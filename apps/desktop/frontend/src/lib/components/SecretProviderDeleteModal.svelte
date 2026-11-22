<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import { trapFocus } from '../a11y';
  import { portal } from '../portal';
  import type { SecretProviderView } from '../wire';

  let {
    provider,
    busy = false,
    onDelete,
    onDismiss,
  }: {
    provider: SecretProviderView;
    busy?: boolean;
    onDelete: () => void;
    onDismiss: () => void;
  } = $props();

  const used = $derived(provider.usedBy.length);

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
    }
  }
</script>

<div class="dialog-backdrop" role="presentation" use:portal onmousedown={(event) => event.target === event.currentTarget && onDismiss()} onkeydown={onKeydown}>
  <div class="modal secret-delete-modal" role="dialog" aria-modal="true" aria-labelledby="secret-delete-title" aria-describedby="secret-delete-intro" tabindex="-1" use:trapFocus>
    <div class="modal-head dialog-head">
      <h2 class="modal-title" id="secret-delete-title">Delete “{provider.name || provider.id}”?</h2>
      <button type="button" class="btn btn-ghost btn-icon dialog-close" onclick={onDismiss} aria-label="Close dialog"><AddCloseIcon /></button>
    </div>
    <div class="secret-trust-body">
      <p id="secret-delete-intro">Kurlo removes it from <code>workspace.yml</code> and forgets its credentials on this device. Values stay in the secret manager.</p>
      {#if used}
        <div class="secret-banner secret-banner-warn">
          <MenuIcon name="warning" />
          <span>{used} linked {used === 1 ? 'variable stops' : 'variables stop'} working until you link {used === 1 ? 'it' : 'them'} to another provider.</span>
        </div>
      {/if}
    </div>
    <div class="modal-foot dialog-actions">
      <button class="btn btn-secondary btn-lg" type="button" onclick={onDismiss} disabled={busy} data-autofocus="">Cancel</button>
      <button class="btn btn-danger btn-lg" type="button" onclick={onDelete} disabled={busy}>{busy ? 'Deleting…' : 'Delete provider'}</button>
    </div>
  </div>
</div>
