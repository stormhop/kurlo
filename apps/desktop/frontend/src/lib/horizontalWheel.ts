export function horizontalWheelDelta(event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>, lineWidth: number, pageWidth: number): number {
  const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (event.deltaMode === 1) return delta * lineWidth;
  if (event.deltaMode === 2) return delta * pageWidth;
  return delta;
}

export function nextHorizontalScroll(scrollLeft: number, scrollWidth: number, clientWidth: number, delta: number): number | null {
  const max = Math.max(0, scrollWidth - clientWidth);
  if (max <= 0 || delta === 0) return null;
  const next = Math.min(max, Math.max(0, scrollLeft + delta));
  return next === scrollLeft ? null : next;
}

export function horizontalWheel(node: HTMLElement, onScroll?: () => void) {
  function onWheel(event: WheelEvent) {
    if (event.ctrlKey || event.metaKey) return;
    const lineWidth = Number.parseFloat(getComputedStyle(node).fontSize) || 16;
    const delta = horizontalWheelDelta(event, lineWidth, node.clientWidth);
    const next = nextHorizontalScroll(node.scrollLeft, node.scrollWidth, node.clientWidth, delta);
    if (next === null) return;
    event.preventDefault();
    node.scrollLeft = next;
    onScroll?.();
  }
  node.addEventListener('wheel', onWheel, { passive: false });
  return {
    destroy() {
      node.removeEventListener('wheel', onWheel);
    },
  };
}
