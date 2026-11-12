const MENU_GAP_PX = 2;

function clearPlacement(node: HTMLElement) {
  for (const property of ['position', 'top', 'bottom', 'left', 'right']) node.style.removeProperty(property);
}

export function placeFloatingMenu(node: HTMLElement, anchor: DOMRect, viewport: { width: number; height: number }) {
  const height = node.offsetHeight;
  const spaceBelow = viewport.height - anchor.bottom;
  const openUp = spaceBelow < height + MENU_GAP_PX && anchor.top > spaceBelow;
  node.style.position = 'fixed';
  node.style.left = 'auto';
  node.style.right = `${Math.max(0, viewport.width - anchor.right)}px`;
  if (openUp) {
    node.style.top = 'auto';
    node.style.bottom = `${Math.max(0, viewport.height - anchor.top + MENU_GAP_PX)}px`;
  } else {
    node.style.bottom = 'auto';
    node.style.top = `${anchor.bottom + MENU_GAP_PX}px`;
  }
}

export function floatingMenu(node: HTMLElement, enabled: boolean) {
  let active = enabled;
  const place = () => {
    const anchor = node.parentElement;
    if (!active || !anchor) return;
    placeFloatingMenu(node, anchor.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
  };
  place();
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
  return {
    update(next: boolean) {
      active = next;
      if (active) place();
      else clearPlacement(node);
    },
    destroy() {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    },
  };
}
