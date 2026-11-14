import type { E2EWindow } from './support/bridge';
import { chooseRequestType } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('pairs a browser from the Sync Cookies tab and syncs into the open workspace', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders');
    await page.getByRole('button', { name: 'Cookies', exact: true }).click();

    const modal = page.locator('.cookie-workspace');
    const panel = page.locator('.cookie-panel');
    await panel.getByRole('button', { name: /^Browser sync/ }).click();
    await expect(modal.getByText('Cookie sync is off')).toBeVisible();
    await expect(modal.getByRole('switch', { name: 'Cookie sync' })).not.toBeChecked();

    await modal.locator('.cookie-sync-toggle .switch-track').click();
    await expect(modal.getByText('Waiting for a browser')).toBeVisible();
    await expect(modal.getByText(/install the extension and press Connect/)).toBeVisible();
    await captureDocsScreenshot(page, 'cookie-jar-sync');

    await expect(modal.locator('.cookie-sync-code')).toHaveCount(0);
    await modal.getByRole('button', { name: 'Show code' }).click();
    await expect(modal.locator('.cookie-sync-code')).toHaveText(/^kurlo-3199-/);
    await modal.getByRole('button', { name: 'Copy' }).click();
    await expect(modal.getByRole('button', { name: 'Copied' })).toBeVisible();
    await modal.getByRole('button', { name: 'Hide' }).click();

    await modal.getByRole('button', { name: /Add api\.kurlo\.test from the open request/ }).click();
    await expect(modal.locator('.cookie-sync-chip')).toHaveText([/api\.kurlo\.test/]);

    await modal.getByPlaceholder('example.com').fill('https://Shop.Kurlo.test/cart?page=2');
    await modal.getByRole('button', { name: 'Add domain' }).click();
    await expect(modal.locator('.cookie-sync-chip')).toHaveText([/api\.kurlo\.test/, /shop\.kurlo\.test/]);

    await modal.getByPlaceholder('example.com').fill('nope');
    await modal.getByRole('button', { name: 'Add domain' }).click();
    await expect(modal.getByText(/does not look like a domain/)).toBeVisible();
    await expect(modal.locator('.cookie-sync-chip')).toHaveCount(2);

    await page.evaluate(() => {
      const state = window.__kurloE2E;
      state.cookieSync = {
        ...state.cookieSync,
        pending: {
          id: 'pair-1',
          browser: 'Chrome',
          extensionId: 'kurlocookiesyncextension',
          code: '482913',
          requestedAt: Date.now(),
          expiresAt: Date.now() + 120000,
        },
      };
      state.emit('cookies:synced', state.cookieSync);
    });

    await expect(modal.getByText('Chrome wants to connect')).toBeVisible();
    await expect(modal.locator('.cookie-sync-approval-code')).toHaveText('482913');
    await expect(modal.getByText(/kurlocookiesyncextension/)).toBeVisible();
    await captureDocsScreenshot(page, 'cookie-jar-sync-approval');

    await modal.getByRole('button', { name: 'Allow' }).click();
    await expect(modal.getByText('Chrome is connected')).toBeVisible();
    await expect(modal.locator('.cookie-sync-approval')).toHaveCount(0);
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter((entry: string) => entry.startsWith('ApproveCookieSyncPairing')))).toEqual(['ApproveCookieSyncPairing:pair-1']);

    await page.evaluate(async () => {
      const app = (window as E2EWindow).go.api.App;
      await app.UpsertCookie('workspace-e2e', {
        name: 'session',
        value: 'from-browser',
        domain: 'api.kurlo.test',
        path: '/',
        expiresAt: 0,
        session: true,
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        hostOnly: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      window.__kurloE2E.emit('cookies:synced', {
        ...(await app.CookieSyncStatus()),
        paired: true,
        connected: true,
        browser: 'Chrome',
        lastSyncAt: Date.now(),
        lastSyncCount: 1,
        log: [{
          id: 'cookie-sync-1',
          timestamp: Date.now(),
          browser: 'Chrome',
          domain: 'api.kurlo.test',
          accepted: 1,
          skipped: 0,
          removed: 0,
          message: '1 cookie synced',
        }],
      });
    });

    await expect(modal.getByText('Chrome is connected')).toBeVisible();
    await expect(modal.locator('.cookie-sync-log')).toContainText('1 cookie synced');

    await page.evaluate(async () => {
      const state = window.__kurloE2E;
      state.cookieSync = { ...state.cookieSync, connected: true, browser: 'Chrome', unreadable: ['shop.kurlo.test'] };
      state.emit('cookies:synced', state.cookieSync);
    });
    await expect(modal.getByText(/not allowed to read shop\.kurlo\.test/)).toBeVisible();
    await expect(modal.locator('.cookie-sync-chip.unreadable')).toHaveCount(1);
    await captureDocsScreenshot(page, 'cookie-jar-sync-paired');

    await panel.getByRole('button', { name: /^api\.kurlo\.test/ }).click();
    await expect(panel.getByRole('button', { name: /^api\.kurlo\.test/ })).toHaveAttribute('aria-current', 'page');
    await expect(modal.locator('.cookie-row')).toContainText('session');

    await panel.getByRole('button', { name: /^Browser sync/ }).click();
    await modal.getByRole('button', { name: 'Disconnect' }).click();
    await expect(modal.getByText('Waiting for a browser')).toBeVisible();

    await modal.locator('.cookie-sync-toggle .switch-track').click();
    await expect(modal.getByText('Cookie sync is off')).toBeVisible();
    await expect(modal.locator('.cookie-sync-code')).toHaveCount(0);
  });
});

