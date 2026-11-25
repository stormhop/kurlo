import { expect, test } from '@playwright/test';

import { installKurloBridge } from './support/bridge';

test('sorts requests by name, persists the choice, and keeps the Runner order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'col-sort', workspaceId: 'workspace-e2e', name: 'Sorting collection' }],
    requests: [
      { id: 'req-sign-in', collectionId: 'col-sort', collection: 'Sorting collection', folderPath: ['Orders'], name: 'Sign in', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/sign-in' },
      { id: 'req-create-order', collectionId: 'col-sort', collection: 'Sorting collection', folderPath: ['Orders'], name: 'Create order', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/create-order' },
      { id: 'req-read-order', collectionId: 'col-sort', collection: 'Sorting collection', folderPath: ['Orders'], name: 'Read order', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/read-order' },
    ],
  }, { preserveStorage: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

  const collectionList = page.locator('.collection-list');
  const requestTitles = collectionList.locator('.collection-request-wrap .collection-title');
  const originalOrder = ['Sign in', 'Create order', 'Read order'];
  await expect(requestTitles).toHaveText(originalOrder);

  const treeMenu = page.getByRole('button', { name: 'Collection tree menu' });
  const byName = page.getByRole('menuitemradio', { name: 'By name' });
  const manual = page.getByRole('menuitemradio', { name: 'Manual' });
  const resize = await page.getByRole('button', { name: 'Resize sidebar' }).boundingBox();
  if (!resize) throw new Error('Sidebar divider is missing');
  await page.mouse.move(resize.x + resize.width / 2, resize.y + 100);
  await page.mouse.down();
  await page.mouse.move(resize.x - 60, resize.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('aside.sidebar')).toHaveCSS('width', '260px');
  await treeMenu.press('ArrowDown');
  await expect(manual).toBeChecked();
  await expect(manual).toBeFocused();
  await manual.press('ArrowDown');
  await expect(byName).toBeFocused();
  await byName.press('Enter');
  await expect(treeMenu).toBeFocused();
  await expect(requestTitles).toHaveText(['Create order', 'Read order', 'Sign in']);
  const readOrder = collectionList.locator('.collection-request-wrap').filter({ hasText: 'Read order' });
  await readOrder.dragTo(
    collectionList.locator('.collection-request-wrap').filter({ hasText: 'Sign in' }),
    { targetPosition: { x: 10, y: 1 } },
  );
  await expect(requestTitles).toHaveText(['Create order', 'Read order', 'Sign in']);
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.map(request => request.id))).toEqual([
    'req-sign-in',
    'req-create-order',
    'req-read-order',
  ]);
  await page.reload();
  await treeMenu.click();
  await expect(byName).toBeChecked();
  await byName.press('Escape');
  await expect(treeMenu).toBeFocused();
  await expect(requestTitles).toHaveText(['Create order', 'Read order', 'Sign in']);

  await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
  const runner = page.getByRole('region', { name: 'Collection runner' });
  await runner.locator('.runner-select .app-select-trigger').click();
  await runner.getByRole('option', { name: 'Sorting collection', exact: true }).click();
  await expect(runner.getByTestId('runner-request-row').locator('.runner-request-copy strong')).toHaveText(originalOrder);
  await runner.getByRole('button', { name: 'Run 3 requests' }).click();
  await expect(runner.locator('.runner-results-summary')).toContainText('Requests 3/3');
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.map(request => request.url))).toEqual([
    'https://api.kurlo.test/sign-in',
    'https://api.kurlo.test/create-order',
    'https://api.kurlo.test/read-order',
  ]);

  await readOrder.dragTo(collectionList.locator('.collection-folder').filter({ hasText: 'Sorting collection' }));
  await expect(requestTitles).toHaveText(['Create order', 'Sign in', 'Read order']);
  await readOrder.dragTo(collectionList.locator('.collection-subfolder').filter({ hasText: 'Orders' }));
  await expect(requestTitles).toHaveText(['Create order', 'Read order', 'Sign in']);

  await treeMenu.click();
  await manual.click();
  await expect(requestTitles).toHaveText(originalOrder);
});
