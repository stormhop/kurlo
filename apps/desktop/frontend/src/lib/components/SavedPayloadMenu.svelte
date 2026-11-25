<script lang="ts" generics="Item extends { id: string; name: string }">
  import { NAME_MAX_LENGTH } from '../constants';
  import { tick } from 'svelte';
  import CheckIcon from './CheckIcon.svelte';
  import MenuIcon from './MenuIcon.svelte';

  let {
    noun, items, summary, suggestName, saveProblem, onSave, onLoad, onSend, onRemove, onRename,
    selectedId, disabled = false, canSend, search, searchFrom = Infinity, maxShown,
  }: {
    noun: 'message' | 'body variant';
    items: Item[];
    summary: (item: Item) => string;
    suggestName: () => string;
    saveProblem: (name: string) => string;
    onSave: (name: string) => string | undefined;
    onLoad: (id: string) => void;
    onSend: (id: string) => void;
    onRemove: (id: string) => void;
    onRename?: (id: string) => void;
    selectedId?: string;
    disabled?: boolean;
    canSend: boolean;
    search?: (items: Item[], query: string) => Item[];
    searchFrom?: number;
    maxShown?: number;
  } = $props();

  const label = $derived(`Saved ${noun}s`);
  const placeholder = $derived(noun === 'message' ? 'Message name' : 'Variant name');

  let open = $state(false);
  let name = $state('');
  let wrap = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let nameInput = $state<HTMLInputElement>();
  let menu = $state<HTMLDivElement>();
  let menuStyle = $state('');
  let justSaved = $state('');
  let query = $state('');

  const problem = $derived(open ? saveProblem(name.trim()) : '');
  const searchable = $derived(!!search && items.length >= searchFrom);
  const matches = $derived(searchable && search ? search(items, query) : items);
  const shown = $derived(maxShown ? matches.slice(0, maxShown) : matches);
  const hidden = $derived(matches.length - shown.length);

  async function toggle() {
    if (open) {
      open = false;
      return;
    }
    name = suggestName();
    justSaved = '';
    query = '';
    open = true;
    await tick();
    nameInput?.focus({ preventScroll: true });
    nameInput?.select();
  }

  function close(focusTrigger = false) {
    open = false;
    if (focusTrigger) trigger?.focus({ preventScroll: true });
  }

  function save(event?: SubmitEvent) {
    event?.preventDefault();
    if (disabled || problem || !name.trim()) return;
    const saved = onSave(name.trim());
    if (!saved) return;
    justSaved = saved;
    name = suggestName();
  }

  function load(id: string) {
    onLoad(id);
    close(true);
  }

  function remove(id: string) {
    onRemove(id);
    if (justSaved === id) justSaved = '';
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
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

  const MENU_MARGIN = 10;
  const MENU_MIN_HEIGHT = 160;

  function clipBounds(from: HTMLElement) {
    let node = from.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (style.overflow !== 'visible' || style.overflowY !== 'visible') return node.getBoundingClientRect();
      node = node.parentElement;
    }
    return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  }

  function fitMenu() {
    if (!wrap || !menu) return;
    const trigger = wrap.getBoundingClientRect();
    const bounds = clipBounds(wrap);
    const below = Math.min(bounds.bottom, window.innerHeight) - trigger.bottom - MENU_MARGIN;
    const above = trigger.top - Math.max(bounds.top, 0) - MENU_MARGIN;
    const natural = menu.scrollHeight;
    if (natural <= below || below >= above) {
      menuStyle = `max-height:${Math.max(MENU_MIN_HEIGHT, Math.floor(below))}px`;
      return;
    }
    menuStyle = `top:auto;bottom:calc(100% + 4px);max-height:${Math.max(MENU_MIN_HEIGHT, Math.floor(above))}px`;
  }

  $effect(() => {
    if (!open) {
      menuStyle = '';
      return;
    }
    if (menu) fitMenu();
    document.addEventListener('pointerdown', closeOnPointerOutside, true);
    window.addEventListener('resize', fitMenu);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerOutside, true);
      window.removeEventListener('resize', fitMenu);
    };
  });
</script>

