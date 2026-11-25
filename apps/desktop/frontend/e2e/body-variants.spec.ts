import { expect, test, type Page } from '@playwright/test';
import { chooseRequestSection, fillCodeEditor, fillPrompt } from './support/actions';
import { installKurloBridge } from './support/bridge';
import { captureDocsScreenshot } from './support/screenshots';
import { DOCS_VIEWPORT } from './support/config';

async function openSavedBodies(page: Page) {
  const menu = page.getByRole('dialog', { name: 'Saved body variants' });
  if (!await menu.isVisible()) await page.getByRole('button', { name: /^Saved body variants/ }).click();
  return menu;
}

async function saveBody(page: Page, name: string) {
  const menu = await openSavedBodies(page);
  await menu.getByRole('textbox', { name: 'Saved body variant name' }).fill(name);
  await menu.getByRole('button', { name: 'Save current' }).click();
  await expect(menu.getByRole('button', { name: `Load ${name}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
}

test('edits, sends and reopens named bodies of one HTTP request', async ({ page, context }) => {
  const url = 'https://api.example.test/orders';
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'shop', workspaceId: 'workspace-e2e', name: 'Shop' }],
    activeId: 'orders', openIds: ['orders'],
    requests: [{
      id: 'orders', collectionId: 'shop', name: 'Create order', method: 'POST', url,
      bodyType: 'json', rawBodyType: 'json', bodyContent: '{"sku":"tea"}',
      headers: [{ key: 'X-Shop', value: 'main' }],
      auth: { type: 'bearer', bearerToken: 'dummy' }, testScriptJs: 'pm.test("Created", () => {});',
    }],
  });
  await page.setViewportSize(DOCS_VIEWPORT);
  await page.goto('/');
  await chooseRequestSection(page, 'Body');
  await saveBody(page, 'Minimal');
  await saveBody(page, 'Full');
  await fillCodeEditor(page, 'request-body-editor', '{"sku":"tea","quantity":2}');
  await saveBody(page, 'Missing field');
  await fillCodeEditor(page, 'request-body-editor', '{}');

  for (const [name, body] of [['Full', '{"sku":"tea","quantity":2}'], ['Minimal', '{"sku":"tea"}'], ['Missing field', '{}']]) {
    const menu = await openSavedBodies(page);
    if (name === 'Minimal') await captureDocsScreenshot(page, 'request-body-variants');
    if (name === 'Minimal') {
      await menu.getByRole('button', { name: 'Send Minimal', exact: true }).click();
      await page.keyboard.press('Escape');
    } else {
      await menu.getByRole('button', { name: `Load ${name}`, exact: true }).click();
      await page.getByRole('button', { name: 'Send', exact: true }).click();
    }
    await expect(page.getByTestId('request-body-editor').locator('.cm-content')).toHaveText(body);
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.at(-1))).toMatchObject({
      method: 'POST', url, body, auth: { token: 'dummy' }, headers: expect.arrayContaining([expect.objectContaining({ key: 'X-Shop', value: 'main' })]),
      testScript: 'pm.test("Created", () => {});',
    });
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests[0].bodyVariants?.length)).toBe(2);
  const saved = await page.evaluate(() => window.__kurloE2E.store);
  const reopened = await context.newPage();
  await installKurloBridge(reopened, '', 'browser/e2e', false, saved, { preserveStorage: true });
  await reopened.addInitScript(() => {
    localStorage.setItem('kurlo.autosave.v1', 'true');
    localStorage.setItem('kurlo.autosaveDelay.v1', '1000');
  });
  await reopened.setViewportSize({ width: 820, height: 780 });
  await reopened.goto('/');
  await chooseRequestSection(reopened, 'Body');
  const menu = await openSavedBodies(reopened);
  await expect(menu.getByRole('button', { name: 'Load Missing field' })).toHaveAttribute('aria-pressed', 'true');
  await menu.getByRole('button', { name: 'Load Full' }).click();
  const editor = reopened.getByTestId('request-body-editor').locator('.cm-content');
  await expect(editor).toHaveText('{"sku":"tea","quantity":2}');
  await editor.press('ControlOrMeta+z');
  await expect(editor).toHaveText('{"sku":"tea","quantity":2}');

  const trigger = reopened.getByRole('button', { name: /^Saved body variants/ });
  const before = await trigger.boundingBox();
  const longName = 'LongOrderBody'.repeat(7);
  await saveBody(reopened, 'With discount');
  await saveBody(reopened, longName);
  await openSavedBodies(reopened);
  await expect(trigger).toHaveAccessibleName('Saved body variants, 5');
  expect((await trigger.boundingBox())!.width).toBeCloseTo(before!.width, 0);
  await expect(menu.getByRole('button', { name: 'Save current' })).toBeDisabled();
  await expect(menu.getByRole('status')).toContainText('up to 5');
  const longRow = menu.getByRole('button', { name: `Load ${longName}` });
  await expect(longRow).toHaveAttribute('title', longName);
  expect(await longRow.locator('.saved-messages-item-name').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await menu.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.width <= 17 * parseFloat(getComputedStyle(document.documentElement).fontSize) + 1 &&
      rect.left >= 0 && rect.right <= window.innerWidth && node.scrollWidth <= node.clientWidth;
  })).toBe(true);
  if (process.env.KURLO_E2E_SHOT) await menu.screenshot({ path: process.env.KURLO_E2E_SHOT });
  await menu.getByRole('button', { name: 'Rename Full' }).click();
  await fillPrompt(reopened, 'Rename body variant', 'Complete');
  await openSavedBodies(reopened);
  await expect(menu.getByRole('button', { name: `Load ${longName}` })).toHaveAttribute('aria-pressed', 'true');
  await menu.getByRole('button', { name: 'Delete Complete' }).click();
  await reopened.getByRole('dialog', { name: 'Delete body variant' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await saveBody(reopened, 'Replacement');
  await expect.poll(() => reopened.evaluate(() => window.__kurloE2E.store.requests[0].activeBodyVariant)).toBe('Replacement');
  await openSavedBodies(reopened);
  await expect(menu.getByRole('button', { name: 'Save current' })).toBeDisabled();
  await expect(menu.getByRole('button', { name: 'Load Complete' })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'Load Minimal' })).toBeVisible();
});
