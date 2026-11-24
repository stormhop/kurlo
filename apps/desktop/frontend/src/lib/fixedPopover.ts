const GAP_PX = 10;
const EDGE_PX = 8;

export function placeFixedPopover(anchor: { left: number; top: number; bottom: number }, popover: { width: number; height: number }, viewport: { width: number; height: number }) {
  const left = Math.max(EDGE_PX, Math.min(anchor.left, viewport.width - popover.width - EDGE_PX));
  const below = anchor.bottom + GAP_PX;
  const top = below + popover.height > viewport.height - EDGE_PX && anchor.top - GAP_PX - popover.height >= EDGE_PX
    ? anchor.top - GAP_PX - popover.height
    : below;
  return { left, top };
}

export function fixedPopover(node: HTMLElement) {
  let frame = 0;
  const place = () => {
    const popover = node.querySelector<HTMLElement>(':scope > [role="tooltip"]');
    if (!popover) return;
    const anchor = node.getBoundingClientRect();
    popover.style.left = `${anchor.left}px`;
    popover.style.top = `${anchor.bottom + GAP_PX}px`;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const { left, top } = placeFixedPopover(anchor, { width: popover.offsetWidth, height: popover.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;
    });
  };
  node.addEventListener('pointerenter', place);
  node.addEventListener('focusin', place);
  return {
    destroy() {
      cancelAnimationFrame(frame);
      node.removeEventListener('pointerenter', place);
      node.removeEventListener('focusin', place);
    },
  };
}
