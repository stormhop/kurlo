<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import { TRASH_LIMIT, type TrashKind } from '../stores/features/trash';

  const KIND_ICONS = { request: 'request', folder: 'folder', collection: 'collection', environment: 'restore' } as const;

  let { kinds, disabled = false }: { kinds: TrashKind[]; disabled?: boolean } = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement>();
  let menuEl = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  const entries = $derived(vm.trashForWorkspace(vm.activeWorkspaceId, kinds));

  function closeOnFocusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (!root?.contains(next) && !menuEl?.contains(next)) open = false;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      open = false;
      trigger?.focus();
    }
  }

  function closeOnOutsidePointer(event: PointerEvent) {
    const target = event.target as Node | null;
    if (open && !root?.contains(target) && !menuEl?.contains(target)) open = false;
  }

  function ago(timestamp: number) {
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  }

  function clearAll() {
    open = false;
    for (const entry of entries) vm.forgetDeleted(entry.id);
  }

  function placeMenu(node: HTMLElement) {
    document.body.appendChild(node);
    const place = () => {
      const anchor = trigger?.getBoundingClientRect();
      if (!anchor) return;
      const width = node.offsetWidth;
      const margin = 8;
      node.style.top = `${anchor.bottom + 4}px`;
      node.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))}px`;
    };
    place();
    window.addEventListener('resize', place);
    return {
      destroy() {
        window.removeEventListener('resize', place);
        node.remove();
      },
    };
  }

  async function restore(id: string) {
    open = false;
    await vm.restoreDeleted(id);
  }
</script>

<svelte:window onpointerdown={closeOnOutsidePointer} />

{#if entries.length}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="recently-deleted" bind:this={root} onfocusout={closeOnFocusOut} onkeydown={onKeydown}>
    <button bind:this={trigger} class="btn btn-ghost btn-icon btn-sm collection-add recently-deleted-trigger" type="button" aria-label="Recently deleted" aria-haspopup="menu" aria-expanded={open} onclick={() => (open = !open)} {disabled}>
      <MenuIcon name="trash" />
    </button>
    {#if open}
      <!-- svelte-ignore a11y_interactive_supports_focus -->
      <div class="menu recently-deleted-menu" role="menu" aria-label="Recently deleted" bind:this={menuEl} use:placeMenu onfocusout={closeOnFocusOut} onkeydown={onKeydown}>
        <div class="menu-label recently-deleted-head">
          <span>Recently deleted</span>
          <span>{entries.length} of {TRASH_LIMIT}</span>
        </div>
        <div class="recently-deleted-list" data-testid="recently-deleted-list">
          {#each entries as entry (entry.id)}
            <button class="menu-item recently-deleted-item" type="button" role="menuitem" aria-label={`Restore ${entry.kind} ${entry.name}`} onclick={() => restore(entry.id)}>
              <MenuIcon name={KIND_ICONS[entry.kind]} />
              <span class="recently-deleted-name">{entry.name}</span>
              {#if entry.detail}<span class="recently-deleted-detail">{entry.detail}</span>{/if}
              <small class="recently-deleted-time">{ago(entry.deletedAt)}</small>
            </button>
          {/each}
        </div>
        <div class="menu-separator" role="separator"></div>
        <button class="menu-item" type="button" role="menuitem" onclick={clearAll}>
          <MenuIcon name="trash" />
          <span>Clear list</span>
        </button>
        <div class="recently-deleted-note">Click an item to restore it. The list is kept until you quit Kurlo.</div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .recently-deleted {
    position: relative;
    display: inline-flex;
  }

  .recently-deleted-menu {
    position: fixed;
    z-index: 70;
    display: flex;
    flex-direction: column;
    width: 18rem;
    max-width: calc(100vw - 1rem);
    max-height: min(26rem, calc(100vh - 6rem));
  }

  .recently-deleted-head {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    flex: 0 0 auto;
  }

  .recently-deleted-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: none;
  }

  .recently-deleted-item {
    min-width: 0;
  }

  .recently-deleted-name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: clip;
    text-overflow: ellipsis;
  }

  .recently-deleted-detail {
    flex: 1 1 0;
    min-width: 0;
    overflow: clip;
    color: var(--text-3);
    font-size: var(--text-label);
    text-overflow: ellipsis;
  }

  .recently-deleted-time {
    flex: 0 0 auto;
    margin-left: auto;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }

  .recently-deleted-note {
    flex: 0 0 auto;
    padding: var(--space-1) var(--space-2) var(--space-0-5);
    color: var(--text-3);
    font-size: var(--text-caption);
    line-height: var(--leading-normal);
    white-space: normal;
  }
</style>
