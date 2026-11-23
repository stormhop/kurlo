import { chooseRequestType } from './support/actions';
import { installKurloBridge } from './support/bridge';
import { installSecretProviderBridge } from './support/secretProviders';
import { expect, test, type Locator, type Page } from '@playwright/test';

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('field is not visible');
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width) };
}

async function openNewVault(page: Page) {
  await installKurloBridge(page);
  await installSecretProviderBridge(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Environments', exact: true }).click();
  await page.getByRole('button', { name: 'Secret providers', exact: true }).click();
  await page.getByRole('button', { name: 'Add provider' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a secret provider' });
  await dialog.getByRole('radio', { name: /HashiCorp Vault/ }).click();
  await dialog.getByRole('button', { name: 'Continue' }).click();
}

for (const width of [1440, 1100, 900]) {
  test(`secret provider fields stay in place while errors come and go at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openNewVault(page);
    const address = page.locator('#secret-provider-address');
    await address.scrollIntoViewIfNeeded();
    const before = await box(address);
    const rowTop = () => address.evaluate(element => Math.round(element.getBoundingClientRect().top - element.closest(".settings-row")!.getBoundingClientRect().top));
    const offset = await rowTop();
    await page.locator('.secret-page-head').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#secret-provider-address-error')).toBeVisible();
    for (const value of ['h', 'http:/', 'http://', 'https://root:pw@vault.example.com', 'https://vault.example.com']) {
      await address.fill(value);
      const now = await box(address);
      expect.soft({ value, x: now.x, width: now.width }).toEqual({ value, x: before.x, width: before.width });
      expect.soft({ value, offset: await rowTop() }).toEqual({ value, offset });
    }
  });
}

async function offsetInRow(field: Locator, row: string) {
  return field.evaluate((input, selector) => {
    const rect = input.getBoundingClientRect();
    const parent = input.closest(selector)!.getBoundingClientRect();
    return { top: Math.round(rect.top - parent.top), left: Math.round(rect.left - parent.left), width: Math.round(rect.width) };
  }, row);
}

test('AI request settings stay in place while errors come and go', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installKurloBridge(page);
  await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'bottom'));
  await page.goto('/');
  await page.getByLabel('New unsaved request').click();
  await chooseRequestType(page, 'AI Request');
  await page.locator('.request-editor').getByText('Settings', { exact: true }).click();
  for (const [id, bad] of [['#ai-temperature', '2132312231'], ['#ai-max-tokens', '-5'], ['#ai-top-p', '7'], ['#ai-idle-timeout', 'soon']]) {
    const field = page.locator(id);
    await field.scrollIntoViewIfNeeded();
    const before = await offsetInRow(field, '.postman-setting');
    await field.fill(bad);
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    expect.soft({ id, ...(await offsetInRow(field, '.postman-setting')) }).toEqual({ id, ...before });
    await field.fill('');
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    expect.soft({ id, ...(await offsetInRow(field, '.postman-setting')) }).toEqual({ id, ...before });
  }
});
