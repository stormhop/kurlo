const TITLEBAR_DRAG_REGION = '.titlebar-drag-region';

const INTERACTIVE_TITLEBAR_TARGET = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="tab"]',
  '.workspace-menu',
  '.environment-menu',
].join(', ');

function isTitlebarDoubleClickTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (!target.closest(TITLEBAR_DRAG_REGION)) return false;
  return !target.closest(INTERACTIVE_TITLEBAR_TARGET);
}

function toggleWindowMaximise() {
  void window.runtime?.WindowToggleMaximise?.();
}

export function installTitlebarDoubleClickHandler() {
  const onDoubleClick = (event: MouseEvent) => {
    if (isTitlebarDoubleClickTarget(event.target)) toggleWindowMaximise();
  };
  document.addEventListener('dblclick', onDoubleClick);
  return () => document.removeEventListener('dblclick', onDoubleClick);
}

export function isQuitShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>) {
  return event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key.toLowerCase() === 'q';
}

export function installQuitShortcut(platform: string) {
  if (platform !== 'linux') return () => {};
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isQuitShortcut(event)) return;
    event.preventDefault();
    void window.runtime?.Quit?.();
  };
  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}