<div class="saved-messages" bind:this={wrap} onfocusout={closeOnFocusOut}>
  <button
    bind:this={trigger}
    class="btn btn-secondary btn-sm toolbar-btn saved-messages-trigger"
    type="button"
    aria-haspopup="dialog"
    aria-expanded={open}
    {disabled}
    aria-label={items.length ? `${label}, ${items.length}` : label}
    title={selectedId ? `${label}: ${selectedId}` : label}
    onclick={toggle}
  >
    <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M3.5 1.5h6a1 1 0 011 1v9l-4-2.2-4 2.2v-9a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>
    <span class="btn-label">Saved</span>
    {#if items.length}<span class="badge">{items.length}</span>{/if}
  </button>

  {#if open}
    <div class="saved-messages-menu" bind:this={menu} style={menuStyle} role="dialog" aria-label={label} tabindex="-1" onkeydown={onKeydown}>
      <form class="saved-messages-form" onsubmit={save}>
        <input
          bind:this={nameInput}
          bind:value={name}
          class="field field-sm saved-messages-name"
          maxlength={NAME_MAX_LENGTH}
          aria-label={`Saved ${noun} name`}
          {placeholder}
          autocomplete="off"
          spellcheck="false"
          autocorrect="off"
          autocapitalize="none"
        />
        <button class="btn btn-primary btn-sm" type="submit" disabled={disabled || !name.trim() || Boolean(problem)}>Save current</button>
      </form>
      {#if problem}<p class="saved-messages-note" role="status">{problem}</p>{/if}

      {#if searchable}
        <div class="field field-sm field-wrap saved-messages-search">
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
            <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
          <input bind:value={query} type="search" aria-label="Search saved messages" placeholder={`Search ${items.length} messages`} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" />
        </div>
      {/if}

      {#if items.length && !shown.length}
        <p class="saved-messages-empty" role="status">No saved message matches “{query.trim()}”.</p>
      {:else if items.length}
        <ul class="saved-messages-list" aria-label={`${label} list`}>
          {#each shown as item (item.id)}
            <li class="saved-messages-item" class:just-saved={justSaved === item.id}>
              <button class="saved-messages-load" type="button" aria-label={`Load ${item.name}`} title={item.name} aria-pressed={selectedId ? selectedId === item.id : undefined} {disabled} onclick={() => load(item.id)}>
                <span class="saved-messages-item-name">{#if selectedId === item.id}<CheckIcon />{/if}{item.name}</span>
                <span class="saved-messages-item-hint">{summary(item)}</span>
              </button>
              <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label={`Send ${item.name}`} title="Send" disabled={disabled || !canSend} onclick={() => onSend(item.id)}>
                <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                  <path d="M1.5 6.5l10-4.5-3.5 10-2-4-4.5-1.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
                </svg>
              </button>
              {#if onRename}
                <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label={`Rename ${item.name}`} title="Rename" {disabled} onclick={() => onRename?.(item.id)}><MenuIcon name="rename" /></button>
              {/if}
              <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label={`Delete ${item.name}`} title="Delete" {disabled} onclick={() => remove(item.id)}>
                <svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
              </button>
            </li>
          {/each}
        </ul>
        {#if hidden > 0}<p class="saved-messages-note" role="status">{hidden} more not shown. Search to find them.</p>{/if}
      {:else}
        <p class="saved-messages-empty">Save the {noun === 'message' ? 'message' : 'body'} in the editor to send it again later. {label} are kept with the request.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .saved-messages {
    position: relative;
    flex-shrink: 0;
  }
  .saved-messages-trigger {
    gap: var(--space-1);
  }
  .saved-messages-menu {
    box-sizing: border-box;
    position: absolute;
    z-index: 30;
    top: calc(100% + var(--space-1));
    right: 0;
    width: min(var(--saved-menu-width, 22rem), calc(100vw - 2rem), calc(100cqw - 1.5rem));
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
    padding: var(--space-1-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    box-shadow: var(--shadow-popover);
    overflow: hidden;
  }
  .saved-messages-form {
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-1-5);
  }
  .saved-messages-name {
    flex: 1 1 auto;
    min-width: 0;
  }
  .saved-messages-list {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    max-height: 17.5rem;
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: none;
    list-style: none;
  }
  .saved-messages-item {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--space-0-5);
    border-radius: var(--radius-sm);
  }
  .saved-messages-item:hover,
  .saved-messages-item:focus-within {
    background: var(--hover);
  }
  .saved-messages-item.just-saved .saved-messages-item-name {
    color: var(--accent-text);
  }
  .saved-messages-load {
    display: grid;
    flex: 1 1 auto;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-0-5);
    min-width: 0;
    padding: var(--space-1-5) var(--space-2);
    border: 0;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .saved-messages-item-name,
  .saved-messages-item-hint {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .saved-messages-item-name {
    font-size: var(--text-label);
  }
  .saved-messages-item-name :global(svg) {
    margin-right: var(--space-1);
    color: var(--accent-text);
  }
  .saved-messages-item-hint {
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }
  .saved-messages-search {
    flex: 0 0 auto;
  }
  .saved-messages-note {
    flex: 0 0 auto;
    margin: 0;
    padding: 0 var(--space-2);
    color: var(--text-2);
    font-size: var(--text-caption);
  }
  .saved-messages-empty {
    flex: 0 0 auto;
    margin: 0;
    padding: var(--space-1-5) var(--space-2);
    color: var(--text-2);
    font-size: var(--text-label);
  }
</style>
