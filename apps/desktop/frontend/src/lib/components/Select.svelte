<script lang="ts">
  import Chevron from './Chevron.svelte';
  import CheckIcon from './CheckIcon.svelte';
  import { tick } from 'svelte';
  let {
    value = $bindable(''),
    options = [],
    className = '',
    disabled = false,
    searchable = false,
    floating = false,
    size = 'lg',
    searchPlaceholder = 'Search models',
    ariaLabel = undefined,
    onChange = () => {},
  }: {
    value: string;
    options: Array<{ value: string; label: string; color?: string; icon?: string; separated?: boolean }>;
    className?: string;
    disabled?: boolean;
    searchable?: boolean;
    floating?: boolean;
    size?: 'sm' | 'md' | 'lg';
    searchPlaceholder?: string;
    ariaLabel?: string;
    onChange?: (value: string) => void;
  } = $props();

  let open = $state(false);
  let wrap = $state<HTMLDivElement>();
  let menu = $state<HTMLDivElement>();
  let menuStyle = $state('');
  let search = $state('');
  let triggerButton = $state<HTMLButtonElement>();
  let searchInput = $state<HTMLInputElement>();

  const selected = $derived(options.find(o => o.value === value));
  const hasIcons = $derived(options.some(o => o.icon));
  const filteredOptions = $derived(options.filter(option => option.label.toLowerCase().includes(search.trim().toLowerCase())));

  async function toggle() {
    if (open) {
      open = false;
      triggerButton?.focus({ preventScroll: true });
      return;
    }
    search = '';
    open = true;
    if (searchable) {
      await tick();
      searchInput?.focus({ preventScroll: true });
    }
  }

  async function navigate(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const wasOpen = open;
    if (!open) {
      search = '';
      open = true;
      await tick();
    }
    const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const selectedIndex = Math.max(0, filteredOptions.findIndex(option => option.value === value));
    const next = !wasOpen ? selectedIndex : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  const MENU_MARGIN = 10;
  const MENU_MIN_HEIGHT = 120;
  const MENU_MAX_REM = 20;

  function clipBounds(from: HTMLElement) {
    let node = from.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (style.overflow !== 'visible' || style.overflowY !== 'visible') {
        return node.getBoundingClientRect();
      }
      node = node.parentElement;
    }
    return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  }

  function fitMenu() {
    if (!wrap || !menu) return;
    const trigger = wrap.getBoundingClientRect();
    const bounds = clipBounds(wrap);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const cap = MENU_MAX_REM * rem;
    if (floating) {
      if (trigger.bottom <= bounds.top || trigger.top >= bounds.bottom) {
        open = false;
        return;
      }
      const gap = rem / 4;
      const dialog = wrap.closest('[role="dialog"]')?.getBoundingClientRect();
      const topEdge = Math.max(dialog?.top ?? 0, 0) + MENU_MARGIN;
      const bottomEdge = Math.min(dialog?.bottom ?? window.innerHeight, window.innerHeight) - MENU_MARGIN;
      const leftEdge = Math.max(bounds.left, 0) + MENU_MARGIN;
      const rightEdge = Math.min(bounds.right, window.innerWidth) - MENU_MARGIN;
      const above = trigger.top - gap - topEdge;
      const below = bottomEdge - trigger.bottom - gap;
      const width = Math.min(Math.max(trigger.width, searchable ? 15 * rem : 0, menu.getBoundingClientRect().width), rightEdge - leftEdge);
      const left = Math.max(leftEdge, trigger.left + width <= rightEdge ? trigger.left : trigger.right - width);
      const downward = Math.min(menu.scrollHeight, cap) <= below || below >= above;
      const edges = downward ? `top:${trigger.bottom + gap}px;bottom:auto` : `top:auto;bottom:${window.innerHeight - trigger.top + gap}px`;
      const height = Math.max(0, Math.floor(Math.min(downward ? below : above, cap)));
      menuStyle = `left:${left}px;width:${width}px;max-height:${height}px;${edges}`;
      return;
    }
    const below = bounds.bottom - trigger.bottom - MENU_MARGIN;
    const above = trigger.top - bounds.top - MENU_MARGIN;
    const natural = menu.scrollHeight;
    const viewportRight = Math.min(bounds.right, window.innerWidth) - MENU_MARGIN;
    const viewportLeft = Math.max(bounds.left, 0) + MENU_MARGIN;
    const width = menu.getBoundingClientRect().width;
    let horizontal = '';
    if (trigger.left + width > viewportRight) {
      const room = trigger.right - viewportLeft;
      horizontal = `left:auto;right:0;max-width:${Math.max(trigger.width, Math.floor(room))}px;`;
    }
    const wanted = Math.min(natural, cap);
    if (wanted <= below || below >= above) {
      menuStyle = `${horizontal}max-height:${Math.max(MENU_MIN_HEIGHT, Math.floor(Math.min(below, cap)))}px`;
      return;
    }
    menuStyle = `${horizontal}top:auto;bottom:calc(100% + 4px);max-height:${Math.max(MENU_MIN_HEIGHT, Math.floor(Math.min(above, cap)))}px`;
  }

  function followMenu(event: Event) {
    if (event.target instanceof Node && menu?.contains(event.target)) return;
    fitMenu();
  }

  function onPointerDownOutside(event: PointerEvent) {
    const target = event.target;
    if (target instanceof Node && wrap?.contains(target)) return;
    open = false;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    open = false;
    triggerButton?.focus({ preventScroll: true });
  }

  $effect(() => {
    if (!open) {
      menuStyle = '';
      return;
    }
    if (menu) fitMenu();
    document.addEventListener('pointerdown', onPointerDownOutside, true);
    document.addEventListener('keydown', onKeydown, true);
    if (floating) {
      window.addEventListener('scroll', followMenu, true);
      window.addEventListener('resize', followMenu);
    }
    return () => {
      document.removeEventListener('pointerdown', onPointerDownOutside, true);
      document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('scroll', followMenu, true);
      window.removeEventListener('resize', followMenu);
    };
  });

  function choose(v: string) {
    value = v;
    open = false;
    onChange(v);
    triggerButton?.focus({ preventScroll: true });
  }

  function onFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (next instanceof Node && !wrap?.contains(next)) open = false;
  }
