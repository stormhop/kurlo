import { expect, test } from '@playwright/test';
import { installKurloBridge } from './support/bridge';
import { collectionRow } from './support/actions';

test('keeps untouched requests clean after renaming their collection in manual-save mode', async ({ page }) => {
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'rename-collection', workspaceId: 'workspace-e2e', name: 'Before' }],
    requests: [{
      id: 'rename-request', name: 'Saved request', collectionId: 'rename-collection', collection: 'Before',
      requestType: 'http', method: 'GET', url: 'https://example.test/untouched',
    }],
    activeId: '', openIds: [],
  });
  await page.addInitScript(() => localStorage.setItem('kurlo.autosave.v1', 'false'));
  await page.goto('/');
  await collectionRow(page, 'Before').getByLabel('Collection menu').click();
  await collectionRow(page, 'Before').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
  const head = page.locator('.collection-workspace-head');
  await head.getByRole('button', { name: 'Rename collection Before' }).click();
  await head.getByLabel('Collection name').fill('After');
  await head.getByLabel('Collection name').press('Enter');
  await expect(head.getByRole('heading', { level: 1 })).toHaveText('After');
  await page.locator('.collection-list .collection-request').filter({ hasText: 'Saved request' }).click();
  await expect(page.getByLabel('Request URL')).toHaveValue('https://example.test/untouched');
  const tab = page.locator('.saved-request-tab.active');
  await expect(tab).not.toHaveClass(/\bunsaved\b/);
  await tab.hover();
  await tab.getByLabel('Close tab').click();
  await expect(page.locator('.saved-request-tab .tab-title').filter({ hasText: 'Saved request' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.locator('.collection-list .collection-request').filter({ hasText: 'Saved request' }).click();
  await page.getByLabel('Request URL').fill('https://example.test/edited');
  await expect(tab).toHaveClass(/\bunsaved\b/);
  await tab.hover();
  await tab.getByLabel('Close tab').click();
  await expect(page.getByRole('dialog')).toContainText('Save changes to');
});