test.describe('Cookie sync extension', () => {
  test('sets the extension up from the app and flags an outdated one', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      (window as any).go.api.App.AppInfo = async () => ({ name: 'Kurlo', version: '2.5.0', runtime: 'darwin/e2e', goVersion: 'e2e' });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Cookies', exact: true }).click();
    const modal = page.locator('.cookie-workspace');
    await page.locator('.cookie-panel').getByRole('button', { name: /^Browser sync/ }).click();

    await modal.getByRole('button', { name: 'Chrome, Edge, Brave' }).click();
    await expect(modal.getByText('chrome://extensions')).toBeVisible();
    await expect(modal.getByText(/Load unpacked/)).toBeVisible();
    await expect(modal.locator('.cookie-sync-path')).toHaveText(/browser-extension\/chromium$/);
    await expect(modal.getByText(/Version 2\.5\.0/)).toBeVisible();
    expect(await page.evaluate(() => (window.__kurloE2E.calls as string[]).filter(call => call.startsWith('InstallBrowserExtension')))).toEqual(['InstallBrowserExtension:chromium']);

    await page.evaluate(() => {
      const state = window.__kurloE2E as any;
      state.cookieSync = { ...state.cookieSync, enabled: true, running: true, paired: true, connected: true, browser: 'Chrome', extensionVersion: '1.0.0' };
      state.emit('cookies:synced', state.cookieSync);
    });
    await expect(modal.getByText('The extension is older than Kurlo')).toBeVisible();
    await expect(modal.getByText(/runs extension 1\.0\.0, Kurlo is 2\.5\.0/)).toBeVisible();
    await modal.getByRole('button', { name: 'Refresh files' }).click();
    expect(await page.evaluate(() => (window.__kurloE2E.calls as string[]).filter(call => call.startsWith('InstallBrowserExtension')))).toHaveLength(2);

    await page.evaluate(() => {
      const state = window.__kurloE2E as any;
      state.cookieSync = { ...state.cookieSync, extensionVersion: '2.5.0' };
      state.emit('cookies:synced', state.cookieSync);
    });
    await expect(modal.getByText('The extension is older than Kurlo')).toHaveCount(0);
  });
});

