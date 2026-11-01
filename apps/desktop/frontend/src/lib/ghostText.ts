import { stripJsonComments } from './jsonEditing';
import type { RequestHistoryEntry, SavedRequest } from './types/models';

export type InputGhost =
  | { kind: 'suffix'; text: string; value: string }
  | { kind: 'replace'; text: string; value: string };

export type UrlGhostCandidate = { url: string; name: string };

const MIN_URL_PREFIX = 2;
const MIN_NAME_PREFIX = 3;
const MAX_URL_CANDIDATES = 2000;

function protocolFamily(requestType: string | undefined): string {
  return !requestType || requestType === 'http' || requestType === 'graphql' ? 'http' : requestType;
}

export function urlGhostCandidates(
  requests: SavedRequest[],
  history: RequestHistoryEntry[],
  options: { workspaceCollectionIds?: Set<string>; requestType?: string; excludeRequestId?: string } = {},
): UrlGhostCandidate[] {
  const family = protocolFamily(options.requestType);
  const seen = new Set<string>();
  const out: UrlGhostCandidate[] = [];
  const add = (request: SavedRequest) => {
    const url = request.url?.trim() ?? '';
    if (!url || seen.has(url) || protocolFamily(request.requestType) !== family) return;
    seen.add(url);
    out.push({ url, name: request.name?.trim() ?? '' });
  };
  const inWorkspace = (request: SavedRequest) => !options.workspaceCollectionIds || options.workspaceCollectionIds.has(request.collectionId);
  for (const entry of [...history].sort((a, b) => b.createdAt - a.createdAt)) {
    if (out.length >= MAX_URL_CANDIDATES) break;
    add(entry.request);
  }
  for (const request of requests) {
    if (out.length >= MAX_URL_CANDIDATES) break;
    if (request.isDraft || request.isInvalid || request.id === options.excludeRequestId || !inWorkspace(request)) continue;
    add(request);
  }
  const named = new Map<string, string>();
  for (const request of requests) {
    const url = request.url?.trim();
    if (url && request.name?.trim() && !request.isDraft && inWorkspace(request) && !named.has(url)) named.set(url, request.name.trim());
  }
  return out.map(candidate => ({ ...candidate, name: candidate.name || named.get(candidate.url) || '' }));
}

export function urlGhost(typed: string, candidates: UrlGhostCandidate[]): InputGhost | null {
  if (!typed.trim() || /[\r\n]/.test(typed)) return null;
  const lower = typed.toLowerCase();
  if (typed.length >= MIN_URL_PREFIX) {
    for (const candidate of candidates) {
      if (candidate.url.length > typed.length && candidate.url.toLowerCase().startsWith(lower)) {
        const text = candidate.url.slice(typed.length);
        return { kind: 'suffix', text, value: typed + text };
      }
    }
  }
  const needle = typed.trim().toLowerCase();
  if (needle.length < MIN_NAME_PREFIX || /[/:{]/.test(needle)) return null;
  for (const candidate of candidates) {
    if (candidate.name && candidate.name.toLowerCase().startsWith(needle) && candidate.url.toLowerCase() !== lower) {
      return { kind: 'replace', text: `${candidate.name.slice(needle.length)} → ${candidate.url}`, value: candidate.url };
    }
  }
  return null;
}

export type JsonKeySchema = Map<string, string[]>;

const OBJECT_PATH_ROOT = '$';

function parseJsonLoosely(source: string): unknown {
  const stripped = stripJsonComments(source);
  const withoutTemplates = stripped.replace(/("(?:[^"\\]|\\.)*")|\{\{[^{}]*\}\}/g, (match, quoted: string | undefined) => quoted ?? 'null');
  try {
    return JSON.parse(withoutTemplates);
  } catch {
    return undefined;
  }
}

export function jsonKeySchema(bodies: string[]): JsonKeySchema {
  const schema: JsonKeySchema = new Map();
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 32) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, `${path}[]`, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const keys = schema.get(path) ?? [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!keys.includes(key)) keys.push(key);
      visit(child, `${path}.${key}`, depth + 1);
    }
    schema.set(path, keys);
  };
  for (const body of bodies) {
    if (!body.trim()) continue;
    const parsed = parseJsonLoosely(body);
    if (parsed !== undefined) visit(parsed, OBJECT_PATH_ROOT, 0);
  }
  return schema;
}

type Frame = { kind: 'object' | 'array'; key: string; keys: Set<string>; expectKey: boolean };

type KeyContext = { path: string; prefix: string; quoted: boolean; present: Set<string> };

