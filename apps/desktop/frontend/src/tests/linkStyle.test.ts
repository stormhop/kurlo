import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : files(path, pattern);
    return pattern.test(name) ? [path] : [];
  });
}

describe('links', () => {
  it('are never underlined, only the lint squiggle is', () => {
    const offenders = files(SRC, /\.(css|svelte)$/).flatMap(file => readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => /text-decoration(-line)?\s*:[^;]*underline/.test(line) && !/wavy/.test(line))
      .map(line => `${relative(SRC, file)}: ${line.trim()}`));
    expect(offenders).toEqual([]);
  });

  it('use the app link style instead of the browser default', () => {
    const offenders = files(SRC, /\.svelte$/).flatMap(file => [...readFileSync(file, 'utf8').matchAll(/<a\s[^>]*>/g)]
      .map(match => match[0])
      .filter(tag => !/\bclass=/.test(tag))
      .map(tag => `${relative(SRC, file)}: ${tag.slice(0, 100)}`));
    expect(offenders).toEqual([]);
  });
});
