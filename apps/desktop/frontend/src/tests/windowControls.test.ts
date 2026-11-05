import { afterEach, describe, expect, it, vi } from 'vitest';
import { installQuitShortcut, isQuitShortcut } from '../lib/windowControls';

const key = (overrides: Partial<KeyboardEvent>) => ({ key: 'q', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...overrides });

describe('quit shortcut', () => {
  const original = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  it('matches plain Ctrl+Q only', () => {
    expect(isQuitShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isQuitShortcut(key({ ctrlKey: true, key: 'Q' }))).toBe(true);
    expect(isQuitShortcut(key({}))).toBe(false);
    expect(isQuitShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isQuitShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isQuitShortcut(key({ metaKey: true }))).toBe(false);
    expect(isQuitShortcut(key({ ctrlKey: true, key: 'w' }))).toBe(false);
  });

  it('quits on Linux and stops after uninstall', () => {
    const listeners = new Set<(event: KeyboardEvent) => void>();
    const quit = vi.fn();
    (globalThis as { window?: unknown }).window = {
      addEventListener: (_: string, fn: (event: KeyboardEvent) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (event: KeyboardEvent) => void) => listeners.delete(fn),
      runtime: { Quit: quit },
    };
    const uninstall = installQuitShortcut('linux');
    const event = { ...key({ ctrlKey: true }), preventDefault: vi.fn() } as unknown as KeyboardEvent;
    for (const fn of listeners) fn(event);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
    uninstall();
    expect(listeners.size).toBe(0);
  });

  it('leaves Ctrl+Q alone on other platforms', () => {
    const add = vi.fn();
    (globalThis as { window?: unknown }).window = { addEventListener: add, removeEventListener: vi.fn(), runtime: { Quit: vi.fn() } };
    for (const platform of ['windows', 'darwin', 'browser']) installQuitShortcut(platform)();
    expect(add).not.toHaveBeenCalled();
  });
});
