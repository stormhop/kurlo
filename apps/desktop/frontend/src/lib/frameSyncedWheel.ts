import { flushSync } from 'svelte';

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const LINE_HEIGHT = 32;

export function wheelPixelsY(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>, pageHeight: number): number {
  if (event.deltaMode === DOM_DELTA_LINE) return event.deltaY * LINE_HEIGHT;
  if (event.deltaMode === DOM_DELTA_PAGE) return event.deltaY * pageHeight;
  return event.deltaY;
}

export function frameSyncedWheel(node: HTMLElement, onScroll: () => void) {
  let sync = onScroll;
  let pending = 0;
  let frame = 0;

  const apply = () => {
    frame = 0;
    const dy = pending;
    pending = 0;
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    const next = Math.max(0, Math.min(node.scrollTop + dy, max));
    if (next === node.scrollTop) return;
    node.scrollTop = next;
    sync();
    flushSync();
  };

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.shiftKey) return;
    if (node.scrollHeight <= node.clientHeight) return;
    const dy = wheelPixelsY(event, node.clientHeight);
    if (dy === 0) return;
    event.preventDefault();
    pending += dy;
    if (!frame) frame = requestAnimationFrame(apply);
  };

  node.addEventListener('wheel', onWheel, { passive: false });
  return {
    update(next: () => void) {
      sync = next;
    },
    destroy() {
      node.removeEventListener('wheel', onWheel);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = 0;
    },
  };
}
