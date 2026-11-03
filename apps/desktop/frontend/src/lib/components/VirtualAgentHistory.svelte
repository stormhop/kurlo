<script lang="ts" generics="T extends { id: string }">
  import { tick, untrack, type Snippet } from 'svelte';
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
  let revision = 0;
  let programmedScroll: number | null = null;

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
    const scroll = () => {
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
    const following = follow;
    const saved = anchor;
    const version = ++revision;
    let cancelled = false;
    void tick().then(() => {
      if (cancelled || !target || version !== revision) return;
      if (following) target.scrollTop = target.scrollHeight;
      else if (saved) {
        const index = current.findIndex(item => item.id === saved.id);
        if (index >= 0) target.scrollTop = listTop() + layout[index] - saved.y;
      }
      programmedScroll = target.scrollTop;
      viewport();
    });
    return () => { cancelled = true; };
  });
</script>

<div class="virtual-agent-history" bind:this={list} style:padding-top={`${offsets[range.start] ?? 0}px`} style:padding-bottom={`${(offsets.at(-1) ?? 0) - (offsets[range.end] ?? 0)}px`}>
  {#each items.slice(range.start, range.end) as item (item.id)}
    <div class="virtual-agent-row" use:measure={item.id} data-turn-id={item.id}>
      {@render children(item)}
    </div>
  {/each}
</div>

<style>
  .virtual-agent-history { flex: 0 0 auto; min-width: 0; overflow-anchor: none; }
  .virtual-agent-row { display: flow-root; min-width: 0; padding-bottom: calc(var(--space-4) + var(--space-5)); }
</style>
