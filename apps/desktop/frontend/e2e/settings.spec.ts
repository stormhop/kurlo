import { collectionRow } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { aboutScreenshotDir } from './support/config';

import { captureDocsScreenshot, waitForTransientToasts } from './support/screenshots';

import { expect, test, type Page } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('shows what is new after an update and skips the changelog otherwise', async ({ page }) => {
    const changelogRequests: string[] = [];
    page.on('request', request => {
      const url = decodeURIComponent(request.url());
      if (url.includes('kurlo-changelog') && !url.includes('kurlo-changelog-meta')) changelogRequests.push(url);
    });
    await installKurloBridge(page);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('kurlo-e2e-updated')) {
        sessionStorage.setItem('kurlo-e2e-updated', '1');
        localStorage.setItem('kurlo:last-seen-version', '2.0.2');
      } else {
        localStorage.setItem('kurlo:last-seen-version', '2.0.3');
      }
      const app = (window as any).go.api.App;
      app.AppInfo = async () => ({ name: 'Kurlo', version: '2.0.3', runtime: 'browser/e2e', goVersion: 'e2e' });
    });
    await page.goto('/');

    const whatsNew = page.getByRole('dialog', { name: /What's new in Kurlo/ });
    await expect(whatsNew).toBeVisible();
    await expect(whatsNew).toContainText('2.0.3');
    expect(changelogRequests.length).toBeGreaterThan(0);

    changelogRequests.length = 0;
    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(whatsNew).toHaveCount(0);
    expect(changelogRequests).toEqual([]);
  });

  test('introduces Agent mode once after an update to 3.0 and marks the Agent button until it is opened', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('kurlo-e2e-agent-mode')) {
        sessionStorage.setItem('kurlo-e2e-agent-mode', '1');
        localStorage.setItem('kurlo:last-seen-version', '2.6.1');
        localStorage.removeItem('kurlo:agent-seen');
      } else {
        localStorage.setItem('kurlo:last-seen-version', '3.0.0');
      }
      const app = (window as any).go.api.App;
      app.AppInfo = async () => ({ name: 'Kurlo', version: '3.0.0', runtime: 'browser/e2e', goVersion: 'e2e' });
    });
    await page.goto('/');

    const spotlight = page.getByRole('dialog', { name: 'Meet Agent mode' });
    await expect(spotlight).toBeVisible();
    await expect(spotlight).toContainText('New in Kurlo 3.0.0');
    for (const agent of ['Kurlo agent', 'Claude Code', 'Codex']) await expect(spotlight.getByRole('listitem').filter({ hasText: agent })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /What's new in Kurlo/ })).toHaveCount(0);
    const newDot = page.getByRole('button', { name: 'Agent', exact: true }).locator('.activity-rail-dot-new');
    await expect(newDot).toBeVisible();
    await captureDocsScreenshot(page, 'agent-spotlight');

    await spotlight.getByRole('button', { name: 'Try Agent mode' }).click();
    await expect(spotlight).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Agent', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(newDot).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('kurlo:agent-seen'))).toBe('1');
    expect(await page.evaluate(() => localStorage.getItem('kurlo:last-seen-version'))).toBe('3.0.0');

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Agent', exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(spotlight).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: /What's new in Kurlo/ })).toHaveCount(0);
  });

  test('opens the full release notes in the system browser', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    const palette = page.getByRole('dialog', { name: 'Search requests, chats and commands' });
    await page.locator('.status-search-btn').click();
    await palette.getByRole('combobox', { name: 'Search requests, chats and commands' }).fill("> what's new");
    await palette.getByRole('combobox', { name: 'Search requests, chats and commands' }).press('Enter');
    const whatsNew = page.getByRole('dialog', { name: /What's new in Kurlo/ });
    await expect(whatsNew).toBeVisible();
    await whatsNew.getByRole('link', { name: 'Full release notes' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('open:')))).toEqual([
      expect.stringMatching(/^open:https:\/\/github\.com\/stormhop\/kurlo\/releases\/tag\/v\d/),
    ]);
    await expect(page).toHaveURL(/127\.0\.0\.1/);
  });

  test('quits without writing the workspace when nothing changed since it was opened', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await page.evaluate(() => {
      window.__kurloE2E.calls.length = 0;
      window.__kurloE2E.emit('kurlo:before-quit', null);
    });

    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls)).toContain('ConfirmQuit');
    const calls = await page.evaluate(() => [...window.__kurloE2E.calls]);
    expect(calls.filter(call => call.startsWith('SaveRequestStore'))).toEqual([]);
  });

  test('offers to quit without saving when the last save fails', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await page.evaluate(() => {
      (window.__kurloE2E as unknown as { failSaves: boolean }).failSaves = true;
    });
    await collectionRow(page, 'Requests').getByLabel('Collapse collection').click();
    await page.evaluate(() => {
      window.__kurloE2E.calls.length = 0;
      window.__kurloE2E.emit('kurlo:before-quit', null);
    });

    const dialog = page.getByRole('dialog', { name: 'Quit without saving?' });
    await expect(dialog).toBeVisible();
    const callsWhileAsking = await page.evaluate(() => [...window.__kurloE2E.calls]);
    expect(callsWhileAsking[0]).toBe('AckQuit');
    expect(callsWhileAsking).not.toContain('ConfirmQuit');
    await dialog.getByRole('button', { name: 'Quit without saving' }).click();

    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls)).toContain('ConfirmQuit');
    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls).not.toContain('CancelQuit');
  });

  test('stays open when quitting without saving is declined', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await page.evaluate(() => {
      (window.__kurloE2E as unknown as { failSaves: boolean }).failSaves = true;
    });
    await collectionRow(page, 'Requests').getByLabel('Collapse collection').click();
    await page.evaluate(() => {
      window.__kurloE2E.calls.length = 0;
      window.__kurloE2E.emit('kurlo:before-quit', null);
    });

    const dialog = page.getByRole('dialog', { name: 'Quit without saving?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls)).toContain('CancelQuit');
    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls).not.toContain('ConfirmQuit');
  });
});

