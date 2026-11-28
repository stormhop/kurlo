import { chooseRequestType, clickTabClose } from './support/actions';
import { reviewShot } from './support/reviewShot';

import { installKurloBridge } from './support/bridge';

import { expectPanelSlide, samplePanelSlide } from './support/layout';

import { expect, test, type Locator } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('narrows the sidebar and clips its content while the main area follows', async ({ page }) => {
    await installKurloBridge(page, '', 'darwin/e2e');
    await page.goto('/');
    const sidebar = page.locator('.shell > .sidebar');
    await expect(sidebar).toBeVisible();
    const switcher = page.locator('.workspace-switcher');
    await expect(switcher).toHaveClass(/(^|\s)docked(\s|$)/);
    const open = (await sidebar.boundingBox())!;
    const switcherOpen = (await switcher.boundingBox())!;

    type Frame = { width: number; contentWidth: number; mainLeft: number; switcherX: number; docked: boolean };
    const sample = () => page.evaluate(() => new Promise<Frame[]>((resolve) => {
      const frames: Frame[] = [];
      const shell = document.querySelector<HTMLElement>('.shell')!;
      const step = () => {
        const side = shell.querySelector<HTMLElement>(':scope > .sidebar')!;
        const content = side.querySelector<HTMLElement>(':scope > .sidebar-search, :scope > *:not(.sidebar-titlebar)')!;
        const bar = document.querySelector<HTMLElement>('.workspace-searchbar')!;
        const sw = document.querySelector<HTMLElement>('.workspace-switcher')!;
        frames.push({
          width: side.getBoundingClientRect().width,
          contentWidth: content.getBoundingClientRect().width,
          mainLeft: bar.getBoundingClientRect().left,
          switcherX: sw.getBoundingClientRect().x,
          docked: sw.classList.contains('docked'),
        });
        if (frames.length >= 24) resolve(frames);
        else requestAnimationFrame(step);
      };
      document.querySelector<HTMLButtonElement>('button[aria-label="Toggle sidebar"]')!.click();
      requestAnimationFrame(step);
    }));
    const contentOpenWidth = await sidebar.evaluate(side => side.querySelector<HTMLElement>(':scope > *:not(.sidebar-titlebar)')!.getBoundingClientRect().width);

    const hiding = await sample();
    const moving = hiding.filter(frame => frame.docked && frame.width < open.width - 1);
    expect(moving.length).toBeGreaterThan(3);
    expect(hiding.some(frame => !frame.docked)).toBe(true);
    for (let index = 1; index < hiding.length; index += 1) {
      expect(hiding[index].width).toBeLessThanOrEqual(hiding[index - 1].width + 0.5);
      expect(hiding[index].mainLeft).toBeLessThanOrEqual(hiding[index - 1].mainLeft + 0.5);
    }
    expect(moving.every(frame => Math.abs(frame.contentWidth - contentOpenWidth) <= 0.5)).toBe(true);
    expect(moving.every(frame => frame.docked && Math.abs(frame.switcherX - switcherOpen.x) <= 0.5)).toBe(true);
    await expect(sidebar).toBeHidden();
    await expect(switcher).not.toHaveClass(/(^|\s)docked(\s|$)/);
    await expect(page.locator('.workspace-searchbar-left .workspace-switcher')).toHaveCount(1);

    const showing = await sample();
    await expect(switcher).toHaveClass(/(^|\s)docked(\s|$)/);
    for (let index = 1; index < showing.length; index += 1) {
      expect(showing[index].width).toBeGreaterThanOrEqual(showing[index - 1].width - 0.5);
      expect(showing[index].mainLeft).toBeGreaterThanOrEqual(showing[index - 1].mainLeft - 0.5);
    }
    expect(showing.filter(frame => frame.width < open.width - 1).every(frame => Math.abs(frame.switcherX - switcherOpen.x) <= 0.5)).toBe(true);
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeCloseTo(open.width, 0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.shell')).toHaveCSS('transition-duration', '0s');
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await expect(sidebar).toBeHidden();
    await expect(switcher).not.toHaveClass(/(^|\s)docked(\s|$)/);
  });

  test('offers the Kurlo docs in the search palette and opens them in the browser', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    const palette = page.getByRole('dialog', { name: 'Search requests, chats and commands' });
    const input = palette.getByRole('combobox', { name: 'Search requests, chats and commands' });
    const openCalls = () => page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('open:')));

    await page.locator('.status-search-btn').click();
    const first = palette.getByRole('option').first();
    await expect(first).toHaveText('Kurlo documentation');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(palette.locator('.palette-section').first()).toHaveText('Documentation');
    await input.press('Enter');
    await expect(palette).toBeHidden();
    await expect.poll(openCalls).toEqual(['open:https://kurlo.dev/docs/']);

    await page.locator('.status-search-btn').click();
    await input.fill('jwt bearer');
    const docs = palette.locator('.palette-docs');
    await expect(docs).toHaveText('Search Kurlo docs for “jwt bearer”');
    await expect(palette.getByRole('option').last()).toHaveClass(/palette-docs/);
    await docs.click();
    await expect(palette).toBeHidden();
    await expect.poll(openCalls).toEqual(['open:https://kurlo.dev/docs/', 'open:https://kurlo.dev/docs/?q=jwt%20bearer']);

    await page.locator('.status-search-btn').click();
    await input.fill('> settings');
    await expect(palette.locator('.palette-docs')).toHaveCount(0);
  });

  test('runs commands from the command palette', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/users');

    const palette = page.getByRole('dialog', { name: 'Search requests, chats and commands' });
    const input = palette.getByRole('combobox', { name: 'Search requests, chats and commands' });

    await page.locator('.status-search-btn').click();
    await expect(palette).toBeVisible();
    await expect(palette.locator('.palette-section').first()).toBeVisible();
    await expect(palette.getByRole('option', { name: /Send request/ })).toBeVisible();

    await input.fill('> history');
    await expect(palette.locator('.global-search-item')).toHaveCount(0);
    await expect(palette.getByRole('option').first()).toHaveAttribute('data-command-id', 'go-history');
    await input.press('Enter');
    await expect(palette).toBeHidden();
    await expect(page.locator('.history-panel')).toBeVisible();

    await page.locator('.status-search-btn').click();
    await input.fill('> response');
    const layoutOption = palette.getByRole('option', { name: /Show response below the request/ });
    await expect(layoutOption).toBeVisible();
    await input.press('ArrowDown');
    await input.press('ArrowUp');
    await expect(layoutOption).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.responseLayout.v1'))).toBe('below');

    await page.locator('.status-search-btn').click();
    await input.fill('> response');
    await expect(palette.getByRole('option', { name: /Show response beside the request/ })).toBeVisible();
    await input.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('reveals tab close buttons on hover and keyboard focus without shifting tabs', async ({ page, browserName }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const requests = ['List customer accounts and permissions', 'Create customer account'].map((name, index) => ({
      id: `tab-${index}`, collectionId: 'col-tabs', name, requestType: 'http', method: 'GET', url: 'https://api.example.test/accounts',
    }));
    await installKurloBridge(page, '', 'darwin/e2e', false, {
      collections: [{ id: 'col-tabs', workspaceId: 'workspace-e2e', name: 'Accounts' }],
      requests, openIds: requests.map(request => request.id), activeId: 'tab-0',
    });
    await page.goto('/');
    const tabs = page.locator('.saved-request-tab:not(.overview-request-tab)');
    const first = tabs.nth(0);
    const second = tabs.nth(1);
    const close = first.getByRole('button', { name: 'Close tab', exact: true });
    await page.getByLabel('Request URL').click();
    await page.mouse.move(0, 100);
    await expect(close).toHaveCSS('opacity', '0');
    await expect(close).toHaveCSS('pointer-events', 'none');
    await expect(second.locator('.tab-close')).toHaveCSS('opacity', '0');
    await expect(first.getByRole('tab')).toHaveCSS('padding-right', '10px');
    await second.getByRole('tab').click();
    await page.mouse.move(0, 100);
    await expect(second.locator('.tab-close')).toHaveCSS('opacity', '0');
    await first.getByRole('tab').click();
    await page.mouse.move(0, 100);
    await expect(close).toHaveCSS('opacity', '0');
    const bounds = await tabs.evaluateAll(nodes => nodes.map(node => {
      const { x, width } = node.getBoundingClientRect();
      return { x, width };
    }));
    const labelWidth = await first.locator('.tab-title').evaluate(node => node.clientWidth);
    expect(labelWidth).toBeGreaterThan(135);
    await reviewShot(page, { path: join(tmpdir(), `kurlo-tabs-idle-${testInfo.project.name}.png`), animations: 'disabled' });

    await first.hover();
    await expect(close).toHaveCSS('opacity', '1');
    await expect(close).toHaveCSS('pointer-events', 'auto');
    await expect(second.locator('.tab-close')).toHaveCSS('opacity', '0');
    expect(await tabs.evaluateAll(nodes => nodes.map(node => {
      const { x, width } = node.getBoundingClientRect();
      return { x, width };
    }))).toEqual(bounds);
    expect(await first.locator('.tab-title').evaluate(node => node.clientWidth)).toBe(labelWidth);
    await reviewShot(page, { path: join(tmpdir(), `kurlo-tabs-hover-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await reviewShot(page, { path: join(tmpdir(), `kurlo-tabs-hover-dark-${testInfo.project.name}.png`), animations: 'disabled' });

    await page.mouse.move(0, 100);
    await page.getByRole('tab', { name: 'Overview', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(close).toHaveCSS('opacity', '1');
    await page.keyboard.press(browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(tabs).toHaveCount(1);
    await expect(tabs.getByRole('tab')).toContainText('Create customer account');

    await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
    const runner = page.locator('.runner-tab');
    await page.locator('.status-search-btn').focus();
    await page.mouse.move(0, 100);
    await expect(runner.locator('.tab-close')).toHaveCSS('opacity', '0');
    await runner.hover();
    await expect(runner.locator('.tab-close')).toHaveCSS('opacity', '1');
    await runner.getByRole('button', { name: 'Close runner tab' }).click();
    await expect(runner).toHaveCount(0);

    await tabs.hover();
    await tabs.getByRole('button', { name: 'Close tab', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Create customer account/ })).toHaveCount(0);
  });

  test('keeps unsaved tab indicators visible and supports closing without hover', async ({ page, browserName }, testInfo) => {
    const savedStore = {
      collections: [{ id: 'col-tabs', workspaceId: 'workspace-e2e', name: 'Accounts' }],
      requests: [{ id: 'saved-tab', collectionId: 'col-tabs', name: 'List accounts', requestType: 'http', method: 'GET', url: 'https://api.example.test/accounts' }],
      openIds: ['saved-tab'], activeId: 'saved-tab',
    };
    await installKurloBridge(page, '', 'browser/e2e', false, savedStore);
    await page.goto('/');
    const saved = page.locator('.saved-request-tab.active');
    await page.getByLabel('Request URL').fill('https://api.example.test/changed');
    await page.mouse.move(0, 100);
    await expect(saved).toHaveClass(/unsaved/);
    await expect(saved.locator('.tab-close')).toHaveCSS('opacity', '1');
    await expect(saved.locator('.tab-close svg')).toHaveCSS('opacity', '0');
    await saved.hover();
    await expect(saved.locator('.tab-close svg')).toHaveCSS('opacity', '1');
    await page.getByRole('button', { name: 'Revert unsaved changes', exact: true }).click();
    await expect(saved).not.toHaveClass(/unsaved/);
    await page.getByLabel('New unsaved request').click();
    const draft = page.locator('.saved-request-tab.active');
    const close = draft.locator('.tab-close');
    await page.getByLabel('Request URL').click();
    await page.mouse.move(0, 100);
    await expect(draft).not.toHaveClass(/unsaved/);
    await page.getByLabel('Request URL').fill('https://api.example.test/draft');
    await page.mouse.move(0, 100);
    await expect(draft).toHaveClass(/unsaved/);
    await expect(close).toHaveCSS('opacity', '1');
    await expect(close.locator('svg')).toHaveCSS('opacity', '0');
    expect(await close.evaluate(node => getComputedStyle(node, '::after').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await reviewShot(page, { path: join(tmpdir(), `kurlo-tabs-unsaved-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.getByRole('tab', { name: 'Overview', exact: true }).focus();
    await page.keyboard.press('End');
    await expect(close.locator('svg')).toHaveCSS('opacity', '1');
    expect(await close.evaluate(node => getComputedStyle(node, '::after').opacity)).toBe('0');
    await page.getByLabel('Request URL').fill('');
    await expect(draft).not.toHaveClass(/unsaved/);
    await page.getByRole('tab', { name: 'Overview', exact: true }).focus();
    await page.keyboard.press('End');
    await page.keyboard.press(browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Save request' })).toHaveCount(0);

    const touchContext = await page.context().browser()!.newContext({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 760 } });
    try {
      const touchPage = await touchContext.newPage();
      await installKurloBridge(touchPage, '', 'browser/e2e', false, savedStore);
      await touchPage.goto('/');
      expect(await touchPage.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
      await expect(touchPage.locator('.saved-request-tab:not(.unsaved) .tab-close').first()).toHaveCSS('opacity', '1');
      await expect(touchPage.locator('.saved-request-tab:not(.unsaved) .tab-close').first()).toHaveCSS('pointer-events', 'auto');
      await touchPage.locator('.saved-request-tab:not(.unsaved) .tab-close').first().tap();
      await expect(touchPage.getByRole('tab', { name: /List accounts/ })).toHaveCount(0);
    } finally {
      await touchContext.close();
    }
  });

  test('lists every open tab when the title row runs out of room', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 760 });
    await installKurloBridge(page);
    await page.goto('/');

    const overflowButton = page.getByRole('button', { name: 'All open tabs' });
    await expect(overflowButton).toBeHidden();
    for (let index = 0; index < 7; index += 1) {
      await page.getByLabel('New unsaved request').click();
      await chooseRequestType(page, 'HTTP Request');
    }
    await expect(overflowButton).toBeVisible();

    const tabs = page.locator('.saved-request-tabs');
    await expect.poll(async () => tabs.evaluate((list) => list.scrollWidth > list.clientWidth)).toBe(true);
    await expect.poll(async () => page.locator('.saved-request-tab:not(.overview-request-tab)').first().evaluate(tab => tab.getBoundingClientRect().width)).toBeLessThan(140);

    await overflowButton.click();
    const list = page.getByRole('listbox', { name: 'Open tabs' });
    await expect(list.getByRole('option')).toHaveCount(9);
    expect(await list.evaluate(menu => {
      const box = menu.getBoundingClientRect();
      return menu.contains(document.elementFromPoint(box.left + box.width / 2, box.top + 16));
    })).toBe(true);
    await list.getByRole('option', { name: 'Overview' }).click();
    await expect(list).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  test('closes a tab with the middle mouse button', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    const requestTabs = page.locator('.saved-request-tab:not(.overview-request-tab)');
    const initial = await requestTabs.count();
    for (let index = 0; index < 2; index += 1) {
      await page.getByLabel('New unsaved request').click();
      await chooseRequestType(page, 'HTTP Request');
    }
    await expect(requestTabs).toHaveCount(initial + 2);

    await requestTabs.last().getByRole('tab').click({ button: 'middle' });
    await expect(requestTabs).toHaveCount(initial + 1);

    await page.getByRole('tab', { name: 'Overview' }).click({ button: 'middle' });
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    await expect(requestTabs).toHaveCount(initial + 1);
  });
});

test.describe('Request tabs', () => {
  test('switching and closing tabs saves only the view, not the whole store', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const request = (id: string) => ({ id, name: id, collectionId: 'collection-tabs', collection: 'Tabs', folderPath: [], requestType: 'http', method: 'GET', url: `https://api.example.test/${id}` });
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-tabs', workspaceId: 'workspace-e2e', name: 'Tabs', filesystemName: 'Tabs' }];
      store.requests = [request('alpha'), request('beta'), request('gamma')];
      store.activeId = 'alpha';
      store.openIds = ['alpha', 'beta'];
    });
    await page.goto('/');
    await expect(page.getByLabel('Request URL')).toHaveValue(/alpha$/);
    await page.evaluate(() => { window.__kurloE2E.calls.length = 0; });

    await page.getByRole('tab', { name: /\bbeta$/ }).first().click();
    await expect(page.getByLabel('Request URL')).toHaveValue(/beta$/);
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedViews.at(-1))).toEqual({ activeId: 'beta', activeWorkspaceId: 'workspace-e2e', openIds: ['alpha', 'beta'] });

    await page.getByText('gamma', { exact: true }).first().click();
    await expect(page.getByLabel('Request URL')).toHaveValue(/gamma$/);
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedViews.at(-1))).toEqual({ activeId: 'gamma', activeWorkspaceId: 'workspace-e2e', openIds: ['alpha', 'beta', 'gamma'] });

    await clickTabClose(page.getByRole('button', { name: 'Close tab' }).nth(2));
    await expect(page.getByLabel('Request URL')).toHaveValue(/beta$/);
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedViews.at(-1))).toEqual({ activeId: 'beta', activeWorkspaceId: 'workspace-e2e', openIds: ['alpha', 'beta'] });

    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls.filter(call => call === 'SaveRequestStore')).toEqual([]);
    expect(await page.evaluate(() => (window.__kurloE2E.store as { activeId: string }).activeId)).toBe('beta');
  });
});

