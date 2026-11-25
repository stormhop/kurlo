<script lang="ts">
  import { tick } from 'svelte';
  import { floatingMenu } from '../floatingMenu';
  import { handleMenuKeydown } from '../menuKeyboard';
  import type { RequestSortMode } from '../types/models';
  import CheckIcon from './CheckIcon.svelte';
  import MenuIcon from './MenuIcon.svelte';

  let { requestSortMode, setRequestSortMode, openPostmanImport, workspaceBlocked }: {
    requestSortMode: RequestSortMode;
    setRequestSortMode: (mode: RequestSortMode) => void;
    openPostmanImport: () => void;
    workspaceBlocked: boolean;
  } = $props();

  const modes = [{ value: 'manual', label: 'Manual' }, { value: 'name', label: 'By name' }] as const;
  let open = $state(false);
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let menu = $state<HTMLDivElement>();
  let openAtPointerDown = false;

  async function show() {
    open = true;
    await tick();
    menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }

  function close() {
    open = false;
    trigger.focus();
  }

  function toggle() {
    const wasOpen = open || openAtPointerDown;
    openAtPointerDown = false;
    if (wasOpen) close();
    else void show();
  }
</script>

<svelte:window onpointerdown={event => { if (open && event.target instanceof Node && !root.contains(event.target)) open = false; }} />

<div bind:this={root} onfocusout={event => { if (!root.contains(event.relatedTarget as Node | null)) open = false; }}>
  <button class="btn btn-ghost btn-icon btn-sm" type="button" bind:this={trigger} aria-label="Collection tree menu" aria-haspopup="menu" aria-expanded={open}
    onpointerdown={() => (openAtPointerDown = open)} onclick={toggle} onkeydown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); void show(); } }}>
    •••
  </button>
  {#if open}
    <div class="menu request-menu" role="menu" tabindex="-1" aria-label="Collection tree menu" bind:this={menu} use:floatingMenu={'end'} onkeydown={event => handleMenuKeydown(event, close)}>
      <div class="menu-label">Sort requests</div>
      {#each modes as mode (mode.value)}
        <button class="menu-item app-select-option" class:active={requestSortMode === mode.value} type="button" role="menuitemradio" aria-checked={requestSortMode === mode.value} onclick={() => { setRequestSortMode(mode.value); close(); }}>
          <span class="app-select-check">{#if requestSortMode === mode.value}<CheckIcon />{/if}</span>
          <span>{mode.label}</span>
        </button>
      {/each}
      <div class="menu-separator" role="separator"></div>
      <button class="menu-item" type="button" role="menuitem" disabled={workspaceBlocked} onclick={() => { close(); openPostmanImport(); }}>
        <MenuIcon name="import" />Import collection…
      </button>
    </div>
  {/if}
</div>

