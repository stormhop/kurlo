import { chooseRequestType } from './support/actions';
import { installKurloBridge } from './support/bridge';
import { captureDocsScreenshot } from './support/screenshots';
import { installSecretProviderBridge } from './support/secretProviders';
import { expect, test, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shot = (page: Page, name: string) => page.screenshot({ path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `${name}.png`), animations: 'disabled' });

async function openSecretProviders(page: Page) {
  await page.getByRole('button', { name: 'Environments', exact: true }).click();
  await page.getByRole('button', { name: 'Secret providers', exact: true }).click();
}

const vaultProvider = { id: 'vault-prod', type: 'vault', name: 'Vault prod', config: { address: 'https://vault.example.com', auth: { method: 'token' } }, trusted: true };

test.describe('secret providers', () => {
  test('shows one Add provider button and no Refresh on an empty page', async ({ page }) => {
    await installKurloBridge(page);
    await installSecretProviderBridge(page);
    await page.goto('/');
    await openSecretProviders(page);
    const main = page.locator('.secret-provider-page, main').filter({ has: page.getByRole('heading', { name: 'Secret providers' }) }).first();
    await expect(page.getByRole('heading', { name: 'No secret providers yet' }).or(page.getByText('No secret providers yet'))).toBeVisible();
    await expect(main.getByRole('button', { name: 'Add provider' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Refresh secrets' })).toHaveCount(0);
    await shot(page, 'secret-providers-empty');
  });

  test('fades the provider list where more types are hidden in a short window', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 600 });
    await installKurloBridge(page);
    await installSecretProviderBridge(page);
    await page.goto('/');
    await openSecretProviders(page);
    await page.getByRole('button', { name: 'Add provider' }).first().click();
    const grid = page.getByRole('dialog', { name: 'Add a secret provider' }).locator('.secret-type-grid');
    await expect(grid).toHaveClass(/more-below/);
    await expect(grid).not.toHaveClass(/more-above/);
    await grid.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(grid).toHaveClass(/more-above/);
    await expect(grid).not.toHaveClass(/more-below/);
  });

  test('validates the new provider form before saving', async ({ page }) => {
    await installKurloBridge(page);
    await installSecretProviderBridge(page, { providers: [vaultProvider] });
    await page.goto('/');
    await openSecretProviders(page);
    await expect(page.getByRole('button', { name: 'Refresh secrets' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add provider' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Add provider' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a secret provider' });
    await dialog.getByRole('radio', { name: /HashiCorp Vault/ }).click();
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: /New .*Vault/ })).toBeVisible();

    const id = page.locator('#secret-provider-id');
    const address = page.locator('#secret-provider-address');
    await expect(address).not.toHaveAttribute('aria-invalid', 'true');
    await page.locator('.secret-page-head').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#secret-provider-address-error')).toHaveText('Enter the Vault address.');
    await expect(address).toBeFocused();
    await shot(page, 'secret-provider-form-required');

    await id.fill('vault-prod');
    await expect(page.locator('#secret-provider-id-error')).toHaveText('Another provider already uses this ID.');
    await id.fill('Vault Staging');
    await expect(page.locator('#secret-provider-id-error')).toContainText('lowercase');
    await id.fill('vault-staging');
    await expect(page.locator('#secret-provider-id-error')).toHaveCount(0);

    await address.fill('vault.example.com');
    await expect(page.locator('#secret-provider-address-error')).toHaveText('Start with https:// or http://.');
    await address.fill('https://root:pw@vault.example.com');
    await expect(page.locator('#secret-provider-address-error')).toContainText('Remove the user name and password');
    await address.fill('https://vault-staging.example.com:8200');
    await expect(page.locator('#secret-provider-address-error')).toHaveCount(0);

    await page.getByRole('radio', { name: 'AppRole' }).click();
    await expect(page.locator('#secret-provider-role-error')).toHaveText('Enter the role ID.');
    await page.locator('#secret-provider-role').fill('role 1');
    await expect(page.locator('#secret-provider-role-error')).toHaveText('Remove the spaces.');
    await page.locator('#secret-provider-role').fill('3f1c-role');
    await page.locator('#secret-provider-mount').fill('team a/approle');
    await page.locator('#secret-provider-mount').blur();
    await expect(page.locator('#secret-provider-mount-error')).toContainText('path like approle');
    await page.locator('#secret-provider-mount').fill('team-a/approle');

    const timeout = page.locator('#secret-provider-timeout');
    await timeout.fill('soon');
    await timeout.blur();
    await expect(page.locator('#secret-provider-timeout-error')).toHaveText('Use a duration like 10s or 1m.');
    await timeout.fill('2h');
    await expect(page.locator('#secret-provider-timeout-error')).toHaveText('Use 1s to 10m.');
    await page.locator('#secret-provider-timeout-error').scrollIntoViewIfNeeded();
    await shot(page, 'secret-provider-form-errors');
    await timeout.fill('30s');
    await expect(page.locator('.secret-field-error')).toHaveCount(0);

    await page.locator('.secret-page-head').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloSecrets.calls.find(call => call.startsWith('save:')))).toBeTruthy();
    const saved = JSON.parse((await page.evaluate(() => window.__kurloSecrets.calls.find(call => call.startsWith('save:'))))!.slice(5));
    expect(saved).toMatchObject({ id: 'vault-staging', type: 'vault', address: 'https://vault-staging.example.com:8200', timeout: '30s', auth: { method: 'approle', roleId: '3f1c-role', mount: 'team-a/approle' } });
    await expect(page.getByRole('heading', { name: /vault-staging/ })).toBeVisible();
  });

  test('checks type specific fields of cloud providers', async ({ page }) => {
    await installKurloBridge(page);
    await installSecretProviderBridge(page);
    await page.goto('/');
    await openSecretProviders(page);
    await page.locator('.secret-empty').getByRole('button', { name: 'Add provider' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a secret provider' });
    await dialog.getByRole('radio', { name: /Azure Key Vault/ }).click();
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('radio', { name: 'Client secret' }).click();
    await page.locator('.secret-page-head').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#secret-provider-address-error')).toHaveText('Enter the vault URL.');
    await expect(page.locator('#secret-provider-tenant-error')).toHaveText('Enter the tenant ID.');
    await expect(page.locator('#secret-provider-client-error')).toHaveText('Enter the application (client) ID.');
    await page.locator('#secret-provider-address').fill('https://team.vault.azure.net');
    await page.locator('#secret-provider-tenant').fill('contoso.onmicrosoft.com');
    await page.locator('#secret-provider-client').fill('my-app');
    await expect(page.locator('#secret-provider-client-error')).toContainText('00000000-0000-0000-0000-000000000000');
    await page.locator('#secret-provider-client').fill('0b8e2f7a-0c5d-4b8e-9a3f-1f2e3d4c5b6a');
    await expect(page.locator('.secret-field-error')).toHaveCount(0);
    await page.locator('.secret-page-head').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloSecrets.providers.map(provider => provider.id))).toEqual(['azure']);

    await page.getByRole('button', { name: 'Add secret provider' }).click();
    await dialog.getByRole('radio', { name: /AWS Secrets Manager/ }).click();
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await page.locator('#secret-provider-region').fill('Frankfurt');
    await page.locator('#secret-provider-region').blur();
    await expect(page.locator('#secret-provider-region-error')).toHaveText('Use an AWS region like eu-central-1.');
    await page.locator('#secret-provider-region').fill('eu-central-1');
    await page.locator('#secret-provider-endpoint').fill('localhost:4566');
    await page.locator('#secret-provider-endpoint').blur();
    await expect(page.locator('#secret-provider-endpoint-error')).toHaveText('Start with https:// or http://.');
    await page.locator('#secret-provider-endpoint').fill('http://localhost:4566');
    await expect(page.locator('.secret-field-error')).toHaveCount(0);
  });

  test('refuses malformed credentials and saves a valid one', async ({ page }) => {
    await installKurloBridge(page);
    await installSecretProviderBridge(page, { providers: [vaultProvider] });
    await page.goto('/');
    await openSecretProviders(page);
    await page.locator('.secret-provider-open').filter({ hasText: 'Vault prod' }).click();
    const token = page.locator('#secret-credential-token');
    const row = page.locator('.settings-row').filter({ has: token });
    await token.fill('hvs abc');
    await expect(page.locator('#secret-credential-token-error')).toHaveText('Remove the spaces and line breaks.');
    await expect(row.getByRole('button', { name: 'Save' })).toBeDisabled();
    await token.fill('hvs.CAESIJ');
    await expect(page.locator('#secret-credential-token-error')).toHaveCount(0);
    await row.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloSecrets.calls)).toContain('credential:vault-prod:token:10');
    await expect(row).toContainText('Saved on this device, encrypted.');
  });

  test('tests the connection, revokes and restores trust, and deletes a provider', async ({ page }) => {
    await installKurloBridge(page);
    await installSecretProviderBridge(page, { providers: [vaultProvider, { id: 'git-vault', type: 'vault', name: 'From Git', config: { address: 'https://vault.other.example.com', auth: { method: 'token' } } }] });
    await page.goto('/');
    await openSecretProviders(page);
    const gitRow = page.locator('.secret-provider-row').filter({ hasText: 'From Git' });
    await gitRow.getByRole('button', { name: 'Review' }).click();
    const trust = page.getByRole('dialog', { name: /Trust .From Git. on this device/ });
    await expect(trust).toContainText('vault.other.example.com');
    await trust.getByRole('button', { name: 'Trust on this device' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloSecrets.calls)).toContain('trust:git-vault');
    await expect(gitRow.getByRole('button', { name: 'Review' })).toHaveCount(0);

    await page.locator('.secret-provider-open').filter({ hasText: 'Vault prod' }).click();
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Connected.' })).toContainText('payments-read');
    await page.getByRole('button', { name: 'Revoke trust' }).click();
    await expect(page.getByRole('button', { name: 'Review and trust' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Test connection' })).toBeDisabled();

    await expect(page.getByText('Delete provider', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'More provider actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete provider' }).click();
    const confirm = page.getByRole('dialog', { name: /Delete .Vault prod./ });
    await expect(confirm).toContainText('forgets its credentials on this device');
    await shot(page, 'secret-provider-delete-confirm');
    await confirm.getByRole('button', { name: 'Delete provider' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloSecrets.providers.map(provider => provider.id))).toEqual(['git-vault']);
    const toast = page.getByRole('status').filter({ hasText: 'Provider deleted' });
    await expect(toast).toBeVisible();
    const box = await toast.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.y + box!.height).toBeGreaterThan(viewport.height - 80);
    await page.getByRole('button', { name: 'Clear cache' }).click();
    await expect(page.getByText('Secret cache cleared · 3 values')).toBeVisible();
  });

  test('connects a KeePassXC provider with the Connect button', async ({ page }) => {
    await installKurloBridge(page);
    await installSecretProviderBridge(page, { secrets: { 'keepassxc:https://api.example.com': { password: 's3cret', username: 'ci-bot' } } });
    await page.goto('/');
    await openSecretProviders(page);
    await page.getByRole('button', { name: 'Add provider' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a secret provider' });
    await dialog.getByRole('radio', { name: /KeePassXC/ }).click();
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: /New .*KeePassXC/ })).toBeVisible();
    await expect(page.locator('#secret-provider-address')).toHaveCount(0);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Not connected.')).toBeVisible();

    const connect = page.getByRole('button', { name: 'Connect to KeePassXC' });
    await expect(page.getByText('Open KeePassXC, unlock the database and turn on Browser Integration.', { exact: false })).toBeVisible();
    await connect.click();
    await expect(page.getByRole('button', { name: 'Connect again' })).toBeVisible();
    await expect(page.getByText('Connected to KeePassXC 2.7.10 as kurlo laptop')).toBeVisible();
    expect(await page.evaluate(() => window.__kurloSecrets.calls)).toEqual(expect.arrayContaining(['connect:keepassxc', 'test:keepassxc']));
    await shot(page, 'secret-providers-keepassxc');
  });

  test('groups a long list of linked variables by environment', async ({ page }) => {
    const linked = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({ id: index + 1, key: `${prefix}Secret${index + 1}`, value: '', enabled: true, secret: true, secretRef: { provider: 'vault-prod', path: `secret/data/${prefix}/${index + 1}`, field: 'value' } }));
    await installKurloBridge(page, '', 'browser/e2e', undefined, {
      environments: [
        { id: 'env-dev', workspaceId: 'workspace-e2e', name: 'Dev', values: linked(3, 'dev') },
        { id: 'env-prod', workspaceId: 'workspace-e2e', name: 'Prod', values: linked(25, 'prod') },
      ],
    });
    await installSecretProviderBridge(page, { providers: [{ ...vaultProvider, savedCredentials: ['token'] }] });
    await page.goto('/');
    await openSecretProviders(page);
    await page.getByRole('button', { name: /Vault prod/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Used by 28 variables in 2 environments' })).toBeVisible();
    await expect(page.getByText('Saved credentials')).toBeVisible();
    await expect(page.locator('.settings-row-desc').filter({ hasText: /^Token$/ })).toBeVisible();
    const rows = page.locator('.secret-usage-row');
    await expect(rows).toHaveCount(0);
    const groups = page.locator('.secret-usage-group');
    const prod = groups.filter({ hasText: 'Prod' });
    await expect(prod).toHaveAttribute('aria-expanded', 'false');
    await prod.click();
    await expect(prod).toHaveAttribute('aria-expanded', 'true');
    await expect(rows).toHaveCount(20);
    await page.getByRole('heading', { name: 'Used by 28 variables in 2 environments' }).evaluate(element => element.scrollIntoView({ block: 'start' }));
    await shot(page, 'secret-providers-usage-groups');
    await page.getByRole('button', { name: 'Show all 25' }).click();
    await expect(rows).toHaveCount(25);
    await expect(groups.filter({ hasText: 'Dev' })).toContainText('3 variables');
    await groups.filter({ hasText: 'Dev' }).click();
    await expect(rows).toHaveCount(28);
    await prod.click();
    await expect(rows).toHaveCount(3);
  });

  test('links an environment variable to a secret through Browse', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      environments: [{ id: 'env-prod', workspaceId: 'workspace-e2e', name: 'Prod', values: [{ id: 1, key: 'apiToken', value: '', enabled: true }] }],
      activeEnvironmentId: 'env-prod',
    });
    await installSecretProviderBridge(page, {
      providers: [vaultProvider],
      secrets: { 'vault-prod:secret/data/payments/api': { token: 's3cr3t-token', user: 'svc' }, 'vault-prod:secret/data/billing': { key: 'x' } },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.locator('.environment-item-main').filter({ hasText: 'Prod' }).click();
    await page.getByRole('button', { name: 'Link apiToken to a secret manager' }).click();
    const popover = page.getByRole('dialog', { name: 'Link apiToken' });
    await popover.getByRole('button', { name: 'Browse the secrets of this provider' }).click();
    const browser = popover.getByRole('group', { name: 'Browse secrets' });
    for (const name of ['secret/', 'data/', 'payments/', 'api']) await browser.getByRole('button', { name, exact: true }).click();
    await expect(popover.locator('#secret-link-path')).toHaveValue('secret/data/payments/api');
    await popover.getByRole('combobox', { name: 'Field' }).fill('token');
    await popover.getByRole('button', { name: 'Test' }).click();
    await expect(popover).toContainText('12 characters');
    await shot(page, 'secret-link-popover');
    await popover.getByRole('button', { name: 'Link' }).click();
    await expect.poll(() => page.evaluate(() => {
      const store = window.__kurloE2E.store as { environments: Array<{ id: string; values: Array<{ key: string; secretRef?: unknown }> }> };
      return store.environments.find(environment => environment.id === 'env-prod')!.values.find(row => row.key === 'apiToken')?.secretRef;
    })).toEqual({ provider: 'vault-prod', path: 'secret/data/payments/api', field: 'token' });
  });

  test('imports every key of a secret into an environment', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      environments: [{ id: 'env-prod', workspaceId: 'workspace-e2e', name: 'Prod', values: [{ id: 1, key: 'baseUrl', value: 'https://api.example.com', enabled: true }] }],
      activeEnvironmentId: 'env-prod',
    });
    await installSecretProviderBridge(page, { providers: [vaultProvider], secrets: { 'vault-prod:secret/data/db': { username: 'app', password: 'pw' } } });
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.locator('.environment-item-main').filter({ hasText: 'Prod' }).click();
    await page.getByRole('region', { name: 'Imported from secret managers' }).getByRole('button', { name: 'Add source' }).click();
    const popover = page.getByRole('dialog', { name: 'Import from a secret' });
    await popover.getByRole('textbox').first().fill('secret/data/db');
    await popover.getByRole('button', { name: 'Load keys' }).click();
    await expect(popover).toContainText('username');
    await expect(popover).toContainText('password');
    await popover.getByRole('button', { name: 'Import' }).click();
    await expect.poll(() => page.evaluate(() => {
      const store = window.__kurloE2E.store as { environments: Array<{ id: string; secretSources?: unknown[] }> };
      return store.environments.find(environment => environment.id === 'env-prod')!.secretSources;
    })).toEqual([expect.objectContaining({ provider: 'vault-prod', path: 'secret/data/db' })]);
    await expect(page.getByRole('region', { name: 'Imported from secret managers' })).toContainText('secret/data/db');
  });

  test('exports saved credentials as a .env file for CI', async ({ page }) => {
    await installKurloBridge(page);
    await installSecretProviderBridge(page, { providers: [{ ...vaultProvider, savedCredentials: ['token'] }] });
    await page.goto('/');
    await openSecretProviders(page);
    await page.locator('.secret-provider-open').filter({ hasText: 'Vault prod' }).click();
    await page.getByRole('button', { name: 'More provider actions' }).click();
    await page.getByRole('menuitem', { name: 'Export for CI…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export credentials for CI' });
    await expect(dialog.getByLabel('Variables in the file')).toContainText('VAULT_TOKEN');
    await expect(dialog.getByLabel('Variables in the file')).toContainText('saved on this device');
    await expect(dialog).toContainText('plain text');
    await shot(page, 'secret-provider-export-ci');
    await dialog.getByRole('button', { name: 'Save .env file' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloSecrets.calls)).toContain('exportEnv:vault-prod');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Saved /Users/e2e/vault-prod.ci.env' })).toBeVisible();
  });

  test('saves Vault LDAP, an AWS role with MFA and a custom cache time', async ({ page }) => {
    await installKurloBridge(page);
    await installSecretProviderBridge(page, { providers: [vaultProvider] });
    await page.goto('/');
    await openSecretProviders(page);
    await page.locator('.secret-provider-open').filter({ hasText: 'Vault prod' }).click();
    await page.getByRole('radio', { name: 'LDAP' }).click();
    await page.locator('#secret-provider-username').fill('ada lovelace');
    await page.locator('#secret-provider-username').blur();
    await expect(page.locator('#secret-provider-username-error')).toHaveText('Remove the spaces.');
    await page.locator('#secret-provider-username').fill('');
    await page.getByRole('radio', { name: 'Custom' }).click();
    await expect(page.locator('#secret-provider-cache-ttl')).toHaveValue('30m');
    await page.locator('#secret-provider-cache-ttl').fill('48h');
    await page.locator('#secret-provider-cache-ttl').blur();
    await expect(page.locator('#secret-provider-cache-ttl-error')).toHaveText('Use up to 24h, or Session.');
    await page.locator('#secret-provider-cache-ttl').fill('2h');
    await page.locator('.secret-page-head').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloSecrets.calls.filter(call => call.startsWith('save:')).length)).toBe(1);
    const vault = JSON.parse((await page.evaluate(() => window.__kurloSecrets.calls.find(call => call.startsWith('save:'))))!.slice(5));
    expect(vault).toMatchObject({ cacheTtl: '2h', auth: { method: 'ldap' } });
    expect(vault.auth.username).toBeUndefined();
    await expect(page.locator('#secret-credential-username')).toBeVisible();
    await expect(page.locator('#secret-credential-password')).toBeVisible();
    await page.locator('#secret-credential-password').fill('pass word');
    await expect(page.locator('#secret-credential-password-error')).toHaveCount(0);

    await page.getByRole('button', { name: 'Add secret provider' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a secret provider' });
    await dialog.getByRole('radio', { name: /AWS Secrets Manager/ }).click();
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await page.locator('#secret-provider-region').fill('eu-central-1');
    await expect(page.locator('#secret-provider-external-id')).toHaveCount(0);
    await page.locator('#secret-provider-role-arn').fill('payments-read');
    await page.locator('#secret-provider-role-arn').blur();
    await expect(page.locator('#secret-provider-role-arn-error')).toContainText('role ARN like');
    await page.locator('#secret-provider-role-arn').fill('arn:aws:iam::123456789012:role/payments-read');
    await page.locator('#secret-provider-external-id').fill('kurlo-ext');
    await page.locator('#secret-provider-mfa-serial').fill('arn:aws:iam::123456789012:mfa/ada');
    await page.locator('.secret-page-head').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloSecrets.calls.filter(call => call.startsWith('save:')).length)).toBe(2);
    const aws = JSON.parse((await page.evaluate(() => window.__kurloSecrets.calls.filter(call => call.startsWith('save:'))[1]))!.slice(5));
    expect(aws).toMatchObject({ roleArn: 'arn:aws:iam::123456789012:role/payments-read', externalId: 'kurlo-ext', mfaSerial: 'arn:aws:iam::123456789012:mfa/ada' });
    const mfa = page.locator('#secret-credential-mfaCode');
    await mfa.fill('12345');
    await expect(page.locator('#secret-credential-mfaCode-error')).toHaveText('Enter the 6 digits from your MFA device.');
    await mfa.fill('123456');
    await page.locator('.settings-row').filter({ has: mfa }).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'MFA code sent' })).toBeVisible();
    await shot(page, 'secret-provider-aws-role');
  });

  test('fills a link from a pasted provider reference', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      environments: [{ id: 'env-prod', workspaceId: 'workspace-e2e', name: 'Prod', values: [{ id: 1, key: 'dbPassword', value: '', enabled: true }] }],
      activeEnvironmentId: 'env-prod',
    });
    await installSecretProviderBridge(page, {
      providers: [vaultProvider, { id: 'aws-us', type: 'aws-secrets-manager', name: 'AWS US', config: { region: 'us-east-1' }, trusted: true }, { id: 'aws-eu', type: 'aws-secrets-manager', name: 'AWS EU', config: { region: 'eu-central-1' }, trusted: true }],
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.locator('.environment-item-main').filter({ hasText: 'Prod' }).click();
    await page.getByRole('button', { name: 'Link dbPassword to a secret manager' }).click();
    const popover = page.getByRole('dialog', { name: 'Link dbPassword' });
    const path = popover.locator('#secret-link-path');
    const paste = async (text: string) => {
      await path.fill('');
      await path.focus();
      await path.evaluate((input, value) => {
        const data = new DataTransfer();
        data.setData('text/plain', value);
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, text);
    };
    await paste('arn:aws:secretsmanager:eu-central-1:123456789012:secret:prod/db-AbCdEf#password');
    await expect(path).toHaveValue('arn:aws:secretsmanager:eu-central-1:123456789012:secret:prod/db-AbCdEf');
    await expect(popover.getByRole('button', { name: /Secret provider: AWS EU/ })).toBeVisible();
    await expect(popover.getByRole('combobox', { name: 'Field' })).toHaveValue('password');
    await expect(popover.getByRole('status')).toHaveText('AWS Secrets Manager ARN · aws-eu');
    await shot(page, 'secret-link-pasted-arn');
    await paste('https://other-vault.example.com/v1/secret/data/app');
    await expect(popover.getByRole('status')).toContainText('Add a HashiCorp Vault provider for other-vault.example.com');
    await paste('https://vault.example.com/v1/secret/data/db#password');
    await expect(path).toHaveValue('secret/data/db');
    await expect(popover.getByRole('button', { name: /Secret provider: Vault prod/ })).toBeVisible();
  });

  test('suggests and sends {{vault:name}} like Postman Vault', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      environments: [{ id: 'env-prod', workspaceId: 'workspace-e2e', name: 'Prod', values: [
        { id: 1, key: 'baseUrl', value: 'https://api.kurlo.test', enabled: true },
        { id: 2, key: 'apiToken', value: '', enabled: true, secret: true, secretRef: { provider: 'vault-prod', path: 'secret/data/app', field: 'token' } },
        { id: 3, key: 'tenant', value: 'acme', enabled: true, secret: true },
      ] }],
      activeEnvironmentId: 'env-prod',
    });
    await installSecretProviderBridge(page, { providers: [vaultProvider] });
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    const url = page.getByLabel('Request URL');
    await url.click();
    await url.pressSequentially('{{baseUrl}}/t/{{va');
    const menu = page.getByRole('listbox', { name: 'Environment variables' });
    await expect(menu.getByRole('option').first()).toContainText('vault:');
    await expect(menu.getByRole('option').first()).toContainText('2 secret variables');
    await menu.getByRole('option').first().click();
    await expect(url).toHaveValue('{{baseUrl}}/t/{{vault:');
    await expect(menu.getByRole('option')).toHaveCount(2);
    await expect(menu.getByRole('option').first()).toContainText('apiToken');
    await expect(menu.getByRole('option').first()).toContainText('vault-prod');
    await shot(page, 'vault-template-suggestions');
    await menu.getByRole('option', { name: /tenant/ }).click();
    await expect(url).toHaveValue('{{baseUrl}}/t/{{vault:tenant}}');
    await expect(page.locator('.url-bar .var-token-err, .request-url .var-token-err')).toHaveCount(0);
    await url.fill('{{baseUrl}}/t/{{vault:tenant}}?token={{vault:apiToken}}');
    await page.keyboard.press('Escape');
    await url.press('Enter');
    await expect.poll(() => page.evaluate(() => {
      const sent = window.__kurloE2E.sentRequests.at(-1) as { url: string; params: Array<{ key: string }> } | undefined;
      if (!sent) return null;
      const target = new URL(sent.url);
      return { endpoint: target.origin + target.pathname, tokens: target.searchParams.getAll('token'), extra: sent.params.filter(row => row.key === 'token').length };
    })).toEqual({
      endpoint: 'https://api.kurlo.test/t/acme',
      tokens: [expect.stringMatching(/^\{\{kurloRef:[A-Za-z0-9_-]+\}\}$/)],
      extra: 0,
    });

    await url.fill('{{vault:nothing}}');
    await expect(page.locator('.var-token-err').filter({ hasText: '{{vault:nothing}}' })).toHaveCount(1);
  });

  test('shows linked variables, the link popover and the provider list for the docs', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 780 });
    const ref = (provider: string, path: string, field?: string) => ({ provider, path, ...(field ? { field } : {}) });
    await installKurloBridge(page, '', 'browser/e2e', undefined, {
      environments: [{
        id: 'env-prod',
        workspaceId: 'workspace-e2e',
        name: 'Prod',
        values: [
          { id: 1, key: 'baseUrl', value: 'https://api.shop.example.com', enabled: true },
          { id: 2, key: 'dbPassword', value: '', enabled: true, secret: true, secretRef: ref('vault-prod', 'secret/data/orders', 'password') },
          { id: 3, key: 'stripeKey', value: '', enabled: true, secret: true, secretRef: ref('1password', 'op://Shop/Stripe', 'credential') },
          { id: 4, key: 'awsWebhookSecret', value: '', enabled: true, secret: true, secretRef: ref('aws-prod', 'prod/webhooks', 'signing') },
          { id: 5, key: 'mapsApiKey', value: '', enabled: true, secret: true, secretRef: ref('gcp', 'projects/shop/secrets/maps-key') },
          { id: 6, key: 'apiToken', value: '', enabled: true },
        ],
        secretSources: [{ provider: 'vault-prod', path: 'secret/data/payments', prefix: 'pay_' }],
      }],
      activeEnvironmentId: 'env-prod',
    });
    await installSecretProviderBridge(page, {
      providers: [
        { id: 'vault-prod', type: 'vault', name: 'Vault prod', config: { address: 'https://vault.shop.example.com', auth: { method: 'approle', roleId: 'orders-api' } }, trusted: true, savedCredentials: ['secretId'] },
        { id: '1password', type: '1password', name: '1Password', config: {}, trusted: true },
        { id: 'aws-prod', type: 'aws-secrets-manager', name: 'AWS prod', config: { region: 'eu-central-1', profile: 'prod' }, trusted: true },
        { id: 'gcp', type: 'gcp-secret-manager', name: 'Google Cloud', config: { project: 'shop' }, trusted: false },
      ],
      secrets: {
        'vault-prod:secret/data/orders': { password: 'orders-db-pass', user: 'orders' },
        'vault-prod:secret/data/payments': { merchantId: 'm-1', webhookKey: 'k' },
        'vault-prod:secret/data/payments/api': { token: 's3cr3t-token-1', user: 'svc' },
        'vault-prod:secret/data/billing': { key: 'x' },
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.locator('.environment-item-main').filter({ hasText: 'Prod' }).click();
    const imported = page.getByRole('region', { name: 'Imported from secret managers' });
    await imported.getByRole('button', { name: 'Load keys' }).click();
    await expect(imported).toContainText('pay_merchantId');
    await captureDocsScreenshot(page, 'secret-managers-environment');

    await page.getByRole('button', { name: 'Link apiToken to a secret manager' }).click();
    const popover = page.getByRole('dialog', { name: 'Link apiToken' });
    await popover.getByRole('button', { name: 'Browse the secrets of this provider' }).click();
    const browser = popover.getByRole('group', { name: 'Browse secrets' });
    for (const name of ['secret/', 'data/', 'payments/']) await browser.getByRole('button', { name, exact: true }).click();
    await browser.getByRole('button', { name: 'api', exact: true }).click();
    await popover.getByRole('combobox', { name: 'Field' }).fill('token');
    await popover.getByRole('button', { name: 'Test' }).click();
    await expect(popover).toContainText('14 characters');
    await captureDocsScreenshot(page, 'secret-managers-link', popover);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Secret providers', exact: true }).click();
    await expect(page.locator('.secret-provider-row').filter({ hasText: 'Google Cloud' })).toBeVisible();
    await captureDocsScreenshot(page, 'secret-managers-providers');
  });
});
