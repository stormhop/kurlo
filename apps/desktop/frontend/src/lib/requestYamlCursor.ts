import { ensureSyntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { unquoteYamlScalar } from './requestFileEditor';

type Cursor = {
  path: string[];
  kind: 'key' | 'value';
  from: number;
  to: number;
  siblings: Map<string, string>;
  inFlow?: boolean;
  hasColon?: boolean;
};

export type RequestYamlCursor = Cursor & { requestType?: string; method?: string; indentStep?: number };

function ancestor(node: SyntaxNode | null, name: string) {
  while (node && node.name !== name) node = node.parent;
  return node;
}

function isMapping(node: SyntaxNode | null): node is SyntaxNode & { name: 'BlockMapping' | 'FlowMapping' } {
  return node?.name === 'BlockMapping' || node?.name === 'FlowMapping';
}

function scalar(state: EditorState, node: SyntaxNode | null) {
  return node && node.to - node.from <= 128 ? unquoteYamlScalar(state.sliceDoc(node.from, node.to)) : '';
}

function keyOf(state: EditorState, pair: SyntaxNode) {
  return scalar(state, pair.getChild('Key'));
}

function valueOf(pair: SyntaxNode) {
  let value = pair.getChild(':')?.nextSibling ?? null;
  while (value?.name === 'Comment') value = value.nextSibling;
  return value;
}

function mappingKeys(state: EditorState, mapping: SyntaxNode) {
  const keys = new Map<string, string>();
  for (const pair of mapping.getChildren('Pair')) {
    if (!pair.getChild(':')) continue;
    const key = keyOf(state, pair);
    if (key) keys.set(key, key === 'type' || key === 'bodyType' ? scalar(state, valueOf(pair)) : '');
  }
  return keys;
}

function pathTo(state: EditorState, node: SyntaxNode | null) {
  const path: string[] = [];
  for (; node; node = node.parent) {
    if (node.name === 'Pair') path.push(keyOf(state, node));
    if (node.name === 'BlockSequence' || node.name === 'FlowSequence') path.push('*');
  }
  return path.reverse();
}

function keysAt(state: EditorState, owner: SyntaxNode, from: number, to = from): Cursor {
  return {
    kind: 'key', path: pathTo(state, owner), from, to,
    siblings: isMapping(owner) ? mappingKeys(state, owner) : new Map(),
    inFlow: owner.name === 'FlowMapping',
  };
}

function column(state: EditorState, pos: number) {
  return pos - state.doc.lineAt(pos).from;
}

function before(node: SyntaxNode, pos: number) {
  let child: SyntaxNode | null;
  while ((child = node.childBefore(pos))) node = child;
  return node;
}

function blockKey(state: EditorState, pos: number, top: SyntaxNode): Cursor | null {
  const line = state.doc.lineAt(pos);
  const match = /^( *)(- +)?(['"]?[\w.-]*['"]?) *$/.exec(line.text);
  if (!match) return null;
  const [, indent, listMarker, word] = match;
  const from = word ? line.from + indent.length + (listMarker?.length ?? 0) : pos;
  if (word && (pos < from || pos > from + word.length)) return null;
  if (listMarker) {
    const dash = top.resolveInner(line.from + indent.length, 1);
    const seq = ancestor(dash, 'BlockSequence');
    return seq && keysAt(state, seq, from, from + word.length);
  }

  let previous = before(top, line.from);
  while (previous.name === 'Comment') previous = before(top, previous.from);
  const pair = ancestor(previous, 'Pair');
  if (!pair) return null;
  const depth = word ? indent.length : pos - line.from;
  if (depth > column(state, pair.from)) {
    const value = valueOf(pair);
    if (isMapping(value)) return keysAt(state, value, from, from + word.length);
    if (!value || value.from >= line.from) return keysAt(state, pair, from, from + word.length);
    return null;
  }
  for (let map = pair.parent; map; map = map.parent) {
    const first = map.name === 'BlockMapping' && map.getChild('Pair');
    if (first && column(state, first.from) === depth) return keysAt(state, map, from, from + word.length);
  }
  return null;
}

function cursorAt(state: EditorState, pos: number, top: SyntaxNode): Cursor | null {
  const line = state.doc.lineAt(pos);
  const left = top.resolveInner(pos, -1);
  const right = top.resolveInner(pos, 1);
  for (const node of [right, left]) {
    if (ancestor(node, 'Comment') || ancestor(node, 'BlockLiteral')) return null;
    const pair = ancestor(node, 'Pair');
    const map = pair?.parent ?? null;
    if (!pair || !isMapping(map)) continue;
    const key = pair.getChild('Key');
    const colon = pair.getChild(':');
    if (key && key.from <= pos && pos <= key.to) {
      return { ...keysAt(state, map, key.from, key.to), hasColon: !!colon };
    }
    const value = valueOf(pair);
    if (value && (value.name === 'Literal' || value.name === 'QuotedLiteral') && value.from <= pos && pos <= value.to) {
      if (value.from > state.doc.lineAt(pair.from).to) {
        const nested = blockKey(state, pos, top);
        if (nested) return nested;
      }
      if (state.doc.lineAt(value.from).to < value.to) return null;
      return { ...keysAt(state, map, value.from, value.to), kind: 'value', path: pathTo(state, pair), hasColon: true };
    }
  }
  const last = before(top, pos);
  if (last.name === ':' && last.to >= line.from && !state.sliceDoc(last.to, pos).trim()) {
    const pair = last.parent;
    if (pair?.name === 'Pair' && isMapping(pair.parent)) {
      return { ...keysAt(state, pair.parent, pos), kind: 'value', path: pathTo(state, pair), hasColon: true };
    }
  }
  if ((last.name === '{' || last.name === ',') && last.parent?.name === 'FlowMapping') {
    return keysAt(state, last.parent, pos);
  }
  return blockKey(state, pos, top);
}

export function requestYamlCursor(state: EditorState, pos: number): RequestYamlCursor | null {
  if (pos < 0 || pos > state.doc.length) return null;
  const top = ensureSyntaxTree(state, pos, 8)?.topNode;
  if (!top) return null;
  const cursor = cursorAt(state, pos, top);
  if (!cursor || cursor.path[0] !== 'request') return null;
  const doc = top.getChild('Document');
  const root = doc?.getChild('BlockMapping') ?? doc?.getChild('FlowMapping');
  const envelope = root?.getChildren('Pair').find(pair => keyOf(state, pair) === 'request');
  const request = envelope && valueOf(envelope);
  if (!request) return cursor;
  let protocol = '', bodyType = '', method = '', websocket = false;
  for (const pair of request.getChildren('Pair')) {
    const key = keyOf(state, pair);
    if (key === 'requestType') protocol = scalar(state, valueOf(pair));
    if (key === 'method') method = scalar(state, valueOf(pair));
    if (key === 'bodyType') bodyType = scalar(state, valueOf(pair));
    if (key === 'url') {
      const url = valueOf(pair);
      websocket = !!url && /^['"]?wss?:\/\//i.test(state.sliceDoc(url.from, Math.min(url.to, url.from + 8)));
    }
  }
  const first = request.name === 'BlockMapping' && request.getChild('Pair');
  return {
    ...cursor,
    requestType: protocol || (bodyType === 'graphql' ? 'graphql' : websocket ? 'ws' : 'http'),
    method: method || undefined,
    indentStep: first ? column(state, first.from) - column(state, envelope.from) : undefined,
  };
}
