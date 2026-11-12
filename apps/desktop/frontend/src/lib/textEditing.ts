import { EditorView } from '@codemirror/view';
import { clipboardGet, clipboardSet } from './backend';
import { clipboardCopy } from './utils';

export type TextField = HTMLInputElement | HTMLTextAreaElement;

export type TextTarget =
  | { kind: 'field'; el: TextField }
  | { kind: 'code'; view: EditorView }
  | { kind: 'editable'; el: HTMLElement };

export type TextAction = 'cut' | 'copy' | 'paste' | 'selectAll';

export type TextTargetState = {
  selection: string;
  readOnly: boolean;
  secret: boolean;
  empty: boolean;
};

export type TextMenuState = { x: number; y: number; target: TextTarget };

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password']);

export function textTargetFrom(target: EventTarget | null): TextTarget | null {
  if (!(target instanceof Element)) return null;
  const editor = target.closest('.cm-editor');
  if (editor instanceof HTMLElement) {
    const view = EditorView.findFromDOM(editor);
    if (view) return { kind: 'code', view };
  }
  if (target instanceof HTMLTextAreaElement) return target.disabled ? null : { kind: 'field', el: target };
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type) && !target.disabled ? { kind: 'field', el: target } : null;
  }
  const editable = target.closest('[contenteditable]');
  if (editable instanceof HTMLElement && editable.isContentEditable) return { kind: 'editable', el: editable };
  return null;
}

export function textTargetState(target: TextTarget): TextTargetState {
  if (target.kind === 'field') {
    const { el } = target;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    return {
      selection: el.value.slice(start, end),
      readOnly: el.readOnly,
      secret: el instanceof HTMLInputElement && el.type === 'password',
      empty: !el.value,
    };
  }
  if (target.kind === 'code') {
    const { state } = target.view;
    const range = state.selection.main;
    return {
      selection: state.sliceDoc(range.from, range.to),
      readOnly: state.readOnly || !target.view.contentDOM.isContentEditable,
      secret: false,
      empty: state.doc.length === 0,
    };
  }
  const selection = window.getSelection();
  const inside = selection && selection.rangeCount && target.el.contains(selection.anchorNode);
  return {
    selection: inside ? selection.toString() : '',
    readOnly: false,
    secret: false,
    empty: !target.el.textContent,
  };
}

function replaceFieldSelection(el: TextField, text: string) {
  el.focus();
  if (document.execCommand(text ? 'insertText' : 'delete', false, text)) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.setRangeText(text, start, end, 'end');
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: text ? 'insertFromPaste' : 'deleteByCut', data: text || null }));
}

function replaceSelection(target: TextTarget, text: string) {
  if (target.kind === 'field') {
    replaceFieldSelection(target.el, text);
  } else if (target.kind === 'code') {
    target.view.dispatch(target.view.state.replaceSelection(text), { userEvent: text ? 'input.paste' : 'delete.cut', scrollIntoView: true });
    target.view.focus();
  } else {
    target.el.focus();
    document.execCommand(text ? 'insertText' : 'delete', false, text);
  }
}

async function writeClipboard(text: string) {
  if (window.go?.api?.App?.ClipboardSet) await clipboardSet(text);
  else await clipboardCopy(text);
}

export function focusTextTarget(target: TextTarget) {
  if (target.kind === 'code') target.view.focus();
  else target.el.focus();
}

export async function runTextAction(target: TextTarget, action: TextAction, state = textTargetState(target)) {
  if (action === 'copy' || action === 'cut') {
    if (!state.selection || state.secret) return;
    await writeClipboard(state.selection);
    if (action === 'cut' && !state.readOnly) replaceSelection(target, '');
    else focusTextTarget(target);
    return;
  }
  if (action === 'paste') {
    if (state.readOnly) return;
    const text = await clipboardGet();
    if (text) replaceSelection(target, target.kind === 'field' && target.el instanceof HTMLInputElement ? text.replace(/\r?\n/g, ' ') : text);
    else focusTextTarget(target);
    return;
  }
  if (target.kind === 'field') {
    target.el.focus();
    target.el.select();
  } else if (target.kind === 'code') {
    target.view.dispatch({ selection: { anchor: 0, head: target.view.state.doc.length } });
    target.view.focus();
  } else {
    target.el.focus();
    const range = document.createRange();
    range.selectNodeContents(target.el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}
