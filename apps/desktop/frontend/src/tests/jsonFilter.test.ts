import { describe, expect, it } from 'vitest';
import { applyJsonFilter } from '../lib/jsonFilter';

const store = JSON.stringify({
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553', price: 8.99 },
      { category: 'fiction', author: 'J. R. R. Tolkien', title: 'Rings', isbn: '0-395', price: 22.99 },
    ],
    bicycle: { color: 'red', price: 399 },
  },
  'odd key': { 'a.b': 1 },
  count: 4,
});

function matches(query: string, body = store) {
  const result = applyJsonFilter(body, query);
  if (!result.ok) throw new Error(result.error);
  return result.matches;
}

describe('applyJsonFilter', () => {
  it('returns a single value for a definite path and shows it unwrapped', () => {
    const result = applyJsonFilter(store, '$.store.bicycle.color');
    expect(result).toMatchObject({ ok: true, definite: true, matches: ['red'], text: '"red"' });
    expect(applyJsonFilter(store, '$.store.bicycle')).toMatchObject({ text: '{\n  "color": "red",\n  "price": 399\n}' });
  });

  it('accepts jq-style paths that start with a dot', () => {
    expect(matches('.store.book[0].title')).toEqual(['Sayings']);
    expect(matches('.store.book[].author')).toHaveLength(4);
    expect(matches('.')).toEqual([JSON.parse(store)]);
    expect(matches('.["odd key"]["a.b"]')).toEqual([1]);
  });

  it('supports negative indexes, slices, unions and wildcards', () => {
    expect(matches('$.store.book[-1].title')).toEqual(['Rings']);
    expect(matches('$.store.book[1:3].title')).toEqual(['Sword', 'Moby Dick']);
    expect(matches('$.store.book[::-2].title')).toEqual(['Rings', 'Sword']);
    expect(matches('$.store.book[0,2].title')).toEqual(['Sayings', 'Moby Dick']);
    expect(matches("$.store.book[0]['title','price']")).toEqual(['Sayings', 8.95]);
    expect(matches('$.store.*.color')).toEqual(['red']);
  });

  it('collects values at any depth with ..', () => {
    expect(matches('$..price')).toEqual([8.95, 12.99, 8.99, 22.99, 399]);
    expect(matches('$..book[2].author')).toEqual(['Herman Melville']);
  });

  it('filters arrays by comparisons, existence and boolean logic', () => {
    expect(matches('$.store.book[?(@.price < 10)].title')).toEqual(['Sayings', 'Moby Dick']);
    expect(matches('$.store.book[?@.isbn].title')).toEqual(['Moby Dick', 'Rings']);
    expect(matches("$.store.book[?(@.category == 'fiction' && @.price > 20)].title")).toEqual(['Rings']);
    expect(matches('$.store.book[?(!@.isbn || @.price >= 22.99)].title')).toEqual(['Sayings', 'Sword', 'Rings']);
    expect(matches('$.store.book[?(@.price > $.store.bicycle.price)]')).toEqual([]);
    expect(matches('$.store.book[?(@.missing == null)]')).toEqual([]);
  });

  it('wraps every match in an array when the path can return more than one value', () => {
    const result = applyJsonFilter(store, '$..color');
    expect(result).toMatchObject({ ok: true, definite: false, text: '[\n  "red"\n]' });
    expect(applyJsonFilter(store, '$..nothing')).toMatchObject({ ok: true, matches: [], text: '[]' });
  });

  it('returns no match for a missing definite path instead of undefined', () => {
    expect(applyJsonFilter(store, '$.store.car')).toMatchObject({ ok: true, matches: [], text: '' });
    expect(applyJsonFilter(store, '$.count[0]')).toMatchObject({ ok: true, matches: [] });
  });

  it('explains syntax errors with their position', () => {
    expect(applyJsonFilter(store, 'store.book')).toEqual({ ok: false, error: expect.stringContaining('Start the filter with $') });
    expect(applyJsonFilter(store, '$.store.book[0')).toEqual({ ok: false, error: 'Missing "]" (at character 15)' });
    expect(applyJsonFilter(store, '$.store | .book')).toEqual({ ok: false, error: expect.stringContaining('Pipes are not supported') });
    expect(applyJsonFilter(store, '$.a[?(@.b = 1)]')).toEqual({ ok: false, error: expect.stringContaining('Use == to compare') });
    expect(applyJsonFilter(store, '$.a[::0]')).toEqual({ ok: false, error: expect.stringContaining('step cannot be 0') });
  });

  it('reports a body that is not JSON', () => {
    expect(applyJsonFilter('<html></html>', '$.a')).toEqual({ ok: false, error: 'The response body is not valid JSON' });
  });
});
