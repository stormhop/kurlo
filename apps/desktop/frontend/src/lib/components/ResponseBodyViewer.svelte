<script lang="ts">
  import { flushSync } from 'svelte';
  import { uiScale } from '../uiScale';
  import {
    buildResponseMatchOffsets,
    renderResponseBodyLine,
    responseMatchLine,
    type ResponseRenderMode,
  } from '../response-render';
  import { responseFoldRegions, unfoldAround, visibleResponseLines } from '../responseFolding';

  const BASE_LINE_HEIGHT = 20;
  const VIRTUAL_OVERSCAN = 600;
  const SCROLL_THUMB_MIN = 42;

  let {
    source,
    mode,
    search,
    searchIndex,
    virtualized,
    page,
    folded = $bindable(new Set<number>()),
    wrap = true,
  }: {
    source: string;
    mode: ResponseRenderMode;
    search: string;
    searchIndex: number;
    virtualized: boolean;
    page: number;
    folded?: Set<number>;
    wrap?: boolean;
  } = $props();

  let lineHeight = $derived(BASE_LINE_HEIGHT * $uiScale);
  let scrollQuantum = $derived(lineHeight * 4);
  let keyboardLineStep = $derived(lineHeight * 2);
  let viewer: HTMLDivElement | undefined;
  let scrollTop = $state(0);
  let viewportHeight = $state(300);
  let lastPage = $state<number | null>(null);
  let lastSource = $state<string | null>(null);
  let metrics = $state({ top: 0, scrollHeight: 0, clientHeight: 0 });
  let drag: { pointerId: number; startY: number; startTop: number } | null = null;
  let dragging = $state(false);

  let rawLines = $derived(source.split(/\r\n|\r|\n/));
  let foldRegions = $derived(responseFoldRegions(source, mode));
  let displayLines = $derived(visibleResponseLines(rawLines.length, foldRegions, folded));
  let matchOffsets = $derived(buildResponseMatchOffsets(rawLines, search));
  let currentMatchLine = $derived(responseMatchLine(matchOffsets, searchIndex));
  let virtualWindow = $derived.by(() => {
    if (!virtualized) return { start: 0, end: displayLines.length, before: 0, after: 0 };
    const start = Math.max(0, Math.floor((scrollTop - VIRTUAL_OVERSCAN) / lineHeight));
    const end = Math.min(
      displayLines.length,
      Math.ceil((scrollTop + viewportHeight + VIRTUAL_OVERSCAN) / lineHeight),
    );
    return {
      start,
      end,
      before: start * lineHeight,
      after: Math.max(0, (displayLines.length - end) * lineHeight),
    };
  });
  let visibleLines = $derived.by(() => displayLines
    .slice(virtualWindow.start, virtualWindow.end)
    .map(index => {
      const rendered = renderResponseBodyLine(
        rawLines[index],
        index + 1,
        mode,
        search,
        { value: matchOffsets[index] ?? 0 },
        searchIndex,
      );
      const region = foldRegions.get(index);
      if (!region) return { ...rendered, region: null, isFolded: false };
      const isFolded = folded.has(index);
      if (!isFolded) return { ...rendered, region, isFolded };
      const tail = renderResponseBodyLine(
        rawLines[region.end].trim(),
        region.end + 1,
        mode,
        '',
        { value: 0 },
        -1,
      );
      return {
        ...rendered,
        region,
        isFolded,
        html: `${rendered.html}<span class="rsp-fold-placeholder" data-fold-line="${index}">⋯</span>${tail.html}`,
      };
    }));

  function setFolded(line: number, fold: boolean) {
    folded = new Set(fold ? [...folded, line] : [...folded].filter(start => start !== line));
  }

  function onViewerClick(event: MouseEvent) {
    const placeholder = (event.target as HTMLElement | null)?.closest<HTMLElement>('.rsp-fold-placeholder');
    if (!placeholder) return;
    const line = Number(placeholder.dataset.foldLine);
    if (Number.isFinite(line)) setFolded(line, false);
  }

  let scrollThumb = $derived.by(() => {
    const { top, scrollHeight, clientHeight } = metrics;
    if (!virtualized || clientHeight <= 0 || scrollHeight <= clientHeight + 1) return null;
    const size = Math.min(clientHeight, Math.max(SCROLL_THUMB_MIN, Math.round((clientHeight * clientHeight) / scrollHeight)));
    const range = scrollHeight - clientHeight;
    return { size, offset: (Math.min(range, Math.max(0, top)) / range) * (clientHeight - size), track: clientHeight };
  });

  function measure(node: HTMLDivElement) {
    metrics = { top: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
  }

  function quantizedScrollTop(top: number) {
    return Math.floor(top / scrollQuantum) * scrollQuantum;
  }

  function scrollViewerTo(top: number) {
    if (!viewer) return;
    viewer.scrollTop = Math.max(0, Math.min(top, viewer.scrollHeight - viewer.clientHeight));
    scrollTop = quantizedScrollTop(viewer.scrollTop);
    measure(viewer);
    flushSync();
  }

  function onThumbPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !viewer) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {}
    drag = { pointerId: event.pointerId, startY: event.clientY, startTop: viewer.scrollTop };
    dragging = true;
  }

  function onThumbPointerMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId || !viewer || !scrollThumb) return;
    const travel = scrollThumb.track - scrollThumb.size;
    if (travel <= 0) return;
    const range = viewer.scrollHeight - viewer.clientHeight;
    scrollViewerTo(drag.startTop + ((event.clientY - drag.startY) * range) / travel);
  }

  function endThumbDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    dragging = false;
  }

  function onTrackPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !viewer || !scrollThumb) return;
    event.preventDefault();
    const trackTop = (event.currentTarget as HTMLElement).getBoundingClientRect().top;
    const page = viewer.clientHeight * 0.9;
    const above = event.clientY - trackTop < scrollThumb.offset;
    scrollViewerTo(viewer.scrollTop + (above ? -page : page));
  }

  function wheelDelta(delta: number, deltaMode: number) {
    if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * lineHeight;
    if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * (viewer?.clientHeight ?? viewportHeight);
    return delta;
  }

  function onWheel(event: WheelEvent) {
    if (!virtualized || !viewer || event.ctrlKey) return;
    event.preventDefault();
    let dy = wheelDelta(event.deltaY, event.deltaMode);
    let dx = wheelDelta(event.deltaX, event.deltaMode);
    if (event.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    if (dx !== 0) viewer.scrollLeft += dx;
    if (dy !== 0) scrollViewerTo(viewer.scrollTop + dy);
  }

  function ownWheel(node: HTMLElement) {
    node.addEventListener('wheel', onWheel, { passive: false });
    return {
      destroy() {
        node.removeEventListener('wheel', onWheel);
      },
    };
  }

  function keyboardScrollTarget(event: KeyboardEvent, node: HTMLElement): number | null {
    if (event.altKey) return null;
    const command = event.metaKey || event.ctrlKey;
    const page = Math.max(lineHeight, node.clientHeight - keyboardLineStep);
    const bottom = node.scrollHeight - node.clientHeight;
    switch (event.key) {
      case 'ArrowDown':
        return command ? bottom : event.shiftKey ? null : node.scrollTop + keyboardLineStep;
      case 'ArrowUp':
        return command ? 0 : event.shiftKey ? null : node.scrollTop - keyboardLineStep;
      case 'PageDown':
        return command ? null : node.scrollTop + page;
      case 'PageUp':
        return command ? null : node.scrollTop - page;
      case ' ':
        return command ? null : node.scrollTop + (event.shiftKey ? -page : page);
      case 'End':
        return event.shiftKey ? null : bottom;
      case 'Home':
        return event.shiftKey ? null : 0;
      default:
        return null;
    }
  }

  function trackViewport(node: HTMLDivElement) {
    viewer = node;
    const update = () => {
      viewportHeight = node.clientHeight || 300;
      measure(node);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    node.addEventListener('wheel', onWheel, { passive: false });
    return {
      destroy() {
        node.removeEventListener('wheel', onWheel);
        observer.disconnect();
        if (viewer === node) viewer = undefined;
      },
    };
  }

  function onScroll(event: Event) {
    const node = event.currentTarget as HTMLDivElement;
    if (!virtualized) return;
    measure(node);
    const next = quantizedScrollTop(node.scrollTop);
    if (next !== scrollTop) scrollTop = next;
  }

  function onKeydown(event: KeyboardEvent) {
    if (virtualized) {
      const target = keyboardScrollTarget(event, event.currentTarget as HTMLElement);
      if (target !== null) {
        event.preventDefault();
        scrollViewerTo(target);
        return;
      }
    }
    if (event.altKey || (!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== 'a') return;
    const selection = window.getSelection();
    if (!selection) return;
    event.preventDefault();
    event.stopPropagation();
    const range = document.createRange();
    range.selectNodeContents(event.currentTarget as HTMLElement);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  $effect(() => {
    if (lastPage === null && lastSource === null) {
      lastPage = page;
      lastSource = source;
      return;
    }
    if (page === lastPage && source === lastSource) return;
    lastPage = page;
    lastSource = source;
    if (folded.size) folded = new Set();
    scrollTop = 0;
    if (viewer) viewer.scrollTop = 0;
  });

  $effect(() => {
    if (displayLines.length >= 0 && virtualized && viewer) measure(viewer);
  });

  $effect(() => {
    const line = currentMatchLine;
    if (line < 0 || !folded.size) return;
    const next = unfoldAround(line, foldRegions, folded);
    if (next !== folded) folded = next;
  });

  $effect(() => {
    const line = currentMatchLine;
    if (line < 0 || !viewer) return;
    if (virtualized) {
      const position = displayLines.indexOf(line);
      if (position < 0) return;
      const targetTop = position * lineHeight;
      const targetBottom = targetTop + lineHeight;
      if (targetTop < viewer.scrollTop || targetBottom > viewer.scrollTop + viewer.clientHeight) {
        const nextTop = Math.max(0, targetTop - Math.floor(viewer.clientHeight / 2));
        viewer.scrollTop = nextTop;
        scrollTop = nextTop;
      }
    }
    queueMicrotask(() => viewer?.querySelector('.rsp-search-current')?.scrollIntoView({
      block: 'center',
      inline: 'nearest',
    }));
  });
</script>

{#snippet foldToggle(line: { number: number; region: { start: number; end: number } | null; isFolded: boolean })}
  {#if line.region}
    <button
      class="response-fold-toggle"
      class:folded={line.isFolded}
      type="button"
      tabindex="-1"
      aria-expanded={!line.isFolded}
      aria-label={`${line.isFolded ? 'Unfold' : 'Fold'} lines ${line.region.start + 1}–${line.region.end + 1}`}
      onmousedown={event => event.preventDefault()}
      onclick={event => { event.stopPropagation(); setFolded(line.region!.start, !line.isFolded); }}
    >
      <svg width="0.5rem" height="0.5rem" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M1.5 2.75L4 5.25l2.5-2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  {/if}
{/snippet}

<div class="response-body-frame">
  <div
    bind:this={viewer}
    class="response-body-viewer"
    class:virtualized
    class:nowrap={!wrap && !virtualized}
    data-virtualized={virtualized ? 'true' : undefined}
    role="textbox"
    aria-label="Response body"
    aria-readonly="true"
    aria-multiline="true"
    tabindex="0"
    use:trackViewport
    onscroll={onScroll}
    onkeydown={onKeydown}
    onclick={onViewerClick}
  >
    {#if virtualized}
      <div class="response-virtual" style={`height: ${displayLines.length * lineHeight}px`}>
        <div class="response-gutter">
          <div class="response-lines-spacer" style={`height: ${virtualWindow.before}px`}></div>
          {#each visibleLines as line (line.number)}
            <div class="response-line-no" data-line-number={line.number}><span aria-hidden="true">{line.number}</span>{@render foldToggle(line)}</div>
          {/each}
        </div>
        <div class="response-virtual-code">
          <div class="response-lines-spacer" style={`height: ${virtualWindow.before}px`}></div>
          {#each visibleLines as line (line.number)}
            <div class="response-line" data-line-number={line.number}>
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              <code class="response-line-code">{@html line.html}</code>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      {#each visibleLines as line (line.number)}
        <div class="response-line" data-line-number={line.number}>
          <span class="response-line-no"><span>{line.number}</span>{@render foldToggle(line)}</span>
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          <code class="response-line-code">{@html line.html}</code>
        </div>
      {/each}
    {/if}
  </div>
  {#if scrollThumb}
    <div
      class="response-vscroll"
      aria-hidden="true"
      style={`height: ${scrollThumb.track}px`}
      onpointerdown={onTrackPointerDown}
      use:ownWheel
    >
      <div
        class="response-vscroll-thumb"
        aria-hidden="true"
        class:dragging
        style={`height: ${scrollThumb.size}px; transform: translateY(${scrollThumb.offset}px)`}
        onpointerdown={onThumbPointerDown}
        onpointermove={onThumbPointerMove}
        onpointerup={endThumbDrag}
        onpointercancel={endThumbDrag}
      ></div>
    </div>
  {/if}
</div>
