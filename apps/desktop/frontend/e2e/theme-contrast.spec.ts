import type { E2EWindow } from './support/bridge';
import { chooseRequestType } from './support/actions';
import { installKurloBridge } from './support/bridge';
import { ALL_THEMES, applyTheme, lowContrastText } from './support/contrast';
import { installSecretProviderBridge } from './support/secretProviders';
import { expect, test, type Page } from '@playwright/test';

const ref = (provider: string, path: string, field?: string) => ({ provider, path, ...(field ? { field } : {}) });
const providers = [
  { id: 'vault-prod', type: 'vault', name: 'Vault prod', config: { address: 'https://vault.shop.example.com', auth: { method: 'approle', roleId: 'orders-api' } }, trusted: true, savedCredentials: ['secretId'] },
  { id: '1password', type: '1password', name: '1Password', config: {}, trusted: true },
  { id: 'aws-prod', type: 'aws-secrets-manager', name: 'AWS prod', config: { region: 'eu-central-1', profile: 'prod' }, trusted: true, problem: 'The profile prod is not in ~/.aws/credentials.' },
  { id: 'gcp', type: 'gcp-secret-manager', name: 'Google Cloud', config: { project: 'shop' }, trusted: false },
];

async function setup(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await installKurloBridge(page, '', 'browser/e2e', undefined, {
    environments: [{
      id: 'env-prod', workspaceId: 'workspace-e2e', name: 'Prod',
      values: [
        { id: 1, key: 'baseUrl', value: 'https://api.shop.example.com', enabled: true },
        { id: 2, key: 'dbPassword', value: '', enabled: true, secret: true, secretRef: ref('vault-prod', 'secret/data/orders', 'password') },
        { id: 3, key: 'stripeKey', value: '', enabled: true, secret: true, secretRef: ref('1password', 'op://Shop/Stripe', 'credential') },
        { id: 4, key: 'mapsApiKey', value: '', enabled: true, secret: true, secretRef: ref('gcp', 'projects/shop/secrets/maps-key') },
        { id: 5, key: 'apiToken', value: '', enabled: true },
      ],
      secretSources: [{ provider: 'vault-prod', path: 'secret/data/payments', prefix: 'pay_' }],
    }],
    activeEnvironmentId: 'env-prod',
  });
  await installSecretProviderBridge(page, {
    providers,
    secrets: {
      'vault-prod:secret/data/orders': { password: 'orders-db-pass' },
      'vault-prod:secret/data/payments': { merchantId: 'm-1', webhookKey: 'k' },
      'vault-prod:secret/data/payments/api': { token: 's3cr3t-token-1' },
    },
  });
  await page.goto('/');
}

const shots = process.env.KURLO_THEME_SHOTS;

async function audit(page: Page, screen: string, root: string) {
  const offenders: string[] = [];
  for (const { theme, variant } of ALL_THEMES) {
    await applyTheme(page, theme, variant);
    for (const line of await lowContrastText(page, root)) offenders.push(`${variant}: ${line}`);
    if (shots) await page.screenshot({ path: `${shots}/${screen}-${variant}.png` });
  }
  return offenders;
}

