import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');
const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'password', 'tel']);

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : svelteFiles(path);
    return name.endsWith('.svelte') ? [path] : [];
  });
}

function inputTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<input\b/g)) {
    let depth = 0;
    let quote = '';
    for (let index = match.index + 6; index < source.length; index++) {
      const char = source[index];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === '>' && depth === 0) {
        tags.push(source.slice(match.index, index + 1));
        break;
      }
    }
  }
  return tags;
}

describe('text fields', () => {
  it('never offer macOS autocorrect, autofill or capitalization hints', () => {
    const offenders: string[] = [];
    for (const file of svelteFiles(SRC)) {
      for (const tag of inputTags(readFileSync(file, 'utf8'))) {
        const type = /\btype=["']?([a-z]*)/.exec(tag)?.[1] ?? '';
        if (!/\btype=\{/.test(tag) && !TEXT_TYPES.has(type)) continue;
        const ok = /autocomplete=/.test(tag)
          && (/autocorrect="off"/.test(tag) || /\{\.\.\.NO_AUTOCORRECT\}/.test(tag))
          && /autocapitalize=/.test(tag)
          && /spellcheck=|\{spellcheck\}/.test(tag);
        if (!ok) offenders.push(`${relative(SRC, file)}: ${tag.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
