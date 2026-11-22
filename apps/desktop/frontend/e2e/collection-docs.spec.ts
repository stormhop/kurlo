import { expect, test } from '@playwright/test';
import { captureDocsScreenshot } from './support/screenshots';
import { collectionRow } from './support/actions';
import { installKurloBridge, type E2EWindow } from './support/bridge';

test('builds documentation from both collection menus and reports export errors', async ({ page }) => {
  const collection = {
    id: 'catalog',
    name: 'Catalog API',
    workspaceId: 'workspace-e2e',
    environmentIds: ['staging'],
    folderPaths: Array.from({ length: 9 }, (_, index) => ['Archive', `Batch ${index + 1}`]),
  };
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [collection, { ...collection, id: 'private', name: 'Private API' }],
    environments: [
      { id: 'staging', name: 'Staging', workspaceId: 'workspace-e2e', values: [{ key: 'baseUrl', value: 'private-host' }] },
      { id: 'personal', name: 'Personal', workspaceId: 'workspace-e2e' },
    ],
    requests: [
      { id: 'list', collectionId: collection.id, name: 'List books', method: 'GET', url: '{{baseUrl}}/books', exampleCount: 1, folderPath: ['Catalog'] },
      { id: 'archive', collectionId: collection.id, name: 'Archive user', method: 'POST', url: '{{baseUrl}}/archive', folderPath: ['Admin'] },
      { id: 'private-req', collectionId: 'private', name: 'Other request' },
    ],
  });
  await page.addInitScript(() => {
    const app = (window as unknown as E2EWindow).go.api.App;
    app.LoadRequestExamples = async ids => Object.fromEntries(ids.map(id => [id, [{
      id: 'found', name: 'Books found', notes: '[Guide](/guide/books)', response: { statusCode: 200, body: '["Atlas"]' },
    }]]));
    app.DocsRelativeLinkScopes = async notes => Object.keys(notes).filter(id => notes[id].includes('[Guide](/guide/books)'));
    app.ExportCollectionDocs = async payload => {
      window.__kurloE2E.savedFiles.push({ name: 'docs', path: '', content: payload });
      if (window.__kurloE2E.savedFiles.length === 2) throw new Error('Browser unavailable');
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  const row = collectionRow(page, collection.name);
  const menu = row.getByRole('button', { name: 'Collection menu' });
  await row.hover();
  await menu.click();
  await captureDocsScreenshot(page, 'collection-docs-menu', page.locator('.collection-menu').filter({ hasText: 'Build documentation' }));
  await page.getByRole('button', { name: 'Build documentation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate documentation' });
  await expect(dialog).toContainText('2 requests · 12 folders');
  const documentationURL = dialog.getByLabel('Base URL for relative links');
  await expect(documentationURL).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => window.__kurloE2E.savedFiles.length)).toBe(0);
  await row.hover();
  await menu.click();
  await page.getByRole('button', { name: 'Build documentation' }).click();
  await dialog.getByRole('radio', { name: 'All requests' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('radio', { name: 'Select requests' })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
  await expect(documentationURL).toHaveCount(0);
  const folderPicker = dialog.getByRole('button', { name: /^Filter by folder/ });
  const folderList = dialog.getByRole('listbox', { name: 'Filter by folder' });
  const folderSearch = dialog.getByRole('searchbox', { name: 'Search Filter by folder' });
  const layout = await dialog.locator('.app-select').evaluateHandle(picker => {
    const body = picker.closest('.docs-body')!;
    const bounds = picker.getBoundingClientRect;
    const measure = () => [body.scrollWidth, body.scrollHeight, body.scrollTop, body.scrollLeft];
    const before = measure();
    const samples: number[][] = [];
    picker.getBoundingClientRect = () => {
      const rect = bounds.call(picker);
      if (picker.querySelector('[role="listbox"]')) samples.push(measure());
      return rect;
    };
    return {
      finish() {
        picker.getBoundingClientRect = bounds;
        return { before, samples, after: measure() };
      },
    };
  });
  await folderPicker.click();
  await expect(folderList).toBeVisible();
  await expect(folderSearch).toBeFocused();
  const { before, samples, after } = await layout.evaluate(state => state.finish());
  await layout.dispose();
  expect(samples.length).toBeGreaterThan(0);
  for (const sample of [...samples, after]) expect(sample).toEqual(before);
  await captureDocsScreenshot(page, 'collection-docs-folders', dialog);
  await folderPicker.hover();
  await page.mouse.down();
  await expect(folderSearch).toBeFocused({ timeout: 1000 });
  await page.mouse.up();
  await expect(folderList).toBeHidden();
  await expect(folderPicker).toBeFocused();
  await folderPicker.click();
  await folderList.getByRole('option', { name: 'All folders' }).click();
  await expect(folderList).toBeHidden();
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await folderPicker.click();
  await folderSearch.press('Escape');
  await expect(folderList).toBeHidden();
  await expect(folderPicker).toBeFocused();
  await folderPicker.click();
  await folderSearch.fill('cat');
  await dialog.getByRole('option', { name: 'Catalog' }).click();
  await dialog.getByRole('button', { name: 'Select visible' }).click();
  await folderPicker.click();
  await dialog.getByRole('option', { name: 'Admin' }).click();
  const search = dialog.getByRole('searchbox', { name: 'Filter requests' });
  await search.fill('POST archive');
  await expect(dialog.getByRole('checkbox')).toHaveCount(1);
  await search.fill('books');
  await expect(dialog.getByText('No matching requests')).toBeVisible();
  await search.clear();
  await dialog.getByRole('checkbox', { name: /Archive user/ }).check();
  await expect(dialog).toContainText('2 of 2 selected');
  await dialog.getByRole('checkbox', { name: /Archive user/ }).uncheck();
  await folderPicker.click();
  await folderList.getByRole('option', { name: 'All folders' }).click();
  await expect(folderList).toBeHidden();
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await expect(dialog.getByRole('checkbox', { name: /List books/ })).toBeChecked();
  await folderPicker.click();
  await dialog.getByRole('option', { name: 'Catalog' }).click();
  await expect(dialog.getByRole('checkbox', { name: /List books/ })).toBeChecked();
  await expect(dialog).toContainText('1 of 2 selected');
  await dialog.getByRole('heading').click();
  await captureDocsScreenshot(page, 'collection-docs-generate', dialog);
  await documentationURL.fill('/docs');
  await expect(dialog.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /List books/ }).uncheck();
  await expect(documentationURL).toHaveCount(0);
  await folderPicker.click();
  await dialog.getByRole('option', { name: 'Admin' }).click();
  await dialog.getByRole('checkbox', { name: /Archive user/ }).check();
  await expect(dialog.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await dialog.getByRole('checkbox', { name: /Archive user/ }).uncheck();
  await folderPicker.click();
  await dialog.getByRole('option', { name: 'Catalog' }).click();
  await dialog.getByRole('checkbox', { name: /List books/ }).check();
  await documentationURL.fill('https://docs.example.test');
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedFiles.length)).toBe(1);
  const payload = await page.evaluate(() => JSON.parse(window.__kurloE2E.savedFiles[0].content));
  expect(payload.environments).toHaveLength(1);
  expect(payload.environments[0]).toMatchObject({ id: 'staging', values: [{ key: 'baseUrl', value: 'private-host' }] });
  expect(payload.collection.id).toBe(collection.id);
  expect(payload.linkBaseUrl).toBe('https://docs.example.test');
  expect(payload.requests.map((request: { id: string }) => request.id)).toEqual(['list']);
  expect(payload.requests[0].examples).toMatchObject([{ id: 'found', response: { body: '["Atlas"]' } }]);
  await row.hover();
  await menu.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click();
  await page.getByRole('button', { name: 'More collection actions' }).click();
  await page.getByRole('menuitem', { name: 'Build documentation' }).click();
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Could not export collection documentation' })).toContainText('Browser unavailable');
});
