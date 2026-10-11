import { describe, expect, it } from 'vitest';
import { gitDiffRows } from '../lib/gitDiffRows';

describe('gitDiffRows', () => {
  it('drops git headers and numbers lines by the file', () => {
    const rows = gitDiffRows([
      'diff --git a/workspaces/Main/collections/Requests/collection.yml b/workspaces/Main/collections/Requests/collection.yml',
      'index 803f713..e94e758 100644',
      '--- a/workspaces/Main/collections/Requests/collection.yml',
      '+++ b/workspaces/Main/collections/Requests/collection.yml',
      '@@ -6,3 +6,3 @@ collection:',
      '     name: EF',
      '-    workspaceId: old',
      '+    workspaceId: new',
      ' requestOrder:',
    ].join('\n'));
    expect(rows.some(row => row.text.includes('diff --git') || row.text.startsWith('index '))).toBe(false);
    expect(rows).toEqual([
      { kind: 'hunk', text: 'collection:', line: null },
      { kind: 'context', text: '    name: EF', line: 6 },
      { kind: 'removed', text: '    workspaceId: old', line: 7 },
      { kind: 'added', text: '    workspaceId: new', line: 7 },
      { kind: 'context', text: 'requestOrder:', line: 8 },
    ]);
  });

  it('shows a new file from line 1 without a separator and keeps the newline note', () => {
    const rows = gitDiffRows([
      'diff --git a/x/403-Forbidden.body.txt b/x/403-Forbidden.body.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/x/403-Forbidden.body.txt',
      '@@ -0,0 +1 @@',
      '+Forbidden',
      '\\ No newline at end of file',
    ].join('\n'));
    expect(rows).toEqual([
      { kind: 'added', text: 'Forbidden', line: 1 },
      { kind: 'note', text: 'No newline at end of file', line: null },
    ]);
  });

  it('keeps a removed line that looks like a header inside a hunk', () => {
    const rows = gitDiffRows('@@ -3,2 +3,1 @@\n--- separator\n keep');
    expect(rows[0]).toEqual({ kind: 'hunk', text: '', line: null });
    expect(rows[1]).toEqual({ kind: 'removed', text: '-- separator', line: 3 });
  });

  it('labels each file when a commit diff touches several', () => {
    const rows = gitDiffRows([
      'diff --git a/kurlo.yml b/kurlo.yml',
      '--- a/kurlo.yml',
      '+++ b/kurlo.yml',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/workspaces/Main/workspace.yml b/workspaces/Main/workspace.yml',
      '--- a/workspaces/Main/workspace.yml',
      '+++ b/workspaces/Main/workspace.yml',
      '@@ -4,1 +4,1 @@',
      '-c',
      '+d',
    ].join('\n'));
    expect(rows.map(row => row.kind)).toEqual(['file', 'removed', 'added', 'file', 'hunk', 'removed', 'added']);
    expect(rows[3].text).toBe('workspaces/Main/workspace.yml');
  });
});