test.describe('Interface size', () => {
  const rootFontSize = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  const sidebarWidth = (page: Page) => page.locator('aside.sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width));

  test('zooms the whole interface from the keyboard and the View menu', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    expect(await rootFontSize(page)).toBe('16px');
    const baseSidebar = await sidebarWidth(page);
    const sendHeight = await page.getByRole('button', { name: /^Send( |$)/ }).first().evaluate(el => el.getBoundingClientRect().height);

    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+=');
    await expect.poll(() => rootFontSize(page)).toBe('20px');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.uiScale.v1'))).toBe('1.25');
    await expect.poll(() => sidebarWidth(page)).toBe(Math.round(baseSidebar * 1.25));
    await expect.poll(() => page.getByRole('button', { name: /^Send( |$)/ }).first().evaluate(el => el.getBoundingClientRect().height)).toBeCloseTo(sendHeight * 1.25, 0);

    await page.keyboard.press('Control+-');
    await expect.poll(() => rootFontSize(page)).toBe('17.6px');

    await page.evaluate(() => window.__kurloE2E.emit('kurlo:zoom', 'out'));
    await page.evaluate(() => window.__kurloE2E.emit('kurlo:zoom', 'out'));
    await expect.poll(() => rootFontSize(page)).toBe('14.4px');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.uiScale.v1'))).toBe('0.9');
    await page.evaluate(() => window.__kurloE2E.emit('kurlo:zoom', 'in'));
    await expect.poll(() => rootFontSize(page)).toBe('16px');
    await page.evaluate(() => window.__kurloE2E.emit('kurlo:zoom', 'in'));
    await expect.poll(() => rootFontSize(page)).toBe('17.6px');
    await page.evaluate(() => window.__kurloE2E.emit('kurlo:zoom', 'reset'));
    await expect.poll(() => rootFontSize(page)).toBe('16px');

    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+0');
    await expect.poll(() => rootFontSize(page)).toBe('16px');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.uiScale.v1'))).toBeNull();
  });

  test('zooms from Appearance settings', async ({ page }, testInfo) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    const zoom = page.getByRole('group', { name: 'Zoom' });
    const reset = page.locator('.zoom-row').getByRole('button', { name: 'Reset' });
    await expect(zoom.locator('output')).toHaveText('100%');
    await expect(reset).toBeDisabled();

    await zoom.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom.locator('output')).toHaveText('110%');
    await expect.poll(() => rootFontSize(page)).toBe('17.6px');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.uiScale.v1'))).toBe('1.1');
    await page.screenshot({ path: join(tmpdir(), `kurlo-settings-zoom-${testInfo.project.name}.png`), animations: 'disabled' });

    await page.keyboard.press('Control+=');
    await expect(zoom.locator('output')).toHaveText('125%');

    for (let i = 0; i < 6; i++) {
      const out = zoom.getByRole('button', { name: 'Zoom out' });
      if (await out.isDisabled()) break;
      await out.click();
    }
    await expect(zoom.locator('output')).toHaveText('80%');
    await expect(zoom.getByRole('button', { name: 'Zoom out' })).toBeDisabled();

    await reset.click();
    await expect(zoom.locator('output')).toHaveText('100%');
    await expect.poll(() => rootFontSize(page)).toBe('16px');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.uiScale.v1'))).toBeNull();
  });

  test('starts at the saved size', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.uiScale.v1', '1.25'));
    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    expect(await rootFontSize(page)).toBe('20px');
    await expect.poll(() => sidebarWidth(page)).toBe(350);
  });
});

