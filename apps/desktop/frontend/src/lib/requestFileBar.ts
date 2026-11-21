import { yamlLanguage } from '@codemirror/lang-yaml';
import { TreeFragment, type SyntaxNode, type Tree } from '@lezer/common';
import { textChange } from './textChange';

export type RequestFileBarValues = Record<string, string>;
export type RequestFileBarFieldErrors = Record<string, string>;
export type RequestFileBarRanges = Record<string, { from: number; to: number }>;
export type RequestFileBarChange = string | boolean;
export type RequestFileBarChanges = Record<string, RequestFileBarChange>;

type RequestFileBarFailure = { ok: false; error: string };
export type RequestFileBarResult<T> = ({ ok: true } & T) | RequestFileBarFailure;

type RequestMapping = { node: SyntaxNode; requestPair: SyntaxNode; pairs: Map<string, SyntaxNode[]> };
type ParsedRequestFileBar = { source: string; tree: Tree; mapping: RequestMapping | null; error: string };
type TextEdit = { from: number; to: number; insert: string };

let lastParsed: ParsedRequestFileBar | null = null;
const cacheLimit = 100 * 1024 * 1024;
const barFields = new Set(['name', 'nameAuto', 'url', 'requestType', 'method', 'bodyType', 'aiProvider', 'aiModel', 'aiConnectionId', 'grpcMethod']);

function decodedScalar(source: string): string | null {
  const text = source.trim();
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }
  return text;
}

function scalarSource(node: SyntaxNode, source: string): string | null {
  const scalar = node.name === 'Key' ? node.firstChild : node;
  if (!scalar || (scalar.name !== 'Literal' && scalar.name !== 'QuotedLiteral')) return null;
  return source.slice(scalar.from, scalar.to);
}

function directPairs(mapping: SyntaxNode, source: string) {
  const pairs = new Map<string, SyntaxNode[]>();
  for (const pair of mapping.getChildren('Pair')) {
    const keyNode = pair.getChild('Key');
    if (!keyNode) return null;
    const keySource = scalarSource(keyNode, source);
    const key = keySource === null ? null : decodedScalar(keySource);
    if (key === null) return null;
    pairs.set(key, [...(pairs.get(key) ?? []), pair]);
  }
  return pairs;
}

function findRequestMapping(source: string, tree: Tree): { mapping: RequestMapping | null; error: string } {
  const documents = tree.topNode.getChildren('Document');
  if (documents.length !== 1) {
    return { mapping: null, error: 'The request file must contain one YAML document.' };
  }
  const document = documents[0];
  const root = document.getChild('BlockMapping') ?? document.getChild('FlowMapping');
  if (!root) return { mapping: null, error: 'The request file does not contain a root mapping.' };
  const rootPairs = directPairs(root, source);
  if (!rootPairs) return { mapping: null, error: 'The request file has an unreadable root field.' };
  const requestPairs = rootPairs.get('request') ?? [];
  if (!requestPairs.length) return { mapping: null, error: 'The request file does not contain a request mapping.' };
  if (requestPairs.length > 1) return { mapping: null, error: 'The request file has duplicate request fields.' };
  const requestPair = requestPairs[0];
  const colon = requestPair.getChild(':');
  let value = colon?.nextSibling ?? null;
  while (value?.name === 'Comment') value = value.nextSibling;
  if (!value || (value.name !== 'BlockMapping' && value.name !== 'FlowMapping')) {
    return { mapping: null, error: 'The request field is not a mapping.' };
  }
  const pairs = directPairs(value, source);
  if (!pairs) return { mapping: null, error: 'The request mapping has an unreadable field.' };
  return { mapping: { node: value, requestPair, pairs }, error: '' };
}

function parseRequestFileBar(source: string): ParsedRequestFileBar {
  if (lastParsed?.source === source) return lastParsed;
  let tree: Tree;
  if (lastParsed && source.length <= cacheLimit && lastParsed.source.length <= cacheLimit) {
    const change = textChange(lastParsed.source, source);
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(lastParsed.tree), [{
      fromA: change.from,
      toA: change.to,
      fromB: change.from,
      toB: change.from + change.insert.length,
    }]);
    tree = yamlLanguage.parser.parse(source, fragments);
  } else {
    tree = yamlLanguage.parser.parse(source);
  }
  const parsed = { source, tree, ...findRequestMapping(source, tree) };
  lastParsed = source.length <= cacheLimit ? parsed : null;
  return parsed;
}

