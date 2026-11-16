import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'svelte/compiler';
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
  return parse(source, { modern: true }).fragment.nodes.map(node => source.slice(node.start, node.end)).join('\n');
}

describe('loaders', () => {
  it('checks markup without script or style contents', () => {
    const source = '<script lang="ts">const caption: string = "Loading…";</script><style>div::before { content: "Loading…"; }</style><div>Ready</div>';
    expect(markup(source)).toBe('<div>Ready</div>');
    expect(markup('<div>Loading…</div>')).toMatch(LOADING_TEXT);
  });

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

  it('settles the perched bird instead of animating it forever', () => {
    const bird = readFileSync(join(SRC, 'lib/components/KurloBird.svelte'), 'utf8');
    const rules = (selector: string) => [...bird.matchAll(new RegExp(`${selector}[^{]*\\{[^}]*\\}`, 'g'))].map(match => match[0]).join('\n');
    const perched = rules('\\.kurlo-bird-perched');
    const flying = rules('\\.kurlo-bird-flying');
    expect(perched).not.toMatch(/infinite/);
    expect(perched).toMatch(/animation:\s*kurlo-bird-bob[^;]*\s3;/);
    expect(perched).toMatch(/animation-iteration-count:\s*2/);
    expect(flying).toMatch(/infinite/);
    expect(bird).toMatch(/<svg[^>]*class="[^"]*kurlo-bird-bob/);
  });
});
