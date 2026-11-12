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
): VirtualWindow<T> {
  const top = Math.max(0, scrollTop - overscan);
  const bottom = scrollTop + Math.max(viewportHeight, minViewport) + overscan;
  const heightOf = (row: T) => measured?.get(row.key) ?? row.height * scale;
  const visible: T[] = [];
  let before = 0;
  let after: number;
  let offset = 0;
  let firstVisible = true;

  for (const row of rows) {
    const rowTop = offset;
    const rowBottom = rowTop + heightOf(row);
    if (rowBottom >= top && rowTop <= bottom) {
      if (firstVisible) {
        before = rowTop;
        firstVisible = false;
      }
      visible.push(row);
    }
    offset = rowBottom;
  }
  if (visible.length) {
    const visibleHeight = visible.reduce((total, row) => total + heightOf(row), 0);
    after = Math.max(0, offset - before - visibleHeight);
  } else {
    before = 0;
    after = offset;
  }
  return { rows: visible, before, after, totalHeight: offset };
}

export function virtualOverscan(viewportHeight: number, minOverscan: number): number {
  return Math.max(minOverscan, viewportHeight);
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
