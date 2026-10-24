import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeMarkdownURL } from '../lib/markdown';

describe('markdown', () => {
  it('parses headings, paragraphs, rules and soft line breaks', () => {
    expect(parseMarkdown('# Title\n\nFirst line\nsame paragraph\n\n---')).toEqual([
      { type: 'heading', level: 1, children: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'First line same paragraph' }] },
      { type: 'hr' },
    ]);
  });

  it('keeps fenced code verbatim, with its language', () => {
    expect(parseMarkdown('```json\n{"a": **1**}\n  <b>\n```')).toEqual([{ type: 'code', lang: 'json', text: '{"a": **1**}\n  <b>' }]);
    expect(parseMarkdown('```\nunclosed')).toEqual([{ type: 'code', lang: '', text: 'unclosed' }]);
  });

  it('parses emphasis, inline code, strikethrough and escapes', () => {
    expect(parseInline('**bold** and *it* and `a*b` ~~old~~ \\*no\\*')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'it' }] },
      { type: 'text', text: ' and ' },
      { type: 'code', text: 'a*b' },
      { type: 'text', text: ' ' },
      { type: 'del', children: [{ type: 'text', text: 'old' }] },
      { type: 'text', text: ' *no*' },
    ]);
    expect(parseInline('snake_case_name and 2 * 3 * 4')).toEqual([{ type: 'text', text: 'snake_case_name and 2 * 3 * 4' }]);
  });

  it('parses nested and ordered lists with tasks', () => {
    const [list] = parseMarkdown('- one\n  - nested\n- [x] done\n\n3. three\n4. four');
    expect(list).toMatchObject({ type: 'list', ordered: false, items: [
      { checked: null, children: [{ type: 'paragraph' }, { type: 'list', items: [{ children: [{ type: 'paragraph', children: [{ text: 'nested' }] }] }] }] },
      { checked: true, children: [{ type: 'paragraph', children: [{ text: 'done' }] }] },
    ] });
    expect(parseMarkdown('3. three\n4. four')[0]).toMatchObject({ type: 'list', ordered: true, start: 3 });
  });

  it('parses quotes and tables with alignment', () => {
    expect(parseMarkdown('> quoted **text**')[0]).toMatchObject({ type: 'quote', children: [{ type: 'paragraph' }] });
    expect(parseMarkdown('| Name | Count |\n|:-----|------:|\n| a \\| b | `1|2` |')[0]).toEqual({
      type: 'table',
      align: ['left', 'right'],
      head: [[{ type: 'text', text: 'Name' }], [{ type: 'text', text: 'Count' }]],
      rows: [[[{ type: 'text', text: 'a | b' }], [{ type: 'code', text: '1|2' }]]],
    });
  });

  it('only links to http, https and mailto, and only shows safe images', () => {
    expect(parseInline('[docs](https://kurlo.dev "Kurlo")')).toEqual([{ type: 'link', href: 'https://kurlo.dev', children: [{ type: 'text', text: 'docs' }] }]);
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ type: 'text', text: 'click' }]);
    expect(parseInline('![x](javascript:alert(1))')).toEqual([{ type: 'text', text: 'x' }]);
    expect(parseInline('![chart](data:image/png;base64,iVBORw0K)')).toEqual([{ type: 'image', src: 'data:image/png;base64,iVBORw0K', alt: 'chart' }]);
    expect(parseInline('![svg](data:image/svg+xml;base64,PHN2Zz4=)')).toEqual([{ type: 'text', text: 'svg' }]);
    expect(parseInline('see https://kurlo.dev/docs.')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', href: 'https://kurlo.dev/docs', children: [{ type: 'text', text: 'https://kurlo.dev/docs' }] },
      { type: 'text', text: '.' },
    ]);
    expect(safeMarkdownURL('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeMarkdownURL('file:///etc/passwd')).toBe('');
  });

  it('keeps raw HTML as text', () => {
    expect(parseMarkdown('<img src=x onerror=alert(1)>')).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] }]);
  });
});
