import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_VARIANTS, type ThemeVariantId } from '../lib/theme';

const tokens = readFileSync(join(import.meta.dirname, '..', 'styles', 'tokens.css'), 'utf8');

const HIGH_CONTRAST: ThemeVariantId[] = ['high-contrast-light', 'high-contrast-dark'];

const TEXT_ROLES = ['--text', '--text-2', '--text-3', '--accent-text'];
const METHOD_ROLES = ['--get', '--post', '--put', '--patch', '--delete', '--head', '--options'];
const STATUS_ROLES = ['--success', '--warning', '--danger', '--info'];
const BACKGROUNDS = ['--bg', '--surface', '--elevated'];

type Rgb = [number, number, number];

function previewBlocks(): Map<string, Record<string, string>> {
  const blocks = new Map<string, Record<string, string>>();
  for (const match of tokens.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const id = match[1].match(/\[data-theme-preview="([^"]+)"\]/)?.[1];
    if (!id) continue;
    const values: Record<string, string> = {};
    for (const declaration of match[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) values[declaration[1]] = declaration[2].trim();
    blocks.set(id, values);
  }
  return blocks;
}

function parseColor(value: string): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map(index => Number.parseInt(hex[1].slice(index, index + 2), 16)) as Rgb;
  const rgb = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`unsupported colour ${value}`);
}

function luminance(value: string): number {
  const [r, g, b] = parseColor(value).map(channel => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function hue(value: string): { hue: number; saturation: number } {
  const [r, g, b] = parseColor(value).map(channel => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (!delta) return { hue: 0, saturation: 0 };
  const saturation = delta / (1 - Math.abs(max + min - 1));
  const h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: (h * 60 + 360) % 360, saturation };
}

function hueGap(a: string, b: string): number {
  const x = hue(a);
  const y = hue(b);
  if (x.saturation < 0.25 || y.saturation < 0.25) return 0;
  const gap = Math.abs(x.hue - y.hue);
  return Math.min(gap, 360 - gap);
}

const blocks = previewBlocks();

function resolved(id: ThemeVariantId, mode: 'light' | 'dark'): Record<string, string> {
  return { '--on-accent': '#ffffff', ...blocks.get('dark'), ...(mode === 'light' ? blocks.get('light') : {}), ...blocks.get(id) };
}

const checked = THEME_VARIANTS;

describe('theme contrast', () => {
  it('has a token block for every theme in the picker', () => {
    expect(THEME_VARIANTS.filter(variant => !blocks.has(variant.id)).map(variant => variant.id)).toEqual([]);
  });

  it('defines every colour role in every theme', () => {
    const missing = checked.flatMap(variant => {
      const theme = resolved(variant.id, variant.mode);
      return [...BACKGROUNDS, ...TEXT_ROLES, ...METHOD_ROLES, ...STATUS_ROLES, '--accent', '--on-accent', '--border', '--hover']
        .filter(role => !theme[role])
        .map(role => `${variant.id} ${role}`);
    });
    expect(missing).toEqual([]);
  });

  it('keeps text, methods and statuses at 4.5:1 on content, sidebar and fields', () => {
    const offenders = checked.flatMap(variant => {
      const theme = resolved(variant.id, variant.mode);
      return [...TEXT_ROLES, ...METHOD_ROLES, ...STATUS_ROLES].flatMap(role =>
        BACKGROUNDS.filter(background => contrast(theme[role], theme[background]) < 4.5)
          .map(background => `${variant.id} ${role} on ${background}: ${contrast(theme[role], theme[background]).toFixed(2)}`),
      );
    });
    expect(offenders).toEqual([]);
  });

  it('keeps text on the accent button readable', () => {
    const offenders = checked
      .map(variant => ({ id: variant.id, theme: resolved(variant.id, variant.mode) }))
      .filter(({ theme }) => contrast(theme['--on-accent'], theme['--accent']) < 4.5)
      .map(({ id, theme }) => `${id}: ${contrast(theme['--on-accent'], theme['--accent']).toFixed(2)}`);
    expect(offenders).toEqual([]);
  });

  it('keeps borders visible but quiet', () => {
    const offenders = checked
      .filter(variant => !HIGH_CONTRAST.includes(variant.id))
      .map(variant => ({ id: variant.id, ratio: contrast(resolved(variant.id, variant.mode)['--border'], resolved(variant.id, variant.mode)['--bg']) }))
      .filter(({ ratio }) => ratio < 1.2 || ratio > 2)
      .map(({ id, ratio }) => `${id}: ${ratio.toFixed(2)}`);
    expect(offenders).toEqual([]);
  });

  it('draws high-contrast borders at 3:1 and all text at 7:1', () => {
    const offenders = checked.filter(variant => HIGH_CONTRAST.includes(variant.id)).flatMap(variant => {
      const theme = resolved(variant.id, variant.mode);
      const border = contrast(theme['--border'], theme['--bg']) < 3 ? [`${variant.id} --border`] : [];
      const text = ['--text', '--text-2', '--text-3'].flatMap(role =>
        BACKGROUNDS.filter(background => contrast(theme[role], theme[background]) < 7).map(background => `${variant.id} ${role} on ${background}`));
      return [...border, ...text];
    });
    expect(HIGH_CONTRAST.every(id => checked.some(variant => variant.id === id))).toBe(true);
    expect(offenders).toEqual([]);
  });

  it('defines every colour a theme preview needs inside its own block', () => {
    const own = ['--bg', '--surface', '--elevated', '--border', '--text', '--text-2', '--text-3', '--accent', '--accent-text', '--on-accent', ...STATUS_ROLES, ...METHOD_ROLES];
    const missing = checked.filter(variant => variant.id !== 'light' && variant.id !== 'dark')
      .flatMap(variant => own.filter(role => !blocks.get(variant.id)?.[role]).map(role => `${variant.id} ${role}`));
    expect(missing).toEqual([]);
  });

  it('stacks layers the same way in every theme', () => {
    const offenders = checked.filter(variant => {
      const theme = resolved(variant.id, variant.mode);
      const sunken = luminance(theme['--surface']) <= luminance(theme['--bg']);
      const raised = variant.mode === 'light' || luminance(theme['--elevated']) > luminance(theme['--bg']);
      return !sunken || !raised;
    }).map(variant => variant.id);
    expect(offenders).toEqual([]);
  });

  it('tells success from failure by hue, not only by lightness', () => {
    const offenders = checked.flatMap(variant => {
      const theme = resolved(variant.id, variant.mode);
      return ([['--success', '--danger'], ['--get', '--delete']] as const)
        .filter(([a, b]) => hueGap(theme[a], theme[b]) < 60)
        .map(([a, b]) => `${variant.id} ${a}/${b}`);
    });
    expect(offenders).toEqual([]);
  });

  it('derives status-code colours from the status roles', () => {
    const shared = tokens.match(/:root,\s*\[data-theme-preview\]\s*\{([^{}]*)\}/)?.[1] ?? '';
    expect(shared).toContain('--s2xx: var(--success)');
    expect(shared).toContain('--s3xx: var(--info)');
    expect(shared).toContain('--s4xx: var(--warning)');
    expect(shared).toContain('--s5xx: var(--danger)');
    expect([...blocks.values()].filter(block => Object.keys(block).some(key => /^--s[2-5]xx$/.test(key)))).toEqual([]);
  });
});
