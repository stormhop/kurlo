import { mkRow } from './constants';
import type { KVRow } from './types/models';

type PathRow = Pick<KVRow, 'key' | 'value' | 'enabled'>;

function pathBounds(url: string): [number, number] | null {
  let end = url.length;
  const cut = url.search(/[?#]/);
  if (cut >= 0) end = cut;
  let from = 0;
  const scheme = url.slice(0, end).indexOf('://');
  if (scheme >= 0) from = scheme + 3;
  else if (url.startsWith('//')) from = 2;
  const slash = url.slice(from, end).indexOf('/');
  if (slash < 0) return null;
  return [from + slash, end];
}

function segmentName(segment: string): string | null {
  return segment.length > 1 && segment.startsWith(':') ? segment.slice(1) : null;
}

export function pathParamNames(url: string): string[] {
  const bounds = pathBounds(url);
  if (!bounds) return [];
  const names: string[] = [];
  for (const segment of url.slice(bounds[0], bounds[1]).split('/')) {
    const name = segmentName(segment);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function pathParamsFromUrl(url: string, existing: KVRow[] = []): KVRow[] {
  return pathParamNames(url).map(name => {
    const prior = existing.find(r => r.key === name);
    return prior ? { ...prior, enabled: true } : { ...mkRow(), key: name };
  });
}

function escapePathValue(value: string): string {
  return value.replace(/%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@{}%]/g, ch =>
    Array.from(new TextEncoder().encode(ch), b => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
  );
}

export function applyPathParams(url: string, rows: PathRow[] | undefined): string {
  const values = new Map<string, string>();
  for (const row of rows ?? []) {
    if (row.enabled && row.key && row.value) values.set(row.key, row.value);
  }
  if (!values.size) return url;
  const bounds = pathBounds(url);
  if (!bounds) return url;
  const path = url
    .slice(bounds[0], bounds[1])
    .split('/')
    .map(segment => {
      const name = segmentName(segment);
      const value = name === null ? undefined : values.get(name);
      return value === undefined ? segment : escapePathValue(value);
    })
    .join('/');
  return `${url.slice(0, bounds[0])}${path}${url.slice(bounds[1])}`;
}
