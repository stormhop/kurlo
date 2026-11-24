<script lang="ts">
  import { onMount } from 'svelte';
  import { handleMenuKeydown } from '../menuKeyboard';
  import { vm } from '../stores/app.svelte';
  import { fileManagerLabel, requestSupportsCurl } from '../utils';
  import { writeClipboard } from '../textEditing';
  import MenuIcon from './MenuIcon.svelte';

  let { requestId, x, y, onclose }: { requestId: string; x: number; y: number; onclose: () => void } = $props();

  let node: HTMLDivElement | undefined = $state();
  let left = $state(0);
  let top = $state(0);

  const request = $derived(vm.requestsById.get(requestId));
  const openIds = $derived(vm.openRequestIds);
  const index = $derived(openIds.indexOf(requestId));
  const others = $derived(openIds.filter(id => id !== requestId));
  const toTheRight = $derived(index < 0 ? [] : openIds.slice(index + 1));
  const revealLabel = fileManagerLabel();

  function place() {
    if (!node) return;
    const { offsetWidth: width, offsetHeight: height } = node;
    left = Math.max(0, Math.min(x, window.innerWidth - width));
    top = y + height > window.innerHeight ? Math.max(0, y - height) : y;
  }

  function run(action: () => unknown) {
    const pending = action();
    onclose();
    void pending;
  }

  onMount(() => {
    place();
    node?.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus();
    const outside = (event: Event) => {
      if (!node?.contains(event.target as Node)) onclose();
    };
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('resize', onclose);
    window.addEventListener('blur', onclose);
    return () => {
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('resize', onclose);
      window.removeEventListener('blur', onclose);
    };
  });
</script>

{#if request}
  <div
    class="menu request-tab-menu"
    role="menu"
    aria-label="Tab"
    tabindex="-1"
    bind:this={node}
    style:left={`${left}px`}
    style:top={`${top}px`}
    onkeydown={(event) => handleMenuKeydown(event, onclose)}
    oncontextmenu={(event) => event.preventDefault()}
  >
    <button class="menu-item" role="menuitem" type="button" onclick={() => run(() => vm.closeRequestTab(requestId))}>Close</button>
    <button class="menu-item" role="menuitem" type="button" disabled={!others.length} onclick={() => run(() => vm.closeRequestTabs(others))}>Close other tabs</button>
    <button class="menu-item" role="menuitem" type="button" disabled={!toTheRight.length} onclick={() => run(() => vm.closeRequestTabs(toTheRight))}>Close tabs to the right</button>
    <button class="menu-item" role="menuitem" type="button" onclick={() => run(() => vm.closeRequestTabs([...openIds]))}>Close all tabs</button>
    <div class="menu-separator" role="separator"></div>
    <button class="menu-item" role="menuitem" type="button" onclick={() => run(() => vm.duplicateRequest(requestId))}><MenuIcon name="duplicate" />Duplicate</button>
    <button class="menu-item" role="menuitem" type="button" disabled={!request.url} onclick={() => run(() => writeClipboard(request.url))}><MenuIcon name="link" />Copy URL</button>
    {#if requestSupportsCurl(request)}
      <button class="menu-item" role="menuitem" type="button" onclick={() => run(() => vm.copyRequestCurl(requestId))}><MenuIcon name="copy" />Copy as cURL</button>
    {/if}
    {#if revealLabel && !request.isDraft}
      <button class="menu-item" role="menuitem" type="button" onclick={() => run(() => vm.revealInFileManager('request', requestId))}><MenuIcon name="open" />{revealLabel}</button>
    {/if}
  </div>
{/if}

<style>
  .request-tab-menu {
    position: fixed;
    z-index: 400;
    min-width: 13rem;
  }

  .request-tab-menu:focus {
    outline: none;
  }
</style>
