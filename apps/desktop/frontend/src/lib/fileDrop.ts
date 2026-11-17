import type { RuntimeBridge } from './wire';

type FileDropZone = { element: HTMLElement; onDrop: (paths: string[]) => void };
type FileDropHandler = (paths: string[]) => unknown;

const zones = new Set<FileDropZone>();
let fallback: FileDropHandler | null = null;

export function addFileDropZone(element: HTMLElement, onDrop: FileDropHandler): () => void {
  const zone = { element, onDrop };
  zones.add(zone);
  return () => zones.delete(zone);
}

export function dispatchFileDrop(target: Element | null, dropped: string[]) {
  const paths = dropped.filter(path => path.trim() !== '');
  if (!paths.length) return;
  for (const zone of zones) {
    if (target && zone.element.contains(target)) {
      zone.onDrop(paths);
      return;
    }
  }
  fallback?.(paths);
}

type DropEventHost = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export function blockExternalDropNavigation(host: DropEventHost): () => void {
  let pageDrag = false;
  const onDragStart = () => { pageDrag = true; };
  const onDragEnd = () => { pageDrag = false; };
  const onDragOver = (event: DragEvent) => {
    if (pageDrag) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (event: DragEvent) => {
    if (!pageDrag) event.preventDefault();
    pageDrag = false;
  };
  host.addEventListener('dragstart', onDragStart, true);
  host.addEventListener('dragend', onDragEnd, true);
  host.addEventListener('dragover', onDragOver);
  host.addEventListener('drop', onDrop);
  return () => {
    host.removeEventListener('dragstart', onDragStart, true);
    host.removeEventListener('dragend', onDragEnd, true);
    host.removeEventListener('dragover', onDragOver);
    host.removeEventListener('drop', onDrop);
  };
}

export function installFileDrop(runtime: RuntimeBridge | undefined, onDrop: FileDropHandler, host: DropEventHost = window): () => void {
  fallback = onDrop;
  const root = document.documentElement;
  root.style.setProperty('--wails-drop-target', 'drop');
  const unblock = blockExternalDropNavigation(host);
  if (runtime?.OnFileDrop) {
    runtime.OnFileDrop((x, y, paths) => dispatchFileDrop(document.elementFromPoint(x, y), paths), true);
  }
  return () => {
    if (fallback === onDrop) fallback = null;
    root.style.removeProperty('--wails-drop-target');
    unblock();
    runtime?.OnFileDropOff?.();
  };
}
