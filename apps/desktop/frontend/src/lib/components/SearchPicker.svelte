<script lang="ts">
  import { tick } from 'svelte';

  type PickerOption = { value: string; label: string; hint?: string; color?: string };

  let {
    options = [],
    placeholder = 'Choose…',
    searchPlaceholder = 'Search',
    ariaLabel,
    emptyText = 'Nothing matches.',
    disabled = false,
    className = '',
    onChoose = () => {},
  }: {
    options: PickerOption[];
    placeholder?: string;
    searchPlaceholder?: string;
    ariaLabel: string;
    emptyText?: string;
    disabled?: boolean;
    className?: string;
    onChoose?: (value: string) => void;
  } = $props();

  const LIST_MIN_REM = 6;
  const LIST_MAX_REM = 17.5;
  let open = $state(false);
  let query = $state('');
  let highlighted = $state(0);
  let listMaxHeight = $state('');
  let upward = $state(false);
  let wrap = $state<HTMLDivElement>();
  let menu = $state<HTMLDivElement>();
  let list = $state<HTMLDivElement>();
  let search = $state<HTMLInputElement>();
  let trigger = $state<HTMLButtonElement>();

  const filtered = $derived.by(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return options;
    return options.filter(option => {
      const text = `${option.label} ${option.hint ?? ''}`.toLowerCase();
      return terms.every(term => text.includes(term));
    });
  });

  function scrollParent(node: HTMLElement | null) {
    let current = node?.parentElement ?? null;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function fitMenu() {
    if (!wrap || !menu) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const container = scrollParent(wrap);
    const bounds = container ? container.getBoundingClientRect() : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const rect = wrap.getBoundingClientRect();
    const chrome = menu.offsetHeight - (list?.offsetHeight ?? 0);
    const gap = rem * 0.75;
    const below = bounds.bottom - rect.bottom - gap - chrome;
    const above = rect.top - bounds.top - gap - chrome;
    upward = below < LIST_MIN_REM * rem && above > below;
    const room = upward ? above : below;
    listMaxHeight = `${Math.round(Math.max(rem * 2.25, Math.min(LIST_MAX_REM * rem, room)))}px`;
  }

  async function toggle() {
    if (open) {
      open = false;
      return;
    }
    query = '';
    highlighted = 0;
    listMaxHeight = '';
    upward = false;
    open = true;
    await tick();
    search?.focus({ preventScroll: true });
    fitMenu();
  }

  function close(focusTrigger = false) {
    open = false;
    if (focusTrigger) trigger?.focus({ preventScroll: true });
  }

  function choose(option: PickerOption) {
    close(true);
    onChoose(option.value);
  }

  async function moveHighlight(next: number) {
    highlighted = Math.max(0, Math.min(filtered.length - 1, next));
    await tick();
    list?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      open = false;
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      void moveHighlight(highlighted + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      void moveHighlight(highlighted - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = filtered[highlighted];
      if (option) choose(option);
    }
  }

  function onTriggerKeydown(event: KeyboardEvent) {
    if (open || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    void toggle();
  }

  function closeOnFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || wrap?.contains(next)) return;
    open = false;
  }

  function closeOnPointerOutside(event: PointerEvent) {
    if (event.target instanceof Node && wrap?.contains(event.target)) return;
    open = false;
  }

  $effect(() => {
    if (!open) return;
    document.addEventListener('pointerdown', closeOnPointerOutside, true);
    return () => document.removeEventListener('pointerdown', closeOnPointerOutside, true);
  });

  $effect(() => {
    if (!open || !wrap || !menu) return;
    const container = scrollParent(wrap);
    const observer = new ResizeObserver(fitMenu);
    observer.observe(wrap);
    if (container) observer.observe(container);
    window.addEventListener('resize', fitMenu);
    container?.addEventListener('scroll', fitMenu, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fitMenu);
      container?.removeEventListener('scroll', fitMenu);
    };
  });
</script>

<div class="search-picker {className}" bind:this={wrap} onfocusout={closeOnFocusOut}>
  <button bind:this={trigger} class="field search-picker-trigger" type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} {disabled} onclick={toggle} onkeydown={onTriggerKeydown}>
    <span class="search-picker-placeholder">{placeholder}</span>
    <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none" aria-hidden="true">
      <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </button>
  {#if open}
    <div class="search-picker-menu" class:search-picker-up={upward} bind:this={menu} role="dialog" aria-label={ariaLabel} tabindex="-1" onkeydown={onKeydown}>
      <input
        class="field search-picker-search"
        bind:this={search}
        bind:value={query}
        oninput={() => (highlighted = 0)}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        autocomplete="off"
        spellcheck="false"
        autocorrect="off"
        autocapitalize="none"
      />
      {#if filtered.length}
        <div class="search-picker-list" bind:this={list} role="listbox" aria-label={ariaLabel} style:max-height={listMaxHeight || undefined}>
          {#each filtered as option, index (option.value)}
            <button
              class="search-picker-option"
              class:active={index === highlighted}
              data-index={index}
              role="option"
              aria-selected={index === highlighted}
              type="button"
              tabindex="-1"
              onmousemove={() => (highlighted = index)}
              onclick={() => choose(option)}
            >
              <span class="search-picker-option-label">{#if option.color}<span class="env-color-dot" style:--env-color={option.color} aria-hidden="true"></span>{/if}{option.label}</span>
              {#if option.hint}<span class="search-picker-option-hint">{option.hint}</span>{/if}
            </button>
          {/each}
        </div>
      {:else}
        <div class="search-picker-empty">{emptyText}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .search-picker {
    position: relative;
    min-width: 0;
  }
  .search-picker-trigger {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    width: 100%;
    text-align: left;
    cursor: pointer;
  }
  .search-picker-trigger svg {
    flex: 0 0 auto;
    color: var(--text-3);
    transition: transform var(--dur-fast);
  }
  .search-picker-trigger[aria-expanded='true'] svg { transform: rotate(180deg); }
  .search-picker-placeholder {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search-picker-menu {
    box-sizing: border-box;
    position: absolute;
    z-index: 30;
    top: calc(100% + var(--space-1));
    left: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
    padding: var(--space-1-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    box-shadow: var(--shadow-popover);
  }
  .search-picker-up {
    top: auto;
    bottom: calc(100% + var(--space-1));
    flex-direction: column-reverse;
  }
  .search-picker-search { width: 100%; }
  .search-picker-list {
    max-height: 17.5rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .search-picker-option {
    display: flex;
    flex: 0 0 auto;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-1-5) var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .search-picker-option.active { background: var(--hover); }
  .search-picker-option-label {
    min-width: 0;
    overflow: clip;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search-picker-option-hint {
    flex: 0 0 auto;
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .search-picker-empty {
    padding: var(--space-2);
    color: var(--text-2);
    font-size: var(--text-label);
  }
</style>