test('keeps the docked macOS workspace switcher still while switching sidebar views', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await installKurloBridge(page, '', 'darwin/e2e');
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Workspace switcher' });
  await expect(trigger).toBeVisible();
  expect(await page.locator('.shell > .workspace-switcher.docked').evaluate(node => getComputedStyle(node).willChange)).toBe('transform');
  await page.evaluate(() => {
    const frames = new Set<string>();
    (window as unknown as { __switcherFrames: Set<string> }).__switcherFrames = frames;
    const tick = () => {
      const node = document.querySelector('[aria-label="Workspace switcher"]');
      if (node) frames.add([node, ...node.querySelectorAll('svg, span')].map(part => {
        const box = part.getBoundingClientRect();
        return [box.left, box.top, box.width, box.height].join(',');
      }).join('|'));
      requestAnimationFrame(tick);
    };
    tick();
  });
  const rail = page.getByRole('navigation', { name: 'Kurlo' });
  for (const view of ['Environments', 'History', 'Agent', 'Cookies', 'Collection runner', 'Mock server', 'Collections']) {
    await rail.getByRole('button', { name: view, exact: true }).click();
    await page.waitForTimeout(200);
  }
  expect(await page.evaluate(() => (window as unknown as { __switcherFrames: Set<string> }).__switcherFrames.size)).toBe(1);
});

