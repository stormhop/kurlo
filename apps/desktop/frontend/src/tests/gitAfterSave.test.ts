import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitStatusFiles: vi.fn(),
  gitListBranches: vi.fn(),
  gitDiff: vi.fn(),
}));

vi.mock('../lib/backend', () => backend);

import { EMPTY_GIT_STATUS, gitFeature, mergeGitFileStatus, noteSavedWorkspacePaths } from '../lib/stores/features/git';
import type { GitFileStatus } from '../lib/wire';

function file(path: string, worktree = 'M', index = ' '): GitFileStatus {
  return { path, index, worktree, status: worktree === '?' ? 'untracked' : 'modified', managed: true };
}

function makeHost(files: GitFileStatus[], isRepo = true) {
  return {
    ...gitFeature,
    gitStatus: { ...EMPTY_GIT_STATUS, isRepo, clean: files.length === 0, branch: 'main', files },
    gitBranches: { ok: true, git: EMPTY_GIT_STATUS, current: 'main', localBranches: [], remoteBranches: [], error: '', output: '' },
    gitSelectedPath: '',
    gitDiff: { path: '', diff: '', stagedDiff: '', unstagedDiff: '', binary: false, truncated: false, error: '' },
    selectGitFile: vi.fn().mockResolvedValue(undefined),
  };
}

describe('git status after a save', () => {
  beforeEach(() => {
    for (const fn of Object.values(backend)) fn.mockReset();
  });

  it('merges a scoped status into the known files and keeps the order', () => {
    const files = [file('ws/a.yml'), file('ws/b.yml'), file('ws/examples/b/one.yml'), file('README.md')];
    const merged = mergeGitFileStatus(files, ['ws/b.yml', 'ws/examples/b', 'ws/c.yml'], [file('ws/b.yml', 'D'), file('ws/c.yml', '?', '?')]);
    expect(merged.map(entry => `${entry.worktree} ${entry.path}`)).toEqual(['M ws/a.yml', 'D ws/b.yml', 'M README.md', '? ws/c.yml']);
  });

  it('asks Git only about the files a delta save wrote and skips the branch list', async () => {
    const host = makeHost([file('ws/a.yml'), file('ws/b.yml')]);
    host.gitSelectedPath = 'ws/a.yml';
    backend.gitStatusFiles.mockResolvedValue({ ok: true, scoped: true, paths: ['ws/b.yml', 'ws/c.yml'], files: [file('ws/c.yml', '?', '?')] });

    noteSavedWorkspacePaths(host, ['ws/b.yml']);
    noteSavedWorkspacePaths(host, ['ws/c.yml', 'ws/b.yml']);
    await host.refreshGitStatusAfterPersist();

    expect(backend.gitStatusFiles).toHaveBeenCalledWith(['ws/b.yml', 'ws/c.yml']);
    expect(backend.gitStatus).not.toHaveBeenCalled();
    expect(backend.gitListBranches).not.toHaveBeenCalled();
    expect(host.gitStatus.files.map(entry => entry.path)).toEqual(['ws/a.yml', 'ws/c.yml']);
    expect(host.gitStatus.clean).toBe(false);
    expect(host.gitStatus.branch).toBe('main');
    expect(host.selectGitFile).not.toHaveBeenCalled();
  });

  it('does not run Git when a delta save wrote nothing', async () => {
    const host = makeHost([]);
    noteSavedWorkspacePaths(host, []);
    await host.refreshGitStatusAfterPersist();
    await host.refreshGitStatusAfterPersist();
    expect(backend.gitStatusFiles).not.toHaveBeenCalled();
    expect(backend.gitStatus).not.toHaveBeenCalled();
  });

  it('refreshes every file after a full save and reloads the open diff', async () => {
    const host = makeHost([file('ws/a.yml')]);
    host.gitSelectedPath = 'ws/a.yml';
    backend.gitStatusFiles.mockResolvedValue({ ok: true, scoped: false, paths: [], files: [file('ws/a.yml'), file('ws/b.yml')] });

    noteSavedWorkspacePaths(host, ['ws/a.yml']);
    noteSavedWorkspacePaths(host, null);
    await host.refreshGitStatusAfterPersist();

    expect(backend.gitStatusFiles).toHaveBeenCalledWith(null);
    expect(host.gitStatus.files.map(entry => entry.path)).toEqual(['ws/a.yml', 'ws/b.yml']);
    expect(host.selectGitFile).toHaveBeenCalledWith('ws/a.yml');
  });

  it('clears the open diff when its file became clean', async () => {
    const host = makeHost([file('ws/a.yml')]);
    host.gitSelectedPath = 'ws/a.yml';
    backend.gitStatusFiles.mockResolvedValue({ ok: true, scoped: true, paths: ['ws/a.yml'], files: [] });

    noteSavedWorkspacePaths(host, ['ws/a.yml']);
    await host.refreshGitStatusAfterPersist();

    expect(host.gitStatus.clean).toBe(true);
    expect(host.gitSelectedPath).toBe('');
  });

  it('falls back to the full status outside a repository or without the scoped call', async () => {
    const host = makeHost([], false);
    backend.gitStatus.mockResolvedValue({ ...EMPTY_GIT_STATUS, isRepo: true, files: [file('ws/a.yml')] });
    backend.gitListBranches.mockResolvedValue({ ok: true, git: EMPTY_GIT_STATUS, current: 'main', localBranches: [{ name: 'main' }], remoteBranches: [], error: '', output: '' });

    noteSavedWorkspacePaths(host, ['ws/a.yml']);
    await host.refreshGitStatusAfterPersist();

    expect(backend.gitStatusFiles).not.toHaveBeenCalled();
    expect(host.gitStatus.isRepo).toBe(true);
    expect(backend.gitListBranches).toHaveBeenCalledTimes(1);

    backend.gitStatusFiles.mockResolvedValue(null);
    noteSavedWorkspacePaths(host, ['ws/a.yml']);
    await host.refreshGitStatusAfterPersist();
    expect(backend.gitStatus).toHaveBeenCalledTimes(2);
    expect(backend.gitListBranches).toHaveBeenCalledTimes(1);
  });

  it('keeps the saved paths for the next refresh when Git fails', async () => {
    const host = makeHost([]);
    backend.gitStatusFiles.mockRejectedValueOnce(new Error('busy')).mockResolvedValue({ ok: true, scoped: true, paths: ['ws/a.yml'], files: [file('ws/a.yml')] });

    noteSavedWorkspacePaths(host, ['ws/a.yml']);
    await host.refreshGitStatusAfterPersist();
    await host.refreshGitStatusAfterPersist();

    expect(backend.gitStatusFiles).toHaveBeenNthCalledWith(2, ['ws/a.yml']);
    expect(host.gitStatus.files.map(entry => entry.path)).toEqual(['ws/a.yml']);
  });
});
