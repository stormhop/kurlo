<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import { shortcutComboLabel, usesMacShortcutGlyphs } from '../stores/features/preferences';

  let { cancel = false }: { cancel?: boolean } = $props();
  const combo = $derived(vm.shortcutCombo(cancel ? 'cancel-request' : 'send-request'));
</script>

{#if combo && usesMacShortcutGlyphs(vm.appRuntime)}
  <kbd class="btn-send-kbd" aria-hidden="true">{shortcutComboLabel(combo, vm.appRuntime)}</kbd>
{/if}
