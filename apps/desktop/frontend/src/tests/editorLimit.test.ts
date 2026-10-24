import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { maxLength } from '../lib/editorLimit';

function editor(doc: string, max: number) {
  return EditorState.create({ doc, extensions: [maxLength(max)] });
}

describe('editor length limit', () => {
  it('cuts a paste to the room that is left and puts the cursor after it', () => {
    const state = editor('abc', 6);
    const next = state.update({ changes: { from: 3, insert: 'defghij' }, userEvent: 'input.paste' }).state;
    expect(next.doc.toString()).toBe('abcdef');
    expect(next.selection.main.head).toBe(6);
  });

  it('counts the text a paste replaces', () => {
    const state = editor('abcdef', 6);
    const next = state.update({ changes: { from: 1, to: 3, insert: 'XYZW' }, userEvent: 'input.paste' }).state;
    expect(next.doc.toString()).toBe('aXYdef');
  });

  it('ignores typing at the limit but still lets you delete', () => {
    const full = editor('abcdef', 6);
    expect(full.update({ changes: { from: 6, insert: 'g' }, userEvent: 'input.type' }).state.doc.toString()).toBe('abcdef');
    expect(full.update({ changes: { from: 5, to: 6 }, userEvent: 'delete.backward' }).state.doc.toString()).toBe('abcde');
  });

  it('keeps text set from outside, such as a request loaded from YAML', () => {
    const state = editor('', 3);
    expect(state.update({ changes: { from: 0, insert: 'longer than three' } }).state.doc.toString()).toBe('longer than three');
  });
});
