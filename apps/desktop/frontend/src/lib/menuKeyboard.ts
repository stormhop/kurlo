function menuItems(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
}

export function focusFirstMenuItem(menu: HTMLElement | undefined) {
  if (menu) menuItems(menu)[0]?.focus();
}

export function handleMenuKeydown(event: KeyboardEvent, close: () => void) {
  const menu = event.currentTarget;
  if (!(menu instanceof HTMLElement)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    const items = menuItems(menu);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (Math.max(index, 0) - 1 + items.length) % items.length;
    items[next]?.focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    event.stopPropagation();
    const items = menuItems(menu);
    if (!items.length) return;
    (event.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
  }
}
