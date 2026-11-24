<script lang="ts">
  let {
    direction = 'down',
    open = false,
    collapsed = false,
    class: className = '',
  }: { direction?: 'down' | 'right'; open?: boolean; collapsed?: boolean; class?: string } = $props();
</script>

<svg class={['chevron', className, { open, collapsed }]} width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true">
  <path d={direction === 'right' ? 'M3.25 1.5L6.75 5L3.25 8.5' : 'M1.5 3.25L5 6.75L8.5 3.25'} stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>

<style>
  svg {
    flex: none;
  }
</style>