export function releaseRequestFileBarCache() {
  lastParsed = null;
}

function valueNode(pair: SyntaxNode) {
  const colon = pair.getChild(':');
  let value = colon?.nextSibling ?? null;
  while (value?.name === 'Comment') value = value.nextSibling;
  return value;
}

function hasError(node: SyntaxNode, includeEnd = false) {
  const cursor = node.cursor();
  do {
    if (cursor.from > node.to || (!includeEnd && cursor.from === node.to)) return false;
    if (cursor.type.isError) return true;
  } while (cursor.next());
  return false;
}

function readValues(parsed: ParsedRequestFileBar, includeRanges = false): RequestFileBarResult<{ values: RequestFileBarValues; fieldErrors: RequestFileBarFieldErrors; ranges?: RequestFileBarRanges }> {
  if (!parsed.mapping) return { ok: false, error: parsed.error };
  const values: RequestFileBarValues = {};
  const fieldErrors: RequestFileBarFieldErrors = {};
  const ranges: RequestFileBarRanges = {};
  for (const [key, pairs] of parsed.mapping.pairs) {
    if (!barFields.has(key)) continue;
    if (pairs.length > 1) {
      fieldErrors[key] = 'The ' + key + ' field is duplicated in the request mapping.';
      continue;
    }
    const pair = pairs[0];
    if (hasError(pair, pairs.length === 1 && pair.to === parsed.mapping.node.to)) {
      fieldErrors[key] = 'The ' + key + ' field has invalid YAML syntax.';
      continue;
    }
    const value = valueNode(pair);
    const raw = value ? scalarSource(value, parsed.source) : null;
    if (value && raw === null) {
      fieldErrors[key] = 'The ' + key + ' field is not a single-line scalar.';
      continue;
    }
    if (raw !== null) {
      const decoded = decodedScalar(raw);
      if (decoded === null) {
        fieldErrors[key] = 'The ' + key + ' field uses a quoted scalar that cannot be decoded safely.';
        continue;
      }
      values[key] = decoded;
      if (includeRanges && value && (value.name === 'Literal' || value.name === 'QuotedLiteral')) {
        ranges[key] = { from: value.from, to: value.to };
      }
    }
  }
  return { ok: true, values, fieldErrors, ...(includeRanges ? { ranges } : {}) };
}

export function readRequestFileBar(content: string, options: { includeRanges?: boolean } = {}): RequestFileBarResult<{ values: RequestFileBarValues; fieldErrors: RequestFileBarFieldErrors; ranges?: RequestFileBarRanges }> {
  return readValues(parseRequestFileBar(content), options.includeRanges);
}

