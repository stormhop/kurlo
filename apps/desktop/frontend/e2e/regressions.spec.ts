import type { E2EWindow, E2EAppBridge } from './support/bridge';
import { reviewShot } from './support/reviewShot';
import { collectionRow } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { expect, test } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe('Audit regressions', () => {
  const collection = { id: 'audit-c', workspaceId: 'workspace-e2e', name: 'Audit' };
  const request = (id: string, name: string, url: string) => ({ id, name, url, collectionId: collection.id, collection: collection.name, requestType: 'http', method: 'GET', auth: { type: 'none' } });
  const environments = () => Array.from({ length: 30 }, (_, index) => ({ id: `audit-e-${index}`, workspaceId: 'workspace-e2e', name: `Environment ${String(index).padStart(2, '0')}`, values: [{ id: `value-${index}`, key: 'host', value: `host-${index}`, enabled: true }] }));

  for (const area of ['environments', 'switcher', 'collections', 'history']) {
    test(`scrolls ${area} with the pointer over a row and opens the last item`, async ({ page }) => {
      const requests = Array.from({ length: 60 }, (_, index) => request(`audit-r-${index}`, `Request ${String(index).padStart(2, '0')} 名`, `https://audit.test/item/${index}`));
      const history = requests.map((item, index) => ({ id: `audit-h-${index}`, request: item, sourceRequestId: item.id, statusCode: 200, status: '200 OK', createdAt: Date.now() - index * 1000, duration: 5, responseSize: 1 }));
      await installKurloBridge(page, '', 'browser/e2e', false, { collections: [collection], requests, history, environments: environments() });
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto('/');
      if (area === 'environments') await page.getByRole('button', { name: 'Environments', exact: true }).click();
      if (area === 'history') await page.getByRole('button', { name: 'History', exact: true }).click();
      if (area === 'switcher') await page.locator('.environment-select').click();
      const selector = { environments: '.environment-list', switcher: '.environment-menu-list', collections: '.collection-list', history: '.history-list' }[area]!;
      const list = page.locator(selector);
      const labels = { environments: '.environment-item-text', switcher: '.environment-menu-name', collections: '.collection-title', history: '.history-url' };
      const label = list.locator(labels[area as keyof typeof labels]).nth(5);
      const point = (await label.boundingBox())!;
      await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
      await page.mouse.wheel(0, 500);
      await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      const bounds = (await list.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, 10000);
      const target = area === 'environments' ? list.locator('.environment-item-main').filter({ hasText: 'Environment 29' })
        : area === 'switcher' ? list.getByRole('button', { name: /Environment 29/ })
        : area === 'collections' ? list.getByRole('button', { name: /Request 59/ })
        : list.locator('.history-entry-main').filter({ hasText: '/item/59' });
      await expect(target).toBeInViewport();
      await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `audit-${area}-last-row.png`), animations: 'disabled' });
      await target.click();
      if (area === 'environments' || area === 'switcher') await expect(page.locator('.environment-select')).toContainText('Environment 29');
      else if (area === 'collections') await expect(page.getByLabel('Request URL')).toHaveValue('https://audit.test/item/59');
      else await expect(page.locator('.history-detail')).toContainText('/item/59');
    });
  }

  test('sizes history day headers like the rows they render, so a long history scrolls without jumps', async ({ page }) => {
    const requests = Array.from({ length: 900 }, (_, index) => request(`days-r-${index}`, `Request ${index}`, `https://days.test/item/${index}`));
    const history = requests.map((item, index) => ({ id: `days-h-${index}`, request: item, sourceRequestId: item.id, statusCode: 200, status: '200 OK', createdAt: Date.now() - index * 900_000, duration: 5, responseSize: 1 }));
    await installKurloBridge(page, '', 'browser/e2e', false, { collections: [collection], requests, history });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const list = page.locator('.history-list');
    await expect(list.locator('.history-day-toggle').first()).toBeVisible();
    const expectedHeight = await list.evaluate((node, timestamps) => {
      const outerHeight = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return element.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
      };
      const days = new Set(timestamps.map(timestamp => new Date(timestamp).toDateString())).size;
      const style = getComputedStyle(node);
      return Math.round(timestamps.length * outerHeight(node.querySelector<HTMLElement>('.history-entry')!)
        + days * outerHeight(node.querySelector<HTMLElement>('.history-day-toggle')!)
        + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));
    }, history.map(entry => entry.createdAt));
    expect(await list.locator('.history-entry-main').count()).toBeLessThan(requests.length);
    await expect.poll(() => list.evaluate(node => node.scrollHeight)).toBe(expectedHeight);
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(list.locator('.history-entry-main').filter({ hasText: '/item/899' })).toBeInViewport();
    await expect.poll(() => list.evaluate(node => node.scrollHeight)).toBe(expectedHeight);
  });

  test('renders a collection the size of a large OpenAPI import in full once the sidebar is idle', async ({ page }) => {
    const requests = Array.from({ length: 491 }, (_, index) => ({
      ...request(`idle-r-${index}`, `Request ${String(index).padStart(4, '0')}`, `https://idle.test/item/${index}`),
      folderPath: [`Folder ${String(Math.floor(index / 8)).padStart(3, '0')}`],
    }));
    await installKurloBridge(page, '', 'browser/e2e', false, { collections: [collection], requests, folderCollapsed: {} });
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        const rows = [...document.querySelectorAll<HTMLElement>('.collection-list .sidebar-vrow')];
        if (!rows.some(row => row.textContent?.includes('Request 0000'))) return;
        document.documentElement.dataset.initialCollectionRows = String(rows.length);
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    const first = await page.waitForFunction(() => Number(document.documentElement.dataset.initialCollectionRows) || false);
    expect(await first.jsonValue()).toBeLessThan(300);
    const list = page.locator('.collection-list');
    await expect(list.getByRole('button', { name: /Request 0000/ })).toBeVisible();
    const total = 1 + 62 + 491;
    await expect.poll(() => list.locator('.sidebar-vrow').count(), { timeout: 5000 }).toBe(total);
    await expect(list.locator('.sidebar-virtual-spacer').first()).toHaveCSS('height', '0px');
    await expect(list.locator('.sidebar-virtual-spacer').last()).toHaveCSS('height', '0px');
    const box = await list.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    for (let step = 0; step < 6; step++) await page.mouse.wheel(0, 4000);
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect(await list.locator('.sidebar-vrow').count()).toBe(total);
    await page.getByRole('textbox', { name: 'Filter requests' }).fill('Request 0007');
    await expect(list.getByRole('button', { name: /Request 0007/ })).toBeVisible();
    await list.evaluate(node => {
      const before = node.querySelectorAll('.sidebar-vrow').length;
      const observer = new MutationObserver(() => {
        const count = node.querySelectorAll('.sidebar-vrow').length;
        if (!count || count === before) return;
        document.documentElement.dataset.restoredCollectionRows = String(count);
        observer.disconnect();
      });
      observer.observe(node, { childList: true });
    });
    await page.getByRole('textbox', { name: 'Filter requests' }).fill('');
    const restored = await page.waitForFunction(() => Number(document.documentElement.dataset.restoredCollectionRows) || false);
    expect(await restored.jsonValue()).toBeLessThan(150);
    await expect.poll(() => list.locator('.sidebar-vrow').count(), { timeout: 5000 }).toBe(total);
  });

  test('keeps rows rendered past both edges while a large collection is flung', async ({ page }, testInfo) => {
    const requests = Array.from({ length: 3000 }, (_, index) => ({
      ...request(`fling-r-${index}`, `Request ${String(index).padStart(4, '0')}`, `https://fling.test/item/${index}`),
      folderPath: [`Folder ${String(Math.floor(index / 25)).padStart(3, '0')}`],
    }));
    await installKurloBridge(page, '', 'browser/e2e', false, { collections: [collection], requests });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    const list = page.locator('.collection-list');
    await expect(list.getByRole('button', { name: /Request 0000/ })).toBeVisible();
    const samples = await list.evaluate(async (node) => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const results: Array<{ above: number; below: number; rows: number; contentAbove: number; contentBelow: number }> = [];
      const viewport = node.getBoundingClientRect();
      for (let step = 0; step < 60; step++) {
        node.scrollTop += node.clientHeight * 0.45;
        await frame();
        const rows = node.querySelectorAll('.sidebar-vrow');
        const first = rows[0].getBoundingClientRect();
        const last = rows[rows.length - 1].getBoundingClientRect();
        results.push({
          above: viewport.top - first.top,
          below: last.bottom - viewport.bottom,
          rows: rows.length,
          contentAbove: node.scrollTop,
          contentBelow: node.scrollHeight - node.scrollTop - node.clientHeight,
        });
      }
      return { results, height: node.clientHeight };
    });
    const buffer = samples.height * 0.75;
    for (const sample of samples.results) {
      expect(sample.above).toBeGreaterThanOrEqual(Math.min(sample.contentAbove, buffer) - 1);
      expect(sample.below).toBeGreaterThanOrEqual(Math.min(sample.contentBelow, buffer) - 1);
      expect(sample.rows).toBeLessThan(700);
    }
    await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `fling-collection-${testInfo.project.name}.png`), animations: 'disabled' });

    await list.evaluate((node) => {
      node.scrollTop = 0;
      const seen = { wheels: 0, cancelled: 0 };
      (window as unknown as { __sidebarWheel: typeof seen }).__sidebarWheel = seen;
      window.addEventListener('wheel', (event) => {
        seen.wheels += 1;
        if (event.defaultPrevented) seen.cancelled += 1;
      });
    });
    const box = await list.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const wheelSamples: Array<{ scrolled: number; above: number; below: number }> = [];
    for (let step = 0; step < 20; step++) {
      const before = await list.evaluate(node => node.scrollTop);
      await page.mouse.wheel(0, Math.round(box!.height * 1.5));
      await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(before);
      wheelSamples.push(await list.evaluate(async (node) => {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const viewport = node.getBoundingClientRect();
        const rows = node.querySelectorAll('.sidebar-vrow');
        return {
          scrolled: node.scrollTop,
          above: viewport.top - rows[0].getBoundingClientRect().top,
          below: rows[rows.length - 1].getBoundingClientRect().bottom - viewport.bottom,
        };
      }));
    }
    for (const sample of wheelSamples) {
      expect(sample.above).toBeGreaterThanOrEqual(0);
      expect(sample.below).toBeGreaterThanOrEqual(0);
    }
    const wheel = await page.evaluate(() => (window as unknown as { __sidebarWheel: { wheels: number; cancelled: number } }).__sidebarWheel);
    expect(wheel.wheels).toBeGreaterThan(0);
    expect(wheel.cancelled).toBe(0);
  });

  test('keeps a background HTTP response in its source tab without replacing the visible response', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, { collections: [collection], requests: [request('audit-a', 'Alpha', 'https://alpha.test/ping'), request('audit-b', 'Beta', 'https://beta.test/ping')], activeId: 'audit-a', openIds: ['audit-a', 'audit-b'] });
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go.api.App;
      const original = app.SendRequest;
      const gate = { ready: false, release: () => {} };
      Object.assign(window.__kurloE2E, { responseGate: gate });
      app.SendRequest = async (sent) => {
        const response = await original(sent);
        if (!sent.url.includes('alpha.test')) return response;
        return new Promise(resolve => { gate.ready = true; gate.release = () => resolve(response); });
      };
    });
    await page.goto('/');
    await page.locator('.send-split .btn-send').click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.responseGate!.ready)).toBe(true);
    await page.getByRole('tab', { name: 'GET Beta', exact: true }).click();
    await page.locator('.send-split .btn-send').click();
    await page.locator('.response-area').getByRole('tab', { name: 'Body', exact: true }).click();
    const body = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(body).toContainText('beta.test');
    await page.evaluate(() => window.__kurloE2E.responseGate!.release());
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.history.some(entry => entry.sourceRequestId === 'audit-a'))).toBe(true);
    await expect(body).toContainText('beta.test');
    await expect(page.locator('.response-area').getByRole('tab', { name: 'Body', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'GET Alpha', exact: true }).click();
    await expect(page.locator('.response-status-bar .status-badge')).toContainText('200');
    await page.locator('.response-area').getByRole('tab', { name: 'Body', exact: true }).click();
    await expect(body).toContainText('alpha.test');
    await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), 'audit-background-response.png'), animations: 'disabled' });
  });

  test('refits an open environment pin picker when its available space changes', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, { collections: [collection], requests: [request('audit-r', 'Ping', 'https://audit.test/ping')], environments: environments() });
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto('/');
    const row = collectionRow(page, 'Audit');
    await row.getByLabel('Collection menu').click();
    await row.getByRole('button', { name: 'Settings', exact: true }).click();
    const picker = page.getByRole('button', { name: 'Pin environment', exact: true });
    await picker.click();
    const menu = page.getByRole('dialog', { name: 'Pin environment' });
    await expect(menu).toBeVisible();
    await page.setViewportSize({ width: 1400, height: 680 });
    await expect(picker).toBeInViewport();
    const inside = () => menu.evaluate(node => { const rect = node.getBoundingClientRect(); const panel = node.closest('.collection-workspace')!.getBoundingClientRect(); return rect.top >= Math.max(0, panel.top) && rect.bottom <= Math.min(innerHeight, panel.bottom); });
    await expect.poll(inside).toBe(true);
    await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), 'audit-picker-resized.png'), animations: 'disabled' });
    const list = menu.locator('.search-picker-list');
    const label = (await list.locator('.search-picker-option-label').nth(3).boundingBox())!;
    await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
    await page.mouse.wheel(0, 10000);
    const last = menu.getByRole('option', { name: /Environment 29/ });
    await expect(last).toBeInViewport();
    await last.click();
    await expect(page.getByRole('list', { name: 'Pinned environments' })).toContainText('Environment 29');
  });

  test('keeps collection notes usable at the minimum window and largest UI scale', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, { collections: [collection], requests: [request('audit-r', 'Ping', 'https://audit.test/ping')] });
    await page.addInitScript(() => localStorage.setItem('kurlo.uiScale.v1', '1.5'));
    await page.setViewportSize({ width: 1120, height: 680 });
    await page.goto('/');
    const row = collectionRow(page, 'Audit');
    await row.getByLabel('Collection menu').click();
    await row.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Write documentation' }).click();
    const notes = page.getByRole('textbox', { name: 'Documentation', exact: true });
    const width = await notes.evaluate(node => node.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(300);
    const subtitle = await page.locator('.collection-workspace-head p').evaluate(node => node.getBoundingClientRect().height);
    expect(subtitle).toBeLessThan(80);
    await notes.fill('Collection notes at 150%');
    await page.locator('.overview-actions').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.collections.find(item => item.id === 'audit-c')?.description)).toBe('Collection notes at 150%');
    await expect(page.locator('.overview-actions').getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Revert unsaved changes', exact: true })).toBeDisabled();
    await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), 'audit-collection-scaled.png'), animations: 'disabled' });
  });
});

