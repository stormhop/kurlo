import { EditorSelection, EditorState, Transaction, type ChangeSpec, type Extension, type TransactionSpec } from '@codemirror/state';

export function limitTransaction(tr: Transaction, max: number): Transaction | TransactionSpec | readonly TransactionSpec[] {
  if (!tr.docChanged || tr.newDoc.length <= max || !tr.annotation(Transaction.userEvent)) return tr;
  let room = max - tr.startState.doc.length;
  tr.changes.iterChangedRanges((fromA, toA) => {
    room += toA - fromA;
  });
  if (room <= 0 && tr.newDoc.length >= tr.startState.doc.length) return [];
  const changes: ChangeSpec[] = [];
  let cursor = -1;
  let shift = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.toString().slice(0, Math.max(0, room));
    room -= text.length;
    changes.push({ from: fromA, to: toA, insert: text });
    shift += text.length - (toA - fromA);
    cursor = toA + shift;
  });
  return {
    changes,
    selection: cursor >= 0 ? EditorSelection.cursor(cursor) : undefined,
    userEvent: tr.annotation(Transaction.userEvent),
    scrollIntoView: true,
  };
}

export function maxLength(max: number): Extension {
  return EditorState.transactionFilter.of(tr => limitTransaction(tr, max));
}
