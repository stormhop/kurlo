import { test, expect, type Page } from '@playwright/test';
import { installKurloBridge } from './support/bridge';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function openEditor(page: Page, mode = 'manual') {
  const requests = [{
    id: 'r0',
    collectionId: 'c',
    collection: 'Audit',
    name: 'Item 1',
    requestType: 'http',
    method: 'GET',
    url: 'http://127.0.0.1/ping',
  }];
  const loadTests = ['Alpha', 'Beta'].map((name) => ({
    id: name,
    name,
    settings: {},
    scenarios: [
      {
        id: 's',
        name: 'Flow',
        executor: { type: 'constant-vus', vus: 1, durationMs: 1000 },
        steps: [{ id: 't', requestId: 'r0' }],
      },
    ],
  }));
  await installKurloBridge(page, '', 'browser/e2e', false, {
    requests,
    collections: [{ id: 'c', workspaceId: 'workspace-e2e', name: 'Audit', loadTests }],
  });
  await page.addInitScript((mode) => {
    localStorage.setItem('kurlo.autosave.v1', String(mode === 'auto'));
    localStorage.setItem('kurlo.autosaveDelay.v1', '30000');
  }, mode);
  await page.goto('/');
  await page.locator('.collection-request-wrap').filter({ hasText: 'Alpha' }).click();
  const ed = page.getByRole('region', { name: 'Load test', exact: true });
  await expect(ed.getByLabel('Load test name')).toHaveValue('Alpha');
  return ed;
}

async function stored(page: Page) {
  return page.evaluate(
    () => window.__kurloE2E.store.collections.find((c) => c.id === 'c')?.loadTests?.find((t) => t.id === 'Alpha')?.name,
  );
}

test('edits typed during a pending save survive its completion', async ({ page }) => {
  const ed = await openEditor(page);
  const field = ed.getByLabel('Load test name');
  await field.fill('First edit');
  await page.evaluate(() => {
    const api = window.go!.api!.App!;
    const orig = api.SaveRequestStoreWithError!;
    api.SaveRequestStoreWithError = async (...args) => {
      api.SaveRequestStoreWithError = orig;
      await new Promise<void>((resolve) => {
        window.__kurloE2E.responseGate = { ready: true, release: resolve };
      });
      return orig(...args);
    };
  });
  await ed.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.responseGate?.ready)).toBe(true);
  await field.fill('Second edit');
  await page.evaluate(() => window.__kurloE2E.responseGate!.release());
  await expect.poll(() => stored(page)).toBe('First edit');
  await expect(field).toHaveValue('Second edit');
  await ed.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => stored(page)).toBe('Second edit');
});

test('autosave retains edits when switching to another load test', async ({ page }) => {
  const ed = await openEditor(page, 'auto');
  const field = ed.getByLabel('Load test name');
  await field.fill('Edited Alpha');
  await page.locator('.collection-request-wrap').filter({ hasText: 'Beta' }).click();
  await expect(field).toHaveValue('Beta');
  await page.locator('.collection-request-wrap').filter({ hasText: 'Alpha' }).click();
  await expect(field).toHaveValue('Edited Alpha');
  expect(await stored(page)).toBe('Edited Alpha');
});

test('retrying a failed save persists the same draft', async ({ page }) => {
  const ed = await openEditor(page);
  await ed.getByLabel('Load test name').fill('Retry Alpha');
  await page.evaluate(() => {
    window.__kurloE2E.failSaves = true;
  });
  const count = await page.evaluate(() => window.__kurloE2E.calls.filter((x) => x === 'SaveRequestStore').length);
  await ed.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__kurloE2E.calls.filter((x) => x === 'SaveRequestStore').length))
    .toBeGreaterThan(count);
  expect(await stored(page)).toBe('Alpha');
  await page.evaluate(() => {
    window.__kurloE2E.failSaves = false;
  });
  await ed.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => stored(page)).toBe('Retry Alpha');
});

test('preserves the shown load profile while the run is locked', async ({ page }) => {
  const ed = await openEditor(page);
  await ed.getByRole('button', { name: 'Run with k6', exact: true }).click();
  await page.getByRole('dialog', { name: 'Run load test' }).getByRole('button', { name: 'Run load test' }).click();
  await expect(ed.getByText('Editing is locked while k6 runs')).toBeVisible();
  await ed.getByRole('tab', { name: /Load & thresholds/ }).click();
  const field = ed.getByLabel('Load test name');
  await expect(field).toBeDisabled();
  await expect(ed.getByLabel('Environment:', { exact: false })).toBeDisabled();
  await page.screenshot({
    path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), 'k6-run-locked.png'),
    animations: 'disabled',
  });
});

test('separates sidebar badges and results for matching test IDs in two collections', async ({ page }) => {
  const names = ['Alpha', 'Beta'];
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: names.map((name) => ({
      id: name,
      name: name + ' collection',
      workspaceId: 'workspace-e2e',
      loadTests: [{ id: 'shared', name, settings: {}, scenarios: [] }],
    })),
  });
  await page.goto('/');
  const row = (name: string) => page.locator('.collection-request-wrap').filter({ hasText: name });
  await expect(row('Alpha')).toBeVisible();
  await page.evaluate(() => {
    for (const [collectionId, status] of [['Alpha', 'passed'], ['Beta', 'failed']]) {
      window.__kurloE2E.emit('load:done', {
        loadTestId: 'shared', collectionId, loadTestName: collectionId, status,
        finishedAt: 2000, startedAt: 1000, thresholds: [], steps: [],
      });
    }
  });
  const editor = page.getByRole('region', { name: 'Load test', exact: true });
  for (const [name, status] of [['Alpha', 'passed'], ['Beta', 'failed'], ['Alpha', 'passed']]) {
    await expect(row(name)).toContainText('last run ' + status);
    await row(name).click();
    await expect(editor.getByLabel('Load test name')).toHaveValue(name);
    await editor.getByRole('tab', { name: /Results/ }).click();
    await expect(editor.locator('.loadrun-banner .tag')).toHaveText(new RegExp(status, 'i'));
  }
});
