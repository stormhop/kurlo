import { describe, expect, it } from 'vitest';
import { gitConflictHunks, replaceAllGitConflictHunks, replaceGitConflictHunk } from '../lib/gitConflicts';

const sample = [
  'version: 1',
  'workspace:',
  '    name: Workspace',
  '<<<<<<< HEAD',
  '    description: dddd',
  '=======',
  '    description: "123321"',
  '>>>>>>> remote',
  '    filesystemName: coll',
].join('\n');

describe('git conflict helpers', () => {
  it('finds conflict hunks with line numbers and sides', () => {
    const hunks = gitConflictHunks(sample);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      index: 0,
      startLine: 4,
      endLine: 8,
      marker: 'HEAD',
      ours: ['    description: dddd'],
      theirs: ['    description: "123321"'],
    });
  });

  it('replaces one hunk with the selected side', () => {
    expect(replaceGitConflictHunk(sample, 0, 'ours')).toContain('description: dddd');
    expect(replaceGitConflictHunk(sample, 0, 'ours')).not.toContain('<<<<<<<');
    expect(replaceGitConflictHunk(sample, 0, 'theirs')).toContain('description: "123321"');
  });

  it('resolves every hunk in a file', () => {
    const resolved = replaceAllGitConflictHunks(`${sample}\n${sample}`, 'theirs');
    expect(resolved).not.toContain('=======');
    expect(resolved.match(/description: "123321"/g)).toHaveLength(2);
  });
});

const diff3Sample = [
  'version: 1',
  '<<<<<<< HEAD',
  '    description: local',
  '||||||| merged common ancestors',
  '    description: base',
  '=======',
  '    description: remote',
  '>>>>>>> feature',
  '    name: Workspace',
].join('\n');

describe('git conflict helpers with diff3 style', () => {
  it('keeps the diff3 base section out of both sides', () => {
    const hunks = gitConflictHunks(diff3Sample);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].ours).toEqual(['    description: local']);
    expect(hunks[0].theirs).toEqual(['    description: remote']);
    expect(hunks[0].base).toEqual(['    description: base']);
    expect(JSON.stringify(hunks[0].ours)).not.toContain('|||||||');
    expect(JSON.stringify(hunks[0].ours)).not.toContain('description: base');
  });

  it('resolving a side drops the base section and its marker', () => {
    for (const side of ['ours', 'theirs'] as const) {
      const resolved = replaceAllGitConflictHunks(diff3Sample, side);
      expect(resolved).not.toContain('|||||||');
      expect(resolved).not.toContain('description: base');
      expect(resolved).not.toContain('=======');
    }
    expect(replaceAllGitConflictHunks(diff3Sample, 'ours')).toContain('description: local');
    expect(replaceAllGitConflictHunks(diff3Sample, 'theirs')).toContain('description: remote');
  });
});