test.describe('Audit followup regressions', () => {
  const collection = { id: 'audit-c', workspaceId: 'workspace-e2e', name: 'Audit' };
  const request = (id: string, name: string, url: string) => ({ id, name, url, collectionId: collection.id, collection: collection.name, requestType: 'http', method: 'GET', auth: { type: 'none' } });

  for (const scale of [1, 1.5]) {
    test(`runs only checked requests after opening the runner from the rail at ${scale}`, async ({ page }) => {
      const requests = ['Alpha', 'Beta'].map(name => ({ ...request(name, name, `https://audit.test/${name}`), method: 'POST' }));
      await installKurloBridge(page, '', 'browser/e2e', false, { collections: [collection], requests, activeId: 'Alpha', openIds: ['Alpha'] });
      await page.addInitScript(value => localStorage.setItem('kurlo.uiScale.v1', String(value)), scale);
      await page.goto('/');
      await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
      await page.getByRole('checkbox', { name: 'Select Beta', exact: true }).uncheck();
      await page.getByRole('button', { name: 'Run 1 request', exact: true }).click();
      await expect.poll(() => page.evaluate(() => Boolean(window.__kurloE2E.store.collectionRuns?.['audit-c']))).toBe(true);
      expect(await page.evaluate(() => window.__kurloE2E.sentRequests.map(sent => sent.url))).toEqual(['https://audit.test/Alpha']);
      await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `audit-runner-subset-${scale}.png`), animations: 'disabled' });
    });

    test(`scrolls both matrix axes over a cell and saves the last value at ${scale}`, async ({ page }) => {
      const environments = Array.from({ length: 16 }, (_, i) => ({ id: `e-${i}`, workspaceId: 'workspace-e2e', name: `Env-${i}`, values: Array.from({ length: 30 }, (_, j) => ({ id: `v-${i}-${j}`, key: `key${j}`, value: `value-${i}-${j}`, enabled: true })) }));
      await installKurloBridge(page, '', 'browser/e2e', false, { environments });
      await page.addInitScript(value => localStorage.setItem('kurlo.uiScale.v1', String(value)), scale);
      await page.setViewportSize({ width: 1120, height: 680 });
      await page.goto('/');
      await page.getByRole('button', { name: 'Environments', exact: true }).click();
      await page.locator('.environment-item-main').filter({ hasText: 'Env-0' }).click();
      await page.getByRole('radio', { name: 'Matrix' }).click();
      await page.getByRole('button', { name: /^Environments \d+ of 16$/ }).click();
      await page.getByRole('button', { name: 'Show all' }).click();
      await page.keyboard.press('Escape');
      const grid = page.locator('.env-matrix-scroll');
      const cell = (await page.getByRole('textbox', { name: 'key0 in Env-0', exact: true }).boundingBox())!;
      const bounds = (await grid.boundingBox())!;
      await page.mouse.move(Math.min(cell.x + cell.width / 2, bounds.x + bounds.width - 10), cell.y + cell.height / 2);
      await page.mouse.wheel(10000, 0);
      await expect.poll(() => grid.evaluate(node => node.scrollLeft)).toBeGreaterThan(1000);
      await page.mouse.wheel(0, 10000);
      await expect.poll(() => grid.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      const last = page.getByRole('textbox', { name: 'key29 in Env-15', exact: true });
      await expect(last).toBeInViewport();
      await last.fill('matrix-edge-saved');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.environments.find(env => env.id === 'e-15')!.values.find(row => row.key === 'key29')!.value)).toBe('matrix-edge-saved');
      await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `audit-matrix-edge-${scale}.png`), animations: 'disabled' });
    });
  }

  test('fills the matrix in the same frame as a wheel scroll across 38 environments', async ({ page }) => {
    const environments = Array.from({ length: 38 }, (_, i) => ({ id: `w-${i}`, workspaceId: 'workspace-e2e', name: i === 0 ? 'big' : `env-${String(i).padStart(2, '0')}`, values: Array.from({ length: 175 }, (_, j) => ({ id: `wv-${i}-${j}`, key: `VAR_${j}`, value: i % 3 === 0 ? `value-${i}-${j}` : '', enabled: true })).filter(row => row.value || i === 0) }));
    await installKurloBridge(page, '', 'browser/e2e', false, { environments, activeEnvironmentId: 'w-0' });
    await page.setViewportSize({ width: 1300, height: 860 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.locator('.environment-item-main').filter({ hasText: 'big' }).click();
    await page.getByRole('radio', { name: 'Matrix' }).click();
    await page.getByRole('button', { name: /^Environments \d+ of 38$/ }).click();
    await page.getByRole('button', { name: 'Show all' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.env-matrix-cell').first()).toBeVisible();
    const log = await page.evaluate(async () => {
      const grid = document.querySelector<HTMLElement>('.env-matrix-scroll')!;
      const holes = () => {
        const box = grid.getBoundingClientRect();
        let count = 0;
        for (let y = box.top + 50; y < box.bottom - 20; y += 23) {
          for (let x = box.left + 20; x < box.right - 20; x += 61) {
            const cell = document.elementFromPoint(x, y)?.closest('.env-matrix-row > span');
            if (!cell) count++;
          }
        }
        return count;
      };
      const steps = [];
      for (const [deltaX, deltaY] of [[0, 900], [700, 0], [3000, 1200], [0, -1800], [-1900, 900], [0, 99999], [99999, 0], [-4000, -3000]]) {
        const event = new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true });
        const before = grid.scrollTop + grid.scrollLeft;
        grid.querySelector('.env-matrix-cell')!.dispatchEvent(event);
        grid.querySelector('.env-matrix-cell')!.dispatchEvent(new WheelEvent('wheel', { deltaX: 10, deltaY: 10, bubbles: true, cancelable: true }));
        steps.push(await new Promise<{ prevented: boolean; moved: boolean; holes: number; cells: number }>(resolve => requestAnimationFrame(() => resolve({
          prevented: event.defaultPrevented,
          moved: grid.scrollTop + grid.scrollLeft !== before,
          holes: holes(),
          cells: document.querySelectorAll('.env-matrix-cell').length,
        }))));
      }
      return steps;
    });
    for (const step of log) {
      expect(step.prevented).toBe(true);
      expect(step.moved).toBe(true);
      expect(step.holes).toBe(0);
      expect(step.cells).toBeLessThan(1000);
    }
    expect(await page.locator('.env-matrix-scroll').evaluate(node => node.scrollTop)).toBeGreaterThan(1000);
  });

  test('keeps every typed character when filling a matrix cell that was not set', async ({ page }) => {
    const environments = ['big', 'empty'].map((name, i) => ({ id: `t-${i}`, workspaceId: 'workspace-e2e', name, values: i === 0 ? [{ id: 'tv-0', key: 'TOKEN', value: 'one', enabled: true }] : [] }));
    await installKurloBridge(page, '', 'browser/e2e', false, { environments, activeEnvironmentId: 't-0' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.locator('.environment-item-main').filter({ hasText: 'big' }).click();
    await page.getByRole('radio', { name: 'Matrix' }).click();
    await page.getByRole('button', { name: 'Set TOKEN in empty', exact: true }).click();
    await page.keyboard.type('typed-by-hand', { delay: 20 });
    const cell = page.getByRole('textbox', { name: 'TOKEN in empty', exact: true });
    await expect(cell).toHaveValue('typed-by-hand');
    await expect(cell).toBeFocused();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.environments.find(env => env.id === 't-1')!.values.find(row => row.key === 'TOKEN')?.value)).toBe('typed-by-hand');
  });

  test('draws only the matrix rows in view and saves a rename when its row scrolls away', async ({ page }) => {
    const environments = Array.from({ length: 6 }, (_, i) => ({ id: `m-${i}`, workspaceId: 'workspace-e2e', name: i === 0 ? 'big' : `env-${i}`, values: i === 0 ? Array.from({ length: 200 }, (_, j) => ({ id: `mv-${j}`, key: `VAR_${j}`, value: `http://20.52.251.237/${j}`, enabled: true })) : [] }));
    await installKurloBridge(page, '', 'browser/e2e', false, { environments, activeEnvironmentId: 'm-0' });
    await page.setViewportSize({ width: 1200, height: 760 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.locator('.environment-item-main').filter({ hasText: 'big' }).click();
    await page.getByRole('radio', { name: 'Matrix' }).click();
    const grid = page.locator('.env-matrix-scroll');
    const rows = page.getByTestId('environment-matrix-row');
    await expect(rows.first()).toHaveAttribute('data-row-key', 'VAR_0');
    expect(await rows.count()).toBeLessThan(60);
    await expect(page.getByRole('button', { name: 'Unset VAR_0 in big', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete VAR_0 from every environment', exact: true })).toHaveCount(1);

    await page.getByLabel('Name of VAR_0', { exact: true }).fill('RENAMED_0');
    await grid.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(page.getByRole('textbox', { name: 'VAR_199 in big', exact: true })).toBeInViewport();
    expect(await rows.count()).toBeLessThan(60);
    await page.waitForTimeout(300);
    expect(await grid.evaluate(node => node.scrollTop)).toBeGreaterThan(5000);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.environments.find(env => env.id === 'm-0')!.values.some(row => row.key === 'RENAMED_0'))).toBe(true);

    await grid.evaluate(node => { node.scrollTop = 0; });
    await expect(page.getByLabel('Name of RENAMED_0', { exact: true })).toBeInViewport();
    expect(await grid.evaluate(node => node.scrollHeight)).toBeGreaterThan(200 * 30);
  });

  test('scrolls request tabs over protocol text and opens the last identity', async ({ page }) => {
    const requests = Array.from({ length: 45 }, (_, i) => request(`r${i}`, `Long tab ${i} Unicode 🚀`, `https://audit.test/${i}`));
    await installKurloBridge(page, '', 'browser/e2e', false, { collections: [collection], requests, activeId: 'r0', openIds: requests.map(req => req.id) });
    await page.goto('/');
    const list = page.locator('.saved-request-tabs');
    const label = (await list.locator('.request-kind-text').first().boundingBox())!;
    await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
    await page.mouse.wheel(10000, 0);
    await expect.poll(() => list.evaluate(node => node.scrollLeft)).toBeGreaterThan(500);
    const last = page.getByRole('tab', { name: /Long tab 44/ });
    await expect(last).toBeInViewport();
    await last.click();
    await expect(page.getByLabel('Request URL')).toHaveValue('https://audit.test/44');
  });

  test('scrolls workspaces over names and selects the final identity', async ({ page }) => {
    const workspaces = Array.from({ length: 15 }, (_, i) => ({ id: i ? `w-${i}` : 'workspace-e2e', name: `Workspace-${String(i).padStart(2, '0')} 日本語` }));
    await installKurloBridge(page, '', 'browser/e2e', false, { workspaces, collections: [], requests: [], environments: [] });
    await page.goto('/');
    await page.getByRole('button', { name: 'Workspace switcher' }).click();
    const menu = page.locator('.workspace-menu');
    const list = menu.locator('.workspace-menu-list');
    const label = (await list.locator('.workspace-menu-select > span:not(.workspace-lock)').nth(2).boundingBox())!;
    await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
    await page.mouse.wheel(0, 10000);
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    const last = menu.getByRole('button', { name: /Workspace-14/ }).first();
    await expect(last).toBeInViewport();
    await last.click();
    await expect(page.getByRole('button', { name: 'Workspace switcher' })).toContainText('Workspace-14');
  });

  for (const kind of ['error', 'sse', 'mcp', 'grpc']) {
    test(`retains a background ${kind} result in its source tab`, async ({ page }) => {
      const source = { ...request('source', 'Source', 'https://audit.test/source'), requestType: kind === 'grpc' || kind === 'mcp' ? kind : 'http', mcpMethod: 'tools/call', mcpName: 'audit', mcpArguments: '{}', grpcMethod: 'audit.Service/Call', bodyContent: '{}' };
      await installKurloBridge(page, '', 'browser/e2e', false, { collections: [collection], requests: [source, request('control', 'Control', 'https://audit.test/control')], activeId: 'source', openIds: ['source', 'control'] });
      await page.addInitScript(kind => {
        const app = (window as E2EWindow).go.api.App;
        const method = kind === 'grpc' ? 'SendGrpcRequest' : kind === 'mcp' ? 'SendMcpRequest' : 'SendRequest';
        type BackgroundRequest = Parameters<E2EAppBridge[typeof method]>[0];
        type BackgroundResponse = Awaited<ReturnType<E2EAppBridge[typeof method]>>;
        const original = app[method] as (sent: BackgroundRequest) => Promise<BackgroundResponse>;
        const gate = { ready: false, done: false, release: () => {} };
        Object.assign(window.__kurloE2E, { followupGate: gate });
        const delayed = async (sent: BackgroundRequest) => {
          let result = await original(sent);
          if (!('url' in sent ? sent.url : sent.target).includes('/source')) return result;
          if (kind === 'error') result = { ...result, statusCode: 0, status: '', body: '', error: 'Error: local connection closed' };
          if (kind === 'sse') result = { ...result, headers: [{ key: 'Content-Type', value: 'text/event-stream', enabled: true }], error: '' };
          return new Promise(resolve => { gate.ready = true; gate.release = () => { gate.done = true; resolve(result); }; });
        };
        Object.assign(app, { [method]: delayed });
      }, kind);
      await page.goto('/');
      await page.locator('.request-bar .btn-send').click();
      await expect.poll(() => page.evaluate(() => window.__kurloE2E.followupGate!.ready)).toBe(true);
      await page.getByRole('tab', { name: 'GET Control', exact: true }).click();
      await page.locator('.request-bar .btn-send').click();
      await page.locator('.response-area').getByRole('tab', { name: 'Body', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Response body', exact: true })).toContainText('/control');
      await page.evaluate(() => window.__kurloE2E.followupGate!.release());
      if (kind === 'sse') await expect.poll(() => page.evaluate(() => window.__kurloE2E.sseConnects.some(call => call.sessionId === 'source'))).toBe(true);
      await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.history.some(entry => entry.sourceRequestId === 'source'))).toBe(true);
      await expect(page.getByRole('textbox', { name: 'Response body', exact: true })).toContainText('/control');
      await page.getByRole('tab', { name: /Source/ }).click();
      if (kind === 'error') await expect(page.locator('.request-error-shell')).toContainText('local connection closed');
      else if (kind === 'sse') await expect(page.locator('.sse-panel')).toBeVisible();
      else if (kind === 'mcp') await expect(page.locator('.mcp-result-panel')).toContainText('It is 21C and clear.');
      else await expect(page.locator('.grpc-response-area')).toContainText('OK');
      await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `audit-background-${kind}-fixed.png`), animations: 'disabled' });
    });
  }
});
