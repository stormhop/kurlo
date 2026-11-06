<script lang="ts">
  let { add = false }: { add?: boolean } = $props();
</script>

<svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true">
  <path d={add ? 'M3 7h8M7 3v8' : 'M3 3l8 8M11 3l-8 8'} stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>

<style>
  svg {
    flex: none;
    vertical-align: middle;
  }
</style>
