<script lang="ts">
  import { tick } from 'svelte';
  let {
    value = $bindable(''),
    options = [],
    className = '',
    disabled = false,
    searchable = false,
    searchPlaceholder = 'Search models',
    ariaLabel = undefined,
    onChange = () => {},
  }: {
    value: string;
    options: Array<{ value: string; label: string }>;
    className?: string;
    disabled?: boolean;
    searchable?: boolean;
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
  const filteredOptions = $derived(options.filter(option => option.label.toLowerCase().includes(search.trim().toLowerCase())));

  async function toggle() {
    open = !open;
    search = '';
    if (open && searchable) {
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
    const cap = MENU_MAX_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    const wanted = Math.min(natural, cap);
    if (wanted <= below || below >= above) {
      menuStyle = `${horizontal}max-height:${Math.max(MENU_MIN_HEIGHT, Math.floor(Math.min(below, cap)))}px`;
      return;
    }
    menuStyle = `${horizontal}top:auto;bottom:calc(100% + 4px);max-height:${Math.max(MENU_MIN_HEIGHT, Math.floor(Math.min(above, cap)))}px`;
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
    triggerButton?.focus();
  }

  $effect(() => {
    if (!open) {
      menuStyle = '';
      return;
    }
    if (menu) fitMenu();
    document.addEventListener('pointerdown', onPointerDownOutside, true);
    document.addEventListener('keydown', onKeydown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDownOutside, true);
      document.removeEventListener('keydown', onKeydown, true);
    };
  });

  function choose(v: string) {
    value = v;
    open = false;
    onChange(v);
    triggerButton?.focus();
  }

  function onFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (next instanceof Node && !wrap?.contains(next)) open = false;
  }
</script>

<div class="app-select {className}" class:open bind:this={wrap} onfocusout={onFocusOut}>
  <button
    class="field select-trigger app-select-trigger"
    type="button"
    bind:this={triggerButton}
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={ariaLabel ? `${ariaLabel}: ${selected?.label ?? value}` : undefined}
    onclick={() => void toggle()}
    onkeydown={navigate}
  >
    <span>{selected?.label ?? value}</span>
    <svg class="app-select-chevron" width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none" aria-hidden="true">
      <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </button>
  {#if open}
    <div class="menu app-select-menu" role="listbox" tabindex="-1" bind:this={menu} style={menuStyle} onkeydown={navigate} aria-label={ariaLabel}>
      {#if searchable}
        <input class="field field-sm" type="search" bind:value={search} bind:this={searchInput} aria-label={`Search ${ariaLabel || 'options'}`} placeholder={searchPlaceholder} spellcheck="false" />
      {/if}
      {#each filteredOptions as opt (opt.value)}
        <button
          class="menu-item app-select-option"
          class:active={opt.value === value}
          type="button"
          role="option"
          aria-selected={opt.value === value}
          onmousedown={(e) => e.preventDefault()}
          onclick={(event) => { event.preventDefault(); choose(opt.value); }}
        >
          <span class="app-select-check">{opt.value === value ? '✓' : ''}</span>
          <span>{opt.label}</span>
        </button>
      {/each}
      {#if !filteredOptions.length}<div class="empty-state">No matches</div>{/if}
    </div>
  {/if}
</div>
