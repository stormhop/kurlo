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

  it('drops the grown rows while the list is resized and grows again once it settles', () => {
    vi.useFakeTimers();
    const growth = new WindowGrowth(() => growth.extra < GROW_STEP_ROWS * 3);
    growth.rowsChanged(['a']);
    vi.advanceTimersByTime(1000);
    expect(growth.extra).toBe(GROW_STEP_ROWS * 3);
    growth.resized();
    expect(growth.extra).toBe(0);
    vi.advanceTimersByTime(100);
    growth.resized();
    vi.advanceTimersByTime(150);
    expect(growth.extra).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(growth.extra).toBe(GROW_STEP_ROWS * 3);
    growth.destroy();
  });

  it('stays at the visible window while suspended and grows again after resuming', () => {
    vi.useFakeTimers();
    const growth = new WindowGrowth(() => growth.extra < GROW_STEP_ROWS * 3);
    growth.rowsChanged(['a']);
    vi.advanceTimersByTime(1000);
    expect(growth.extra).toBe(GROW_STEP_ROWS * 3);
    growth.suspend();
    expect(growth.extra).toBe(0);
    growth.rowsChanged(['a', 'b']);
    growth.scrolled(0, 100, 0, 100);
    vi.advanceTimersByTime(1000);
    expect(growth.extra).toBe(0);
    growth.resume();
    vi.advanceTimersByTime(1000);
    expect(growth.extra).toBe(GROW_STEP_ROWS * 3);
    growth.destroy();
  });
});
