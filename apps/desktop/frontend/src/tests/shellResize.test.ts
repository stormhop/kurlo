import { describe, expect, it, vi } from 'vitest';
import { announceShellResize, onShellResize } from '../lib/shellResize';

describe('shellResize', () => {
  it('tells every subscribed list about a coming shell resize until it unsubscribes', () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = onShellResize(first);
    const stopSecond = onShellResize(second);
    announceShellResize();
    stopFirst();
    announceShellResize();
    stopSecond();
    announceShellResize();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
});
