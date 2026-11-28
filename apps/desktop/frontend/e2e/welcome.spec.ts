import { expect, test, type Page } from '@playwright/test';
import { reviewShot } from './support/reviewShot';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installKurloBridge, type E2EWindow } from './support/bridge';
import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';
import { captureDocsScreenshot } from './support/screenshots';

async function firstLaunch(page: Page) {
  await installKurloBridge(page, '', 'browser/e2e', false, null, { firstLaunch: true, preserveStorage: true });
}

test('welcome appears once, survives reload as dismissed and reopens from commands', async ({ page }) => {
  await firstLaunch(page);
  await page.addInitScript(() => localStorage.setItem('kurlo.theme.v2', JSON.stringify({ mode: 'dark', light: 'light', dark: 'dark' })));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('kurlo:welcome-seen'))).toBe('1');
  const bird = page.locator('.welcome-illustration .kurlo-bird');
  await expect(bird).toBeVisible();
  const animations = await bird.evaluate(element => element.getAnimations({ subtree: true }).length);
  expect(animations).toBe(0);
  await reviewShot(page, { path: join(tmpdir(), 'kurlo-welcome-dark.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeHidden();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeHidden();
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: 'Search requests, chats and commands' });
  await search.getByRole('combobox').fill('> Welcome screen');
  await search.getByRole('option', { name: /Welcome screen/ }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeVisible();
});

test('welcome new request and example use real drafts without sending or duplicating startup tabs', async ({ page }) => {
  await firstLaunch(page);
  await page.goto('/');
  await page.getByRole('button', { name: /New request Paste a URL/ }).click();
  await expect(page.locator('.welcome-workspace')).toBeHidden();
  await expect(page.locator('input.url-input')).toBeVisible();
  expect(await page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(0);
  await page.goto('/?welcome=1');
  await page.getByRole('button', { name: 'Try an example' }).click();
  await expect(page.locator('input.url-input')).toHaveValue('https://httpbin.org/get');
  expect(await page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(0);
  await expect(page.getByRole('tab', { name: /New Request/ })).toHaveCount(1);
});

test('welcome opens real import and agent settings, and canceled workspace selection keeps it visible', async ({ page }) => {
  if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
  await firstLaunch(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeVisible();
  await captureDocsScreenshot(page, 'welcome');
  await page.getByRole('button', { name: /Import a collection Postman/ }).click();
  const importer = page.getByRole('dialog', { name: 'Import collection' });
  await expect(importer).toBeVisible();
  await importer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeVisible();
  await page.evaluate(() => { (window as E2EWindow).go.api.App.OpenDirectoryDialog = async () => ''; });
  await page.getByRole('button', { name: /Open a workspace Use/ }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeVisible();
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.locator('.settings-nav-item.active')).toContainText('AI');
});

test('welcome debug override works for returning users and supports a compact light window', async ({ page }) => {
  await installKurloBridge(page);
  await page.addInitScript(() => localStorage.setItem('kurlo.theme.v2', JSON.stringify({ mode: 'light', light: 'light', dark: 'dark' })));
  await page.setViewportSize({ width: 850, height: 650 });
  await page.goto('/?welcome=1');
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try an example' })).toBeVisible();
  await reviewShot(page, { path: join(tmpdir(), 'kurlo-welcome-light.png'), animations: 'disabled' });
  const overflow = await page.locator('.welcome-workspace').evaluate(element => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeHidden();
});

test('welcome does not replace startup after an upgrade, or cover first-launch release notes', async ({ page }) => {
  await firstLaunch(page);
  await page.addInitScript(() => {
    (window as E2EWindow).go.api.App.AppInfo = async () => ({ name: 'Kurlo', version: '3.1.3', runtime: 'browser/e2e' });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('kurlo:last-seen-version'))).toBe('3.1.3');
  await expect(page.locator('.whats-new-modal')).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem('kurlo:welcome-seen'));
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeHidden();
});

test('welcome opens a selected workspace with the real workspace loader', async ({ page }) => {
  await firstLaunch(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeVisible();
  await page.evaluate(() => {
    (window as E2EWindow).go.api.App.OpenWorkspaceRoot = async path => ({
      ok: true,
      root: path,
      payload: JSON.stringify({
        ...window.__kurloE2E.store,
        activeWorkspaceId: 'opened-workspace',
        workspaces: [{ id: 'opened-workspace', name: 'Opened API', description: '' }],
        collections: [], requests: [], history: [],
      }),
      git: { isRepo: false, workspaceRoot: path },
      diagnostics: [],
    });
  });
  await page.getByRole('button', { name: /Open a workspace Use/ }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Kurlo' })).toBeHidden();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Rename workspace Opened API' })).toBeVisible();
});
