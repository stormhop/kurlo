import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROW_STEP_ROWS, WindowGrowth } from '../lib/windowGrowth.svelte';

describe('WindowGrowth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('grows while idle and drops back to the visible window only after a jump past the rendered rows', () => {
    vi.useFakeTimers();
    const growth = new WindowGrowth(() => growth.extra < GROW_STEP_ROWS * 5);
    growth.rowsChanged(['a']);
    vi.advanceTimersByTime(1000);
    expect(growth.extra).toBe(GROW_STEP_ROWS * 5);
    growth.scrolled(0, 600, 0, 20000);
    growth.scrolled(400, 600, 0, 20000);
    expect(growth.extra).toBe(GROW_STEP_ROWS * 5);
    growth.scrolled(15000, 600, 0, 20000);
    expect(growth.extra).toBe(GROW_STEP_ROWS * 5);
    growth.scrolled(30000, 600, 0, 20000);
    expect(growth.extra).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(growth.extra).toBe(GROW_STEP_ROWS * 5);
    growth.destroy();
  });

  it('keeps only the rows that are still in the list when the list changes', () => {
    vi.useFakeTimers();
    const growth = new WindowGrowth(() => growth.extra < 200);
    growth.rowsChanged(['a', 'b', 'c']);
    vi.advanceTimersByTime(1000);
    growth.rendered(['a', 'b', 'c']);
    growth.rowsChanged(['b']);
    expect(growth.extra).toBe(1);
    growth.destroy();
  });
});
