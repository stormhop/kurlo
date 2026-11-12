<script lang="ts">
  import { onMount } from 'svelte';
  import { handleMenuKeydown } from '../menuKeyboard';
  import { focusTextTarget, runTextAction, textTargetState, type TextAction, type TextMenuState } from '../textEditing';

  let { menu, onclose }: { menu: TextMenuState; onclose: () => void } = $props();

  let node: HTMLDivElement | undefined = $state();
  let left = $state(0);
  let top = $state(0);

  const modifier = document.documentElement.dataset.platform === 'darwin' ? '⌘' : 'Ctrl+';
  const status = $derived(textTargetState(menu.target));
  const items = $derived<{ action: TextAction; label: string; key: string; enabled: boolean }[]>([
    { action: 'cut', label: 'Cut', key: 'X', enabled: Boolean(status.selection) && !status.readOnly && !status.secret },
    { action: 'copy', label: 'Copy', key: 'C', enabled: Boolean(status.selection) && !status.secret },
    { action: 'paste', label: 'Paste', key: 'V', enabled: !status.readOnly },
    { action: 'selectAll', label: 'Select all', key: 'A', enabled: !status.empty },
  ]);

  function place() {
    if (!node) return;
    const { offsetWidth: width, offsetHeight: height } = node;
    left = Math.max(0, Math.min(menu.x, window.innerWidth - width));
    top = menu.y + height > window.innerHeight ? Math.max(0, menu.y - height) : menu.y;
  }

  function dismiss() {
    const { target } = menu;
    onclose();
    focusTextTarget(target);
  }

  async function run(action: TextAction) {
    const { target } = menu;
    const snapshot = status;
    onclose();
    await runTextAction(target, action, snapshot);
  }

  onMount(() => {
    place();
    node?.focus();
    const outside = (event: Event) => {
      if (!node?.contains(event.target as Node)) onclose();
    };
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('resize', onclose);
    window.addEventListener('blur', onclose);
    window.addEventListener('scroll', onclose, true);
    return () => {
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('resize', onclose);
      window.removeEventListener('blur', onclose);
      window.removeEventListener('scroll', onclose, true);
    };
  });
</script>

<div
  class="menu text-context-menu"
  role="menu"
  aria-label="Edit"
  tabindex="-1"
  bind:this={node}
  style:left={`${left}px`}
  style:top={`${top}px`}
  onkeydown={(event) => handleMenuKeydown(event, dismiss)}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#each items as item (item.action)}
    <button class="menu-item" role="menuitem" type="button" disabled={!item.enabled} onmousedown={(event) => event.preventDefault()} onclick={() => run(item.action)}>
      <span>{item.label}</span>
      <kbd>{modifier}{item.key}</kbd>
    </button>
  {/each}
</div>

<style>
  .text-context-menu {
    position: fixed;
    z-index: 400;
    min-width: 12rem;
  }

  .text-context-menu:focus {
    outline: none;
  }

  .text-context-menu .menu-item {
    display: flex;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .text-context-menu kbd {
    color: var(--text-3);
    font: inherit;
    font-size: var(--text-label);
  }
</style>
