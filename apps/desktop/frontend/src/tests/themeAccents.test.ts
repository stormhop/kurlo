import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(join(import.meta.dirname, '..', 'styles', 'tokens.css'), 'utf8');

function themeBlocks(): Array<{ name: string; accent: string; hover: string }> {
  const blocks: Array<{ name: string; accent: string; hover: string }> = [];
  for (const match of tokens.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const accent = match[2].match(/--accent:\s*(#[0-9a-f]{6})/i)?.[1];
    const hover = match[2].match(/--accent-hover:\s*(#[0-9a-f]{6})/i)?.[1];
    if (accent && hover) blocks.push({ name: match[1].trim().split('\n')[0], accent, hover });
  }
  return blocks;
}

function hsl(hex: string): { hue: number; saturation: number } {
  const [r, g, b] = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (!delta) return { hue: 0, saturation: 0 };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: (hue * 60 + 360) % 360, saturation };
}

describe('theme accents', () => {
  it('finds every theme that defines an accent', () => {
    expect(themeBlocks().length).toBeGreaterThanOrEqual(12);
  });

  it('keeps the hover colour in the accent hue, so a hovered button only gets lighter or darker', () => {
    const offenders = themeBlocks().filter(({ accent, hover }) => {
      const base = hsl(accent);
      const hovered = hsl(hover);
      if (base.saturation < 0.08) return false;
      const gap = Math.abs(base.hue - hovered.hue);
      return Math.min(gap, 360 - gap) > 10;
    }).map(({ name, accent, hover }) => `${name} ${accent} → ${hover}`);
    expect(offenders).toEqual([]);
  });
});
