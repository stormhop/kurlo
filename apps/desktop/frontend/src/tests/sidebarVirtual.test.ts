import { describe, it, expect, vi, afterEach } from 'vitest';
import { anchorOffset, canGrowWindow, createRowMeasurer, createWindowGrower, GROWN_ROW_LIMIT, keptRowCount, rowAnchor, virtualOverscan, virtualizeRows, windowScrollTop, type VirtualRow } from '../lib/sidebarVirtual';

const OVERSCAN = 60;
const MIN = 30;

function rows(heights: number[]): VirtualRow[] {
  return heights.map((height, i) => ({ key: `r${i}`, height }));
}

function uniform(count: number, height: number): VirtualRow[] {
  return rows(Array.from({ length: count }, () => height));
}

describe('virtualizeRows', () => {
  it('reports the full content height regardless of scroll position', () => {
    const list = uniform(100, 30);
    const total = 100 * 30;
    for (const scrollTop of [0, 750, 1500, 2700]) {
      const win = virtualizeRows(list, scrollTop, 300, OVERSCAN, MIN);
      expect(win.totalHeight).toBe(total);
    }
  });

  it('keeps before + visible + after === totalHeight at every scroll position (no gaps, no overlap)', () => {
    const list = rows([200, 30, 30, 124, 30, 30, 58, 30, 30, 30, 30, 78, 30, 30, 30, 30, 30, 30]);
    const total = list.reduce((t, r) => t + r.height, 0);
    for (let scrollTop = 0; scrollTop <= total; scrollTop += 17) {
      const win = virtualizeRows(list, scrollTop, 250, OVERSCAN, MIN);
      const visibleHeight = win.rows.reduce((t, r) => t + r.height, 0);
      expect(win.before + visibleHeight + win.after).toBe(total);
      expect(win.before).toBeGreaterThanOrEqual(0);
      expect(win.after).toBeGreaterThanOrEqual(0);
    }
  });

  it('renders the top rows with no leading spacer at scrollTop 0', () => {
    const win = virtualizeRows(uniform(100, 30), 0, 300, OVERSCAN, MIN);
    expect(win.before).toBe(0);
    expect(win.rows[0].key).toBe('r0');
  });

  it('renders the last rows with zero trailing spacer at the bottom (no phantom panel)', () => {
    const list = uniform(100, 30);
    const total = 100 * 30;
    const viewport = 300;
    const win = virtualizeRows(list, total - viewport, viewport, OVERSCAN, MIN);
    expect(win.rows.at(-1)!.key).toBe('r99');
    expect(win.after).toBe(0);
  });

  it('uses measured heights instead of estimates, so spacers match the real DOM', () => {
    const list = uniform(10, 30);
    const measured = new Map(list.map(r => [r.key, 80]));
    const win = virtualizeRows(list, 0, 250, OVERSCAN, MIN, measured);
    expect(win.totalHeight).toBe(10 * 80);
  });

  it('mixes measured and estimated heights during progressive measurement', () => {
    const list = uniform(10, 30);
    const measured = new Map<string, number>();
    measured.set('r0', 100);
    measured.set('r1', 100);
    const win = virtualizeRows(list, 0, 250, OVERSCAN, MIN, measured);
    expect(win.totalHeight).toBe(2 * 100 + 8 * 30);
  });

  it('eliminates the phantom panel when an estimate over-counted the real height', () => {
    const list = rows([124, 124, 124, 124, 124]);
    const measured = new Map(list.map(r => [r.key, 80]));
    const viewport = 200;
    const total = 5 * 80;
    const win = virtualizeRows(list, total - viewport, viewport, OVERSCAN, MIN, measured);
    expect(win.totalHeight).toBe(total);
    expect(win.rows.at(-1)!.key).toBe('r4');
    expect(win.after).toBe(0);
  });

  it('handles an empty list', () => {
    const win = virtualizeRows([], 0, 300, OVERSCAN, MIN);
    expect(win).toEqual({ rows: [], before: 0, after: 0, totalHeight: 0 });
  });

  it('includes overscan rows above and below the viewport', () => {
    const list = uniform(100, 30);
    const noOverscan = virtualizeRows(list, 900, 300, 0, MIN);
    const withOverscan = virtualizeRows(list, 900, 300, OVERSCAN, MIN);
    expect(withOverscan.rows.length).toBeGreaterThan(noOverscan.rows.length);
  });
});

