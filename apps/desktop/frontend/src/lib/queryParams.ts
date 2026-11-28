import { mkRow } from './constants';
import { rowHasContent } from './utils';
import type { KVRow } from './types/models';

export type QueryPair = { key: string; value: string; bare?: boolean };

type QueryRow = Pick<KVRow, 'key' | 'value' | 'enabled' | 'secret' | 'secretRef'>;

function maskTemplates(value: string) {
  return value.includes('{{') ? value.replace(/\{\{[^{}]*\}\}/g, token => '_'.repeat(token.length)) : value;
}

export function splitUrl(url: string): { head: string; query: string; hash: string } {
  const masked = maskTemplates(url);
  const fragment = masked.indexOf('#');
  const end = fragment < 0 ? url.length : fragment;
  const start = masked.indexOf('?');
  return start >= 0 && start < end
    ? { head: url.slice(0, start), query: url.slice(start + 1, end), hash: url.slice(end) }
    : { head: url.slice(0, end), query: '', hash: url.slice(end) };
}

export function appendQueryString(url: string, extra: string): string {
  if (!extra) return url;
  const { head, query, hash } = splitUrl(url);
  return `${head}?${query ? query + '&' : ''}${extra}${hash}`;
}

export function parseQuery(query: string): QueryPair[] {
  const masked = maskTemplates(query);
  const pairs: QueryPair[] = [];
  for (const segment of masked.matchAll(/[^&]+/g)) {
    const raw = query.slice(segment.index, segment.index + segment[0].length);
    const eq = segment[0].indexOf('=');
    pairs.push(eq < 0
      ? { key: raw, value: '', bare: true }
      : { key: raw.slice(0, eq), value: raw.slice(eq + 1) });
  }
  return pairs;
}

function decodePart(value: string) {
  try { return decodeURIComponent(value.replace(/\+/g, ' ')); }
  catch { return value; }
}

function encodePart(value: string, encode: (part: string) => string = encodeURIComponent) {
  return value.split(/(\{\{[^{}]*\}\})/g).map((part, i) => i % 2 ? part : encode(part)).join('');
}

export function matchQueryRows(pairs: QueryPair[], rows: QueryRow[], allowKeyMatch = false) {
  const remaining = new Set(rows.map((_, index) => index));
  const matches = pairs.map(() => -1);
  const match = (accept: (row: QueryRow, pair: QueryPair) => boolean, candidates: QueryPair[]) => {
    candidates.forEach((pair, i) => {
      if (matches[i] >= 0) return;
      for (const index of remaining) {
        if (rows[index].enabled && accept(rows[index], pair)) {
          remaining.delete(index);
          matches[i] = index;
          break;
        }
      }
    });
  };
  const identical = (row: QueryRow, pair: QueryPair) => row.key === pair.key && row.value === pair.value;
  match(identical, pairs);
  if (matches.includes(-1)) {
    const decoded = pairs.map(pair => ({ key: decodePart(pair.key), value: decodePart(pair.value) }));
    match(identical, decoded);
    if (allowKeyMatch) {
      const sameKey = (row: QueryRow, pair: QueryPair) => !row.secret && !row.secretRef && row.key === pair.key;
      match(sameKey, pairs);
      match(sameKey, decoded);
    }
  }
  return { matches, remaining };
}

function encodeKeepingEscapes(part: string) {
  return part.replace(/%[0-9A-Fa-f]{2}|[^%]+|%/g, piece => (/^%[0-9A-Fa-f]{2}$/.test(piece) ? piece : encodeURIComponent(piece)));
}

function formatRow(row: QueryRow) {
  return `${encodePart(row.key, encodeKeepingEscapes)}=${encodePart(row.value, encodeKeepingEscapes)}`;
}

export function buildQuery(rows: QueryRow[]): string {
  return rows.filter(row => row.enabled && row.key && !row.secret && !row.secretRef).map(formatRow).join('&');
}

export function urlWithParams(url: string, rows: QueryRow[]): string {
  const { head, query, hash } = splitUrl(url);
  const pairs = parseQuery(query);
  const { matches } = matchQueryRows(pairs, rows);
  const rawByRow = new Map<number, string>();
  pairs.forEach((pair, i) => {
    if (matches[i] >= 0) rawByRow.set(matches[i], pair.bare ? pair.key : `${pair.key}=${pair.value}`);
  });
  const next = rows.flatMap((row, i) =>
    row.enabled && (rawByRow.has(i) || (row.key && !row.secret && !row.secretRef)) ? [rawByRow.get(i) ?? formatRow(row)] : []
  ).join('&');
  return `${head}${next ? `?${next}` : ''}${hash}`;
}

function editorRows(pairs: QueryPair[], existing: KVRow[], matches: number[]) {
  return pairs.map((pair, i) => {
    const row = existing[matches[i]];
    if (!row) return { ...mkRow(), key: pair.key, value: pair.value };
    if (row.value === pair.value || row.value === decodePart(pair.value)) return row;
    return { ...row, value: pair.value };
  });
}

export function paramsFromUrl(url: string, existing: KVRow[]): KVRow[] {
  const pairs = parseQuery(splitUrl(url).query);
  const pool = existing.filter(rowHasContent);
  const { matches, remaining } = matchQueryRows(pairs, pool, true);
  const kept = [...remaining].map(i => pool[i]).filter(row => !row.enabled || row.secret || row.secretRef);
  return [...editorRows(pairs, pool, matches), ...kept, mkRow()];
}

export function queryForEditor(url: string, params: KVRow[]): { url: string; params: KVRow[] } {
  const pairs = parseQuery(splitUrl(url).query);
  const rows = params.filter(rowHasContent);
  const { matches, remaining } = matchQueryRows(pairs, rows);
  const extra = [...remaining].map(i => rows[i]);
  const next = appendQueryString(url, buildQuery(extra));
  const active = rows.flatMap((row, index) => row.enabled && row.key ? [index] : []);
  const rowsInOrder = matches.every((index, i) => index >= 0 && index === active[i]);
  const visible = rowsInOrder ? rows : [...editorRows(pairs, rows, matches), ...extra];
  return { url: next, params: [...visible, mkRow()] };
}

export function additionalQueryRows(url: string, params: KVRow[]): KVRow[] {
  const { query } = splitUrl(url);
  if (!query) return params;
  const { remaining } = matchQueryRows(parseQuery(query), params);
  return [...remaining].map(i => params[i]).filter(row => row.key || row.value);
}

export function resolveQueryUrl(url: string, resolve: (value: string) => string): string {
  const { head, query, hash } = splitUrl(url);
  if (!query.includes('{{')) return resolve(url);
  const escapeValue = (value: string) => encodeURIComponent(value)
    .replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
  const resolved = query.replace(/\{\{[^{}]*\}\}/g, token => {
    const value = resolve(token);
    return value === token ? token : encodePart(value, escapeValue);
  });
  return `${resolve(head)}?${resolved}${resolve(hash)}`;
}
