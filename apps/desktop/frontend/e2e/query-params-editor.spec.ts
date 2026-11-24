import { expect, test } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installKurloBridge } from './support/bridge';
import { chooseRequestSection, collectionRow } from './support/actions';

const screenshotPath = (name: string) => join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), name);

test('hydrates legacy URL-only and params-only query data without making clean drafts dirty', async ({ page }) => {
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'query-legacy', workspaceId: 'workspace-e2e', name: 'Legacy requests' }],
    requests: [
      {
        id: 'url-only', name: 'URL only', collectionId: 'query-legacy', collection: 'Legacy requests',
        requestType: 'http', method: 'GET', url: 'https://example.test/items?tag=red&tag=blue&limit=2', params: [],
      },
      {
        id: 'params-only', name: 'Params only', collectionId: 'query-legacy', collection: 'Legacy requests',
        requestType: 'http', method: 'GET', url: 'https://example.test/items',
        params: [
          { enabled: true, key: 'region', value: 'eu', description: 'Region', secret: false },
          { enabled: true, key: 'token', value: 'private-token', description: 'Secret', secret: true },
          { enabled: false, key: 'preview', value: '1', description: 'Disabled', secret: true },
        ],
      },
    ],
    activeId: '', openIds: [],
  });
  await page.addInitScript(() => localStorage.setItem('kurlo.autosave.v1', 'false'));
  await page.goto('/');
  const collection = collectionRow(page, 'Legacy requests');
  const expand = collection.getByLabel('Expand collection');
  if (await expand.isVisible()) await expand.click();

  await page.locator('.collection-list .collection-request').filter({ hasText: 'URL only' }).click();
  await expect(page.getByLabel('Request URL')).toHaveValue('https://example.test/items?tag=red&tag=blue&limit=2');
  await chooseRequestSection(page, 'Params');
  const urlOnlyRows = page.locator('[data-testid="params-row"]');
  await expect(urlOnlyRows).toHaveCount(4);
  await expect(page.getByText('3 active', { exact: true })).toBeVisible();
  const urlOnlyTab = page.locator('.saved-request-tab.active');
  await expect(urlOnlyTab).not.toHaveClass(/\bunsaved\b/);
  await expect.poll(() => page.evaluate(() => {
    const saved = window.__kurloE2E.store.requests.find(request => request.id === 'url-only')!;
    return [saved.url, saved.params.length];
  })).toEqual(['https://example.test/items?tag=red&tag=blue&limit=2', 0]);
  await page.screenshot({ path: screenshotPath('query-editor-url-only-hydrated.png'), animations: 'disabled' });

  const url = page.getByLabel('Request URL');
  await url.fill('https://example.test/v2/items?tag=red&tag=blue&limit=2');
  await expect(url).toHaveValue('https://example.test/v2/items?tag=red&tag=blue&limit=2');
  await expect(urlOnlyRows).toHaveCount(4);
  await expect(urlOnlyTab).toHaveClass(/\bunsaved\b/);
  await urlOnlyRows.nth(1).getByPlaceholder('Value').fill('green');
  await expect(url).toHaveValue('https://example.test/v2/items?tag=red&tag=green&limit=2');
  await page.getByRole('button', { name: 'Revert unsaved changes' }).click();
  await expect(url).toHaveValue('https://example.test/items?tag=red&tag=blue&limit=2');
  await expect(urlOnlyTab).not.toHaveClass(/\bunsaved\b/);

  await page.locator('.collection-list .collection-request').filter({ hasText: 'Params only' }).click();
  await expect(page.getByLabel('Request URL')).toHaveValue('https://example.test/items?region=eu');
  await chooseRequestSection(page, 'Params');
  const paramsOnlyRows = page.locator('[data-testid="params-row"]');
  await expect(paramsOnlyRows).toHaveCount(4);
  await expect(paramsOnlyRows.nth(1).getByPlaceholder('Value')).toHaveValue('private-token');
  await expect(paramsOnlyRows.nth(2).locator('input[aria-label="Enable"]')).not.toBeChecked();
  const paramsOnlyTab = page.locator('.saved-request-tab.active');
  await expect(paramsOnlyTab).not.toHaveClass(/\bunsaved\b/);
  await page.screenshot({ path: screenshotPath('query-editor-params-only-hydrated.png'), animations: 'disabled' });
  await page.getByLabel('Request URL').fill('https://example.test/v2/items?region=eu');
  await expect(page.getByLabel('Request URL')).not.toHaveValue(/private-token/);
  await expect(paramsOnlyRows.nth(1).getByPlaceholder('Value')).toHaveValue('private-token');
  await expect(paramsOnlyTab).toHaveClass(/\bunsaved\b/);
  await page.getByRole('button', { name: 'Revert unsaved changes' }).click();
  await expect(page.getByLabel('Request URL')).toHaveValue('https://example.test/items?region=eu');
  await paramsOnlyRows.nth(0).getByPlaceholder('Value').fill('us');
  await expect(page.getByLabel('Request URL')).toHaveValue('https://example.test/items?region=us');
  await expect(paramsOnlyTab).toHaveClass(/\bunsaved\b/);
  await page.getByRole('button', { name: 'Revert unsaved changes' }).click();
  await expect(page.getByLabel('Request URL')).toHaveValue('https://example.test/items?region=eu');
  await expect(paramsOnlyTab).not.toHaveClass(/\bunsaved\b/);
});

