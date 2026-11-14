import { chooseRequestType, collectionRow } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { expect, test } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('runs default and rebound shortcuts on Windows and Linux, and shows their keycaps', async ({ page }) => {
    for (const runtime of ['windows/e2e', 'linux/e2e']) {
      await installKurloBridge(page, '', runtime);
      await page.goto('/');
      const requestTabs = page.locator('.saved-request-tab:not(.overview-request-tab)');
      await expect(requestTabs).toHaveCount(1);
      await page.getByLabel('New unsaved request').click();
      await expect(requestTabs).toHaveCount(2);
      await page.getByLabel('Request URL').click();
      await page.keyboard.press('Control+Alt+\\');
      await expect(page.locator('.code-snippet-panel')).toBeVisible();
      await page.keyboard.press('Control+Alt+\\');
      await expect(page.locator('.code-snippet-panel')).toBeHidden();
      await page.keyboard.press('Control+w');
      await expect(requestTabs).toHaveCount(1);

      await page.keyboard.press('Control+,');
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await settings.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
      const searchRow = settings.locator('.shortcut-row').filter({ has: page.getByText('Search', { exact: true }) });
      await searchRow.locator('.shortcut-combo').click();
      await page.keyboard.press('Control+Alt+P');
      await expect(searchRow.locator('.keycaps')).toHaveAttribute('aria-label', 'Ctrl+Alt+P');
      await page.keyboard.press('Escape');
      await expect(settings).toBeHidden();
      await page.keyboard.press('Control+Alt+P');
      await expect(page.getByRole('dialog', { name: 'Search requests, chats and commands' })).toBeVisible();
      await page.keyboard.press('Escape');
    }
  });

  test('runs the request, view, create and tab shortcuts', async ({ page }) => {
    await installKurloBridge(page, '', 'windows/e2e');
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    const url = page.getByLabel('Request URL');
    await url.fill('https://api.kurlo.test/slow?ms=4000');
    const send = page.locator('.send-split .btn-send');
    await url.press('Control+Enter');
    await expect(send).toHaveText(/Cancel/);
    await url.press('Escape');
    await expect(send).toHaveText(/^Send/);
    await expect(page.getByText('Request canceled')).toBeVisible();

    await url.fill('https://api.kurlo.test/users');
    await url.press('Control+Shift+C');
    await expect(page.locator('.curl-toast')).toHaveText('Copied as cURL');

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Alt+2');
    await expect(page.locator('.sidebar')).toContainText(/Environments/);
    await page.keyboard.press('Control+Alt+3');
    await expect(page.locator('.sidebar')).toContainText(/History/);
    await page.keyboard.press('Control+Alt+1');

    const layout = () => page.evaluate(() => localStorage.getItem('kurlo.responseLayout.v1'));
    const before = await layout();
    await page.keyboard.press('Control+Alt+V');
    await expect.poll(layout).not.toBe(before);

    await page.keyboard.press('Control+Alt+E');
    await expect(page.locator('.environment-menu')).toBeVisible();
    await expect(page.locator('.environment-menu .menu-item').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.environment-menu')).toHaveCount(0);

    await page.keyboard.press('Control+O');
    await expect(page.getByRole('dialog', { name: 'Import collection' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Import collection' })).toHaveCount(0);

    await page.keyboard.press('Control+Shift+N');
    const prompt = page.getByRole('dialog', { name: 'New collection' });
    await expect(prompt).toBeVisible();
    await prompt.getByRole('textbox').fill('Shortcut collection');
    await prompt.getByRole('textbox').press('Enter');
    await expect(collectionRow(page, 'Shortcut collection')).toBeVisible();

    await page.keyboard.press('Control+Shift+R');
    await expect(page.getByRole('button', { name: 'Collection runner', exact: true })).toHaveClass(/active/);

    const closeButtons = page.locator('.saved-request-tab').getByRole('button', { name: 'Close tab', exact: true });
    await page.getByLabel('New unsaved request').click();
    await page.getByLabel('New unsaved request').click();
    const opened = await closeButtons.count();
    expect(opened).toBeGreaterThanOrEqual(3);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Alt+Shift+W');
    const saveDraft = page.getByRole('dialog', { name: 'Save request' });
    await expect(saveDraft).toBeVisible();
    await saveDraft.getByRole('button', { name: 'Discard' }).click();
    await expect(closeButtons).toHaveCount(1);
    await page.getByLabel('New unsaved request').click();
    await expect(closeButtons).toHaveCount(2);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Shift+W');
    await expect(closeButtons).toHaveCount(0);
  });

  test('lays out the shortcut settings without sideways scrolling and with aligned keycaps', async ({ page }) => {
    await installKurloBridge(page, '', 'darwin/e2e');
    await page.goto('/');
    await page.getByRole('button', { name: /^Settings/ }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
    const list = settings.locator('.shortcut-list');
    await expect(list.locator('.shortcut-row').first()).toBeVisible();
    const layout = await list.evaluate(el => {
      const textLeft = (node: Element) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect().left;
      };
      const body = el.closest('.settings-body') as HTMLElement;
      const glyphs = [...el.querySelectorAll('.keycaps-md .keycap-glyph')].map(cap => Math.round(cap.getBoundingClientRect().width));
      const lastCaps = [...el.querySelectorAll('.shortcut-row .keycaps')].map(caps => Math.round(caps.lastElementChild!.getBoundingClientRect().right));
      return {
        listScrolls: el.scrollWidth > el.clientWidth + 1,
        bodyScrolls: body.scrollWidth > body.clientWidth + 1,
        glyphWidths: new Set(glyphs).size,
        rightEdges: new Set(lastCaps).size,
        headingAligned: Math.round(textLeft(el.querySelector('.shortcut-group h3')!)) === Math.round(textLeft(el.querySelector('.shortcut-row > span')!)),
      };
    });
    expect(layout).toEqual({ listScrolls: false, bodyScrolls: false, glyphWidths: 1, rightEdges: 1, headingAligned: true });
    await list.screenshot({ path: test.info().outputPath('shortcuts.png') });
  });

  for (const runtime of ['darwin/e2e', 'windows/e2e']) {
    test(`fits the General settings page without vertical scrolling on ${runtime.split('/')[0]}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await installKurloBridge(page, '', runtime);
      await page.goto('/');
      await page.getByRole('button', { name: /^Settings/ }).click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await expect(settings.getByRole('heading', { name: 'General' })).toBeVisible();
      const body = settings.locator('.settings-body');
      for (const mode of ['Manual save', 'Autosave']) {
        await settings.getByRole('radio', { name: mode }).click();
        expect(await body.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
      }
      await expect(settings.getByLabel('Autosave delay')).toHaveValue('1200');
      await settings.screenshot({ path: join(tmpdir(), `kurlo-settings-general-${runtime.split('/')[0]}.png`), animations: 'disabled' });
    });
  }
});
