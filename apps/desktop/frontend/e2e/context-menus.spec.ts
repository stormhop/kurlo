import { installKurloBridge } from './support/bridge';

import { expect, test } from '@playwright/test';

test('encodes and decodes selected text from the context menu', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.getByLabel('New unsaved request').click();
  const url = page.getByLabel('Request URL');
  await url.fill('https://api.kurlo.test/users?name=Ada Lovelace');
  const select = (from: string) => url.evaluate((input: HTMLInputElement, from) => {
    input.focus();
    input.setSelectionRange(input.value.indexOf(from), input.value.length);
  }, from);

  await select('Ada');
  await url.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Decode URI component' })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Encode URI component' }).click();
  await expect(url).toHaveValue('https://api.kurlo.test/users?name=Ada%20Lovelace');
  expect(await url.evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart!, input.selectionEnd!))).toBe('Ada%20Lovelace');

  await url.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Encode Base64' }).click();
  await expect(url).toHaveValue('https://api.kurlo.test/users?name=QWRhJTIwTG92ZWxhY2U=');
  await url.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Decode Base64' }).click();
  await url.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Decode URI component' }).click();
  await expect(url).toHaveValue('https://api.kurlo.test/users?name=Ada Lovelace');
});

test('opens a context menu on request tabs', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  const newTab = page.getByLabel('New unsaved request');
  for (let i = 0; i < 4; i += 1) await newTab.click();
  const tabs = page.locator('.saved-request-tab:not(.runner-tab):not(.overview-request-tab)');
  const count = await tabs.count();
  expect(count).toBeGreaterThanOrEqual(4);

  await tabs.nth(1).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Tab' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Close tabs to the right' }).click();
  await expect(tabs).toHaveCount(2);

  await tabs.nth(1).click();
  await page.getByLabel('Request URL').fill('https://api.kurlo.test/copy-me');
  await tabs.nth(1).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Copy URL' }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.clipboard)).toBe('https://api.kurlo.test/copy-me');

  await tabs.nth(1).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(tabs).toHaveCount(3);

  await tabs.nth(0).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Close other tabs' }).click();
  const discard = page.getByRole('button', { name: 'Discard' });
  for (let i = 0; i < 2; i += 1) {
    await expect(discard).toBeVisible();
    await discard.click();
  }
  await expect(tabs).toHaveCount(1);
  await tabs.nth(0).click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Close other tabs' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});
