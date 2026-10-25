import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatJwtNumericDate } from '../lib/jwt';

const SRC = join(import.meta.dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : walk(path);
    return /\.(ts|svelte)$/.test(name) ? [path] : [];
  });
}

describe('UI locale', () => {
  it('formats dates, times and numbers in English whatever the system language is', () => {
    const offenders = walk(SRC).flatMap(file => {
      const lines = readFileSync(file, 'utf8').split('\n');
      return lines.flatMap((line, index) => {
        const calls = line.match(/toLocale(?:Date|Time)?String\(\s*(?:\)|\[\]|undefined|navigator)/g) ?? [];
        const intl = line.match(/new Intl\.\w+\(\s*(?:\)|\[\]|undefined|navigator)/g) ?? [];
        return [...calls, ...intl].map(() => `${relative(SRC, file)}:${index + 1}`);
      });
    });
    expect(offenders).toEqual([]);
  });

  it('shows JWT dates in English', () => {
    expect(formatJwtNumericDate('exp', Date.UTC(2026, 9, 25, 12, 30, 5) / 1000)).toMatch(/^Oct 25, 2026, \d{2}:30:05$/);
  });
});
