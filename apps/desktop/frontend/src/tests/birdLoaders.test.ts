import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');
const LOADING_TEXT = /(^|[>'"`{}]\s*)(Loading|Checking|Reading|Fetching|Opening|Generating|Searching|Sending|Invoking)\b[^<>'"`{}]*(…|&hellip;|\.\.\.)/;

function walk(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : walk(path, pattern);
    return pattern.test(name) ? [path] : [];
  });
}

function markup(source: string) {
  return source.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
}

describe('loaders', () => {
  it('uses the flying bird instead of spinners', () => {
    const offenders = walk(SRC, /\.(svelte|css)$/)
      .filter(file => /class="[^"]*\bspinner\b|\.spinner\b|-spinner\b(?![-\w]*bird)|@keyframes (sse-)?spin\b/.test(readFileSync(file, 'utf8').replace(/bird-spinner/g, '')))
      .map(file => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('shows no loading captions in the markup', () => {
    const offenders = walk(SRC, /\.svelte$/).flatMap(file => markup(readFileSync(file, 'utf8'))
      .split('\n')
      .filter(line => !/aria-label=|placeholder=|label=["{`]/.test(line) && LOADING_TEXT.test(line))
      .map(line => `${relative(SRC, file)}: ${line.trim()}`));
    expect(offenders).toEqual([]);
  });

  it('labels every bird loader for assistive technology', () => {
    const loader = readFileSync(join(SRC, 'lib/components/BirdLoader.svelte'), 'utf8');
    expect(loader).toMatch(/role="status" aria-label=\{label\}/);
    expect(loader).toMatch(/<KurloBird mode="flying"/);
  });
});