test.describe('Request toolbar and sidebar menu placement', () => {
  test.use({ actionTimeout: 10000 });

  test('slides the code snippet panel without squeezing its content', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installKurloBridge(page);
    await page.goto('/');
    const toggle = page.getByLabel('Code snippet', { exact: true });
    const panel = page.locator('.code-snippet-panel');
    await toggle.click();
    await expect(panel.locator('.curl-line').first()).toBeVisible();
    await expect.poll(() => panel.evaluate(node => node.getAnimations().length)).toBe(0);
    const selectors = { toggle: '[aria-label="Code snippet"]', panel: '.code-snippet-panel', content: '.code-snippet-content', main: '.workspace-searchbar' };
    expectPanelSlide(await samplePanelSlide(page, selectors), false);
    await expect(panel).toBeHidden();
    await expect(panel).toHaveAttribute('inert');
    expectPanelSlide(await samplePanelSlide(page, selectors), true);
    await expect(panel).toBeVisible();
    await reviewShot(page, { path: join(tmpdir(), `kurlo-snippet-slide-open-${testInfo.project.name}.png`), animations: 'disabled' });
    await panel.getByLabel('Snippet language').click();
    await toggle.click();
    await toggle.click();
    await expect(panel.locator('.snippet-select .app-select-menu')).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect.poll(() => panel.evaluate(node => node.getAnimations().length)).toBe(0);
    const resizer = panel.getByLabel('Resize code snippet panel');
    await resizer.focus();
    const before = (await panel.boundingBox())!.width;
    await resizer.press('ArrowLeft');
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before);
    await expect.poll(() => panel.evaluate(node => node.getAnimations().length)).toBe(0);
    const divider = (await resizer.boundingBox())!;
    await page.mouse.move(divider.x + divider.width / 2, divider.y + 100);
    await page.mouse.down();
    await expect(page.locator('.workspace')).toHaveCSS('transition-duration', '0s');
    const dragWidth = (await panel.boundingBox())!.width;
    await page.mouse.move(divider.x - 24, divider.y + 100);
    expect((await panel.boundingBox())!.width).toBeGreaterThan(dragWidth);
    await page.mouse.up();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.workspace')).toHaveCSS('transition-duration', '0s');
    await toggle.click();
    await expect(panel).toBeHidden();
    await toggle.click();
    await expect(panel).toBeVisible();
    expect(await panel.evaluate(node => node.getAnimations().filter(animation => animation instanceof CSSTransition && animation.transitionProperty === 'width').length)).toBe(0);
  });

  test('keeps the snippet control in the URL row across supported protocols', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await installKurloBridge(page);
    await page.goto('/');
    for (const type of ['HTTP Request', 'MCP Request', 'AI Request', 'GraphQL Request', 'WebSocket Request', 'Socket.IO Request', 'gRPC Request']) {
      await page.getByLabel('New unsaved request').click();
      await chooseRequestType(page, type);
      const snippet = page.getByLabel('Code snippet', { exact: true });
      if (['HTTP Request', 'MCP Request', 'AI Request'].includes(type)) {
        await expect(snippet).toBeVisible();
        await snippet.click();
        await expect(page.locator('.code-snippet-panel')).toBeVisible();
        const layout = await page.locator('.request-bar').evaluate(node => {
          const row = node.getBoundingClientRect();
          const code = node.querySelector('.request-code-btn')!.getBoundingClientRect();
          const send = node.querySelector('.btn-send')!.getBoundingClientRect();
          return { fits: send.right <= row.right + 1, sameLine: Math.abs(code.top - send.top) < 1, beforeSend: code.right <= send.left };
        });
        expect(layout).toEqual({ fits: true, sameLine: true, beforeSend: true });
        await reviewShot(page, { path: join(tmpdir(), `kurlo-snippet-${type}.png`), animations: 'disabled' });
        await snippet.click();
      } else {
        await expect(snippet).toHaveCount(0);
      }
    }
  });

  for (const runtime of ['darwin/e2e', 'windows/e2e', 'linux/e2e']) {
    test(`places code snippet before Send and sidebar menus beside the list on ${runtime}`, async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 800 });
      await installKurloBridge(page, '', runtime, false, {
        collections: [{ id: 'col-api', workspaceId: 'workspace-e2e', name: 'API', folderPaths: [['Orders']], loadTests: [{ id: 'lt-flow', name: 'Order flow', scenarios: [], thresholds: [] }] }],
        requests: [
          { id: 'req-root', collectionId: 'col-api', collection: 'API', name: 'Root request', method: 'GET', url: 'https://example.test/root' },
          { id: 'req-folder', collectionId: 'col-api', collection: 'API', name: 'Nested request', folderPath: ['Orders'], method: 'POST', url: 'https://example.test/orders' },
        ],
        history: [{ id: 'history-root', request: { id: 'req-root', collectionId: 'col-api', collection: 'API', name: 'Root request', method: 'GET', url: 'https://example.test/root' }, statusCode: 200, status: '200 OK', duration: 20, createdAt: Date.now() }],
        starredRequestIds: ['req-root'], activeId: 'req-root', openIds: ['req-root'],
      });
      await page.goto('/');
      const snippet = page.getByLabel('Code snippet', { exact: true });
      await expect(snippet).toHaveCount(1);
      await expect(page.locator('.workspace-searchbar').getByLabel('Code snippet', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Toggle code snippet panel', { exact: true })).toHaveCount(0);
      const assertToolbar = async () => {
        await expect.poll(async () => {
          const code = (await snippet.boundingBox())!;
          const send = (await page.locator('.request-bar .btn-send').boundingBox())!;
          return Math.abs(code.y - send.y) < 1 && code.x + code.width <= send.x;
        }).toBe(true);
        await expect(page.locator('.request-bar')).toContainText('</>');
      };
      await assertToolbar();
      await snippet.click();
      await expect(page.locator('.code-snippet-panel')).toBeVisible();
      await expect(snippet).toHaveAttribute('aria-pressed', 'true');
      await assertToolbar();
      await reviewShot(page, { path: join(tmpdir(), `kurlo-snippet-url-${runtime.split('/')[0]}.png`), animations: 'disabled' });
      await snippet.click();
      await expect(page.locator('.code-snippet-panel')).toBeHidden();

      const assertMenu = async (row: Locator, trigger: Locator, menu: Locator, supportsRightClick = true) => {
        for (const rightClick of supportsRightClick ? [true, false] : [false]) {
          if (rightClick) await row.click({ button: 'right' });
          else await trigger.click();
          await expect(menu).toBeVisible();
          const bounds = (await menu.boundingBox())!;
          const anchor = (await trigger.boundingBox())!;
          const rowBox = (await menu.evaluate(node => {
            const box = node.parentElement!.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom };
          }));
          expect(Math.abs(bounds.x - anchor.x)).toBeLessThan(1);
          expect(bounds.y).toBeGreaterThanOrEqual(rowBox.bottom);
          expect(bounds.y - rowBox.bottom).toBeLessThan(8);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(1100);
          expect(bounds.y).toBeGreaterThanOrEqual(0);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
          expect(await menu.evaluate(node => {
            const box = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(box.left + 8, box.top + 8));
          })).toBe(true);
          await reviewShot(page, { path: join(tmpdir(), `kurlo-sidebar-menu-${runtime.split('/')[0]}-${await row.getAttribute('class')}-${rightClick}.png`), animations: 'disabled' });
          await page.locator('.sidebar-search input').click();
          await expect(menu).toHaveCount(0);
        }
      };
      const starred = page.locator('.starred-list .collection-request-wrap');
      await assertMenu(starred.locator('.collection-request'), starred.getByLabel('Request menu'), starred.locator('.request-menu'));
      const collection = page.locator('.collection-folder').filter({ hasText: 'API' });
      await assertMenu(collection, collection.getByLabel('Collection menu'), collection.locator('.collection-menu'));
      const collapsed = collection.getByLabel('Expand collection');
      if (await collapsed.isVisible()) await collapsed.click();
      const root = page.locator('.collection-list .collection-request-wrap').filter({ hasText: 'Root request' });
      await assertMenu(root.locator('.collection-request'), root.getByLabel('Request menu'), root.locator('.request-menu'));
      const folder = page.locator('.collection-subfolder').filter({ hasText: 'Orders' });
      await assertMenu(folder, folder.getByLabel('Folder menu'), folder.locator('.folder-menu'));
      const expandFolder = folder.getByLabel('Expand folder');
      if (await expandFolder.isVisible()) await expandFolder.click();
      const nested = page.locator('.collection-list .collection-request-wrap').filter({ hasText: 'Nested request' });
      await assertMenu(nested.locator('.collection-request'), nested.getByLabel('Request menu'), nested.locator('.request-menu'));
      const expandLoads = page.getByLabel('Expand load tests', { exact: true });
      if (await expandLoads.isVisible()) await expandLoads.click();
      const load = page.locator('.collection-request-wrap').filter({ hasText: 'Order flow' });
      await assertMenu(load.locator('.collection-request'), load.getByLabel('Load test menu'), load.locator('.request-menu'));
      await page.getByRole('button', { name: 'History', exact: true }).click();
      const history = page.locator('.history-entry');
      await assertMenu(history, history.getByLabel('History request menu'), history.locator('.history-entry-menu'), false);
      const header = page.locator('.history-head');
      await assertMenu(header, page.getByLabel('History menu', { exact: true }), page.locator('.history-header-menu'), false);
    });
  }
});