function keyContextAt(doc: string, pos: number): KeyContext | null {
  const stack: Frame[] = [];
  let i = 0;
  let pendingKey = '';
  while (i < pos) {
    const ch = doc[i];
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < doc.length && doc[j] !== '"') {
        if (doc[j] === '\\') { text += doc[j + 1] ?? ''; j += 2; continue; }
        text += doc[j];
        j += 1;
      }
      const top = stack[stack.length - 1];
      if (j >= pos) {
        if (top?.kind === 'object' && top.expectKey && !/[\r\n]/.test(doc.slice(i + 1, pos))) {
          return { path: pathOf(stack), prefix: doc.slice(i + 1, pos), quoted: true, present: collectKeys(doc, top, stack.length, Math.min(j + 1, doc.length)) };
        }
        return null;
      }
      if (top?.kind === 'object' && top.expectKey) {
        pendingKey = text;
        top.keys.add(text);
      }
      i = j + 1;
      continue;
    }
    if (ch === '/' && doc[i + 1] === '/') {
      const end = doc.indexOf('\n', i);
      if (end < 0 || end >= pos) return null;
      i = end + 1;
      continue;
    }
    if (ch === '/' && doc[i + 1] === '*') {
      const end = doc.indexOf('*/', i + 2);
      if (end < 0 || end + 2 > pos) return null;
      i = end + 2;
      continue;
    }
    if (ch === '{' && doc[i + 1] === '{') {
      const end = doc.indexOf('}}', i + 2);
      if (end < 0 || end + 2 > pos) return null;
      i = end + 2;
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === '{' || ch === '[') {
      const key = top?.kind === 'object' ? pendingKey : top?.kind === 'array' ? '[]' : '';
      stack.push({ kind: ch === '{' ? 'object' : 'array', key, keys: new Set(), expectKey: ch === '{' });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ':' && top?.kind === 'object') {
      top.expectKey = false;
    } else if (ch === ',' && top?.kind === 'object') {
      top.expectKey = true;
    }
    i += 1;
  }
  const top = stack[stack.length - 1];
  if (top?.kind !== 'object' || !top.expectKey) return null;
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1;
  const before = doc.slice(lineStart, pos);
  const bare = /([A-Za-z_$][\w$-]*)$/.exec(before);
  const prefix = bare ? bare[1] : '';
  const head = before.slice(0, before.length - prefix.length);
  if (!/(^|[{,\s])$/.test(head)) return null;
  return { path: pathOf(stack), prefix, quoted: false, present: collectKeys(doc, top, stack.length, pos) };
}

function pathOf(stack: Frame[]): string {
  let path = OBJECT_PATH_ROOT;
  for (const frame of stack.slice(1)) path += frame.key === '[]' ? '[]' : `.${frame.key}`;
  return path;
}

function collectKeys(doc: string, frame: Frame, depth: number, pos: number): Set<string> {
  const keys = new Set(frame.keys);
  let level = depth;
  let expectKey = false;
  let i = pos;
  while (i < doc.length && level >= depth) {
    const ch = doc[i];
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < doc.length && doc[j] !== '"') {
        if (doc[j] === '\\') { text += doc[j + 1] ?? ''; j += 2; continue; }
        text += doc[j];
        j += 1;
      }
      if (level === depth && expectKey && doc.slice(j + 1).trimStart().startsWith(':')) keys.add(text);
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '[') level += 1;
    else if (ch === '}' || ch === ']') level -= 1;
    else if (ch === ',' && level === depth) expectKey = true;
    i += 1;
  }
  return keys;
}

export type EditorGhost = { text: string; from: number; to: number; insert: string };

export function jsonKeyGhost(doc: string, pos: number, schema: JsonKeySchema): EditorGhost | null {
  if (!schema.size) return null;
  const context = keyContextAt(doc, pos);
  if (!context) return null;
  const keys = schema.get(context.path);
  if (!keys?.length) return null;
  const present = new Set(context.present);
  if (!context.quoted && context.prefix) present.delete(context.prefix);
  const key = keys.find(candidate => !present.has(candidate) && candidate.startsWith(context.prefix) && candidate !== context.prefix);
  if (!key) return null;
  const rest = key.slice(context.prefix.length);
  if (context.quoted) {
    const closingQuote = doc[pos] === '"';
    const afterQuote = closingQuote ? doc.slice(pos + 1).trimStart() : '';
    const hasColon = afterQuote.startsWith(':');
    return {
      text: rest,
      from: pos,
      to: closingQuote ? pos + 1 : pos,
      insert: hasColon ? `${rest}"` : `${rest}": `,
    };
  }
  return {
    text: context.prefix ? rest : `"${key}": `,
    from: pos - context.prefix.length,
    to: pos,
    insert: `"${key}": `,
  };
}
