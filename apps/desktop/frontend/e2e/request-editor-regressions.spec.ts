import { expect, test, type Page } from '@playwright/test';
import { reviewShot } from './support/reviewShot';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

test('blocks the send shortcut while Settings is open and restores it on close', async ({ page }) => {
  await openRequest(page);
  await page.getByRole('button', { name: /^Settings/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'General', exact: true }).press('Meta+Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByLabel('Request URL').press('Meta+Enter');
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(1);
  await expect(page.locator('.response-area')).toContainText('200');
  expect(await page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(1);
});

for (const protocol of ['HTTP', 'GraphQL']) {
  test(`sends twice from the ${protocol} editor without modifying the document`, async ({ page }) => {
    const isGraphQL = protocol === 'GraphQL';
    const text = isGraphQL ? query : 'first\nsecond';
    await openRequest(page, isGraphQL ? graphql : { requestTab: 'body', bodyType: 'text', bodyContent: text });
    const lines = page.getByTestId(isGraphQL ? 'graphql-query-editor' : 'request-body-editor').locator('.cm-line');
    await lines.first().click();
    for (const count of [1, 2]) {
      await page.keyboard.press('Meta+Enter');
      await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(count);
      await expect(page.locator('.request-composer .btn-send')).toHaveAccessibleName(isGraphQL ? 'Query' : 'Send');
    }
    expect(await lines.allTextContents()).toEqual(text.split('\n'));
    const sent = await page.evaluate(() => window.__kurloE2E.sentRequests.map(call => call.body));
    expect(sent.map(body => isGraphQL ? JSON.parse(body).query : body)).toEqual([text, text]);
  });
}

for (const scale of [1.25, 1.5]) {
  test(`keeps the Socket.IO Send button clickable at ${scale * 100}%`, async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 680 });
    await openRequest(page, { requestType: 'socketio', requestTab: 'body', sioEventName: 'greet' });
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    for (let step = 0; step < (scale === 1.25 ? 2 : 3); step++) await page.keyboard.press('Meta+=');
    await expect(page.locator('html')).toHaveCSS('font-size', 16 * scale + 'px');
    await reviewShot(page, { path: join(tmpdir(), `kurlo-socketio-send-${scale}.png`), animations: 'disabled' });
    const send = page.locator('.ws-message-send');
    await expect.poll(() => send.evaluate(button => {
      const rect = button.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      return [rect.left + 2, rect.right - 2].every(x => button.contains(document.elementFromPoint(x, y)));
    })).toBe(true);
    await send.click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.socketIOEmits.map(call => call.message.eventName))).toEqual(['greet']);
  });
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
