<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    summary = '',
    storageKey,
    defaultOpen = false,
    variant = 'details',
    forceOpen = false,
    reveal = false,
    conceal = false,
    children,
  }: {
    title: string;
    summary?: string;
    storageKey: string;
    defaultOpen?: boolean;
    variant?: 'details' | 'settings';
    forceOpen?: boolean;
    reveal?: boolean;
    conceal?: boolean;
    children: Snippet;
  } = $props();

  const key = $derived(`kurlo.disclosure.${storageKey}`);

  function stored(name: string): boolean | null {
    try {
      const value = localStorage.getItem(`kurlo.disclosure.${name}`);
      return value === null ? null : value === '1';
    } catch {
      return null;
    }
  }

  let override = $derived<boolean | null>(reveal ? true : conceal ? false : stored(storageKey));
  const open = $derived(forceOpen || (override ?? defaultOpen));

  function toggle() {
    override = !open;
    try {
      localStorage.setItem(key, override ? '1' : '0');
    } catch {}
  }
</script>

<section class="disclosure {variant}" class:open aria-label={title}>
  <h3 class="disclosure-heading">
    <button class="disclosure-toggle" type="button" aria-expanded={open} onclick={toggle}>
      <span class="disclosure-title">{title}</span>
      <svg class="disclosure-chevron" width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      {#if summary}<span class="disclosure-summary">{summary}</span>{/if}
    </button>
  </h3>
  {#if open}
    <div class="disclosure-body">{@render children()}</div>
  {/if}
</section>

<style>
  .disclosure {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .disclosure-heading {
    margin: 0;
    font: inherit;
  }
  .disclosure-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    width: 100%;
    min-width: 0;
    padding: var(--space-1) 0;
    border: none;
    background: transparent;
    color: var(--text-3);
    text-align: left;
    cursor: pointer;
  }
  .disclosure-toggle:hover .disclosure-title,
  .disclosure-toggle:focus-visible .disclosure-title {
    color: var(--text);
  }
  .disclosure-title {
    flex: 0 0 auto;
  }
  .disclosure-chevron {
    flex: 0 0 auto;
    transition: transform 0.12s ease;
  }
  .open .disclosure-chevron {
    transform: rotate(90deg);
  }
  .disclosure-summary {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .disclosure-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .details .disclosure-title {
    font-size: var(--text-caption);
    font-weight: var(--weight-medium);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .details .disclosure-summary {
    font-size: var(--text-label);
  }
  .details .disclosure-body {
    gap: var(--space-2);
    padding-top: var(--space-1-5);
  }
  .settings .disclosure-toggle {
    padding: var(--space-1) calc(var(--space-3) + 1px);
    font-size: var(--text-label);
  }
  .settings .disclosure-title {
    color: var(--text-2);
    font-weight: var(--weight-medium);
  }
  .settings .disclosure-summary {
    font-size: var(--text-label);
  }
  .settings .disclosure-body {
    gap: var(--space-1-5);
    padding-top: var(--space-1);
  }
  @media (prefers-reduced-motion: reduce) {
    .disclosure-chevron {
      transition: none;
    }
  }
</style>