test.describe('Update release notes', () => {
  test('About limits long release notes to ten lines and opens the full website changelog', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const app = (window as any).go.api.App;
      const item = (n: number) => `- **Change ${n}.** ${'A long sentence about what changed and why it matters to you. '.repeat(6)}`;
      app.AppInfo = async () => ({ name: 'Kurlo', version: '2.2.6', runtime: 'darwin/e2e', goVersion: 'e2e', packaged: false });
      app.CheckForUpdate = async () => ({
        info: {
          version: '2.3.0',
          releaseNotes: ['### Added',
            '- **OpenAPI sync.** Keep a collection in step with its spec. Review new, changed and removed endpoints before applying updates, while keeping your edits, scripts and tests.',
            '- **Request variables.** Set variables before sending a request, or take values from the response to use in later requests.',
            '- **JWT Bearer auth.** Sign a fresh token on every send with your own claims, secret or private key.',
            '- **Assertions.** Check a response without code and see the results alongside your tests.',
            ...Array.from({ length: 8 }, (_, i) => item(i)), '### Fixed', item(9)].join('\n'),
          publishedAt: '2026-10-14T10:00:00Z',
          downloadUrl: 'https://github.com/stormhop/kurlo/releases/download/v2.3.0/kurlo-darwin-universal.app.zip',
          assetName: 'kurlo-darwin-universal.app.zip',
          sha256: 'abc123',
          signatureUrl: '',
          manualInstallUrl: '',
        },
        error: '',
      });
    });
    await page.goto('/');

    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    const about = page.locator('#settings-panel-about');
    await expect(about).toContainText('Kurlo 2.3.0 is available');
    await expect(about).toContainText('Change 9');

    const row = about.locator('.about-update-row');
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(40);
    const list = await about.locator('.about-list').boundingBox();
    expect(list?.height ?? 0).toBeGreaterThan(box?.height ?? 0);
    await about.getByRole('button', { name: 'Install', exact: true }).click({ trial: true });

    const preview = about.locator('.updates-notes-preview');
    const link = about.getByRole('link', { name: 'Read the full changelog' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://kurlo.dev/changelog/');
    const metrics = await preview.evaluate(element => ({
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
      lineHeight: Number.parseFloat(getComputedStyle(element.querySelector('li')!).lineHeight),
      overflow: getComputedStyle(element).overflowY,
    }));
    expect(metrics.height).toBeLessThanOrEqual(Math.ceil(metrics.lineHeight * 10));
    expect(metrics.contentHeight).toBeGreaterThan(metrics.height * 3);
    expect(metrics.overflow).toBe('hidden');
    expect(await about.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThan(160);
    await link.click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls)).toContain('open:https://kurlo.dev/changelog/');

    if (aboutScreenshotDir) {
      await waitForTransientToasts(page);
      await link.scrollIntoViewIfNeeded();
      await about.locator('.updates-notes').screenshot({ path: join(aboutScreenshotDir, 'about-changelog-preview.png'), animations: 'disabled' });
      await page.locator('.settings-modal').screenshot({ path: join(aboutScreenshotDir, 'about-long-changelog.png'), animations: 'disabled' });
      await page.screenshot({ path: join(aboutScreenshotDir, 'about-full-screen.png'), animations: 'disabled' });
    }

    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    await expect(link).toBeVisible();
    await page.setViewportSize({ width: 900, height: 650 });
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport();
    await page.emulateMedia({ colorScheme: 'dark' });
    if (aboutScreenshotDir) {
      await page.locator('.settings-modal').screenshot({ path: join(aboutScreenshotDir, 'about-long-changelog-small-dark.png'), animations: 'disabled' });
    }
  });

  test('About shows short release notes in full without a changelog link', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const app = (window as any).go.api.App;
      app.AppInfo = async () => ({ name: 'Kurlo', version: '2.2.6', runtime: 'darwin/e2e', goVersion: 'e2e', packaged: false });
      app.CheckForUpdate = async () => ({
        info: { version: '2.3.0', releaseNotes: '### Fixed\n- Updates install cleanly.', publishedAt: '2026-10-14T10:00:00Z' },
        error: '',
      });
    });
    await page.goto('/');
    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    const about = page.locator('#settings-panel-about');
    await expect(about.locator('.updates-notes-preview')).toHaveText('Fixed Updates install cleanly.');
    await expect(about.getByRole('link', { name: 'Read the full changelog' })).toHaveCount(0);
    expect(await about.locator('.updates-notes-preview').evaluate(element => element.scrollHeight === element.clientHeight)).toBe(true);
    if (aboutScreenshotDir) {
      await waitForTransientToasts(page);
      await page.locator('.settings-modal').screenshot({ path: join(aboutScreenshotDir, 'about-short-changelog.png'), animations: 'disabled' });
    }
  });

  test('About shows the bird perched on the wire in the night scene', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    const scene = page.locator('#settings-panel-about .about-night');
    await expect(scene).toBeVisible();
    await expect.poll(() => scene.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);

    const sceneBox = await scene.boundingBox();
    const birdBox = await scene.locator('.about-night-bird').boundingBox();
    expect(birdBox && sceneBox && birdBox.x > sceneBox.x && birdBox.x + birdBox.width < sceneBox.x + sceneBox.width).toBe(true);
    expect(birdBox && sceneBox && birdBox.y > sceneBox.y && birdBox.y + birdBox.height < sceneBox.y + sceneBox.height).toBe(true);
    await expect(page.locator('#settings-panel-about')).toContainText('Kurlo');
  });
});

