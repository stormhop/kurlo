import { describe, expect, it } from 'vitest';
import { mkRow } from '../lib/constants';
import type { KVRow } from '../lib/types/models';
import {
  buildQuery,
  additionalQueryRows,
  queryForEditor,
  paramsFromUrl,
  parseQuery,
  splitUrl,
  urlWithParams,
} from '../lib/queryParams';
import { requestBodyFeature } from '../lib/stores/features/requestBody';

const row = (key: string, value: string, enabled = true, description = ''): KVRow => ({
  ...mkRow(),
  key,
  value,
  enabled,
  description,
});

const kv = (rows: KVRow[]) => rows.map(r => ({ key: r.key, value: r.value, enabled: r.enabled }));

describe('splitUrl', () => {
  it('separates head, query and hash', () => {
    expect(splitUrl('https://x.com/p?a=1&b=2#frag')).toEqual({ head: 'https://x.com/p', query: 'a=1&b=2', hash: '#frag' });
    expect(splitUrl('https://x.com/p')).toEqual({ head: 'https://x.com/p', query: '', hash: '' });
    expect(splitUrl('https://x.com/p#frag')).toEqual({ head: 'https://x.com/p', query: '', hash: '#frag' });
  });

  it('leaves a bare variable untouched (no "?" to split on)', () => {
    expect(splitUrl('{{baseUrl}}')).toEqual({ head: '{{baseUrl}}', query: '', hash: '' });
  });
});

describe('parseQuery', () => {
  it('splits pairs and tolerates empty / value-less segments', () => {
    expect(parseQuery('a=1&b=2')).toEqual([{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
    expect(parseQuery('a=1&&b=')).toEqual([{ key: 'a', value: '1' }, { key: 'b', value: '' }]);
    expect(parseQuery('flag')).toEqual([{ key: 'flag', value: '', bare: true }]);
    expect(parseQuery('')).toEqual([]);
  });

  it('recognizes delimiters only outside variable references', () => {
    const url = '/p?q={{secret:vault:app#token}}&{{a=b}}={{a&b}}#fragment';
    const { query, hash } = splitUrl(url);
    expect(hash).toBe('#fragment');
    expect(parseQuery(query)).toEqual([{ key: 'q', value: '{{secret:vault:app#token}}' }, { key: '{{a=b}}', value: '{{a&b}}' }]);
  });

  it('keeps template values literal', () => {
    expect(parseQuery('token={{secret}}')).toEqual([{ key: 'token', value: '{{secret}}' }]);
  });
});

describe('buildQuery', () => {
  it('joins enabled, keyed rows with &', () => {
    expect(buildQuery([row('a', '1'), row('b', '2')])).toBe('a=1&b=2');
  });

  it('skips disabled rows and rows without a key', () => {
    expect(buildQuery([row('a', '1'), row('b', '2', false), row('', 'orphan')])).toBe('a=1');
  });
});

describe('urlWithParams', () => {
  it('appends the query and preserves the fragment', () => {
    expect(urlWithParams('https://x.com/p#frag', [row('a', '1'), row('b', '2')])).toBe('https://x.com/p?a=1&b=2#frag');
  });

  it('replaces an existing query', () => {
    expect(urlWithParams('https://x.com/p?old=9', [row('a', '1')])).toBe('https://x.com/p?a=1');
  });

  it('drops the "?" when there are no active params', () => {
    expect(urlWithParams('https://x.com/p?old=9', [row('a', '1', false), row('', '')])).toBe('https://x.com/p');
  });
});

describe('paramsFromUrl', () => {
  it('builds rows from the query with a trailing blank row', () => {
    const rows = paramsFromUrl('https://x.com?a=1&b=2', [mkRow()]);
    expect(kv(rows)).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: '2', enabled: true },
      { key: '', value: '', enabled: true },
    ]);
  });

  it('inherits the description of a matching existing key', () => {
    const existing = [row('a', 'old', true, 'my note'), mkRow()];
    const rows = paramsFromUrl('https://x.com?a=99', existing);
    expect(rows[0].value).toBe('99');
    expect(rows[0].description).toBe('my note');
  });

  it('keeps user-disabled params that are not in the URL', () => {
    const existing = [row('keep', 'me', false), mkRow()];
    const rows = paramsFromUrl('https://x.com?a=1', existing);
    expect(kv(rows)).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'keep', value: 'me', enabled: false },
      { key: '', value: '', enabled: true },
    ]);
  });
});

