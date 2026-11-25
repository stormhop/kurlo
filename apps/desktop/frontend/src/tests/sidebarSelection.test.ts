import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  applySelectionClick,
  pruneSelection,
  selectAllRequests,
  selectionModifiers,
} from '../lib/sidebarSelection';

const order = ['a', 'b', 'c', 'd', 'e'];
const plain = { toggle: false, range: false };
const toggle = { toggle: true, range: false };
const range = { toggle: false, range: true };

describe('sidebar request selection', () => {
  it('reads Cmd or Ctrl as toggle and Shift as range', () => {
    expect(selectionModifiers({ metaKey: true, ctrlKey: false, shiftKey: false })).toEqual(toggle);
    expect(selectionModifiers({ metaKey: false, ctrlKey: true, shiftKey: true })).toEqual({ toggle: true, range: true });
    expect(selectionModifiers({ metaKey: false, ctrlKey: false, shiftKey: false })).toEqual(plain);
  });

  it('starts a toggle selection from the open request and keeps tree order', () => {
    const first = applySelectionClick(EMPTY_SELECTION, 'd', order, 'b', toggle);
    expect(first).toEqual({ ids: ['b', 'd'], anchor: 'd' });
    const second = applySelectionClick(first, 'a', order, 'b', toggle);
    expect(second.ids).toEqual(['a', 'b', 'd']);
    expect(applySelectionClick(second, 'b', order, 'b', toggle).ids).toEqual(['a', 'd']);
    expect(applySelectionClick(EMPTY_SELECTION, 'b', order, 'b', toggle).ids).toEqual(['b']);
    expect(applySelectionClick(EMPTY_SELECTION, 'b', order, 'gone', toggle).ids).toEqual(['b']);
  });

  it('selects a range from the anchor, the open request or the clicked row', () => {
    expect(applySelectionClick({ ids: [], anchor: 'b' }, 'd', order, 'e', range)).toEqual({ ids: ['b', 'c', 'd'], anchor: 'b' });
    expect(applySelectionClick({ ids: [], anchor: 'd' }, 'a', order, 'e', range).ids).toEqual(['a', 'b', 'c', 'd']);
    expect(applySelectionClick(EMPTY_SELECTION, 'c', order, 'e', range).ids).toEqual(['c', 'd', 'e']);
    expect(applySelectionClick(EMPTY_SELECTION, 'c', order, '', range).ids).toEqual(['c']);
    const extended = applySelectionClick({ ids: ['a'], anchor: 'c' }, 'e', order, '', { toggle: true, range: true });
    expect(extended.ids).toEqual(['a', 'c', 'd', 'e']);
  });

  it('clears on a plain click and ignores rows outside the tree', () => {
    expect(applySelectionClick({ ids: ['a', 'b'], anchor: 'a' }, 'c', order, 'a', plain)).toEqual({ ids: [], anchor: 'c' });
    const selection = { ids: ['a', 'b'], anchor: 'a' };
    expect(applySelectionClick(selection, 'starred-only', order, 'a', toggle)).toBe(selection);
  });

  it('selects everything visible and drops rows that left the tree', () => {
    expect(selectAllRequests(order)).toEqual({ ids: order, anchor: 'a' });
    expect(selectAllRequests([])).toEqual({ ids: [], anchor: '' });
    const selection = { ids: ['a', 'c', 'e'], anchor: 'c' };
    expect(pruneSelection(selection, order)).toBe(selection);
    expect(pruneSelection(selection, ['a', 'b', 'e'])).toEqual({ ids: ['a', 'e'], anchor: '' });
  });
});
