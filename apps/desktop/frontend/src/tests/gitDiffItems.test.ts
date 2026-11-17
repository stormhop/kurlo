import { describe, expect, it } from 'vitest';
import { gitDiffItems, gitDiffRows } from '../lib/gitDiffRows';

const twoFiles = ['a.yml', 'b.yml'].map(name => [
  `diff --git a/${name} b/${name}`, '--- /dev/null', `+++ b/${name}`, '@@ -0,0 +1,2 @@', '+one', '+two',
].join('\n')).join('\n');

describe('flat Git diff rows for the virtual list', () => {
  it('keeps section labels, file headers and lines in order with unique keys', () => {
    const items = gitDiffItems([{ label: 'Staged', rows: gitDiffRows(twoFiles) }, { label: 'Unstaged', rows: [] }, { label: 'Other', rows: gitDiffRows('@@ -1 +1 @@\n-old\n+new') }]);
    expect(items.map(item => `${item.kind}:${item.text}`)).toEqual([
      'section:Staged', 'file:a.yml', 'added:one', 'added:two', 'file:b.yml', 'added:one', 'added:two',
      'section:Other', 'removed:old', 'added:new',
    ]);
    expect(new Set(items.map(item => item.key)).size).toBe(items.length);
    expect(items.filter(item => item.kind === 'file' && item.first)).toHaveLength(0);
  });

  it('marks the first file header when it opens the list and sizes rows for the view', () => {
    const compact = gitDiffItems([{ label: '', rows: gitDiffRows(twoFiles) }]);
    const expanded = gitDiffItems([{ label: '', rows: gitDiffRows(twoFiles) }], true);
    expect(compact.filter(item => item.first).map(item => item.key)).toEqual([compact[0].key]);
    expect(compact.find(item => item.kind === 'added')?.height).toBe(16.5);
    expect(expanded.find(item => item.kind === 'added')?.height).toBe(18);
    expect(compact[0].height).toBeLessThan(compact.filter(item => item.kind === 'file')[1].height);
  });
});
