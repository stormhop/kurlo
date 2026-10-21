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