test.describe('Windows app package updates', () => {
  test('offers the MSIX download instead of replacing a packaged install', async ({ page }) => {
    const msixUrl = 'https://github.com/stormhop/kurlo/releases/download/v2.1.0/kurlo-2.1.0-windows-amd64.msix';
    await installKurloBridge(page, '', 'windows/e2e', false);
    await page.addInitScript((msixUrl) => {
      const state = (window as any).__kurloE2E;
      const app = (window as any).go.api.App;
      localStorage.setItem('kurlo:auto-update-install', 'true');
      app.AppInfo = async () => ({ name: 'Kurlo', version: '2.0.2', runtime: 'windows/e2e', goVersion: 'e2e', packaged: true });
      app.CheckForUpdate = async () => ({
        info: {
          version: '2.1.0',
          releaseNotes: '### Fixed\n- Packaged installs update cleanly',
          publishedAt: '2026-10-01T10:00:00Z',
          downloadUrl: 'https://github.com/stormhop/kurlo/releases/download/v2.1.0/kurlo-windows-amd64.exe',
          assetName: 'kurlo-windows-amd64.exe',
          sha256: 'abc123',
          signatureUrl: '',
          manualInstallUrl: msixUrl,
        },
        error: '',
      });
      app.ApplyUpdate = async () => {
        state.calls.push('ApplyUpdate');
        return '';
      };
    }, msixUrl);
    await page.goto('/');

    const banner = page.locator('.update-notif');
    await expect(banner).toContainText('Kurlo 2.1.0 is available');
    await banner.getByRole('button', { name: 'Download' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls)).toContain(`open:${msixUrl}`);

    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    const about = page.locator('#settings-panel-about');
    await expect(about).toContainText('Kurlo 2.1.0 is available');
    await expect(about).toContainText('.msix');
    await expect(about).toContainText('Packaged installs update cleanly');
    await expect(about.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
    await about.getByRole('button', { name: 'Download', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.__kurloE2E.calls)).filter((call: string) => call === `open:${msixUrl}`).length).toBe(2);

    const autoInstall = page.getByLabel('Install updates automatically').locator('input');
    await expect(autoInstall).toBeDisabled();
    await expect(autoInstall).not.toBeChecked();
    await expect(about).toContainText('Not available for the Windows app package');

    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls).not.toContain('ApplyUpdate');
  });
});

