import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('sidebar menu layering', () => {
  it('drops the list stacking context while a menu is open so WKWebView does not clip the menu beside the sidebar', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../styles/shell-sidebar.css'), 'utf8');
    const rule = css.match(/\.collection-list:has\(\.menu\),\s*\.starred-list:has\(\.menu\),\s*\.history-list:has\(\.menu\),\s*\.environment-list:has\(\.menu\)\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/z-index:\s*auto;/);
  });
});