describe('scrolling the window', () => {
  const viewport = 600;
  const overscan = virtualOverscan(viewport, 240);

  it('keeps a viewport and a half rendered beyond each edge', () => {
    expect(virtualOverscan(600, 240)).toBe(900);
    expect(virtualOverscan(100, 240)).toBe(240);
  });

  it('keeps the rendered window while the viewport stays inside its buffer', () => {
    expect(windowScrollTop(1000, 1000 + overscan / 2, overscan)).toBe(1000);
    expect(windowScrollTop(1000, 1000 - overscan / 2, overscan)).toBe(1000);
  });

  it('moves the window once the viewport leaves half of its buffer', () => {
    expect(windowScrollTop(1000, 1000 + overscan / 2 + 1, overscan)).toBe(1000 + overscan / 2 + 1);
    expect(windowScrollTop(1000, 0, overscan)).toBe(0);
  });

  it('follows the exact position when forced', () => {
    expect(windowScrollTop(1000, 1010, overscan, true)).toBe(1010);
  });

  it('always covers the viewport plus three quarters of a viewport on both sides while scrolling', () => {
    const list = uniform(5000, 30);
    let rendered = 0;
    for (let actual = 0; actual <= 5000 * 30 - viewport; actual += 97) {
      rendered = windowScrollTop(rendered, actual, overscan);
      const win = virtualizeRows(list, rendered, viewport, overscan, MIN);
      const renderedBottom = win.before + win.rows.reduce((t, r) => t + r.height, 0);
      expect(win.before).toBeLessThanOrEqual(Math.max(0, actual - viewport * 0.75));
      expect(renderedBottom).toBeGreaterThanOrEqual(Math.min(win.totalHeight, actual + viewport + viewport * 0.75));
    }
  });

  it('re-renders far less often than once per scroll event', () => {
    const list = uniform(5000, 30);
    let rendered = 0;
    let shifts = 0;
    for (let actual = 0; actual <= 30000; actual += 20) {
      const next = windowScrollTop(rendered, actual, overscan);
      if (next !== rendered) shifts++;
      rendered = next;
    }
    expect(shifts).toBeLessThan(30000 / 20 / 10);
    expect(virtualizeRows(list, rendered, viewport, overscan, MIN).rows.length).toBeLessThan(110);
  });
});

describe('createRowMeasurer', () => {
  type Callback = (entries: Array<{ target: Element; borderBoxSize?: Array<{ blockSize: number }> }>) => void;
  const observers: Array<{ callback: Callback; observed: Set<Element> }> = [];

  afterEach(() => {
    observers.length = 0;
    vi.unstubAllGlobals();
  });

  function stubResizeObserver() {
    vi.stubGlobal('ResizeObserver', class {
      observed = new Set<Element>();
      constructor(public callback: Callback) { observers.push(this); }
      observe(node: Element) { this.observed.add(node); }
      unobserve(node: Element) { this.observed.delete(node); }
      disconnect() { this.observed.clear(); }
    });
  }

  function row(height: number) {
    return { getBoundingClientRect: () => ({ height }) } as unknown as HTMLElement;
  }

  it('measures every row with one shared observer', () => {
    stubResizeObserver();
    const heights = new Map<string, number>();
    const measure = createRowMeasurer(heights);
    const a = row(30);
    const b = row(58);
    measure(a, 'a');
    measure(b, 'b');
    expect(observers).toHaveLength(1);
    observers[0].callback([{ target: a, borderBoxSize: [{ blockSize: 30 }] }, { target: b, borderBoxSize: [{ blockSize: 58 }] }]);
    expect(Object.fromEntries(heights)).toEqual({ a: 30, b: 58 });
  });

  it('files the height under the new key when a row is reused and stops watching removed rows', () => {
    stubResizeObserver();
    const heights = new Map<string, number>();
    const measure = createRowMeasurer(heights);
    const node = row(44);
    const action = measure(node, 'a');
    action.update('b');
    expect(heights.get('b')).toBe(44);
    action.destroy();
    expect(observers[0].observed.size).toBe(0);
    observers[0].callback([{ target: node, borderBoxSize: [{ blockSize: 90 }] }]);
    expect(heights.get('b')).toBe(44);
  });

  it('measures a row as soon as it is mounted, before the observer reports, so rows drawn above the viewport cannot shift the list for a frame', () => {
    stubResizeObserver();
    const heights = new Map<string, number>([['a', 41]]);
    const measure = createRowMeasurer(heights);
    measure(row(120), 'a');
    expect(heights.get('a')).toBe(120);
  });

  it('ignores zero heights from hidden rows', () => {
    stubResizeObserver();
    const heights = new Map<string, number>();
    const measure = createRowMeasurer(heights);
    const node = row(0);
    measure(node, 'a');
    observers[0].callback([{ target: node, borderBoxSize: [{ blockSize: 0 }] }]);
    expect(heights.has('a')).toBe(false);
  });
});

