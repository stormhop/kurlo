const MENU_GAP_PX = 4;

type Box = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;

let dismissMenus: () => void = () => {};

export function setFloatingMenuDismiss(dismiss: () => void) {
  dismissMenus = dismiss;
}

export function placeFloatingMenu(node: HTMLElement, row: Box, trigger: Box, viewport: { width: number; height: number }) {
  node.style.position = 'fixed';
  node.style.maxHeight = `${Math.max(0, viewport.height - MENU_GAP_PX * 2)}px`;
  node.style.maxWidth = `${Math.max(0, viewport.width - MENU_GAP_PX * 2)}px`;
  node.style.overflowY = 'auto';
  const { width, height } = node.getBoundingClientRect();
  const left = Math.max(MENU_GAP_PX, Math.min(trigger.left, viewport.width - width - MENU_GAP_PX));
  const below = row.bottom + MENU_GAP_PX;
  const above = row.top - height - MENU_GAP_PX;
  const top = below + height <= viewport.height - MENU_GAP_PX || above < MENU_GAP_PX
    ? Math.max(MENU_GAP_PX, Math.min(below, viewport.height - height - MENU_GAP_PX))
    : above;
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.style.right = 'auto';
  node.style.bottom = 'auto';
}

export function rowLeftScrollView(row: Box, view: Box): boolean {
  return row.top < view.top - 1 || row.bottom > view.bottom + 1;
}

function triggerFor(node: HTMLElement, anchor: HTMLElement): HTMLElement {
  const previous = node.previousElementSibling;
  if (previous instanceof HTMLElement && previous.matches('button[aria-label$="menu" i]')) return previous;
  return anchor.querySelector<HTMLElement>(':scope > button[aria-label$="menu" i]') ?? anchor;
}

function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let current = node.parentElement; current; current = current.parentElement) {
    const { overflowY } = getComputedStyle(current);
    if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) return current;
  }
  return null;
}

export function floatingMenu(node: HTMLElement) {
  const anchor = node.parentElement;
  if (!anchor) return {};
  const trigger = triggerFor(node, anchor);
  const scroller = scrollParent(anchor);
  const place = () => {
    const row = anchor.getBoundingClientRect();
    placeFloatingMenu(node, row, trigger.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
  };
  const onScroll = (event: Event) => {
    if (event.target instanceof Node && node.contains(event.target)) return;
    if (scroller && rowLeftScrollView(anchor.getBoundingClientRect(), scroller.getBoundingClientRect())) {
      dismissMenus();
      return;
    }
    place();
  };
  place();
  const observer = new ResizeObserver(place);
  observer.observe(node);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', place);
  return {
    destroy() {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    },
  };
}
