import { describe, expect, it } from 'vitest';
import { foldAllRegions, responseFoldRegions, unfoldAround, visibleResponseLines } from '../lib/responseFolding';
import { prettyJson, prettyMarkup } from '../lib/utils';

const json = prettyJson(JSON.stringify({
  id: 1,
  customer: { name: 'Ada', address: { city: 'London' } },
  items: [{ sku: 'A1' }, { sku: 'B2' }],
  empty: {},
  list: [],
}));

describe('response fold regions', () => {
  it('finds JSON objects and arrays with their depth', () => {
    const regions = responseFoldRegions(json, 'json');
    expect([...regions.values()].sort((a, b) => a.start - b.start)).toEqual([
      { start: 0, end: 18, depth: 0 },
      { start: 2, end: 7, depth: 1 },
      { start: 4, end: 6, depth: 2 },
      { start: 8, end: 15, depth: 1 },
      { start: 9, end: 11, depth: 2 },
      { start: 12, end: 14, depth: 2 },
    ]);
  });

  it('finds markup elements and skips self-closing and inline ones', () => {
    const xml = prettyMarkup('<?xml version="1.0"?><order><customer><name>Ada</name></customer><items><item sku="A1"/><br><item sku="B2"/></items></order>');
    expect(xml.split('\n')).toEqual([
      '<?xml version="1.0"?>',
      '<order>',
      '  <customer>',
      '    <name>Ada</name>',
      '  </customer>',
      '  <items>',
      '    <item sku="A1"/>',
      '    <br>',
      '    <item sku="B2"/>',
      '  </items>',
      '</order>',
    ]);
    expect([...responseFoldRegions(xml, 'html').values()].sort((a, b) => a.start - b.start)).toEqual([
      { start: 1, end: 10, depth: 0 },
      { start: 2, end: 4, depth: 1 },
      { start: 5, end: 9, depth: 1 },
    ]);
  });

  it('closes unclosed HTML elements at their parent', () => {
    const regions = responseFoldRegions('<ul>\n  <li>\n    one\n</ul>', 'html');
    expect([...regions.values()]).toEqual([{ start: 0, end: 3, depth: 0 }]);
  });

  it('has no regions for text or mismatched brackets', () => {
    expect(responseFoldRegions('{\n  "a": 1\n}', 'text').size).toBe(0);
    expect(responseFoldRegions('{\n  "a": [\n}', 'json').size).toBe(0);
  });
});

describe('folded lines', () => {
  const regions = responseFoldRegions(json, 'json');

  it('hides the inside and the closing line of folded regions', () => {
    expect(visibleResponseLines(19, regions, new Set([2]))).toEqual([0, 1, 2, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(visibleResponseLines(19, regions, new Set([2, 4]))).toEqual([0, 1, 2, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(visibleResponseLines(19, regions, new Set([0]))).toEqual([0]);
  });

  it('folds everything below the root', () => {
    expect([...foldAllRegions(regions)].sort((a, b) => a - b)).toEqual([2, 4, 8, 9, 12]);
    expect(visibleResponseLines(19, regions, foldAllRegions(regions))).toEqual([0, 1, 2, 8, 16, 17, 18]);
    const flat = responseFoldRegions('{\n  "a": 1\n}', 'json');
    expect([...foldAllRegions(flat)]).toEqual([0]);
  });

  it('unfolds the regions around a line', () => {
    const folded = new Set([2, 4, 8]);
    expect([...unfoldAround(5, regions, folded)]).toEqual([8]);
    expect(unfoldAround(17, regions, folded)).toBe(folded);
    expect(unfoldAround(2, regions, folded)).toBe(folded);
  });
});
