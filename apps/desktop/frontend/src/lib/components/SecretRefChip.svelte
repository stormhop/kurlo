<script lang="ts">
  import MenuIcon from './MenuIcon.svelte';
  import type { SecretRef } from '../types/models';

  let {
    secretRef,
    tone = 'ok',
    onclick,
    label = '',
  }: {
    secretRef: SecretRef;
    tone?: 'ok' | 'error' | 'untrusted' | 'loading';
    onclick?: (event: MouseEvent) => void;
    label?: string;
  } = $props();

  const target = $derived(`${secretRef.path}${secretRef.field ? `#${secretRef.field}` : ''}${secretRef.version ? `@${secretRef.version}` : ''}`);
  const title = $derived(label || `${secretRef.provider} · ${target}`);
</script>

{#if onclick}
  <button class="secret-chip secret-chip-{tone}" type="button" {onclick} aria-label={`Linked to ${title}. Edit link`}>
    <MenuIcon name={tone === 'error' ? 'warning' : tone === 'untrusted' ? 'lock' : 'key'} />
    <span class="secret-chip-provider">{secretRef.provider}</span>
    <span class="secret-chip-sep" aria-hidden="true">·</span>
    <span class="secret-chip-path">{target}</span>
  </button>
{:else}
  <span class="secret-chip secret-chip-{tone}">
    <MenuIcon name={tone === 'error' ? 'warning' : tone === 'untrusted' ? 'lock' : 'key'} />
    <span class="secret-chip-provider">{secretRef.provider}</span>
    <span class="secret-chip-sep" aria-hidden="true">·</span>
    <span class="secret-chip-path">{target}</span>
  </span>
{/if}