describe('sidebar scrolling', () => {
  it('leaves wheel and trackpad scrolling to the browser', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../lib/components/Sidebar.svelte', import.meta.url), 'utf8');
    expect(source).not.toMatch(/wheel/i);
    expect(source).not.toMatch(/flushSync/);
  });

  it('gives every sidebar scroller its own stacking context so WebKit paints the rows in one layer', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../styles/shell-sidebar.css', import.meta.url), 'utf8');
    const rule = css.match(/\.collection-list,\s*\.starred-list,\s*\.history-list,\s*\.environment-list\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/position:\s*relative/);
    expect(rule?.[1]).toMatch(/z-index:\s*0/);
    expect(css).toMatch(/\.starred-list:has\(\.menu\)[^{]*\{\s*z-index:\s*auto/);
  });
});

describe('growing the window in the background', () => {
  it('adds extra rows on both sides of the visible window', () => {
    const list = uniform(1000, 30);
    const base = virtualizeRows(list, 15000, 600, 0, MIN);
    const grown = virtualizeRows(list, 15000, 600, 0, MIN, undefined, 1, 40);
    expect(grown.rows.length).toBe(base.rows.length + 40);
    expect(grown.rows[0].key).toBe(`r${Number(base.rows[0].key.slice(1)) - 20}`);
    expect(grown.before + grown.rows.length * 30 + grown.after).toBe(grown.totalHeight);
  });

  it('spends the rows an edge cannot take on the other side', () => {
    const list = uniform(1000, 30);
    const base = virtualizeRows(list, 0, 600, 0, MIN);
    const grown = virtualizeRows(list, 0, 600, 0, MIN, undefined, 1, 100);
    expect(grown.before).toBe(0);
    expect(grown.rows.length).toBe(base.rows.length + 100);
  });

  it('ends up rendering a whole collection the size of a large OpenAPI import', () => {
    const list = uniform(600, 28);
    let extra = 0;
    let window = virtualizeRows(list, 0, 700, 700, MIN, undefined, 1, extra);
    while (canGrowWindow(window)) {
      extra += 40;
      window = virtualizeRows(list, 0, 700, 700, MIN, undefined, 1, extra);
    }
    expect(window.rows.length).toBe(600);
    expect(window.before).toBe(0);
    expect(window.after).toBe(0);
  });

  it('stops growing at the row limit for very large lists', () => {
    const list = uniform(5000, 28);
    let extra = 0;
    let window = virtualizeRows(list, 50000, 700, 700, MIN, undefined, 1, extra);
    while (canGrowWindow(window)) {
      extra += 40;
      window = virtualizeRows(list, 50000, 700, 700, MIN, undefined, 1, extra);
    }
    expect(window.rows.length).toBeGreaterThanOrEqual(GROWN_ROW_LIMIT);
    expect(window.rows.length).toBeLessThan(GROWN_ROW_LIMIT + 40);
  });

  it('counts the rendered rows that are still in the list', () => {
    expect(keptRowCount(['r0', 'r1', 'gone'], ['r0', 'r1', 'r2'])).toBe(2);
    expect(keptRowCount([], ['r0'])).toBe(0);
  });

  it('grows step by step and waits while the list is being scrolled', () => {
    vi.useFakeTimers();
    let steps = 0;
    const grower = createWindowGrower(() => ++steps < 5, 32, 200);
    grower.start();
    vi.advanceTimersByTime(32);
    expect(steps).toBe(1);
    grower.pause();
    vi.advanceTimersByTime(199);
    expect(steps).toBe(1);
    vi.advanceTimersByTime(1);
    expect(steps).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(steps).toBe(5);
    grower.start();
    grower.stop();
    vi.advanceTimersByTime(1000);
    expect(steps).toBe(5);
    vi.useRealTimers();
  });
});

describe('row anchors', () => {
  it('anchors to the first row that starts inside the viewport, so a half-hidden row growing does not push the rest down', () => {
    const list = rows([40, 40, 40]);
    expect(rowAnchor(list, 0)).toEqual({ key: 'r0', delta: 0 });
    expect(rowAnchor(list, 55)).toEqual({ key: 'r2', delta: -25 });
    expect(rowAnchor(list, 100)).toEqual({ key: 'r2', delta: 20 });
    expect(rowAnchor(list, 500)).toBeNull();
  });

  it('puts the anchored row back under the viewport top after rows above it change height', () => {
    const list = rows([40, 40, 40, 40]);
    const measured = new Map<string, number>();
    const anchor = rowAnchor(list, 90, measured)!;
    expect(anchor).toEqual({ key: 'r3', delta: -30 });
    measured.set('r0', 100);
    measured.set('r1', 60);
    expect(anchorOffset(list, anchor, measured)).toBe(170);
    expect(anchorOffset(rows([40]), anchor, measured)).toBeNull();
  });

  it('scales estimated heights like the window does', () => {
    const list = rows([40, 40]);
    expect(rowAnchor(list, 50, undefined, 2)).toEqual({ key: 'r1', delta: -30 });
    expect(anchorOffset(list, { key: 'r1', delta: 5 }, undefined, 2)).toBe(85);
  });
});
