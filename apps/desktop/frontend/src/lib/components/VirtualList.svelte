<script lang="ts" generics="T extends VirtualRow">
  import { untrack, type Snippet } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { anchorOffset, canGrowWindow, createRowMeasurer, rowAnchor, virtualOverscan, virtualizeRows, windowScrollTop, type RowAnchor, type VirtualRow } from '../sidebarVirtual';
  import { WindowGrowth } from '../windowGrowth.svelte';
  import { onShellResize } from '../shellResize';
  import { uiScale } from '../uiScale';
  import BirdSpinner from './BirdSpinner.svelte';

  let {
    rows,
    row,
    rowHeight,
    scroller = undefined,
    className = '',
    role = undefined,
    ariaLabel = undefined,
    growLimit = 240,
    loadingMore = false,
    hasMore = false,
    onEndReached = undefined,
    footer = undefined,
    loadingLabel = 'Loading more',
  }: {
    rows: T[];
    row: Snippet<[T]>;
    rowHeight: number;
    scroller?: HTMLElement;
    className?: string;
    role?: string;
    ariaLabel?: string;
    growLimit?: number;
    loadingMore?: boolean;
    hasMore?: boolean;
    onEndReached?: () => void;
    footer?: Snippet;
    loadingLabel?: string;
  } = $props();

  let listEl = $state<HTMLElement | undefined>();
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  const heights = new SvelteMap<string, number>();
  const measure = createRowMeasurer(heights);
  const scrollEl = $derived(scroller ?? listEl);
  const overscan = $derived(virtualOverscan(viewportHeight, 8 * rowHeight * $uiScale));
  const growth = new WindowGrowth((): boolean => canGrowWindow(visible, growLimit));
  const visible = $derived(virtualizeRows(rows, scrollTop, viewportHeight, overscan, rowHeight * $uiScale, heights, $uiScale, growth.extra));

  $effect.pre(() => {
    const keys = rows.map(item => item.key);
    untrack(() => growth.rowsChanged(keys));
  });

  $effect(() => {
    growth.rendered(visible.rows.map(item => item.key));
  });

  $effect(() => () => growth.destroy());

  $effect(() => onShellResize(() => growth.resized()));

  let anchor: RowAnchor | null = null;
  let anchoring = false;
  let anchoredTop = 0;
  let listWidth = 0;

  function noteWidth(el: HTMLElement) {
    const width = el.clientWidth;
    if (width === listWidth) return;
    if (listWidth > 0) {
      anchoring = anchor !== null;
      growth.resized();
    }
    listWidth = width;
  }

  function captureAnchor(el: HTMLElement) {
    anchor = rowAnchor(rows, Math.max(0, el.scrollTop - listOffset()), heights, $uiScale);
  }

  function holdAnchor() {
    const el = scrollEl;
    if (!el) return;
    noteWidth(el);
    const target = anchoring && anchor ? anchorOffset(rows, anchor, heights, $uiScale) : null;
    if (target === null) {
      anchoring = false;
      captureAnchor(el);
      return;
    }
    const desired = target + listOffset();
    if (Math.abs(el.scrollTop - desired) >= 1) el.scrollTop = desired;
    anchoredTop = el.scrollTop;
  }

  function listOffset() {
    if (!scroller || !listEl) return 0;
    return listEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  function sync(force = true) {
    const el = scrollEl;
    if (!el) return;
    viewportHeight = el.clientHeight;
    const top = Math.max(0, el.scrollTop - listOffset());
    scrollTop = windowScrollTop(scrollTop, top, overscan, force);
    checkEnd();
  }

  function checkEnd() {
    const el = scrollEl;
    if (!el || !onEndReached || !hasMore || loadingMore) return;
    const bottom = listOffset() + visible.totalHeight;
    if (el.scrollTop + el.clientHeight >= bottom - Math.max(el.clientHeight, 1) * 1.5) onEndReached();
  }

  function onScroll() {
    const el = scrollEl;
    if (!el) return;
    if (!anchoring || Math.abs(el.scrollTop - anchoredTop) >= 1) {
      anchoring = false;
      captureAnchor(el);
    }
    const top = Math.max(0, el.scrollTop - listOffset());
    growth.scrolled(top, el.clientHeight, visible.before, visible.totalHeight - visible.after);
    sync(false);
  }

  $effect(() => {
    const el = scrollEl;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      noteWidth(el);
      sync();
    });
    observer.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  });

  $effect(() => {
    visible;
    untrack(holdAnchor);
  });

  $effect(() => {
    rows.length;
    hasMore;
    loadingMore;
    requestAnimationFrame(() => sync());
  });
</script>

<div class="virtual-list {className}" class:own-scroll={!scroller} bind:this={listEl} {role} aria-label={ariaLabel}>
  <div class="virtual-list-spacer" style={`height: ${visible.before}px`}></div>
  {#each visible.rows as item (item.key)}
    <div class="virtual-list-row" use:measure={item.key}>{@render row(item)}</div>
  {/each}
  <div class="virtual-list-spacer" style={`height: ${visible.after}px`}></div>
  {#if footer}{@render footer()}{/if}
  {#if loadingMore}
    <div class="virtual-list-more"><BirdSpinner size="1.5rem" label={loadingLabel} /></div>
  {/if}
</div>

<style>
  .virtual-list {
    position: relative;
    z-index: 0;
    min-width: 0;
  }
  .virtual-list.own-scroll {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: none;
    overflow-anchor: none;
  }
  .virtual-list:has(:global(.menu)) {
    z-index: auto;
  }
  .virtual-list-spacer {
    pointer-events: none;
  }
  .virtual-list-row {
    min-width: 0;
  }
  .virtual-list-more {
    display: flex;
    justify-content: center;
    padding: var(--space-3) 0;
  }
</style>
