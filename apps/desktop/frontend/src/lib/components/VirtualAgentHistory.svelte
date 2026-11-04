<script lang="ts" generics="T extends { id: string }">
  import { untrack, type Snippet } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { virtualOffsets, virtualIndex, virtualRange } from '../agentHistory';

  let { items, scroller, follow, onScroll, children }: { items: T[]; scroller?: HTMLDivElement; follow: boolean; onScroll: () => void; children: Snippet<[T]> } = $props();
  let list = $state<HTMLDivElement>();
  let top = $state(0);
  let height = $state(600);
  const heights = new SvelteMap<string, number>();
  const offsets = $derived(virtualOffsets(items.map(item => item.id), heights));
  const range = $derived(virtualRange(offsets, top, height));
  let anchor: { id: string; y: number } | null = null;
  let observedScrollTop = 0;
  let programmedScroll: number | null = null;
  let lastFollow: boolean | null = null;

  $effect(() => {
    const ids = new Set(items.map(item => item.id));
    untrack(() => { for (const id of heights.keys()) if (!ids.has(id)) heights.delete(id); });
  });

  function listTop() {
    if (!scroller || !list) return 0;
    return list.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop + scroller.scrollTop;
  }

  function viewport(updateAnchor = false) {
    if (!scroller) return;
    top = scroller.scrollTop - listTop();
    height = scroller.clientHeight;
    if (updateAnchor) {
      const index = virtualIndex(offsets, top);
      if (items[index]) anchor = { id: items[index].id, y: offsets[index] - top };
    }
  }

  export function captureAnchor() {
    if (!scroller) return;
    observedScrollTop = scroller.scrollTop;
    viewport(true);
  }

  function measure(node: HTMLDivElement, id: string) {
    let alive = true;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!alive) return;
        const size = node.getBoundingClientRect().height;
        if (size > 0 && Math.abs(size - (heights.get(id) ?? 0)) > 0.5) heights.set(id, size);
      });
    });
    observer.observe(node);
    return { destroy() { alive = false; cancelAnimationFrame(frame); observer.disconnect(); } };
  }

  $effect(() => {
    const target = scroller;
    if (!target || !list) return;
    const observer = new ResizeObserver(() => viewport());
    observer.observe(target);
    observedScrollTop = target.scrollTop;
    const scroll = () => {
      observedScrollTop = target.scrollTop;
      const own = programmedScroll !== null && Math.abs(target.scrollTop - programmedScroll) < 1;
      programmedScroll = null;
      viewport(!own);
      if (!own) onScroll();
    };
    target.addEventListener('scroll', scroll, { passive: true });
    untrack(viewport);
    return () => { observer.disconnect(); target.removeEventListener('scroll', scroll); };
  });

  $effect(() => {
    const layout = offsets;
    const current = items;
    const target = scroller;
    const wasFollowing = lastFollow ?? follow;
    const saved = anchor;
    lastFollow = follow;
    if (!target || !list) return;
    untrack(() => {
      if ((wasFollowing && !follow) || target.scrollTop < observedScrollTop - 0.5) return;
      if (follow) target.scrollTop = target.scrollHeight;
      else if (saved) {
        const index = current.findIndex(item => item.id === saved.id);
        if (index >= 0) target.scrollTop = listTop() + layout[index] - saved.y;
      }
      observedScrollTop = target.scrollTop;
      programmedScroll = observedScrollTop;
      viewport();
    });
  });
</script>

<div class="virtual-agent-history" bind:this={list} style:height={`${offsets.at(-1) ?? 0}px`}>
  {#each items.slice(range.start, range.end) as item, index (item.id)}
    <div class="virtual-agent-row" style:top={`${offsets[range.start + index] ?? 0}px`} use:measure={item.id} data-turn-id={item.id}>
      {@render children(item)}
    </div>
  {/each}
</div>

<style>
  .virtual-agent-history { position: relative; flex: 0 0 auto; min-width: 0; overflow-anchor: none; }
  .virtual-agent-row { position: absolute; left: 0; right: 0; padding-bottom: calc(var(--space-4) + var(--space-5)); }
</style>