function serializeValue(value: RequestFileBarChange) {
  return typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

function hasSameScalarValue(node: SyntaxNode, source: string, value: RequestFileBarChange) {
  const raw = scalarSource(node, source);
  if (raw === null) return false;
  const trimmed = raw.trim();
  if (typeof value === 'boolean') return node.name === 'Literal' && trimmed === String(value);
  if (node.name === 'QuotedLiteral') return decodedScalar(raw) === value;
  if (/^(?:~|null|true|false|[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?)$/i.test(trimmed)) return false;
  return decodedScalar(raw) === value;
}

function sourceLineEnding(source: string) {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function lineStart(source: string, position: number) {
  return source.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
}

function afterBlankLines(source: string, position: number) {
  let cursor = position;
  while (cursor < source.length) {
    const newlineAt = source.indexOf('\n', cursor);
    const end = newlineAt < 0 ? source.length : newlineAt;
    if (source.slice(cursor, end).trim() !== '') break;
    cursor = newlineAt < 0 ? source.length : newlineAt + 1;
  }
  return cursor;
}

function blockInsertion(source: string, mapping: RequestMapping, additions: string[]) {
  const pairs = mapping.node.getChildren('Pair');
  const newline = sourceLineEnding(source);
  if (pairs.length) {
    const lastPair = pairs[pairs.length - 1];
    if (hasError(lastPair, lastPair.to === mapping.node.to)) return null;
    const lineStartAt = lineStart(source, lastPair.from);
    const indent = source.slice(lineStartAt, lastPair.from).match(/^ */)?.[0] ?? '';
    const newlineAt = source.indexOf('\n', lastPair.to);
    const insertAt = afterBlankLines(source, newlineAt < 0 ? source.length : newlineAt + 1);
    const prefix = insertAt === source.length && !source.endsWith('\n') ? newline : '';
    const suffix = insertAt < source.length || source.endsWith('\n') ? newline : '';
    return { from: insertAt, to: insertAt, insert: prefix + additions.map(item => indent + item).join(newline) + suffix };
  }
  const requestStart = lineStart(source, mapping.requestPair.from);
  const requestIndent = source.slice(requestStart, mapping.requestPair.from).match(/^ */)?.[0] ?? '';
  const newlineAt = source.indexOf('\n', mapping.requestPair.to);
  const insertAt = afterBlankLines(source, newlineAt < 0 ? source.length : newlineAt + 1);
  const prefix = insertAt === source.length && !source.endsWith('\n') ? newline : '';
  const suffix = insertAt < source.length || source.endsWith('\n') ? newline : '';
  const indent = requestIndent + '  ';
  return { from: insertAt, to: insertAt, insert: prefix + additions.map(item => indent + item).join(newline) + suffix };
}

function flowInsertion(source: string, mapping: SyntaxNode, additions: string[]) {
  const close = mapping.getChild('}');
  if (!close) return null;
  const interior = source.slice(mapping.from + 1, close.from);
  const separator = interior.trim() && !interior.trimEnd().endsWith(',') ? ', ' : '';
  return { from: close.from, to: close.from, insert: separator + additions.join(', ') };
}

function applyEdits(source: string, edits: TextEdit[]) {
  let result = source;
  for (const edit of edits.sort((a, b) => b.from - a.from || b.to - a.to)) {
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  }
  return result;
}

function patchParsed(parsed: ParsedRequestFileBar, changes: RequestFileBarChanges): RequestFileBarResult<{ content: string }> {
  const mapping = parsed.mapping;
  if (!mapping) return { ok: false, error: parsed.error };
  const entries = Object.entries(changes);
  if (entries.some(([key, value]) => !barFields.has(key) || (typeof value !== 'string' && typeof value !== 'boolean'))) {
    return { ok: false, error: 'Only toolbar request fields can be changed.' };
  }
  const edits: TextEdit[] = [];
  const additions: string[] = [];
  const state = readValues(parsed);
  if (!state.ok) return state;
  for (const [key, value] of entries) {
    const serialized = serializeValue(value);
    const pairs = mapping.pairs.get(key) ?? [];
    if (state.fieldErrors[key]) return { ok: false, error: state.fieldErrors[key] };
    if (pairs.length > 1) return { ok: false, error: 'The ' + key + ' field is duplicated in the request mapping.' };
    const pair = pairs[0];
    if (!pair) {
      additions.push(key + ': ' + serialized);
      continue;
    }
    const target = valueNode(pair);
    if (!target) {
      const colon = pair.getChild(':');
      if (!colon) return { ok: false, error: 'The ' + key + ' field cannot be edited safely.' };
      edits.push({ from: colon.to, to: colon.to, insert: ' ' + serialized });
    } else if (target.name !== 'Literal' && target.name !== 'QuotedLiteral') {
      return { ok: false, error: 'The ' + key + ' field is not a single-line scalar.' };
    } else if (!hasSameScalarValue(target, parsed.source, value)) {
      edits.push({ from: target.from, to: target.to, insert: serialized });
    }
  }
  if (additions.length) {
    const insertion = mapping.node.name === 'FlowMapping'
      ? flowInsertion(parsed.source, mapping.node, additions)
      : blockInsertion(parsed.source, mapping, additions);
    if (!insertion) return { ok: false, error: 'The request mapping cannot be extended safely.' };
    edits.push(insertion);
  }
  return { ok: true, content: applyEdits(parsed.source, edits) };
}

export function patchRequestFileBar(content: string, changes: RequestFileBarChanges): RequestFileBarResult<{ content: string }> {
  return patchParsed(parseRequestFileBar(content), changes);
}

