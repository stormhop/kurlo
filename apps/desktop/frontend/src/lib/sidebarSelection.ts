export type RequestSelection = { ids: string[]; anchor: string };

export type SelectionModifiers = { toggle: boolean; range: boolean };

export const EMPTY_SELECTION: RequestSelection = { ids: [], anchor: '' };

export function selectionModifiers(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>): SelectionModifiers {
  return { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey };
}

function inOrder(ids: Iterable<string>, order: string[]): string[] {
  const wanted = new Set(ids);
  return order.filter(id => wanted.has(id));
}

export function applySelectionClick(
  selection: RequestSelection,
  id: string,
  order: string[],
  activeId: string,
  modifiers: SelectionModifiers,
): RequestSelection {
  if (!order.includes(id)) return selection;
  if (modifiers.range) {
    const anchor = order.includes(selection.anchor) ? selection.anchor : order.includes(activeId) ? activeId : id;
    const from = order.indexOf(anchor);
    const to = order.indexOf(id);
    const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    return { ids: modifiers.toggle ? inOrder([...selection.ids, ...range], order) : range, anchor };
  }
  if (modifiers.toggle) {
    const base = selection.ids.length ? selection.ids : activeId !== id && order.includes(activeId) ? [activeId] : [];
    const ids = base.includes(id) ? base.filter(candidate => candidate !== id) : inOrder([...base, id], order);
    return { ids, anchor: id };
  }
  return { ids: [], anchor: id };
}

export function selectAllRequests(order: string[]): RequestSelection {
  return { ids: [...order], anchor: order[0] ?? '' };
}

export function pruneSelection(selection: RequestSelection, order: string[]): RequestSelection {
  const visible = new Set(order);
  const ids = selection.ids.filter(id => visible.has(id));
  const anchor = visible.has(selection.anchor) ? selection.anchor : '';
  if (ids.length === selection.ids.length && anchor === selection.anchor) return selection;
  return { ids, anchor };
}

export type RequestBatchActions = {
  count: number;
  allStarred: boolean;
  canStar: boolean;
  canLoadTest: boolean;
  duplicate: () => void;
  star: () => void;
  loadTest: () => void;
  remove: () => void;
};