test.describe('new screens in every theme', () => {
  test('secret provider list', async ({ page }) => {
    await setup(page);
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.getByRole('button', { name: 'Secret providers', exact: true }).click();
    await expect(page.locator('.secret-provider-row').filter({ hasText: 'Google Cloud' })).toBeVisible();
    expect(await audit(page, 'providers', 'main')).toEqual([]);
  });

  test('secret provider form with errors', async ({ page }) => {
    await setup(page);
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.getByRole('button', { name: 'Secret providers', exact: true }).click();
    await page.getByRole('button', { name: 'Add provider' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a secret provider' });
    await expect(dialog).toBeVisible();
    expect(await audit(page, 'add-provider', '[role="dialog"]')).toEqual([]);
    await dialog.getByRole('radio', { name: /HashiCorp Vault/ }).click();
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await page.locator('#secret-provider-id').fill('vault-prod');
    await page.locator('#secret-provider-address').fill('https://root:pw@vault.example.com');
    await page.locator('.secret-page-head').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.secret-field-error').first()).toBeVisible();
    expect(await audit(page, 'provider-form', 'main')).toEqual([]);
  });

  test('environment with linked variables and the link popover', async ({ page }) => {
    await setup(page);
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.locator('.environment-item-main').filter({ hasText: 'Prod' }).click();
    const imported = page.getByRole('region', { name: 'Imported from secret managers' });
    await imported.getByRole('button', { name: 'Load keys' }).click();
    await expect(imported).toContainText('pay_merchantId');
    expect(await audit(page, 'environment', 'main')).toEqual([]);
    await page.getByRole('button', { name: 'Link apiToken to a secret manager' }).click();
    const popover = page.getByRole('dialog', { name: 'Link apiToken' });
    await popover.getByRole('button', { name: 'Browse the secrets of this provider' }).click();
    const browser = popover.getByRole('group', { name: 'Browse secrets' });
    for (const name of ['secret/', 'data/', 'payments/']) await browser.getByRole('button', { name, exact: true }).click();
    await browser.getByRole('button', { name: 'api', exact: true }).click();
    await popover.getByRole('combobox', { name: 'Field' }).fill('token');
    await popover.getByRole('button', { name: 'Test' }).click();
    await expect(popover).toContainText('14 characters');
    expect(await audit(page, 'link-popover', '[role="dialog"]')).toEqual([]);
  });

  test('response viewer with format menu, status details and cookies', async ({ page }) => {
    await setup(page);
    const body = '<order><id>42</id><state>paid</state></order>';
    await page.evaluate((text) => {
      (window as E2EWindow).go.api.App.SendRequest = async () => ({
        statusCode: 404, status: '404 Not Found',
        headers: [{ key: 'Content-Type', value: 'text/plain' }, { key: 'Set-Cookie', value: 'session=abc; Path=/; HttpOnly; Secure; SameSite=Lax' }, { key: 'Set-Cookie', value: 'theme=dark; Expires=Wed, 01 Jan 2020 00:00:00 GMT' }],
        body: text, duration: 9, size: text.length, headersSize: 210, encodedBodySize: 120,
        preRequestResult: { tests: [], logs: [] }, testResult: { tests: [], logs: [] },
      });
    }, body);
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders/42');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.response-status-bar .status-badge')).toBeVisible();
    expect(await audit(page, 'response-body', '.response-panel, .response-area, main')).toEqual([]);
    await page.locator('.response-status-bar .status-badge').hover();
    await expect(page.locator('#response-status-info')).toBeVisible();
    expect(await audit(page, 'response-status', '#response-status-info')).toEqual([]);
    await page.mouse.move(5, 5);
    await page.getByRole('tab', { name: /Cookies/ }).click();
    await expect(page.locator('.response-cookies-table tbody tr')).toHaveCount(2);
    expect(await audit(page, 'response-cookies', '.response-cookies-table')).toEqual([]);
    const json = JSON.stringify({ id: 42, paid: true, note: null, total: 19.5, url: 'https://shop.example.com/orders/42', items: [{ sku: 'A-1', qty: 2 }] }, null, 2);
    await page.evaluate((text) => {
      (window as E2EWindow).go.api.App.SendRequest = async () => ({
        statusCode: 200, status: '200 OK', headers: [{ key: 'Content-Type', value: 'application/json' }],
        body: text, duration: 9, size: text.length, preRequestResult: { tests: [], logs: [] }, testResult: { tests: [], logs: [] },
      });
    }, json);
    await page.locator('[aria-controls="response-panel-body"]').click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.response-panel, .response-area, main').getByText('sku').first()).toBeVisible();
    expect(await audit(page, 'response-json', '.response-panel, .response-area, main')).toEqual([]);
  });

  test('request tab menu and file tab', async ({ page }) => {
    await setup(page);
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.locator('.request-tab, [role="tab"]').filter({ hasText: /New Request/ }).first().click({ button: 'right' });
    const menu = page.getByRole('menu').first();
    await expect(menu).toBeVisible();
    expect(await audit(page, 'tab-menu', '[role="menu"]')).toEqual([]);
    await page.keyboard.press('Escape');
  });
});