test.describe('Cookie jar', () => {
  test('opens cookies as a sidebar section beside the other workspace screens', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders');
    await page.getByRole('button', { name: 'Cookies', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cookies', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.cookie-panel')).toBeVisible();
    await expect(page.locator('.cookie-workspace')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const main = page.locator('.cookie-workspace');
    await main.getByRole('button', { name: 'Add cookie for api.kurlo.test' }).click();
    const editor = main.getByRole('form', { name: 'Cookie editor' });
    await editor.getByLabel('Name').press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(main).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Cookies' })).toHaveCount(0);
    await page.getByRole('tab', { name: /New Request/ }).last().click();
    await expect(main).toHaveCount(0);
    await expect(page.getByLabel('Request URL')).toHaveValue('https://api.kurlo.test/orders');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await expect(page.locator('.cookie-panel')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cookies', exact: true }).click();
    await expect(page.locator('.cookie-panel')).toBeVisible();
    await expect(main).toBeVisible();
  });

  test('picks a cookie expiry with the app date picker instead of the system one', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders');
    await page.getByRole('button', { name: 'Cookies', exact: true }).click();
    const main = page.locator('.cookie-workspace');
    const stored = () => page.evaluate(() => (window.__kurloE2E as any).cookies['workspace-e2e'] ?? []);
    await main.getByRole('button', { name: 'Add cookie for api.kurlo.test' }).click();
    const editor = main.getByRole('form', { name: 'Cookie editor' });
    await editor.getByLabel('Name').fill('token');
    await editor.getByLabel('Value').fill('t1');
    await expect(page.locator('input[type="datetime-local"]')).toHaveCount(0);

    const trigger = editor.getByRole('button', { name: 'Expires' });
    await expect(trigger).toHaveText('When the session ends');
    await trigger.click();
    const picker = page.getByRole('dialog', { name: 'Expires date' });
    await expect(picker).toBeVisible();
    await page.screenshot({ path: join(tmpdir(), `kurlo-date-picker-${test.info().project.name}.png`), animations: 'disabled' });
    const today = await page.evaluate(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() }; });
    await expect(picker.locator(`[data-day="${today.y}-${today.m}-${today.d}"]`)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await picker.getByLabel('Hour').fill('9');
    await picker.getByLabel('Minute').fill('30');
    await picker.getByLabel('Minute').press('Enter');
    await expect(picker).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const expected = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 30, 0, 0); return d.getTime(); });
    await expect(trigger).toContainText('· 09:30');

    await trigger.click();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(editor).toBeVisible();

    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);
    expect((await stored()).find((cookie: { name: string }) => cookie.name === 'token')).toEqual(expect.objectContaining({ expiresAt: expected, session: false }));

    await main.getByRole('button', { name: 'Edit cookie token' }).click();
    await editor.getByRole('button', { name: 'Expires' }).click();
    await picker.getByRole('button', { name: 'Next month' }).click();
    await picker.getByRole('button', { name: 'In 7 days' }).click();
    await picker.getByRole('button', { name: 'Clear' }).click();
    await expect(editor.getByRole('button', { name: 'Expires' })).toHaveText('When the session ends');
    await editor.getByRole('button', { name: 'Save' }).click();
    expect((await stored()).find((cookie: { name: string }) => cookie.name === 'token')).toEqual(expect.objectContaining({ expiresAt: 0, session: true }));
  });

  test('manages cookies in a table with a fields and a raw editor', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders');
    await page.getByRole('button', { name: 'Cookies', exact: true }).click();
    const modal = page.locator('.cookie-workspace');
    const panel = page.locator('.cookie-panel');
    const stored = () => page.evaluate(() => (window.__kurloE2E as any).cookies['workspace-e2e'] ?? []);

    await expect(modal.getByText('No cookies yet')).toBeVisible();
    await modal.getByRole('button', { name: 'Add cookie for api.kurlo.test' }).click();
    const editor = modal.getByRole('form', { name: 'Cookie editor' });
    await expect(editor.getByLabel('Name')).toBeFocused();
    await editor.getByLabel('Name').fill('bad name');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor.getByRole('alert')).toHaveText('Cookie name cannot contain "=", ";" or spaces.');

    await editor.getByLabel('Name').fill('session');
    await editor.getByLabel('Value').fill('abc');
    await editor.getByLabel('HttpOnly').check();
    await editor.getByLabel('Secure').check();
    await editor.getByRole('button', { name: 'SameSite' }).click();
    await page.getByRole('option', { name: 'Lax' }).click();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);

    const row = modal.locator('.cookie-row', { hasText: 'session' });
    await expect(row).toContainText('abc');
    await expect(row).toContainText('Session');
    await expect(row.locator('.tag')).toHaveText(['HttpOnly', 'Secure', 'Lax']);
    expect(await stored()).toEqual([expect.objectContaining({ name: 'session', value: 'abc', domain: 'api.kurlo.test', hostOnly: true, secure: true, httpOnly: true, sameSite: 'lax', session: true })]);

    await modal.getByRole('button', { name: 'Edit cookie session' }).click();
    await expect(editor.getByLabel('Value')).toHaveValue('abc');
    await captureDocsScreenshot(page, 'cookie-jar-editor');
    await editor.getByRole('button', { name: 'Raw' }).click();
    await expect(editor.getByLabel('Raw cookie')).toHaveValue('session=abc; Path=/; Secure; HttpOnly; SameSite=Lax;');
    await editor.getByLabel('Raw cookie').fill('session=xyz; Path=/; Domain=kurlo.test; Max-Age=3600; Secure; HttpOnly');
    await editor.getByRole('button', { name: 'Fields' }).click();
    await expect(editor.getByLabel('Value')).toHaveValue('xyz');
    await expect(editor.getByLabel('Include subdomains')).toBeChecked();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);

    await expect(panel.getByRole('button', { name: /^kurlo\.test/ })).toHaveAttribute('aria-current', 'page');
    const moved = modal.locator('.cookie-row', { hasText: 'session' });
    await expect(moved).toContainText('xyz');
    await expect(moved).toContainText('in 1 h');
    await expect(moved.locator('.tag')).toHaveText(['HttpOnly', 'Secure', 'Subdomains']);
    expect(await stored()).toEqual([expect.objectContaining({ name: 'session', value: 'xyz', domain: 'kurlo.test', hostOnly: false, session: false })]);

    await page.evaluate(() => {
      (window.__kurloE2E as any).cookies['workspace-e2e'].push({
        name: 'refresh', value: '{{kurloSecret:cookie.refresh}}', domain: 'auth.kurlo.test', path: '/', expiresAt: 0, session: true,
        secure: false, httpOnly: false, sameSite: '', hostOnly: true, createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
    await modal.getByRole('button', { name: 'More cookie actions' }).click();
    await modal.getByRole('menuitem', { name: 'Reload from disk' }).click();
    const authDomain = panel.getByRole('button', { name: /^auth\.kurlo\.test/ });
    await expect(authDomain.locator('.cookie-domain-dot.warning')).toHaveCount(1);
    await expect(authDomain).toContainText('some without a value');
    await authDomain.click();
    await expect(modal.locator('.cookie-row', { hasText: 'refresh' })).toContainText('no value');
    await modal.getByRole('button', { name: 'Edit cookie refresh' }).click();
    await expect(editor.getByText(/kept on the computer that created it/)).toBeVisible();
    await expect(editor.getByLabel('Value')).toHaveValue('');
    await expect(editor.getByLabel('Value')).toHaveAttribute('placeholder', 'Not on this computer');
    await editor.getByRole('button', { name: 'Raw' }).click();
    await expect(editor.getByLabel('Raw cookie')).toHaveValue('refresh=; Path=/;');
    await editor.getByRole('button', { name: 'Fields' }).click();
    await expect(editor.getByLabel('Value')).toHaveValue('');
    await editor.getByLabel('Path').fill('/auth');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);
    expect((await stored()).find((cookie: { name: string }) => cookie.name === 'refresh')).toEqual(expect.objectContaining({ value: '{{kurloSecret:cookie.refresh}}', path: '/auth' }));

    await panel.getByLabel('Filter domains').fill('auth');
    await expect(panel.locator('.cookie-domain-item')).toHaveCount(1);
    await panel.getByLabel('Filter domains').fill('');

    await panel.getByRole('button', { name: 'Add domain' }).click();
    await panel.getByLabel('New domain').fill('https://Shop.Kurlo.test/cart');
    await panel.getByLabel('New domain').press('Enter');
    await expect(panel.getByRole('button', { name: /^shop\.kurlo\.test/ })).toHaveAttribute('aria-current', 'page');
    await expect(editor.getByLabel('Name')).toHaveValue('Cookie_1');
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(modal.getByText('No cookies for shop.kurlo.test')).toBeVisible();
    await modal.getByRole('button', { name: 'More cookie actions' }).click();
    await modal.getByRole('menuitem', { name: 'Delete shop.kurlo.test' }).click();
    await expect(panel.locator('.cookie-domain-item')).toHaveCount(2);

    await panel.getByRole('button', { name: /^kurlo\.test/ }).click();
    await modal.getByRole('button', { name: 'Delete cookie session' }).click();
    await expect(panel.locator('.cookie-domain-item')).toHaveCount(1);
    await modal.getByRole('button', { name: 'More cookie actions' }).click();
    await modal.getByRole('menuitem', { name: 'Clear all cookies' }).click();
    await expect(modal.getByText('No cookies yet')).toBeVisible();
    expect(await stored()).toEqual([]);
  });
});