test.describe('GitHub star prompt', () => {
  test('shows once after the twentieth send and stays away when closed', async ({ page }) => {
    const shots = process.env.KURLO_STAR_SHOTS ?? '';
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.starPrompt.v1', JSON.stringify({ sends: 19, done: false })));
    await page.goto('/');
    const prompt = page.getByRole('button', { name: 'Star on GitHub' });
    await expect(prompt).toHaveCount(0);
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/users');
    await page.getByRole('button', { name: /^Send( |$)/ }).first().click();
    await expect(prompt).toBeVisible();
    if (shots) await page.locator('.status-bar').screenshot({ path: `${shots}/status-light.png` });
    await page.getByRole('button', { name: 'Hide the GitHub star prompt' }).click();
    await expect(prompt).toHaveCount(0);
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('kurlo.starPrompt.v1') ?? '{}'))).toEqual({ sends: 20, done: true });
    await page.getByRole('button', { name: /^Send( |$)/ }).first().click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(2);
    await page.waitForTimeout(300);
    await expect(prompt).toHaveCount(0);
  });

  test('opens the repository from the status bar and from Support', async ({ page }) => {
    const shots = process.env.KURLO_STAR_SHOTS ?? '';
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.starPrompt.v1', JSON.stringify({ sends: 20, done: false })));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Star on GitHub' })).toBeVisible();
    if (shots) await page.locator('.status-bar').screenshot({ path: `${shots}/status-dark.png` });
    await page.getByRole('button', { name: 'Star on GitHub' }).click();
    await expect(page.getByRole('button', { name: 'Star on GitHub' })).toHaveCount(0);
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call === 'open:https://github.com/stormhop/kurlo'))).toHaveLength(1);
    await page.locator('.version-pill').click();
    await page.getByRole('tab', { name: 'Support' }).click();
    const card = page.getByRole('button', { name: /Star Kurlo on GitHub/ });
    await expect(card).toBeVisible();
    if (shots) await page.locator('#settings-panel-support').screenshot({ path: `${shots}/support-dark.png` });
    await card.click();
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call === 'open:https://github.com/stormhop/kurlo'))).toHaveLength(2);
  });

  test('opens Boosty from Support', async ({ page }) => {
    const shots = process.env.KURLO_STAR_SHOTS ?? '';
    await installKurloBridge(page);
    await page.goto('/');
    await page.locator('.version-pill').click();
    await page.getByRole('tab', { name: 'Support' }).click();
    const card = page.getByRole('button', { name: /Support Kurlo on Boosty/ });
    await expect(card).toBeVisible();
    if (shots) await page.locator('#settings-panel-support').screenshot({ path: `${shots}/support-boosty.png` });
    await card.click();
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call === 'open:https://boosty.to/kurlo'))).toHaveLength(1);
  });
});

test.describe('UI locale', () => {
  test.use({ locale: 'ru-RU' });

  test('shows English dates on a system in another language', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      localStorage.setItem('kurlo:last-seen-version', '2.0.2');
      const app = (window as any).go.api.App;
      app.AppInfo = async () => ({ name: 'Kurlo', version: '2.0.3', runtime: 'browser/e2e', goVersion: 'e2e' });
    });
    await page.goto('/');

    const whatsNew = page.getByRole('dialog', { name: /What's new in Kurlo/ });
    await expect(whatsNew).toBeVisible();
    await expect(whatsNew).not.toContainText(/октябр|сентябр|ноябр|г\./);
    await expect(whatsNew).toContainText(/(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/);
  });
});

test('warms the settings and search dialogs after startup so the first open does not wait for them', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await expect(page.locator('.collection-list')).toBeVisible();
  const loaded = () => page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /\/(SettingsModal|GlobalSearchModal)-[^/]*\.js$/.test(name)).length);
  expect(await loaded()).toBe(0);
  await expect.poll(loaded, { timeout: 6000 }).toBe(2);
  await page.getByLabel('Settings', { exact: true }).click();
  await expect(page.locator('.settings-nav-list')).toBeVisible();
});
