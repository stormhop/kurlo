import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETIRED_THEME_VARIANTS, THEME_VARIANTS } from '../lib/theme';

const root = join(import.meta.dirname, '..', '..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
const tokens = readFileSync(join(root, 'src', 'styles', 'tokens.css'), 'utf8');

function objectLiteral(name: string): Record<string, unknown> {
  const body = indexHtml.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\s*\\});`))?.[1];
  if (!body) throw new Error(`${name} not found in index.html`);
  return JSON.parse(body);
}

function themeToken(id: string, name: string): string | undefined {
  const block = tokens.match(new RegExp(`\\[data-theme-preview="${id}"\\]\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
  return block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
}

describe('boot screen', () => {
  it('starts every theme in its own colours', () => {
    const variants = objectLiteral('bootVariants');
    expect(Object.keys(variants).sort()).toEqual(THEME_VARIANTS.map(variant => variant.id).sort());
    for (const variant of THEME_VARIANTS) {
      expect(variants[variant.id], variant.id).toEqual({
        mode: variant.mode,
        bg: themeToken(variant.id, '--bg'),
        text: themeToken(variant.id, '--text'),
        muted: themeToken(variant.id, '--text-2'),
        accent: themeToken(variant.id, '--accent'),
      });
    }
  });

  it('maps retired themes the same way the app does', () => {
    expect(objectLiteral('retiredVariants')).toEqual(RETIRED_THEME_VARIANTS);
  });
});