</script>

<div class="app-select {className}" class:open bind:this={wrap} onfocusout={onFocusOut}>
  <button
    class="field select-trigger app-select-trigger"
    class:field-sm={size === 'sm'}
    class:field-md={size === 'md'}
    class:open
    class:env-colored={Boolean(selected?.color)}
    style:--env-color={selected?.color}
    type="button"
    bind:this={triggerButton}
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={ariaLabel ? `${ariaLabel}: ${selected?.label ?? value}` : undefined}
    onmousedown={(event) => { if (open && event.button === 0) event.preventDefault(); }}
    onclick={() => void toggle()}
    onkeydown={navigate}
  >
    {#if selected?.color}<span class="env-color-dot" aria-hidden="true"></span>{/if}
    <span>{selected?.label ?? value}</span>
    <Chevron class="app-select-chevron" />
  </button>
  {#if open}
    <div class="menu app-select-menu" class:app-select-menu-floating={floating} role="listbox" tabindex="-1" bind:this={menu} style={floating && !menuStyle ? 'visibility:hidden' : menuStyle} onkeydown={navigate} aria-label={ariaLabel}>
      {#if searchable}
        <input class="field field-sm" type="search" bind:value={search} bind:this={searchInput} aria-label={`Search ${ariaLabel || 'options'}`} placeholder={searchPlaceholder} spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="none" />
      {/if}
      {#each filteredOptions as opt (opt.value)}
        {#if opt.separated}<hr class="menu-separator" />{/if}
        <button
          class="menu-item app-select-option"
          class:active={opt.value === value}
          type="button"
          role="option"
          aria-selected={opt.value === value}
          onmousedown={(e) => e.preventDefault()}
          onclick={(event) => { event.preventDefault(); choose(opt.value); }}
        >
          <span class="app-select-check">{#if opt.value === value}<CheckIcon />{/if}</span>
          {#if opt.color}<span class="env-color-dot" style:--env-color={opt.color} aria-hidden="true"></span>{/if}
          {#if hasIcons}<span class="app-select-icon" aria-hidden="true">{opt.icon ?? ''}</span>{/if}
          <span>{opt.label}</span>
        </button>
      {/each}
      {#if !filteredOptions.length}<div class="empty-state">No matches</div>{/if}
    </div>
  {/if}
</div>
