<script lang="ts">
  import { secretProviderMonogram } from '../secretProviderTypes';
  import { secretProviderLogo } from '../secretProviderLogos';

  let { type, size = 'md' }: { type: string; size?: 'sm' | 'md' | 'lg' } = $props();
  const logo = $derived(secretProviderLogo(type));
  const text = $derived(secretProviderMonogram(type));
</script>

{#if logo?.mono}
  <span class="secret-logo secret-logo-{size} secret-logo-art" data-provider-type={type} aria-hidden="true">
    <span class="secret-logo-mask" style:--secret-logo-src={`url("${logo.src}")`}></span>
  </span>
{:else if logo}
  <span class="secret-logo secret-logo-{size} secret-logo-art secret-logo-color" data-provider-type={type} aria-hidden="true">
    <img class="secret-logo-img" src={logo.src} alt="" draggable="false" />
  </span>
{:else}
  <span class="secret-logo secret-logo-{size}" class:secret-logo-wide={text.length > 2} data-provider-type={type} aria-hidden="true">{text}</span>
{/if}