describe('additionalQueryRows', () => {
  it('leaves query-less URLs with their table rows', () => {
    const params = [row('a', '1'), mkRow()];
    expect(additionalQueryRows('https://x.com/p', params)).toBe(params);
  });

  it('sends raw URL pairs only once and retains the extra occurrences in table order', () => {
    const disabled = row('tag', 'a', false);
    const extra = row('tag', 'a');
    const different = row('tag', 'b');
    expect(additionalQueryRows('https://x.com/p?tag=a&tag=a#frag', [
      disabled, row('tag', 'a'), different, row('tag', 'a'), extra, mkRow(),
    ])).toEqual([disabled, different, extra]);
    expect(additionalQueryRows('https://x.com/p?flag&a=1', [mkRow()])).toEqual([]);
  });

  it('matches both raw URL rows and decoded imported rows without re-encoding either', () => {
    const extra = row('search', 'A+B & C');
    expect(additionalQueryRows('/p?a%26b=%23&search=A%2BB+%26+C&raw=%2f', [
      row('a&b', '#'), row('search', 'A+B & C'), row('raw', '%2f'), extra,
    ])).toEqual([extra]);
  });
});

describe('editor query representation', () => {
  it('preserves flag spelling and repeated pairs when another row is edited', () => {
    const url = '/p?tag=red&preview&empty=&tag=red&word=caf%c3%a9#part';
    const editor = queryForEditor(url, []);
    expect(editor.url).toBe(url);
    editor.params.push(row('a&b', 'x+y#z & {{name}}'));
    expect(urlWithParams(url, editor.params)).toBe('/p?tag=red&preview&empty=&tag=red&word=caf%c3%a9&a%26b=x%2By%23z%20%26%20{{name}}#part');
  });

  it('keeps an encoded key as it is when only the value is edited', () => {
    const url = '/p?filter%5Bstatus%5D=open';
    const editor = queryForEditor(url, []);
    editor.params[0] = { ...editor.params[0], value: 'closed' };
    expect(urlWithParams(url, editor.params)).toBe('/p?filter%5Bstatus%5D=closed');
    editor.params[0] = { ...editor.params[0], value: '100% caf%C3%A9' };
    expect(urlWithParams(url, editor.params)).toBe('/p?filter%5Bstatus%5D=100%25%20caf%C3%A9');
  });

  it('keeps private table parameters out of the stored URL on open and after editing', () => {
    const secret = { ...row('custom', 'private value'), secret: true };
    const editor = queryForEditor('/p', [row('a', '1'), secret]);
    expect(editor.url).toBe('/p?a=1');
    expect(paramsFromUrl('/next?a=2', editor.params)).toContainEqual(secret);
    expect(urlWithParams('/next?a=2', [row('a', '3'), secret])).toBe('/next?a=3');
    expect(additionalQueryRows(editor.url, editor.params)).toEqual([secret]);
  });

  it('keeps disabled rows between their original neighbors on reload', () => {
    const rows = [row('a', '1'), row('draft', '2', false), row('b', '3')];
    expect(queryForEditor('/p?a=1&b=3', rows).params.slice(0, -1)).toEqual(rows);
  });

  it('keeps duplicate row metadata on a URL edit or reload', () => {
    const red = row('tag', 'red', true, 'first');
    const blue = row('tag', 'blue', true, 'second');
    const disabled = row('tag', 'red', false, 'draft');
    const legacy = queryForEditor('/old?tag=blue#section', [red, blue, disabled]);
    expect(legacy.url).toBe('/old?tag=blue&tag=red#section');
    expect(legacy.params.slice(0, -1)).toEqual([blue, red, disabled]);
    expect(paramsFromUrl('/new?tag=changed&tag=blue', legacy.params).slice(0, -1))
      .toEqual([{ ...red, value: 'changed' }, blue, disabled]);
  });
});

describe('requestBody query sync methods', () => {
  const host = (over: Partial<{ url: string; params: KVRow[]; requestType: string }>) =>
    ({ url: '', params: [mkRow()], requestType: 'http', ...over }) as { url: string; params: KVRow[]; requestType: string };

  it('syncUrlFromParams writes enabled params into the URL', () => {
    const h = host({ url: 'https://x.com', params: [row('a', '1'), row('b', '2'), mkRow()] });
    requestBodyFeature.syncUrlFromParams.call(h as never);
    expect(h.url).toBe('https://x.com?a=1&b=2');
  });

  it('syncUrlFromParams leaves gRPC targets untouched', () => {
    const h = host({ url: 'localhost:50051', params: [row('a', '1'), mkRow()], requestType: 'grpc' });
    requestBodyFeature.syncUrlFromParams.call(h as never);
    expect(h.url).toBe('localhost:50051');
  });

  it('syncParamsFromUrl rebuilds the table from the URL', () => {
    const h = host({ url: 'https://x.com?a=1&b=2', params: [mkRow()] });
    requestBodyFeature.syncParamsFromUrl.call(h as never);
    expect(kv(h.params)).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: '2', enabled: true },
      { key: '', value: '', enabled: true },
    ]);
  });
});