test('imports a Postman URL query once, retains disabled rows and raw spelling after editing', async ({ page }) => {
  await installKurloBridge(page);
  await page.addInitScript(() => localStorage.setItem('kurlo.autosave.v1', 'false'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Collections' }).click();
  await page.getByLabel('Import collection').first().click();
  const sourceDialog = page.getByRole('dialog', { name: 'Import collection' });
  await sourceDialog.getByText('Postman collection').click();
  await sourceDialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(sourceDialog).toBeHidden();
  await page.setInputFiles('input[type="file"]', {
    name: 'query.postman_collection.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      info: { name: 'Query import', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'Search', request: { method: 'GET', url: {
        raw: 'https://api.example.test/items?tag=red&tag=blue&limit=2#results',
        query: [
          { key: 'tag', value: 'red' },
          { key: 'tag', value: 'blue' },
          { key: 'limit', value: '2' },
          { key: 'preview', value: '1', disabled: true },
        ],
      } } }],
    })),
  });
  await expect(page.getByLabel('Request URL')).toHaveValue('https://api.example.test/items?tag=red&tag=blue&limit=2#results');
  await chooseRequestSection(page, 'Params');
  const rows = page.locator('[data-testid="params-row"]');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(3).locator('input[aria-label="Enable"]')).not.toBeChecked();
  await rows.nth(1).getByPlaceholder('Value').fill('green');
  await expect(page.getByLabel('Request URL')).toHaveValue('https://api.example.test/items?tag=red&tag=green&limit=2#results');
  await expect.poll(() => page.evaluate(() => {
    const saved = window.__kurloE2E.store.requests.find(request => request.name === 'Search')!;
    return { url: saved.url, params: saved.params.map(({ key, value, enabled }) => [key, value, enabled]) };
  })).toEqual({
    url: 'https://api.example.test/items?tag=red&tag=blue&limit=2#results',
    params: [['tag', 'red', true], ['tag', 'blue', true], ['limit', '2', true], ['preview', '1', false]],
  });
  await page.screenshot({ path: screenshotPath('query-editor-postman-edited.png'), animations: 'disabled' });
});

test('imports an HTTP file query into the editor and preserves every occurrence after a table edit', async ({ page }) => {
  await installKurloBridge(page);
  await page.addInitScript(() => localStorage.setItem('kurlo.autosave.v1', 'false'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Collections' }).click();
  await page.getByLabel('Import collection').first().click();
  const sourceDialog = page.getByRole('dialog', { name: 'Import collection' });
  await sourceDialog.getByText('.http / .rest file').click();
  await sourceDialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(sourceDialog).toBeHidden();
  await page.setInputFiles('input[type="file"]', {
    name: 'query.http',
    mimeType: 'text/plain',
    buffer: Buffer.from('### Example\nGET http://127.0.0.1:9000/items?tag=red&tag=blue&limit=2\n'),
  });
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:9000/items?tag=red&tag=blue&limit=2');
  await chooseRequestSection(page, 'Params');
  const rows = page.locator('[data-testid="params-row"]');
  await expect(rows).toHaveCount(4);
  await expect(page.getByText('3 active', { exact: true })).toBeVisible();
  await rows.nth(0).getByPlaceholder('Value').fill('green');
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:9000/items?tag=green&tag=blue&limit=2');
  await page.screenshot({ path: screenshotPath('query-editor-http-edited.png'), animations: 'disabled' });
});
