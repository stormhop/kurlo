import type { E2EWindow } from './support/bridge';
import { reviewShot } from './support/reviewShot';
import { fillPrompt } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { openGitPanel, setGitBranches, setGitStatus } from './support/git';

import { expect, test } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('shows the branch, sync state and changes in the status bar as the only Git entry point', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await expect(page.locator('.activity-rail').getByRole('button', { name: 'Git', exact: true })).toHaveCount(0);
    const git = page.getByLabel('Open Git and storage status');
    await expect(git).toContainText('Local storage');
    const base = { isRepo: true, workspaceRoot: '/workspace', root: '/workspace', branch: 'feature/checkout', head: 'a1b2c3d', upstream: 'origin/feature/checkout', remotes: ['origin'] };
    await setGitStatus(page, { ...base, clean: true, files: [] });
    await git.click();
    await expect(page.locator('.git-workspace')).toBeVisible();
    await expect(git).toContainText('feature/checkout');
    await expect(git.locator('.storage-clean')).toHaveCount(1);
    await expect(git.locator('.storage-sync')).toHaveCount(0);
    await setGitStatus(page, {
      ...base, ahead: 2, behind: 1, clean: false, operation: 'merge', upstreamGone: true,
      files: [
        { path: 'workspaces/Main/collections/API/requests/Login.yml', index: ' ', worktree: 'M', status: 'modified' },
        { path: 'workspaces/Main/environments/Local.yml', index: 'A', worktree: ' ', status: 'added' },
      ],
    });
    await page.getByRole('tab', { name: 'Overview' }).click();
    await git.click();
    await expect(git.locator('.storage-sync [aria-hidden="true"]')).toHaveText(['↑2', '↓1']);
    await expect(git.locator('.storage-sync .sr-only')).toHaveText('2 commits to push · 1 to pull');
    await expect(git.locator('.storage-change-count')).toHaveText('2 changed');
    await expect(git.locator('.storage-flag')).toHaveText(['merge', 'gone']);
    await reviewShot(git, { path: join(tmpdir(), 'kurlo-status-git.png'), animations: 'disabled' });
    await page.getByRole('tab', { name: 'Overview' }).click();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await reviewShot(page.locator('.status-bar'), { path: join(tmpdir(), 'kurlo-status-git-dark.png'), animations: 'disabled' });
  });

  test('Git panel commits Kurlo changes, and writes the pending edit first', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      localStorage.setItem('kurlo.autosave.v1', 'true');
      localStorage.setItem('kurlo.autosaveDelay.v1', '30000');
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-git', workspaceId: 'workspace-e2e', name: 'API', filesystemName: 'API' }];
      store.requests = [{ id: 'login', name: 'Login', collectionId: 'collection-git', collection: 'API', folderPath: [], requestType: 'http', method: 'POST', url: 'https://api.example.test/login' }];
      store.activeId = 'login';
      store.openIds = ['login'];
    });
    await page.goto('/');
    await expect(page.getByLabel('Request URL')).toHaveValue('https://api.example.test/login');
    await page.evaluate(() => { window.__kurloE2E.calls.length = 0; });
    await page.getByLabel('Request URL').fill('https://api.example.test/v2/login');

    await setGitStatus(page, {
      isRepo: true,
      workspaceRoot: '/workspace',
      root: '/workspace',
      branch: 'main',
      head: 'a1b2c3d',
      upstream: 'origin/main',
      remotes: ['origin'],
      clean: false,
      files: [{ path: 'workspaces/Main/collections/API/requests/Login.yml', index: ' ', worktree: 'M', status: 'modified' }],
    });

    await openGitPanel(page);
    await expect(page.getByText('Login.yml')).toBeVisible();

    await page.getByRole('button', { name: 'Commit all', exact: true }).first().click();
    await fillPrompt(page, 'Commit Kurlo workspace', 'Update the login request');

    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    const saveIndex = calls.indexOf('SaveRequestStore');
    const commitIndex = calls.findIndex(call => call.startsWith('GitCommitWorkspace:'));

    expect(commitIndex).toBeGreaterThan(-1);
    expect(calls[commitIndex]).toBe('GitCommitWorkspace:Update the login request');
    expect(saveIndex).toBeGreaterThan(-1);
    expect(saveIndex).toBeLessThan(commitIndex);
    expect(await page.evaluate(() => (window.__kurloE2E.store as { requests: Array<{ id: string; url: string }> }).requests.find(request => request.id === 'login')?.url)).toBe('https://api.example.test/v2/login');
  });

  for (const layout of [{ width: 1500, scale: 1 }, { width: 1000, scale: 1.25 }]) {
    test(`Git panel keeps workspace issues, history and output readable at ${layout.width}px and ${layout.scale} scale`, async ({ page }) => {
      await page.setViewportSize({ width: layout.width, height: 780 });
      await installKurloBridge(page);
      await page.addInitScript(scale => localStorage.setItem('kurlo.uiScale.v1', String(scale)), layout.scale);
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
      await setGitStatus(page, {
        isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
        branch: 'main', head: 'a1b2c3d', upstream: 'origin/main', remotes: ['origin'],
        clean: false,
        files: [{ path: 'workspaces/Main/collections/API/examples/Login/403.body.txt', index: '?', worktree: '?', status: 'untracked' }],
      });
      await page.evaluate(() => {
        const app = (window as E2EWindow).go.api.App;
        app.LoadWorkspaceDiagnostics = async () => [
          {
            scope: 'store', severity: 'error', blocking: true, path: 'workspaces/Main/collections/HB-copy/collection.yml',
            message: 'This collection has the same id "collection-fb71d1c7-ca15-45e0-bb05-e127ac36fa75" as workspaces/Main/collections/HB/collection.yml, so the folder looks like a copy. Give the copy and everything inside it new ids, or remove it.',
          },
          {
            scope: 'store', severity: 'error', blocking: true, path: 'workspaces/Main/collections/API/collection.yml',
            message: 'collection.yml is missing but its child files remain. Restore the collection file before saving.',
          },
        ];
        app.GitCommitLogPage = async (limit, offset) => ({
          git: await app.GitStatus(), limit, offset, hasMore: false, error: '', output: '',
          commits: Array.from({ length: 12 }, (_, index) => ({
            hash: `commit-${index}`, shortHash: `hash-${index}`, author: 'Workspace author',
            date: '2026-10-06', message: index ? 'Update workspace files' : 'Restore original workspace ID',
          })),
        });
        app.GitPullWorkspaceWithStrategy = async () => ({
          ok: true, root: '/workspace', payload: JSON.stringify(window.__kurloE2E.store),
          git: await app.GitStatus(), diagnostics: await app.LoadWorkspaceDiagnostics(),
          missingSecrets: [], error: '',
          output: 'Updating 2e346da..55a5b55\nFast-forward\nworkspaces/Main/workspace.yml | 2 +-\n1 file changed, 1 insertion(+), 1 deletion(-)',
        });
      });
      await openGitPanel(page);
      await page.getByRole('button', { name: 'Pull', exact: true }).click();
      await expect(page.locator('.git-yaml-card')).toContainText('2 workspace files need fixing');
      await expect(page.locator('.git-yaml-row')).toHaveCount(2);
      await expect(page.locator('.git-yaml-row').first()).toContainText('collections/HB-copy');
      await expect(page.getByRole('button', { name: 'Commit all', exact: true })).toBeDisabled();
      expect(await page.locator('.git-layout').evaluate(grid => getComputedStyle(grid).borderTopWidth)).toBe('1px');
      await page.getByRole('tab', { name: 'History' }).click();

      await expect.poll(() => page.locator('.git-workspace').evaluate(panel => {
        const card = panel.querySelector<HTMLElement>('.git-yaml-card')!;
        const grid = panel.querySelector<HTMLElement>('.git-layout')!;
        const toolbar = panel.querySelector<HTMLElement>('.git-toolbar')!;
        const content = panel.querySelector<HTMLElement>('.git-content')!;
        const rows = [...panel.querySelectorAll<HTMLElement>('.git-commit-row')];
        const diagnostics = [...panel.querySelectorAll<HTMLElement>('.git-yaml-row')];
        return grid.getBoundingClientRect().top >= card.getBoundingClientRect().bottom - 1
          && toolbar.scrollWidth <= toolbar.clientWidth + 1
          && content.scrollWidth <= content.clientWidth + 1
          && rows.length > 1
          && rows.every(row => row.querySelector('span')!.getBoundingClientRect().bottom <= row.getBoundingClientRect().bottom + 1)
          && rows.slice(1).every((row, index) => row.getBoundingClientRect().top >= rows[index].getBoundingClientRect().bottom - 1)
          && diagnostics.every(row => {
            const edit = row.querySelector('button')!.getBoundingClientRect();
            const bounds = row.getBoundingClientRect();
            return row.scrollWidth <= row.clientWidth + 1 && edit.right <= bounds.right && edit.bottom <= bounds.bottom;
          });
      })).toBe(true);

      await page.getByRole('tab', { name: /Changes/ }).click();
      await expect(page.locator('.git-commit-list')).toHaveCount(0);
      await expect(page.locator('.git-file-row')).toHaveCount(1);
      await page.getByRole('tab', { name: 'History' }).click();
      await expect(page.locator('.git-commit-list')).toBeVisible();
      await expect(page.locator('.git-output-log')).toHaveCount(0);
      await page.getByRole('button', { name: 'More Git actions' }).click();
      await page.getByRole('menuitem', { name: 'Show Git output' }).click();
      const outputDialog = page.getByRole('dialog');
      await expect(outputDialog.getByRole('heading', { name: 'Git output' })).toBeVisible();
      await expect(outputDialog.locator('.git-output-log')).toContainText('Fast-forward');
      await outputDialog.getByRole('button', { name: 'Close Git output' }).click();
      await expect(page.locator('.git-output-log')).toHaveCount(0);
    });
  }

  test('Git branch picker lists each branch once and keeps remote actions on the tracking branch', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'a1b2c3d', upstream: 'origin/main', remotes: ['origin'], clean: true, files: [],
    });
    await setGitBranches(page, {
      ok: true, git: {}, current: 'main', error: '', output: '',
      localBranches: [
        { name: 'main', fullName: 'main', remote: '', current: true, upstream: 'origin/main' },
        { name: 'feature', fullName: 'feature', remote: '', current: false, upstream: 'origin/feature' },
        { name: 'stale', fullName: 'stale', remote: '', current: false, upstream: 'origin/stale' },
      ],
      remoteBranches: [
        { name: 'main', fullName: 'origin/main', remote: 'origin', current: false, upstream: '' },
        { name: 'feature', fullName: 'origin/feature', remote: 'origin', current: false, upstream: '' },
        { name: 'release', fullName: 'origin/release', remote: 'origin', current: false, upstream: '' },
      ],
    });
    await openGitPanel(page);
    await page.locator('.git-branch-chip').click();
    const picker = page.getByRole('dialog', { name: 'Switch branch' });
    const rows = picker.locator('.git-branch-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    await expect(rows.first()).toContainText('origin/main');
    await expect(picker.locator('.git-branch-row', { hasText: 'stale' })).toContainText('gone');
    await expect(picker.locator('.git-branch-row', { hasText: 'release' })).toContainText('remote only');
    await expect(picker.locator('.git-branch-popover-foot')).toHaveCount(0);

    await picker.getByRole('button', { name: 'Actions for feature' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Delete from origin' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Rename on origin' })).toBeVisible();
    await picker.getByRole('button', { name: 'Actions for feature' }).click();
    await expect(menu).toHaveCount(0);

    await picker.getByLabel('Filter branches').fill('rele');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('origin/release');
  });

  test('Git changes and history share the left panel and a commit opens in the diff', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'a1b2c3d', upstream: 'origin/main', remotes: ['origin'], clean: false,
      files: [{ path: 'kurlo.yml', index: ' ', worktree: 'M', status: 'modified', managed: true }],
    });
    await page.evaluate(() => {
      const app = (window as E2EWindow).go.api.App;
      app.GitCommitLogPage = async (limit, offset) => ({
        git: await app.GitStatus(), limit, offset, hasMore: false, error: '', output: '',
        commits: [{ hash: 'abc1234def', shortHash: 'abc1234', author: 'Evgeny', date: '2026-10-06', message: 'Restore original workspace ID' }],
      });
      app.GitCommitDiff = async (hash) => ({ path: hash, diff: '@@ -1 +1 @@\n-old\n+new', stagedDiff: '', unstagedDiff: '', binary: false, truncated: false, error: '' });
    });
    await openGitPanel(page);
    await expect(page.locator('.git-layout > *')).toHaveCount(2);
    await expect(page.getByText('Clean', { exact: true })).toHaveCount(0);
    const changes = page.getByRole('tab', { name: /Changes/ });
    await expect(changes).toHaveAttribute('aria-selected', 'true');
    await expect(changes).toContainText('1');
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.locator('.git-history')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh commit history' })).toHaveCount(0);
    await page.locator('.git-commit-row').first().click();
    await expect(page.locator('.git-diff .git-panel-title')).toContainText('Restore original workspace ID');
    await expect(page.locator('.git-diff .git-panel-title')).toContainText('abc1234 · Evgeny');
  });

  test('pushes the previous file header away instead of stacking it in a commit diff', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'a1b2c3d', upstream: 'origin/main', remotes: ['origin'], clean: true, files: [],
    });
    await page.evaluate(() => {
      const app = (window as E2EWindow).go.api.App;
      const file = (name: string) => [
        `diff --git a/workspaces/Main/${name} b/workspaces/Main/${name}`, '--- /dev/null', `+++ b/workspaces/Main/${name}`, '@@ -0,0 +1,40 @@',
        ...Array.from({ length: 40 }, (_, index) => `+line ${index + 1}`),
      ].join('\n');
      app.GitCommitLogPage = async (limit, offset) => ({
        git: await app.GitStatus(), limit, offset, hasMore: false, error: '', output: '',
        commits: [{ hash: 'abc1234def', shortHash: 'abc1234', author: 'Evgeny', date: '2026-10-06', message: 'Add requests' }],
      });
      app.GitCommitDiff = async (hash) => ({ path: hash, diff: ['first.yml', 'second.yml', 'third.yml'].map(file).join('\n'), stagedDiff: '', unstagedDiff: '', binary: false, truncated: false, error: '' });
    });
    await openGitPanel(page);
    await page.getByRole('tab', { name: 'History' }).click();
    await page.locator('.git-commit-row').first().click();
    const code = page.getByRole('region', { name: 'Git diff' });
    await expect(code.locator('.git-diff-file')).toHaveCount(3);
    const second = code.locator('.git-diff-file', { hasText: 'second.yml' });
    await second.evaluate((header) => {
      const scroller = header.closest('.git-diff-code') as HTMLElement;
      scroller.scrollTop = (header.parentElement as HTMLElement).offsetTop - scroller.offsetTop + 120;
    });
    const tops = await code.locator('.git-diff-file').evaluateAll((headers) => {
      const scroller = headers[0].closest('.git-diff-code') as HTMLElement;
      const top = scroller.getBoundingClientRect().top;
      return headers.map((header) => {
        const rect = header.getBoundingClientRect();
        return { text: header.textContent, top: Math.round(rect.top - top), bottom: Math.round(rect.bottom - top) };
      });
    });
    const pinned = tops.filter((header) => header.bottom > 0 && header.top <= 1);
    expect(pinned.map((header) => header.text)).toEqual(['workspaces/Main/second.yml']);
    expect(pinned[0].top).toBe(0);
  });

  test('renders a large commit diff in a window of rows and scrolls to its end', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'a1b2c3d', upstream: 'origin/main', remotes: ['origin'], clean: true, files: [],
    });
    await page.evaluate(() => {
      const app = (window as E2EWindow).go.api.App;
      const file = (name: string) => [
        `diff --git a/workspaces/Main/${name} b/workspaces/Main/${name}`, '--- /dev/null', `+++ b/workspaces/Main/${name}`, '@@ -0,0 +1,3000 @@',
        ...Array.from({ length: 3000 }, (_, index) => `+${name} line ${index + 1}`),
      ].join('\n');
      app.GitCommitLogPage = async (limit, offset) => ({
        git: await app.GitStatus(), limit, offset, hasMore: false, error: '', output: '',
        commits: [{ hash: 'abc1234def', shortHash: 'abc1234', author: 'Evgeny', date: '2026-10-06', message: 'Import a large collection' }],
      });
      app.GitCommitDiff = async (hash) => ({ path: hash, diff: ['first.yml', 'second.yml'].map(file).join('\n'), stagedDiff: '', unstagedDiff: '', binary: false, truncated: false, error: '' });
    });
    await openGitPanel(page);
    await page.getByRole('tab', { name: 'History' }).click();
    await page.locator('.git-commit-row').first().click();
    const code = page.getByRole('region', { name: 'Git diff', exact: true });
    await expect(code.locator('.git-diff-file', { hasText: 'first.yml' })).toBeVisible();
    await expect(code).toContainText('first.yml line 1');
    expect(await code.locator('.git-diff-line').count()).toBeLessThan(400);
    await page.getByRole('button', { name: 'Expand' }).click();
    const big = page.getByRole('region', { name: 'Expanded Git diff', exact: true });
    await expect(big).toContainText('first.yml line 1');
    expect(await big.locator('.git-diff-line').count()).toBeLessThan(400);
    await page.getByRole('button', { name: 'Close review' }).click();
    await expect(big).toHaveCount(0);

    await expect.poll(async () => {
      await code.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      return code.locator('.git-diff-line', { hasText: 'second.yml line 3000' }).count();
    }).toBe(1);
    await expect(code.locator('.git-diff-line', { hasText: 'second.yml line 3000' })).toBeInViewport();
    expect(await code.locator('.git-diff-line').count()).toBeLessThan(400);
  });

  test('Git panel shows a pulled syntax error in a workspace that is not open', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'a665a49', upstream: 'origin/main', remotes: ['origin'], clean: true, files: [],
    });
    await page.evaluate(() => {
      const app = (window as E2EWindow).go.api.App;
      app.LoadWorkspaceDiagnostics = async () => [{
        scope: 'workspace', severity: 'error', blocking: true, path: 'workspaces/My-Workspace/workspace.yml',
        line: 5, message: "line 5: could not find expected ':'",
      }];
      app.GitPullWorkspaceWithStrategy = async () => ({
        ok: true, root: '/workspace', payload: JSON.stringify(window.__kurloE2E.store),
        git: await app.GitStatus(), diagnostics: await app.LoadWorkspaceDiagnostics(),
        missingSecrets: [], error: '', output: '',
      });
    });
    await openGitPanel(page);
    await page.getByRole('button', { name: 'Pull', exact: true }).click();
    const row = page.locator('.git-yaml-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('workspace.yml:5');
    await expect(row).toContainText('Workspace “My Workspace” stays locked until this is fixed');
    await expect(page.locator('.git-yaml-card')).toContainText('1 workspace file could not be loaded');
  });

  test('Git history loads older commits while scrolling a 5000-commit repository', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'c0', upstream: 'origin/main', remotes: ['origin'], clean: true, files: [],
    });
    await page.evaluate(() => {
      const app = (window as E2EWindow).go.api.App;
      const total = 5000;
      const calls: number[] = [];
      (window as unknown as { __logCalls: number[] }).__logCalls = calls;
      app.GitCommitLogPage = async (limit: number, offset: number) => {
        calls.push(offset);
        await new Promise(resolve => setTimeout(resolve, 150));
        const end = Math.min(total, offset + limit);
        return {
          git: await app.GitStatus(), limit, offset, hasMore: end < total, error: '', output: '',
          commits: Array.from({ length: end - offset }, (_, index) => ({
            hash: `c${offset + index}`, shortHash: `c${offset + index}`, author: 'Author',
            date: '2026-10-06', message: `Commit ${offset + index}`,
          })),
        };
      };
    });
    await openGitPanel(page);
    await page.getByRole('tab', { name: 'History' }).click();
    const list = page.locator('.git-commit-list');
    await expect(list.locator('.git-commit-row').first()).toContainText('Commit 0');
    const loadedOffsets = () => page.evaluate(() => (window as unknown as { __logCalls: number[] }).__logCalls.filter(offset => offset > 0));

    expect(await loadedOffsets()).toEqual([]);
    await expect(page.getByRole('button', { name: /Load more/ })).toHaveCount(0);

    await list.evaluate(element => element.scrollTo(0, element.scrollHeight));
    await expect(list.getByRole('status', { name: 'Loading older commits' }).locator('.kurlo-bird-flying')).toBeVisible();
    await expect(list.locator('.virtual-list-more')).toHaveText('');
    await list.evaluate(element => element.scrollTo(0, element.scrollHeight));
    await reviewShot(list, { path: join(tmpdir(), 'kurlo-git-history-loading.png'), animations: 'disabled' });
    await expect(page.getByRole('button', { name: 'Fetch', exact: true })).toBeEnabled();
    await expect.poll(loadedOffsets).toEqual([100]);
    await expect(list.getByRole('status')).toHaveCount(0);

    await list.evaluate(element => element.scrollTo(0, element.scrollHeight - element.clientHeight * 2));
    await expect.poll(loadedOffsets).toEqual([100, 200]);
    expect(await list.locator('.git-commit-row').count()).toBeLessThan(700);
  });

  test('Git history fills a tall panel and retries older commits after a failure', async ({ page }) => {
    await installKurloBridge(page);
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'c0', upstream: 'origin/main', remotes: ['origin'], clean: true, files: [],
    });
    await page.evaluate(() => {
      const app = (window as E2EWindow).go.api.App;
      const state = { calls: [] as number[], failNext: false };
      (window as unknown as { __log: typeof state }).__log = state;
      app.GitCommitLogPage = async (limit: number, offset: number) => {
        state.calls.push(offset);
        const size = 10;
        const end = Math.min(200, offset + size);
        if (offset > 0 && state.failNext) {
          state.failNext = false;
          return { git: await app.GitStatus(), limit, offset, hasMore: true, error: 'git log failed', output: '', commits: [] };
        }
        return {
          git: await app.GitStatus(), limit, offset, hasMore: end < 200, error: '', output: '',
          commits: Array.from({ length: end - offset }, (_, index) => ({ hash: `c${offset + index}`, shortHash: `c${offset + index}`, author: 'Author', date: '2026-10-06', message: `Commit ${offset + index}` })),
        };
      };
    });
    await openGitPanel(page);
    await page.getByRole('tab', { name: 'History' }).click();
    const list = page.locator('.git-commit-list');
    await expect(list.locator('.git-commit-row').first()).toContainText('Commit 0');
    await expect.poll(() => list.evaluate(node => node.scrollHeight > node.clientHeight * 2.5)).toBe(true);
    const calls = () => page.evaluate(() => (window as unknown as { __log: { calls: number[] } }).__log.calls.filter(offset => offset > 0));
    const filled = (await calls()).length;
    expect(filled).toBeGreaterThan(1);

    await page.evaluate(() => { (window as unknown as { __log: { failNext: boolean } }).__log.failNext = true; });
    await list.evaluate(element => element.scrollTo(0, element.scrollHeight));
    const failure = list.getByRole('alert');
    await expect(failure).toContainText('Older commits could not be loaded.');
    const afterFailure = (await calls()).length;
    await list.evaluate(element => element.scrollTo(0, element.scrollHeight - 1));
    await page.waitForTimeout(300);
    expect((await calls()).length).toBe(afterFailure);
    await reviewShot(list, { path: join(tmpdir(), 'kurlo-git-history-failed.png'), animations: 'disabled' });
    await failure.getByRole('button', { name: 'Retry' }).click();
    await expect(failure).toHaveCount(0);
    await expect.poll(async () => (await calls()).length).toBeGreaterThan(afterFailure);
    await expect(list.locator('.git-commit-row').filter({ hasText: `Commit ${(filled + 1) * 10}` })).toHaveCount(1, { timeout: 5000 }).catch(() => {});
  });

  test('fills in a long Git change list in the background and keeps it windowed', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    const files = Array.from({ length: 1500 }, (_, index) => ({ path: `collections/Big/requests/request-${index}.yml`, status: 'M', staged: false, unstaged: true, x: ' ', y: 'M' }));
    await setGitStatus(page, { isRepo: true, root: '/workspace', workspaceRoot: '/workspace', branch: 'main', head: 'c0', upstream: 'origin/main', remotes: ['origin'], clean: false, files });
    await openGitPanel(page);
    const first = await page.waitForFunction(() => document.querySelectorAll('.git-file-list .git-file-row').length || false, null, { polling: 'raf' });
    expect(await first.jsonValue()).toBeLessThan(300);
    const list = page.locator('.git-file-list');
    await expect(list.locator('.git-file-row').first()).toContainText('request-0.yml');
    await expect.poll(() => list.locator('.git-file-row').count(), { timeout: 5000 }).toBeGreaterThanOrEqual(600);
    expect(await list.locator('.git-file-row').count()).toBeLessThan(700);
    expect(await list.evaluate(node => [getComputedStyle(node).position, getComputedStyle(node).zIndex])).toEqual(['relative', '0']);
    await list.evaluate(node => node.scrollTo(0, node.scrollHeight));
    await expect(list.locator('.git-file-row').last()).toContainText('request-1499.yml');
    expect(await list.locator('.git-file-row').count()).toBeLessThan(700);
  });

  test('Git panel refuses to switch branches while the workspace has local changes', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await setGitStatus(page, {
      isRepo: true,
      workspaceRoot: '/workspace',
      root: '/workspace',
      branch: 'main',
      head: 'a1b2c3d',
      upstream: 'origin/main',
      remotes: ['origin'],
      clean: false,
      files: [{ path: 'workspaces/Main/environments/Local.yml', index: ' ', worktree: 'M', status: 'modified' }],
    });

    await setGitBranches(page, {
      ok: true,
      git: {},
      current: 'main',
      localBranches: [
        { name: 'main', fullName: 'main', remote: '', current: true, upstream: 'origin/main' },
        { name: 'feature', fullName: 'feature', remote: '', current: false, upstream: '' },
      ],
      remoteBranches: [],
      error: '',
      output: '',
    });

    await openGitPanel(page);
    await page.evaluate(() => { window.__kurloE2E.calls.length = 0; });

    await page.locator('.git-branch-chip').click();
    const picker = page.getByRole('dialog', { name: 'Switch branch' });
    await expect(picker).toBeVisible();
    await picker.getByText('feature', { exact: true }).click();

    const blocked = page.getByRole('dialog', { name: 'Checkout blocked' });
    await expect(blocked).toBeVisible();
    await blocked.getByRole('button').first().click();

    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls.some(call => call.startsWith('GitCheckoutBranch:'))).toBe(false);
  });

  test('centres local storage in the status bar without clipping its text', async ({ page }, testInfo) => {
    await installKurloBridge(page, '', 'browser/e2e', false);
    await page.goto('/');
    const button = page.getByLabel('Open Git and storage status');
    await expect(button).toContainText('Local storage');
    await button.hover();
    const layout = await button.evaluate(element => {
      const bar = element.closest('.status-bar')!.getBoundingClientRect();
      const button = element.getBoundingClientRect();
      const label = element.querySelector('.storage-status-main')!;
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      const line = label.getBoundingClientRect();
      const badge = element.querySelector('.storage-status-mode')!.getBoundingClientRect();
      return { top: button.top - bar.top, bottom: bar.bottom - button.bottom, textTop: text.top - button.top, textBottom: button.bottom - text.bottom, offset: line.top + line.height / 2 - badge.top - badge.height / 2 };
    });
    expect(layout.top).toBeGreaterThanOrEqual(2);
    expect(layout.bottom).toBeGreaterThanOrEqual(2);
    expect(layout.textTop).toBeGreaterThanOrEqual(0);
    expect(layout.textBottom).toBeGreaterThanOrEqual(0);
    expect(Math.abs(layout.offset)).toBeLessThan(1);
    await reviewShot(page.locator('.status-bar'), { path: join(tmpdir(), `kurlo-local-storage-${testInfo.project.name}.png`), animations: 'disabled' });
  });

  test('keeps the branch name and change counters of the status bar on one baseline', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', true);
    await page.goto('/');
    const button = page.locator('.storage-status-btn.git');
    await expect(button.locator('.storage-change-count')).toBeVisible();
    const baselines = await button.evaluate(element => [...element.querySelectorAll('.storage-status-main, .storage-sync > span, .storage-change-count')].map(item => {
      const marker = document.createElement('span');
      marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      item.appendChild(marker);
      const bottom = marker.getBoundingClientRect().bottom;
      marker.remove();
      return bottom;
    }));
    expect(baselines.length).toBeGreaterThan(2);
    for (const baseline of baselines) expect(Math.abs(baseline - baselines[0])).toBeLessThan(0.6);
    const offset = await button.evaluate(element => {
      const outer = element.getBoundingClientRect();
      const line = element.querySelector('.storage-status-line')!.getBoundingClientRect();
      return (line.top + line.height / 2) - (outer.top + outer.height / 2);
    });
    expect(Math.abs(offset)).toBeLessThan(1);
  });

  test('Git panel opens a pull request for a pushed branch', async ({ page }, testInfo) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
      e2e.pullRequestCalls = 0;
      ((window as E2EWindow).go.api.App as Record<string, unknown>).GitPullRequestURL = async () => {
        e2e.pullRequestCalls = (e2e.pullRequestCalls as number) + 1;
        return { url: 'https://github.com/acme/api/compare/main...feature%2Forders?expand=1', branch: 'feature/orders', base: 'main' };
      };
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    const base = { isRepo: true, workspaceRoot: '/workspace', root: '/workspace', branch: 'feature/orders', head: 'a1b2c3d', remotes: ['origin'], clean: true, files: [] };

    await setGitStatus(page, { ...base, upstream: 'origin/feature/orders', ahead: 2, behind: 0 });
    await openGitPanel(page);
    await expect(page.getByRole('button', { name: /^Push/ })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Create PR' })).toHaveCount(0);

    await setGitStatus(page, { ...base, upstream: 'origin/feature/orders', ahead: 0, behind: 0 });
    await page.getByRole('button', { name: 'More Git actions' }).click();
    await page.getByRole('menuitem', { name: 'Refresh status' }).click();
    const create = page.getByRole('button', { name: 'Create PR' });
    await expect(create).toBeVisible();
    await reviewShot(page.locator('.git-toolbar'), { path: join(tmpdir(), `kurlo-git-create-pr-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.evaluate(() => { window.__kurloE2E.calls.length = 0; });
    await create.click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls)).toContain('open:https://github.com/acme/api/compare/main...feature%2Forders?expand=1');

    await page.evaluate(() => {
      ((window as E2EWindow).go.api.App as Record<string, unknown>).GitPullRequestURL = async () => ({ url: '', branch: 'feature/orders', base: 'main', error: 'Kurlo builds pull request links for GitHub, GitLab and Bitbucket only; git.example.com is not one of them.' });
    });
    await create.click();
    await expect(page.getByRole('alert').filter({ hasText: 'GitHub, GitLab and Bitbucket only' })).toBeVisible();
  });
});
