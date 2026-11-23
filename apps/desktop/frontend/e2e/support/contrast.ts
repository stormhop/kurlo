import type { Page } from '@playwright/test';

export const ALL_THEMES: Array<{ theme: 'light' | 'dark'; variant: string }> = [
  ...['light', 'github-light', 'jetbrains-light', 'vscode-light', 'catppuccin-latte', 'flexoki-paper', 'high-contrast-light'].map(variant => ({ theme: 'light' as const, variant })),
  ...['dark', 'github-dimmed', 'jetbrains-dark', 'vscode-dark', 'one-dark', 'tokyo-night', 'catppuccin-mocha', 'nord', 'everforest', 'high-contrast-dark'].map(variant => ({ theme: 'dark' as const, variant })),
];

export async function applyTheme(page: Page, theme: 'light' | 'dark', variant: string) {
  await page.evaluate(([mode, id]) => {
    if (!document.getElementById('contrast-audit-still')) {
      const style = document.createElement('style');
      style.id = 'contrast-audit-still';
      style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
      document.head.append(style);
    }
    document.documentElement.dataset.theme = mode;
    document.documentElement.dataset.themeVariant = id;
  }, [theme, variant]);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function lowContrastText(page: Page, root: string, minimum = 4.5): Promise<string[]> {
  return page.evaluate(([selector, floor]) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (value: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: number[], bottom: number[]) => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3]));
    const luminance = (c: number[]) => {
      const [r, g, b] = c.map(v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: number[], b: number[]) => { const [h, l] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (h + 0.05) / (l + 0.05); };
    const background = (element: Element): number[] | null => {
      const layers: Array<[number, number, number, number]> = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== 'none' && !style.backgroundImage.startsWith('url(')) return null;
        const color = rgba(style.backgroundColor);
        if (color[3] > 0) layers.push(color);
        if (color[3] >= 1) break;
      }
      let result = [255, 255, 255];
      if (!layers.length || layers[layers.length - 1][3] < 1) result = over(rgba(getComputedStyle(document.body).backgroundColor), [255, 255, 255, 1]);
      for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i], result);
      return result;
    };
    const opacity = (element: Element) => {
      let value = 1;
      for (let node: Element | null = element; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
      return value;
    };
    const scope = document.querySelector(selector) ?? document.body;
    const found = new Set<string>();
    const elements = [scope, ...scope.querySelectorAll('*')];
    for (const element of elements) {
      const isField = element instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'color', 'file', 'hidden'].includes(element.type) && element.value;
      const ownText = [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      if (!ownText && !isField) continue;
      if (element.closest('[disabled], [aria-disabled="true"], svg, [aria-hidden="true"], .cm-gutters')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.bottom < 0 || rect.top > innerHeight) continue;
      const style = getComputedStyle(element);
      if (style.visibility !== 'visible') continue;
      const bg = background(element);
      if (!bg) continue;
      const fg = rgba(style.color);
      const alpha = fg[3] * opacity(element);
      if (alpha < 0.05) continue;
      const text = over([fg[0], fg[1], fg[2], alpha], [...bg, 1]);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const value = ratio(text, bg);
      const need = large ? Math.min(3, floor) : floor;
      if (value < need) {
        const label = (isField ? (element as HTMLInputElement).value : element.textContent!.trim()).replace(/\s+/g, ' ').slice(0, 40);
        found.add(`${value.toFixed(2)} "${label}" .${[...element.classList].join('.') || element.tagName.toLowerCase()}`);
      }
    }
    return [...found];
  }, [root, minimum] as const);
}
