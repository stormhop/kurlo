import { describe, expect, it } from 'vitest';
import { placeFloatingMenu, rowLeftScrollView } from '../lib/floatingMenu';

function menu(width: number, height: number) {
  return {
    getBoundingClientRect: () => ({ width, height }),
    style: {} as Record<string, string>,
  } as unknown as HTMLElement;
}

const viewport = { width: 1000, height: 800 };
const row = (top: number, height = 28) => ({ top, bottom: top + height, left: 40, right: 300 });
const trigger = (left = 270) => ({ top: 0, bottom: 0, left, right: left + 24 });

describe('sidebar floating menus', () => {
  it('opens right under the row, starting at its menu button', () => {
    const node = menu(200, 200);
    placeFloatingMenu(node, row(100), trigger(), viewport);
    expect(node.style).toMatchObject({ position: 'fixed', left: '270px', top: '132px', right: 'auto', bottom: 'auto' });
  });

  it('opens above the row when there is no room below', () => {
    const node = menu(200, 200);
    placeFloatingMenu(node, row(700), trigger(), viewport);
    expect(node.style.top).toBe('496px');
  });

  it('shifts left to stay inside the window', () => {
    const node = menu(200, 200);
    placeFloatingMenu(node, row(100), trigger(900), viewport);
    expect(node.style.left).toBe('796px');
  });

  it('keeps oversized menus scrollable within the viewport', () => {
    const node = menu(200, 792);
    placeFloatingMenu(node, row(300), trigger(), viewport);
    expect(node.style).toMatchObject({ top: '4px', maxHeight: '792px', maxWidth: '992px', overflowY: 'auto' });
  });

  it('closes once the row starts leaving the scrolled list', () => {
    const view = { top: 100, bottom: 700, left: 0, right: 300 };
    expect(rowLeftScrollView(row(100), view)).toBe(false);
    expect(rowLeftScrollView(row(672), view)).toBe(false);
    expect(rowLeftScrollView(row(90), view)).toBe(true);
    expect(rowLeftScrollView(row(690), view)).toBe(true);
  });
});
