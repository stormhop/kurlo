<script lang="ts">
  import KurloBird from './KurloBird.svelte';

  let {
    label = 'Loading',
    envelope = false,
    size = '2.75rem',
    className = '',
  }: {
    label?: string;
    envelope?: boolean;
    size?: string;
    className?: string;
  } = $props();
</script>

<div class="bird-loader {className}" role="status" aria-label={label}>
  <span class="bird-loader-bird"><KurloBird mode="flying" {envelope} {size} /></span>
</div>

<style>
  .bird-loader {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    min-height: 0;
    padding: var(--space-6) var(--space-4);
  }
  .bird-loader-bird {
    opacity: 0;
    animation: bird-loader-in var(--dur-base) ease-out 0.3s forwards;
  }
  @keyframes bird-loader-in {
    from { opacity: 0; transform: translateY(0.375rem); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .bird-loader-bird {
      opacity: 1;
      animation: none;
    }
  }
</style>
