import { expect, test, type Page } from '@playwright/test';
import type { SavedRequest } from '../src/lib/types/models';
import { installKurloBridge, type E2EWindow } from './support/bridge';

const query = 'query Read { book { title } book { author } }';
const graphql: Partial<SavedRequest> = {
  requestType: 'graphql', requestTab: 'query', bodyType: 'graphql',
  graphqlSchema: 'type Query { book: Book } type Book { title: String author: String }',
  bodyContent: JSON.stringify({ query, variables: {} }),
};

async function openRequest(page: Page, fields: Partial<SavedRequest> = {}) {
  await installKurloBridge(page, '', 'darwin/e2e', false, {
    activeId: 'editor', openIds: ['editor'],
    requests: [{ id: 'editor', name: 'Editor test', collectionId: '', requestType: 'http',
      method: 'POST', url: 'https://editor.kurlo.test/request', ...fields }],
  });
  await page.goto('/');
  await expect(page.locator('.request-composer')).toBeVisible();
}

test('removes all occurrences of an unchecked GraphQL field from the outgoing query', async ({ page }) => {
  await openRequest(page, graphql);
  const book = page.getByRole('checkbox', { name: 'book', exact: true });
  await page.getByLabel('Expand book', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'author', exact: true })).toBeChecked();
  await book.uncheck();
  await page.getByRole('button', { name: 'Query', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(1);
  const sent = await page.evaluate(() => JSON.parse(window.__kurloE2E.sentRequests[0].body).query);
  expect(sent).toMatch(/query Read\s*\{\s*__typename\s*\}/);
  await expect(book).not.toBeChecked();
});

test('ignores a pending introspection response after Clear', async ({ page }) => {
  await openRequest(page, { ...graphql, requestTab: 'schema' });
  await page.evaluate(() => {
    const app = (window as unknown as E2EWindow).go.api.App;
    const send = app.SendRequest;
    app.SendRequest = async request => {
      const response = await send(request);
      await new Promise<void>(release => { window.__kurloE2E.responseGate = { ready: true, release }; });
      return { ...response, body: 'type Query { restored: String }' };
    };
  });
  await page.getByRole('button', { name: 'Refresh introspection' }).click();
  await page.waitForFunction(() => window.__kurloE2E.responseGate?.ready);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  const importSchema = page.getByRole('button', { name: 'Import a GraphQL schema', exact: true });
  await expect(importSchema).toBeEnabled();
  await page.evaluate(() => window.__kurloE2E.responseGate!.release());
  await importSchema.click();
  await expect(page.getByRole('button', { name: 'Choose a file' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeHidden();
});

test('resizes the GraphQL explorer with arrow keys', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openRequest(page, graphql);
  const below = page.getByRole('button', { name: 'Show the response below the request' });
  if (await below.isVisible()) await below.click();
  const divider = page.getByLabel('Resize GraphQL explorer');
  await expect(divider).toBeVisible();
  const x = () => divider.evaluate(button => button.getBoundingClientRect().left);
  const before = await x();
  await divider.press('ArrowRight');
  await expect.poll(x).toBeGreaterThan(before);
  await divider.press('ArrowLeft');
  await expect.poll(x).toBe(before);
  await expect(divider).toBeFocused();
});
