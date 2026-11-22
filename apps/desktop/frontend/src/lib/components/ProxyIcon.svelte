<script lang="ts">
  let { size = '1.125rem', strokeWidth = 1.7 }: { size?: string; strokeWidth?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={strokeWidth} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 12 19 5"/><path d="M20.5 12A8.5 8.5 0 1 1 12 3.5"/><path d="M16.5 12A4.5 4.5 0 1 1 12 7.5"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>
</svg>
