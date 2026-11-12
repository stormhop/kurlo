import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRowMeasurer, virtualOverscan, virtualizeRows, windowScrollTop, type VirtualRow } from '../lib/sidebarVirtual';

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

  it('keeps at least a full viewport rendered beyond each edge', () => {
    expect(virtualOverscan(600, 240)).toBe(600);
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

  it('always covers the viewport plus half a viewport on both sides while scrolling', () => {
    const list = uniform(5000, 30);
    let rendered = 0;
    for (let actual = 0; actual <= 5000 * 30 - viewport; actual += 97) {
      rendered = windowScrollTop(rendered, actual, overscan);
      const win = virtualizeRows(list, rendered, viewport, overscan, MIN);
      const renderedBottom = win.before + win.rows.reduce((t, r) => t + r.height, 0);
      expect(win.before).toBeLessThanOrEqual(Math.max(0, actual - viewport / 2));
      expect(renderedBottom).toBeGreaterThanOrEqual(Math.min(win.totalHeight, actual + viewport + viewport / 2));
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
    expect(virtualizeRows(list, rendered, viewport, overscan, MIN).rows.length).toBeLessThan(80);
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
