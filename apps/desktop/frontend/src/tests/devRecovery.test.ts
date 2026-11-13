import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_HMR_ERROR_WINDOW_MS, DEV_RELOAD_LIMIT, DEV_RELOAD_WINDOW_MS, allowReload, isHmrBreakage, shouldReloadAfterError } from '../lib/devRecovery';

describe('dev recovery', () => {
  it('treats the errors a half-applied hot update leaves behind as breakage', () => {
    expect(isHmrBreakage('ReferenceError: Cannot access uninitialized variable.')).toBe(true);
    expect(isHmrBreakage("ReferenceError: Cannot access 'vm' before initialization")).toBe(true);
    expect(isHmrBreakage('ResizeObserver loop completed with undelivered notifications.')).toBe(false);
    expect(isHmrBreakage('Error: Invalid value for <svg> attribute width="0.75rem"')).toBe(false);
  });

  it('reloads on an uninitialized-variable error at any time after a hot update, other errors only right after it', () => {
    const tdz = 'ReferenceError: Cannot access uninitialized variable.';
    const other = "TypeError: undefined is not an object (evaluating 'x.y')";
    expect(shouldReloadAfterError(tdz, 0, 1_000_000)).toBe(false);
    expect(shouldReloadAfterError(tdz, 1_000_000, 1_000_000 + 10 * 60_000)).toBe(true);
    expect(shouldReloadAfterError(other, 1_000_000, 1_000_000 + DEV_HMR_ERROR_WINDOW_MS)).toBe(true);
    expect(shouldReloadAfterError(other, 1_000_000, 1_000_000 + DEV_HMR_ERROR_WINDOW_MS + 1)).toBe(false);
    expect(shouldReloadAfterError('ResizeObserver loop completed with undelivered notifications.', 1_000_000, 1_000_001)).toBe(false);
  });

  it('caps reloads so a genuinely broken build cannot loop forever', () => {
    const now = 1_000_000;
    let history: number[] = [];
    for (let i = 0; i < DEV_RELOAD_LIMIT; i += 1) {
      const result = allowReload(history, now + i);
      expect(result.allowed).toBe(true);
      history = result.history;
    }
    expect(allowReload(history, now + DEV_RELOAD_LIMIT).allowed).toBe(false);
    expect(allowReload(history, now + DEV_RELOAD_WINDOW_MS + DEV_RELOAD_LIMIT).allowed).toBe(true);
  });

  it('is only loaded by the dev server', () => {
    const main = readFileSync(resolve(import.meta.dirname, '../main.ts'), 'utf8');
    expect(main).toMatch(/if \(import\.meta\.env\.DEV\) \{\s*void import\('\.\/lib\/devRecovery'\)/);
  });
});
