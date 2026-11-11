import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');
const PX_ALLOWED_PROPERTY = /^(border(-(top|right|bottom|left))?(-width)?|outline(-offset|-width)?|box-shadow|text-shadow|filter|stroke-width|-webkit-text-stroke|--titlebar-h|--mac-traffic-w|--shadow-[a-z]+|--focus-[a-z]+|--radius-full)$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : walk(path);
    return /\.(css|svelte)$/.test(name) ? [path] : [];
  });
}

function styleSources(): Array<{ file: string; css: string }> {
  return walk(SRC).flatMap(file => {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.css')) return [{ file, css: text }];
    return Array.from(text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g), match => ({ file, css: match[1] }));
  });
}

function declarations(css: string): Array<{ selector: string; property: string; value: string }> {
  const out: Array<{ selector: string; property: string; value: string }> = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@')) continue;
    for (const part of rule[2].split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      out.push({ selector, property: part.slice(0, colon).trim(), value: part.slice(colon + 1).trim() });
    }
  }
  return out;
}

function topLevelParts(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value.trim()) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function violations(check: (decl: { selector: string; property: string; value: string }) => boolean): string[] {
  return styleSources().flatMap(({ file, css }) =>
    declarations(css).filter(check).map(decl => `${relative(SRC, file)} ${decl.selector} { ${decl.property}: ${decl.value} }`),
  );
}

const KIT_BUTTON_CLASSES = new Set(['btn', 'btn-link', 'menu-item', 'segmented-item', 'field', 'option-card', 'tab']);
const SPECIAL_BUTTON_CLASSES = new Set([
  'about-item', 'activity-rail-btn', 'agent-change-head', 'agent-picker-trigger', 'agent-tool-toggle', 'ai-combo-option', 'btn-send', 'btn-send-caret', 'code-panel-resizer', 'collection-collapse',
  'collection-empty-row', 'collection-name', 'collection-request', 'cookie-domain-item', 'cookie-row-main', 'date-picker-day',
  'dialog-choice-card', 'disclosure-toggle', 'env-matrix-inherited', 'env-matrix-not-set',
  'env-matrix-unset', 'env-type-toggle', 'environment-globals-item', 'environment-item-main',
  'environment-none-item', 'examples-row-main', 'git-branch-chip', 'git-branch-row-main', 'git-branch-section',
  'git-commit-row', 'git-conflict-choice-btn', 'git-conflict-file-pill', 'git-file-open', 'git-history-toggle', 'git-popover-scrim',
  'gitauth-pick', 'global-search', 'global-search-item', 'graphql-column-resizer', 'graphql-explorer-field',
  'graphql-explorer-footer-action', 'graphql-explorer-introspection-link', 'graphql-introspection-status',
  'graphql-panel-tab-btn', 'grpc-method-option', 'history-day-toggle', 'history-entry-main',
  'input-validation-anchor', 'kv-auto-toggle', 'kv-col-resizer', 'kv-file-value', 'method-trigger', 'mock-row-name',
  'mock-url', 'overview-name', 'overview-row', 'overview-tile', 'palette-command', 'panel-divider', 'pinned-head', 'response-time-trigger',
  'saved-messages-load', 'saved-request-tab-btn', 'search-picker-option', 'settings-nav-item', 'shortcut-combo', 'sidebar-divider', 'sse-event-main',
  'subfolder-collapse', 'support-link-card', 'tab-close', 'theme-menu-item', 'theme-menu-mode', 'theme-menu-scrim',
  'version-pill', 'win-control', 'workspace-diagnostic-chip', 'workspace-menu-footer', 'workspace-menu-select',
]);

function buttonTags(): Array<{ file: string; line: number; tag: string }> {
  return walk(SRC).filter(file => file.endsWith('.svelte')).flatMap(file => {
    const text = readFileSync(file, 'utf8');
    const tags: Array<{ file: string; line: number; tag: string }> = [];
    for (const match of text.matchAll(/<button\b/g)) {
      let depth = 0;
      let index = match.index + 7;
      for (; index < text.length; index += 1) {
        const char = text[index];
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        else if (char === '>' && depth === 0) break;
      }
      tags.push({ file: relative(SRC, file), line: text.slice(0, match.index).split('\n').length, tag: text.slice(match.index, index + 1) });
    }
    return tags;
  });
}

function classWords(tag: string): string[] {
  const words: string[] = [];
  for (const match of tag.matchAll(/\sclass=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)) {
    words.push(...(match[1] ?? match[2] ?? match[3] ?? '').match(/[\w-]+/g) ?? []);
  }
  for (const match of tag.matchAll(/\sclass:([\w-]+)/g)) words.push(match[1]);
  return words;
}

