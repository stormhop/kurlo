<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import { trapFocus } from '../a11y';
  import { SECRET_PROVIDER_TYPES, type SecretProviderType } from '../secretProviderTypes';

  let { onChoose, onDismiss }: { onChoose: (type: SecretProviderType) => void; onDismiss: () => void } = $props();
  let selected = $state<SecretProviderType>('vault');

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
    }
  }
</script>

<div class="dialog-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onDismiss()} onkeydown={onKeydown}>
  <div class="modal secret-add-modal" role="dialog" aria-modal="true" aria-labelledby="secret-add-title" tabindex="-1" use:trapFocus>
    <div class="modal-head dialog-head">
      <div>
        <h2 class="modal-title" id="secret-add-title">Add a secret provider</h2>
        <p class="secret-modal-sub">Choose where the values live. You link variables to it in an environment.</p>
      </div>
      <button type="button" class="btn btn-ghost btn-icon dialog-close" onclick={onDismiss} aria-label="Close dialog"><AddCloseIcon /></button>
    </div>
    <div class="secret-type-grid" role="radiogroup" aria-label="Provider type">
      {#each SECRET_PROVIDER_TYPES as item (item.type)}
        <button class="secret-type-tile" class:active={selected === item.type} type="button" role="radio" aria-checked={selected === item.type} onclick={() => (selected = item.type)} ondblclick={() => onChoose(item.type)} data-autofocus={item.type === 'vault' ? '' : undefined}>
          <ProviderLogo type={item.type} size="lg" />
          <span class="secret-type-text">
            <span class="secret-type-name">{item.name}</span>
            <span class="secret-type-desc">{item.description}</span>
          </span>
        </button>
      {/each}
    </div>
    <p class="secret-modal-note">Kurlo talks to each service over its API or its official CLI. No credentials go into workspace.yml.</p>
    <div class="modal-foot dialog-actions">
      <button class="btn btn-secondary btn-lg" type="button" onclick={onDismiss}>Cancel</button>
      <button class="btn btn-primary btn-lg" type="button" onclick={() => onChoose(selected)}>Continue</button>
    </div>
  </div>
</div>