test('closes a sidebar menu once its row scrolls out of the list, keeps it while the row is visible', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const requests = Array.from({ length: 80 }, (_, index) => ({
    id: `req-${index + 1}`, collectionId: 'col-api', collection: 'API', name: `Order ${index + 1}`, method: 'GET', url: `https://example.test/orders/${index + 1}`, auth: { type: 'none' },
  }));
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'col-api', workspaceId: 'workspace-e2e', name: 'API' }],
    requests, activeId: 'req-1', openIds: ['req-1'],
  });
  await page.goto('/');
  const list = page.locator('.collection-list');
  const expand = page.getByLabel('Expand collection');
  if (await expand.isVisible()) await expand.click();
  const row = list.locator('.collection-request-wrap').filter({ has: page.getByText('Order 6', { exact: true }) });
  await row.hover();
  await row.getByLabel('Request menu').click();
  const menu = row.locator('.request-menu');
  await expect(menu).toBeVisible();
  await list.evaluate(node => { node.scrollTop += 4; });
  await expect(menu).toBeVisible();
  await reviewShot(page, { path: join(tmpdir(), 'kurlo-sidebar-menu-scroll-open.png'), animations: 'disabled' });
  await list.evaluate(node => { node.scrollTop += 600; });
  await expect(page.locator('.collection-list .request-menu')).toHaveCount(0);
  await list.evaluate(node => { node.scrollTop = 0; });
  await expect(page.locator('.collection-list .request-menu')).toHaveCount(0);
});

