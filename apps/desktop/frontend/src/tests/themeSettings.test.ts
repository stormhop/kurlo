import { describe, expect, it } from 'vitest';
import { DARK_THEME_VARIANTS, LIGHT_THEME_VARIANTS, RETIRED_THEME_VARIANTS, THEME_VARIANTS, normalizeThemeSettings, withThemeVariant } from '../lib/theme';

describe('theme settings', () => {
  it('moves a saved retired theme to its closest replacement', () => {
    expect(normalizeThemeSettings({ mode: 'dark', light: 'light-pastel', dark: 'catppuccin-frappe' }))
      .toEqual({ mode: 'dark', light: 'flexoki-paper', dark: 'catppuccin-mocha' });
    expect(normalizeThemeSettings({ mode: 'light', light: 'light-monochrome', dark: 'dark-pastel' }))
      .toEqual({ mode: 'light', light: 'light', dark: 'everforest' });
    expect(normalizeThemeSettings({ mode: 'system', light: 'light', dark: 'dark-monochrome' }).dark).toBe('dark');
    expect(normalizeThemeSettings({ mode: 'system', light: 'light', dark: 'catppuccin-macchiato' }).dark).toBe('catppuccin-mocha');
  });

  it('replaces retired themes with ones of the same mode that still exist', () => {
    const byId = new Map(THEME_VARIANTS.map(variant => [variant.id, variant]));
    const offenders = Object.entries(RETIRED_THEME_VARIANTS).filter(([retired, replacement]) => {
      const mode = retired.startsWith('light') ? 'light' : 'dark';
      return byId.has(retired as never) || byId.get(replacement)?.mode !== mode;
    });
    expect(offenders).toEqual([]);
  });

  it('keeps unknown themes on the defaults and ignores inherited keys', () => {
    expect(normalizeThemeSettings({ mode: 'dark', light: 'solarized', dark: 'toString' }))
      .toEqual({ mode: 'dark', light: 'light', dark: 'dark' });
  });

  it('offers the new themes in the picker', () => {
    expect(LIGHT_THEME_VARIANTS.map(variant => variant.id)).toEqual(['light', 'github-light', 'jetbrains-light', 'vscode-light', 'catppuccin-latte', 'flexoki-paper', 'high-contrast-light']);
    expect(DARK_THEME_VARIANTS.map(variant => variant.id)).toEqual(['dark', 'github-dimmed', 'jetbrains-dark', 'vscode-dark', 'one-dark', 'tokyo-night', 'catppuccin-mocha', 'nord', 'everforest', 'high-contrast-dark']);
  });

  it('selects every theme from the picker into the slot of its own mode', () => {
    const start = { mode: 'light' as const, light: 'light' as const, dark: 'dark' as const };
    const offenders = THEME_VARIANTS.filter(variant => {
      const next = normalizeThemeSettings(withThemeVariant(start, variant.id));
      return variant.mode === 'light'
        ? next.light !== variant.id || next.dark !== start.dark
        : next.dark !== variant.id || next.light !== start.light;
    }).map(variant => variant.id);
    expect(offenders).toEqual([]);
  });
});
