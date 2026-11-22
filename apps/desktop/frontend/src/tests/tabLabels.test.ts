import { describe, expect, it } from 'vitest';
import { numberDuplicateTabLabels, numberedTabLabel } from '../lib/utils';

const tabs = (...entries: Array<[string, string]>) => entries.map(([id, label]) => ({ id, label }));

describe('numberDuplicateTabLabels', () => {
  it('numbers untitled tabs in the order they open', () => {
    const numbers = numberDuplicateTabLabels(new Map(), tabs(['a', 'New Request'], ['b', 'Login'], ['c', 'New Request']));
    expect([...numbers]).toEqual([['a', 1], ['c', 2]]);
    expect(numberedTabLabel('New Request', numbers.get('a'))).toBe('New Request');
    expect(numberedTabLabel('New Request', numbers.get('c'))).toBe('New Request 2');
    expect(numberedTabLabel('Login', numbers.get('b'))).toBe('Login');
  });

  it('keeps numbers when other tabs close and fills the first free number', () => {
    const first = numberDuplicateTabLabels(new Map(), tabs(['a', 'New Request'], ['b', 'New Request'], ['c', 'New Request']));
    const afterClose = numberDuplicateTabLabels(first, tabs(['b', 'New Request'], ['c', 'New Request']));
    expect([...afterClose]).toEqual([['b', 2], ['c', 3]]);
    const afterOpen = numberDuplicateTabLabels(afterClose, tabs(['b', 'New Request'], ['c', 'New Request'], ['d', 'New Request']));
    expect(afterOpen.get('d')).toBe(1);
  });

  it('drops a number once the tab gets its own name', () => {
    const first = numberDuplicateTabLabels(new Map(), tabs(['a', 'New Request'], ['b', 'New Request']));
    const renamed = numberDuplicateTabLabels(first, tabs(['a', 'Orders'], ['b', 'New Request']));
    expect([...renamed]).toEqual([['b', 2]]);
  });
});