test('slides the sidebar without restyling the rest of the window', async ({ page }) => {
  const col = { id: 'big-col', workspaceId: 'workspace-e2e', name: 'Big API' };
  const requests = Array.from({ length: 400 }, (_, r) => ({
    id: `r${r}`, name: `Operation ${r}`, url: `https://api.kurlo.test/v1/things/${r}`, collectionId: col.id, collection: col.name, requestType: 'http', method: 'GET', auth: { type: 'none' },
  }));
  await installKurloBridge(page, '', 'browser/e2e', false, { collections: [col], requests, activeId: 'r0', openIds: ['r0'], folderCollapsed: {} });
  await page.goto('/');
  const sidebar = page.locator('.shell > .sidebar');
  const rendered = () => sidebar.evaluate(node => node.querySelectorAll('*').length);
  await expect.poll(rendered).toBeGreaterThan(3000);
  const grown = await rendered();
  const inherited = () => page.evaluate(() => {
    const names = new Set<string>();
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) for (const name of rule.style) if (name.startsWith('--')) names.add(name);
        if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules);
    for (const name of document.querySelector<HTMLElement>('.shell')!.style) if (name.startsWith('--')) names.add(name);
    const style = getComputedStyle(document.querySelector('.workspace')!);
    const inherited = [...names].sort().map(name => [name, style.getPropertyValue(name)]);
    return Object.fromEntries(inherited.filter(([, value]) => value !== ''));
  });
  const before = await inherited();
  const toggle = page.getByLabel('Toggle sidebar', { exact: true });
  await toggle.click();
  await expect(sidebar).toBeHidden();
  expect(await inherited()).toEqual(before);
  await expect.poll(rendered).toBeLessThan(grown / 3);
  await toggle.click();
  await expect(sidebar).toBeVisible();
  expect(await inherited()).toEqual(before);
  await expect.poll(rendered).toBeGreaterThanOrEqual(grown);
});
