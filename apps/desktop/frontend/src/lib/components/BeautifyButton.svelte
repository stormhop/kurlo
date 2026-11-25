<script lang="ts">
  let {
    onbeautify,
    beautified = false,
    disabled = false,
    busy,
    title = 'Beautify',
  }: {
    onbeautify: () => void | boolean | Promise<unknown>;
    beautified?: boolean;
    disabled?: boolean;
    busy?: boolean;
    title?: string;
  } = $props();
</script>

<button
  class="btn btn-ghost btn-sm beautify-btn"
  class:feedback-ok={beautified}
  type="button"
  {title}
  {disabled}
  aria-busy={busy}
  onclick={() => onbeautify()}
>
  {#if beautified}
    <svg width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 6l2.3 2.3L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="btn-label">Beautified</span>
  {:else}
    <svg width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M1 3h4M1 6h7M1 9h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      <path d="M9 4l2 2-2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="btn-label">Beautify</span>
  {/if}
</button>

<style>
  .beautify-btn {
    display: inline-flex;
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .beautify-btn:disabled {
    pointer-events: none;
  }
</style>
