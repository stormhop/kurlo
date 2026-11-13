export type VirtualRow = { key: string; height: number };
export type VirtualWindow<T extends VirtualRow> = { rows: T[]; before: number; after: number; totalHeight: number };

export function virtualizeRows<T extends VirtualRow>(
  rows: T[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
  minViewport: number,
  measured?: Map<string, number>,
  scale = 1,
  extraRows = 0,
): VirtualWindow<T> {
  const top = Math.max(0, scrollTop - overscan);
  const bottom = scrollTop + Math.max(viewportHeight, minViewport) + overscan;
  const heightOf = (row: T) => measured?.get(row.key) ?? row.height * scale;
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  let first = -1;
  let last = -1;
  for (let index = 0; index < rows.length; index++) {
    const rowTop = offsets[index];
    const rowBottom = rowTop + heightOf(rows[index]);
    offsets[index + 1] = rowBottom;
    if (rowBottom >= top && rowTop <= bottom) {
      if (first < 0) first = index;
      last = index;
    }
  }
  const totalHeight = offsets[rows.length];
  if (first < 0) return { rows: [], before: 0, after: totalHeight, totalHeight };
  let budget = Math.max(0, Math.floor(extraRows));
  const above = Math.min(first, Math.ceil(budget / 2));
  first -= above;
  budget -= above;
  const below = Math.min(rows.length - 1 - last, budget);
  last += below;
  budget -= below;
  first -= Math.min(first, budget);
  return {
    rows: rows.slice(first, last + 1),
    before: offsets[first],
    after: totalHeight - offsets[last + 1],
    totalHeight,
  };
}

export const GROWN_ROW_LIMIT = 600;

export function canGrowWindow(window: { rows: unknown[]; before: number; after: number }, limit = GROWN_ROW_LIMIT): boolean {
  if (window.rows.length >= limit) return false;
  return window.before > 0 || window.after > 0;
}

export function keptRowCount(renderedKeys: Iterable<string>, currentKeys: string[]): number {
  const keys = new Set(currentKeys);
  let kept = 0;
  for (const key of renderedKeys) if (keys.has(key)) kept++;
  return kept;
}

export function createWindowGrower(grow: () => boolean, delay = 32, pauseFor = 200, now = () => Date.now()) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pausedUntil = 0;
  const tick = () => {
    timer = undefined;
    const wait = pausedUntil - now();
    if (wait > 0) {
      timer = setTimeout(tick, wait);
      return;
    }
    if (grow()) timer = setTimeout(tick, delay);
  };
  return {
    start() {
      timer ??= setTimeout(tick, delay);
    },
    pause() {
      pausedUntil = now() + pauseFor;
      timer ??= setTimeout(tick, pauseFor);
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function virtualOverscan(viewportHeight: number, minOverscan: number): number {
  return Math.max(minOverscan, viewportHeight * 1.5);
}

export function windowScrollTop(rendered: number, actual: number, overscan: number, force = false): number {
  if (force || Math.abs(actual - rendered) > overscan / 2) return actual;
  return rendered;
}

export function createRowMeasurer(heights: Map<string, number>) {
  const keys = new WeakMap<Element, string>();
  const record = (node: Element, height: number) => {
    const key = keys.get(node);
    if (key === undefined || !(height > 0) || heights.get(key) === height) return;
    heights.set(key, height);
  };
  let observer: ResizeObserver | null = null;
  const ensureObserver = () => {
    observer ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize?.[0];
        record(entry.target, box ? box.blockSize : entry.target.getBoundingClientRect().height);
      }
    });
    return observer;
  };
  return (node: HTMLElement, key: string) => {
    keys.set(node, key);
    ensureObserver().observe(node);
    return {
      update(nextKey: string) {
        if (keys.get(node) === nextKey) return;
        keys.set(node, nextKey);
        record(node, node.getBoundingClientRect().height);
      },
      destroy() {
        keys.delete(node);
        observer?.unobserve(node);
      },
    };
  };
}
