import { EditorState, type ChangeSpec } from '@codemirror/state';
import { foldable } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { requestFileEditor } from '../lib/requestFileEditor';

const source = 'version: 1\nrequest:\n  "id": demo # stable\n  requestType: http\n  url: https://example.test\n  bodyContent: |\n    id: editable\n';

function editor(doc = source) {
  return EditorState.create({ doc, extensions: requestFileEditor(() => doc, () => {}) });
}

function edit(state: EditorState, changes: ChangeSpec, userEvent = 'input.type') {
  return state.update({ changes, userEvent }).state;
}

describe('request file editor', () => {
  it('preserves managed values during typing, deletion and pasting a whole file', () => {
    const state = editor();
    const id = source.indexOf('demo');
    expect(edit(state, { from: id + 2, insert: 'q' }).doc.toString()).toBe(source);
    expect(edit(state, { from: id, to: id + 4 }, 'delete.selection').doc.toString()).toBe(source);
    const forged = source.replace('"id": demo', 'id: different');
    expect(edit(state, { from: 0, to: state.doc.length, insert: forged }, 'input.paste').doc.toString()).toBe(source);
    const updated = source.replace('"id": demo', "id: 'demo'").replace('example.test', 'api.test');
    expect(edit(state, { from: 0, to: state.doc.length, insert: updated }, 'input.paste').doc.toString()).toBe(updated);
  });

  it('keeps an existing collection name while editing another field', () => {
    const legacy = source.replace('  requestType:', '  collection: Smoke\n  requestType:');
    const updated = legacy.replace('example.test', 'orders.test');
    const pasted = (text: string) => edit(editor(legacy), { from: 0, to: legacy.length, insert: text }, 'input.paste').doc.toString();
    expect(pasted(updated)).toBe(updated);
    expect(pasted(updated.replace('Smoke', 'Other'))).toBe(legacy);
  });

  it('recognizes fields in flow YAML and allows editing comments and block scalar content', () => {
    const flow = '{version: 1, request: {id: demo, requestType: http, url: example}}';
    const state = editor(flow);
    expect(edit(state, { from: flow.indexOf('demo'), insert: 'z' }).doc.toString()).toBe(flow);
    expect(edit(editor(), { from: source.indexOf('stable'), insert: 'a ' }).doc.toString()).toContain('# a stable');
    expect(edit(editor(), { from: source.indexOf('editable'), insert: 'also ' }).doc.toString()).toContain('id: also editable');
    const body = editor().doc.line(6);
    expect(foldable(editor(), body.from, body.to)).toBeTruthy();
  });

  it('keeps absent managed fields out of sparse files while allowing nested fields with the same name', () => {
    expect(edit(editor(), { from: source.length, insert: '  collectionId: core' }).doc.toString()).toBe(source);
    expect(edit(editor(), { from: source.length, insert: '  id: duplicate' }).doc.toString()).toBe(source);
    const pasted = source + '  newId: duplicate';
    const key = pasted.indexOf('newId');
    expect(edit(editor(pasted), { from: key, to: key + 5, insert: 'id' }).doc.toString()).toBe(pasted);
    const nested = '  x-owner:\n    collectionId: core';
    expect(edit(editor(), { from: source.length, insert: nested }).doc.toString()).toBe(source + nested);
  });
});
