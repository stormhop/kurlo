<script lang="ts">
  import KurloBird from './KurloBird.svelte';

  let { size = '1.125rem', label = '', tone = 'brand' }: { size?: string; label?: string; tone?: 'brand' | 'current' } = $props();
</script>

{#if label}
  <span class="bird-spinner" role="status" aria-label={label}><KurloBird mode="flying" {tone} {size} /></span>
{:else}
  <span class="bird-spinner" aria-hidden="true"><KurloBird mode="flying" {tone} {size} /></span>
{/if}

<style>
  .bird-spinner {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    line-height: 0;
    vertical-align: middle;
  }
</style>