describe('design tokens', () => {
  it('keeps every scroll area from bouncing past its edges', () => {
    const offenders = styleSources().flatMap(({ file, css }) => declarations(css)
      .filter(({ property, value }) => property.startsWith('overscroll-behavior') && value.trim() !== 'none')
      .map(({ selector, property, value }) => `${relative(SRC, file)} ${selector} { ${property}: ${value} }`));
    expect(offenders).toEqual([]);
  });

  it('dims overlays without blurring what is behind them', () => {
    expect(violations(({ property }) => /backdrop-filter$/.test(property))).toEqual([]);
  });

  it('sizes text with the type scale', () => {
    expect(violations(d => d.property === 'font-size' && /\dpx/.test(d.value) && d.selector !== ':root')).toEqual([]);
  });

  it('sets weights with the weight tokens', () => {
    expect(violations(d => d.property === 'font-weight' && !/^(var\(--weight-[a-z]+\)|inherit)$/.test(d.value))).toEqual([]);
  });

  it('rounds corners with the radius tokens', () => {
    expect(violations(d => /radius$/.test(d.property) && /(^|\s)([2-9]|\d{2,})(\.\d+)?px/.test(d.value))).toEqual([]);
  });

  it('spaces with the spacing scale', () => {
    const spacing = /^(padding|margin)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^(gap|row-gap|column-gap)$/;
    const allowed = /^(0|auto|inherit|initial|unset|-?1px|-?0\.5px|-?[\d.]+cqw|var\(--[\w-]+(, ?[^)]*)?\)|calc\(.*\))$/;
    expect(violations(d => spacing.test(d.property) && topLevelParts(d.value.replace(/\s*!important$/, '')).some(part => !allowed.test(part)))).toEqual([]);
  });

  it('keeps lengths in rem so the interface size scales them', () => {
    expect(violations(d => !PX_ALLOWED_PROPERTY.test(d.property) && /(^|[\s(,])-?([2-9]|\d{2,})(\.\d+)?px/.test(d.value)
      && !/var\(--(mac-traffic-w|titlebar-h), \d+px\)/.test(d.value))).toEqual([]);
  });

  it('pairs user-select with the WebKit prefix the macOS app needs', () => {
    const offenders = styleSources().flatMap(({ file, css }) => {
      const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g);
      return Array.from(rules).flatMap(rule => {
        const body = rule[2];
        const plain = /(^|[;\s])user-select:\s*([a-z]+)/.exec(body);
        if (!plain) return [];
        const prefixed = /-webkit-user-select:\s*([a-z]+)/.exec(body);
        return prefixed && prefixed[1] === plain[2] ? [] : [`${relative(SRC, file)} ${rule[1].trim().replace(/\s+/g, ' ')}`];
      });
    });
    expect(offenders).toEqual([]);
  });

  it('shows no native browser tooltips', () => {
    const offenders = walk(SRC).filter(file => file.endsWith('.svelte')).flatMap(file => {
      const source = readFileSync(file, 'utf8');
      const markup = Array.from(source.matchAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/g)).reduce((text, block) => text.replace(block[0], ' '.repeat(block[0].length)), source);
      return Array.from(markup.matchAll(/<([a-z][a-z0-9-]*)\b(?:[^<>{}]|\{[^{}]*\})*?\stitle=/g))
        .filter(match => match[1] !== 'iframe')
        .map(match => `${relative(SRC, file)}:${markup.slice(0, match.index).split('\n').length} <${match[1]}>`);
    });
    expect(offenders).toEqual([]);
  });

  it('builds every button from a kit component or a named special one', () => {
    const offenders = buttonTags()
      .filter(({ tag }) => !classWords(tag).some(word => KIT_BUTTON_CLASSES.has(word) || SPECIAL_BUTTON_CLASSES.has(word)))
      .map(({ file, line, tag }) => `${file}:${line} ${tag.replace(/\s+/g, ' ').slice(0, 80)}`);
    expect(offenders).toEqual([]);
  });

  it('draws checkboxes and radios with kit controls instead of native ones', () => {
    const offenders = walk(SRC).filter(file => file.endsWith('.svelte')).flatMap(file => {
      const text = readFileSync(file, 'utf8');
      return Array.from(text.matchAll(/<input\b[^>]*type="(checkbox|radio)"[^>]*>/g)).filter(match => {
        if (/\sclass="[^"]*\bcheck\b/.test(match[0])) return false;
        const before = text.slice(Math.max(0, match.index - 300), match.index);
        const opener = Math.max(before.lastIndexOf('<label'), before.lastIndexOf('<span'));
        const container = opener >= 0 ? before.slice(opener) : '';
        return !/class="[^"]*\b(switch-control|segmented-item)\b/.test(container);
      }).map(match => `${relative(SRC, file)}:${text.slice(0, match.index).split('\n').length} ${match[0].slice(0, 70)}`);
    });
    expect(offenders).toEqual([]);
  });

  it('tints status backgrounds and borders with the status tokens', () => {
    const statusMix = /color-mix\(in srgb, var\(--(danger|warning|success|info|s[2-5]xx|delete)\)/;
    expect(violations(d => /^(background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?)$/.test(d.property)
      && statusMix.test(d.value)).filter(line => !line.startsWith('styles/tokens.css'))).toEqual([]);
  });

  it('keeps the DELETE method colour for method labels', () => {
    expect(violations(d => d.value.includes('var(--delete)') && !/method-delete|tp-method\.delete/.test(d.selector))).toEqual([]);
  });

  it('colours accent text with the accent text token', () => {
    expect(violations(d => /^(color|fill|stroke|caret-color|text-decoration-color)$/.test(d.property) && /^var\(--accent\)( !important)?$/.test(d.value))).toEqual([]);
  });
});
