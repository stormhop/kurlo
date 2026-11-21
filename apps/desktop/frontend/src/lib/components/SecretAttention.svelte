<script lang="ts">
  import MenuIcon from './MenuIcon.svelte';
  import { secretProviderAttention } from '../stores/secretProviders.svelte';
  import { openSecretProviders } from '../secretProvidersNav';

  const attention = $derived(secretProviderAttention());
</script>

{#if attention.signin}
  <button class="btn btn-ghost btn-xs secret-attention" type="button" onclick={() => openSecretProviders()}>
    <MenuIcon name="key" />{attention.signin === 1 ? '1 secret provider needs sign-in' : `${attention.signin} secret providers need sign-in`}
  </button>
{:else if attention.untrusted}
  <button class="btn btn-ghost btn-xs secret-attention untrusted" type="button" onclick={() => openSecretProviders()}>
    <MenuIcon name="shield" />{attention.untrusted === 1 ? '1 secret provider not trusted' : `${attention.untrusted} secret providers not trusted`}
  </button>
{/if}
