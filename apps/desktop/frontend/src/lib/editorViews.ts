import type { EditorView } from '@codemirror/view';

const views = new WeakMap<HTMLElement, EditorView>();

export function registerEditorView(dom: HTMLElement, view: EditorView) {
  views.set(dom, view);
}

export function unregisterEditorView(dom: HTMLElement) {
  views.delete(dom);
}

export function editorViewFor(dom: HTMLElement): EditorView | null {
  return views.get(dom) ?? null;
}
