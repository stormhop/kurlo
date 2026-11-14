import type { E2EWindow } from './support/bridge';
import { chooseRequestType, collectionRow, fillPrompt } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test } from '@playwright/test';

import { readFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('renders an ordinary JSON response without virtualization', async ({ page }) => {
    const ordinaryResponsePath = process.env.KURLO_E2E_ORDINARY_RESPONSE_PATH;
    const responseBody = ordinaryResponsePath
      ? await readFile(ordinaryResponsePath, 'utf8')
      : JSON.stringify({
        resources: Array.from({ length: 60 }, (_, index) => ({
          id: `resource-${index}`,
          title: `exampleEditForAutotest-${index}`,
          path: `widget-kind/resource-${index}.json`,
        })),
      }, null, 2);
    const formattedResponseBody = JSON.stringify(JSON.parse(responseBody), null, 2);
    expect(formattedResponseBody.split('\n').length).toBeGreaterThan(250);

    await installKurloBridge(page, responseBody);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).not.toHaveAttribute('data-virtualized', 'true');
    await expect(viewer.locator('.response-line')).toHaveCount(formattedResponseBody.split('\n').length);
    await viewer.evaluate((element) => {
      for (const top of [400, 1_200, 2_400, 4_000, 1_600]) {
        element.scrollTop = top;
        element.dispatchEvent(new Event('scroll'));
      }
    });
    await expect(viewer.locator('.response-line-no')).toHaveCount(formattedResponseBody.split('\n').length);
  });

  test('virtualizes a large JSON response while scrolling', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    const realResponsePath = process.env.KURLO_E2E_REAL_RESPONSE_PATH;
    const realResponseBody = realResponsePath ? await readFile(realResponsePath, 'utf8') : '';
    await installKurloBridge(page, realResponseBody);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await expect(page.getByLabel('Request URL')).toBeVisible();
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toHaveAttribute('data-virtualized', 'true');
    const renderedLines = viewer.locator('.response-line');
    await expect(renderedLines).not.toHaveCount(0);
    expect(await renderedLines.count()).toBeLessThan(200);
    const gutter = viewer.locator('.response-gutter');
    expect(await gutter.evaluate(element => getComputedStyle(element).position)).toBe('sticky');
    await captureDocsScreenshot(page, 'response-viewer-large-body');

    await viewer.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => Number(
      await renderedLines.first().getAttribute('data-line-number'),
    )).toBeGreaterThan(1_000);
    expect(await renderedLines.count()).toBeLessThan(200);
    const firstGutterNumber = gutter.locator('.response-line-no').first();
    expect(await firstGutterNumber.getAttribute('data-line-number')).toBe(await renderedLines.first().getAttribute('data-line-number'));
    const gutterLeft = await firstGutterNumber.evaluate(
      element => Math.round(element.getBoundingClientRect().left),
    );
    await viewer.evaluate((element) => {
      element.scrollLeft = 240;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => firstGutterNumber.evaluate(
      element => Math.round(element.getBoundingClientRect().left),
    )).toBe(gutterLeft);


    await page.getByLabel('Search response').click();
    const realCategoryName = realResponseBody
      ? (JSON.parse(realResponseBody) as { Categories?: Array<{ Name?: unknown }> }).Categories?.[0]?.Name
      : undefined;
    const uniqueQuery = realResponseBody ? JSON.stringify(realCategoryName) : 'Product 10-3"';
    await page.getByLabel('Search response body').fill(uniqueQuery);
    await expect(page.locator('.response-search-count')).toHaveText('1/1');
    await expect(viewer.locator('.rsp-search-current')).toContainText(uniqueQuery);
    await expect.poll(async () => Number(
      await renderedLines.first().getAttribute('data-line-number'),
    )).toBeLessThan(1_000);
    expect(await renderedLines.count()).toBeLessThan(200);
  });

  test('filters a JSON response with JSONPath and jq-style paths', async ({ page }) => {
    const body = JSON.stringify({
      items: [
        { id: 'ord-1', total: 12, status: 'paid' },
        { id: 'ord-2', total: 48, status: 'open' },
        { id: 'ord-3', total: 99, status: 'paid' },
      ],
      meta: { page: 1 },
    });
    await installKurloBridge(page, body);
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Clipboard is not available')) } }));
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    const filterButton = page.getByRole('button', { name: 'Filter response', exact: true });
    await filterButton.click();
    const filter = page.getByLabel('Filter response with JSONPath');
    await expect(filter).toBeFocused();

    await filter.fill("$.items[?(@.status == 'paid')].id");
    await expect(page.locator('.response-filter-status')).toHaveText('2 matches');
    await expect(viewer).toContainText('"ord-1"');
    await expect(viewer).toContainText('"ord-3"');
    await expect(viewer).not.toContainText('ord-2');
    await captureDocsScreenshot(page, 'response-viewer-filter');

    await page.getByRole('button', { name: 'Search response', exact: true }).click();
    await page.getByLabel('Search response body').fill('ord-');
    await expect(page.locator('.response-search-count')).toHaveText('1/2');
    await page.getByRole('button', { name: 'Search response', exact: true }).click();

    await filter.fill('.meta.page');
    await expect(page.locator('.response-filter-status')).toHaveText('1 match');
    await expect(viewer.locator('.response-line')).toHaveCount(1);
    await expect(viewer).toHaveText(/1$/);

    await filter.fill('$.items[0');
    await expect(page.locator('.response-filter-status')).toHaveText('Missing "]" (at character 10)');
    await expect(filter).toHaveAttribute('aria-invalid', 'true');
    const dangerColor = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--danger)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect.poll(() => page.locator('.response-filter-field').evaluate(element => getComputedStyle(element).borderTopColor)).toBe(dangerColor);
    await expect(viewer).toContainText('ord-2');

    await filter.fill('$.items[?(@.total > 500)]');
    await expect(page.getByText('Nothing matches this filter')).toBeVisible();

    await filter.fill('$.items[-1].id');
    await page.getByRole('button', { name: 'Copy response', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('clipboard:')))).toEqual([`clipboard:${'"ord-3"'.length}`]);

    await filter.press('Escape');
    await expect(filter).toHaveCount(0);
    await expect(viewer).toContainText('ord-2');
    await expect(filterButton).toHaveAttribute('aria-pressed', 'false');
  });

  test('keeps a large response painted while its scrollbar is dragged', async ({ page }) => {
    const photos = JSON.stringify(Array.from({ length: 5_000 }, (_, index) => ({
      albumId: Math.floor(index / 50) + 1,
      id: index + 1,
      title: `photo ${index + 1}`,
      url: `https://via.placeholder.com/600/${index}`,
      thumbnailUrl: `https://via.placeholder.com/150/${index}`,
    })), null, 2);
    await installKurloBridge(page, photos);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toHaveAttribute('data-virtualized', 'true');
    const thumb = page.locator('.response-vscroll-thumb');
    await expect(thumb).toBeVisible();
    expect(await viewer.evaluate(element => (element as HTMLElement).offsetWidth - element.clientWidth)).toBe(0);

    const drag = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.response-body-viewer.virtualized')!;
      const handle = document.querySelector<HTMLElement>('.response-vscroll-thumb')!;
      const viewerRect = scroller.getBoundingClientRect();
      const handleRect = handle.getBoundingClientRect();
      const x = handleRect.left + handleRect.width / 2;
      let y = handleRect.top + 4;
      const pointer = { bubbles: true, pointerId: 7, isPrimary: true, clientX: x };
      handle.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, button: 0, clientY: y }));
      let blankSteps = 0;
      const steps = 40;
      for (let step = 0; step < steps; step += 1) {
        y += (viewerRect.height - handleRect.height) / steps;
        handle.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientY: y }));
        const probe = viewerRect.top + viewerRect.height / 2;
        const covered = Array.from(scroller.querySelectorAll<HTMLElement>('.response-virtual-code .response-line')).some((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top <= probe && rect.bottom > probe;
        });
        if (!covered) blankSteps += 1;
      }
      handle.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientY: y }));
      return { blankSteps, top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight };
    });
    expect(drag.blankSteps).toBe(0);
    expect(drag.top).toBeGreaterThan(drag.max * 0.9);

    const owned = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.response-body-viewer.virtualized')!;
      const viewerRect = scroller.getBoundingClientRect();
      const coveredAt = (selector: string, y: number) => Array.from(scroller.querySelectorAll<HTMLElement>(selector)).some((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top <= y && rect.bottom > y;
      });
      const painted = () => {
        const probes = [viewerRect.top + viewerRect.height / 2, viewerRect.bottom - 30];
        return probes.every(y => coveredAt('.response-virtual-code .response-line', y) && coveredAt('.response-gutter .response-line-no', y));
      };
      let blank = 0;
      let slowest = 0;
      const timed = (fire: () => void) => {
        const started = performance.now();
        fire();
        slowest = Math.max(slowest, performance.now() - started);
        if (!painted()) blank += 1;
      };
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
      for (let step = 0; step < 30; step += 1) {
        timed(() => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 3_000, bubbles: true, cancelable: true })));
      }
      const afterWheel = scroller.scrollTop;
      const key = (init: KeyboardEventInit) => timed(() => scroller.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
      key({ key: 'Home' });
      const afterHome = scroller.scrollTop;
      key({ key: 'End' });
      const afterEnd = scroller.scrollTop;
      key({ key: 'ArrowUp', metaKey: true });
      key({ key: 'ArrowDown', metaKey: true });
      const afterCommandDown = scroller.scrollTop;
      key({ key: 'PageUp' });
      const afterPageUp = scroller.scrollTop;
      return { blank, slowest, afterWheel, afterHome, afterEnd, afterCommandDown, afterPageUp, max: scroller.scrollHeight - scroller.clientHeight, page: scroller.clientHeight };
    });
    expect(owned.blank).toBe(0);
    expect(owned.afterWheel).toBe(90_000);
    expect(owned.afterHome).toBe(0);
    expect(owned.afterEnd).toBe(owned.max);
    expect(owned.afterCommandDown).toBe(owned.max);
    expect(owned.max - owned.afterPageUp).toBeGreaterThan(owned.page / 2);
    console.log(`slowest synchronous scroll render: ${owned.slowest.toFixed(1)} ms`);

    await viewer.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => (await thumb.boundingBox())?.y ?? 0).toBeLessThan((await viewer.boundingBox())!.y + 4);
    const start = (await thumb.boundingBox())!;
    const viewerBox = (await viewer.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + 4);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2, viewerBox.y + viewerBox.height + 40, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => Number(
      await viewer.locator('.response-virtual-code .response-line').last().getAttribute('data-line-number'),
    )).toBe(photos.split('\n').length);

    await page.mouse.move(start.x + start.width / 2, viewerBox.y + 10);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => viewer.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThanOrEqual(300);
  });

  test('keeps sidebar arrow shortcuts out of the response body and dialogs', async ({ page }) => {
    const photos = JSON.stringify(Array.from({ length: 5_000 }, (_, index) => ({ id: index + 1, title: `photo ${index + 1}` })), null, 2);
    await installKurloBridge(page, photos);
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    for (const name of ['First', 'Second']) {
      await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
      await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
      await chooseRequestType(page, 'HTTP Request');
      await page.getByLabel('Request name').fill(name);
      await page.getByLabel('Request name').press('Enter');
      await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
    }
    await page.locator('.collection-request').filter({ hasText: 'First' }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    const activeTab = page.locator('.saved-request-tab.active');
    await expect(activeTab).toContainText('First');

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toHaveAttribute('data-virtualized', 'true');
    await viewer.click();
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => viewer.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowLeft');
    await expect(activeTab).toContainText('First');
    await expect(viewer).toBeVisible();

    await page.getByLabel('Settings', { exact: true }).click();
    const settingsTheme = page.getByRole('tab', { name: 'Appearance', exact: true });
    await settingsTheme.click();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('tab', { name: 'Proxy', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByLabel('Close settings').click();
    await expect(activeTab).toContainText('First');
  });

  test('pins the line numbers while a wide virtualized response scrolls', async ({ page }) => {
    const wideBody = JSON.stringify(Array.from({ length: 1_500 }, (_, index) => ({
      id: index,
      payload: `row-${index}-`.padEnd(2_000, 'x'),
    })), null, 2);
    await installKurloBridge(page, wideBody);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toHaveAttribute('data-virtualized', 'true');
    const gutter = viewer.locator('.response-gutter');
    const gutterLeft = await gutter.evaluate(element => Math.round(element.getBoundingClientRect().left));

    await viewer.evaluate((element) => {
      element.scrollTop = 20_000;
      element.scrollLeft = 900;
      element.dispatchEvent(new Event('scroll'));
    });
    expect(await viewer.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await expect.poll(async () => Number(
      await viewer.locator('.response-line').first().getAttribute('data-line-number'),
    )).toBeGreaterThan(500);

    expect(await gutter.evaluate(element => Math.round(element.getBoundingClientRect().left))).toBe(gutterLeft);
    const alignment = await viewer.evaluate((element) => {
      const numbers = Array.from(element.querySelectorAll<HTMLElement>('.response-gutter .response-line-no'));
      const rows = Array.from(element.querySelectorAll<HTMLElement>('.response-virtual-code .response-line'));
      const viewerRect = element.getBoundingClientRect();
      const probeY = viewerRect.top + viewerRect.height / 2;
      const number = numbers.find(node => {
        const rect = node.getBoundingClientRect();
        return rect.top <= probeY && rect.bottom > probeY;
      });
      const row = rows.find(node => node.dataset.lineNumber === number?.dataset.lineNumber);
      const hit = document.elementFromPoint(viewerRect.left + 20, probeY);
      return {
        sameCount: numbers.length === rows.length,
        offset: number && row ? Math.abs(number.getBoundingClientRect().top - row.getBoundingClientRect().top) : -1,
        gutterOnTop: Boolean(hit?.closest('.response-gutter')),
      };
    });
    expect(alignment.sameCount).toBe(true);
    expect(alignment.offset).toBeGreaterThanOrEqual(0);
    expect(alignment.offset).toBeLessThan(1);
    expect(alignment.gutterOnTop).toBe(true);
  });

  test('keeps wrapped response lines inside the viewer gutter', async ({ page }) => {
    const nestedPackage = JSON.stringify({
      name: '@kurlo/factory',
      title: 'Release validation package for a frontend factory workspace',
      scripts: {
        'lint:fix': './node_modules/.bin/lint-fix',
        validate: './node_modules/.bin/configurator validate',
      },
      version: '16.7.0-rc.16',
      description: 'Contains schema definitions for frontend release validation',
      dependencies: {
        '@kurlo/factory': '>=16.7.0-rc.0 <17.0.0',
        '@kurlo-uiremote/chat': '~16.5.0',
        '@kurlo-uiremote/calendar': '~16.6.1',
      },
    }, null, 2);
    const responseBody = JSON.stringify({ content: nestedPackage }, null, 2);
    await installKurloBridge(page, responseBody);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/large-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).not.toHaveAttribute('data-virtualized', 'true');
    const wrappedLine = viewer.locator('.response-line[data-line-number="2"]');
    await expect(wrappedLine).toBeVisible();
    await wrappedLine.hover();

    const metrics = await wrappedLine.evaluate((line) => {
      const viewerNode = line.closest('.response-body-viewer') as HTMLElement;
      const gutterNode = line.querySelector('.response-line-no') as HTMLElement;
      const lineRect = line.getBoundingClientRect();
      const gutterRect = gutterNode.getBoundingClientRect();
      return {
        clientWidth: viewerNode.clientWidth,
        gutterHeight: gutterRect.height,
        lineHeight: lineRect.height,
        scrollWidth: viewerNode.scrollWidth,
      };
    });

    expect(metrics.lineHeight).toBeGreaterThan(40);
    expect(Math.abs(metrics.gutterHeight - metrics.lineHeight)).toBeLessThan(1);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });

  test('keeps a response selection inside the body when a warning sits above it', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false);
    await page.goto('/');
    await page.evaluate(() => {
      (window as E2EWindow).go.api.App.SendRequest = async () => {
        const body = '{"type":"parseQuery","text":"hello"}\n{"type":"error","message":"free tier"}\n';
        return {
          statusCode: 200, status: '200 OK', headers: [{ key: 'content-type', value: 'application/x-ndjson' }], body, duration: 12, size: body.length,
          warnings: ['Replaced by the Auth tab: Authorization. The value in the Headers tab was not sent.'],
          preRequestResult: { tests: [], logs: [] }, testResult: { tests: [], logs: [] },
        };
      };
    });
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/chat');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    const warning = page.locator('.response-warning');
    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(warning).toBeVisible();
    const selected = () => page.evaluate(() => window.getSelection()?.toString() ?? '');

    await warning.click();
    await page.keyboard.press('ControlOrMeta+a');
    expect(await selected()).toContain('free tier');
    expect(await selected()).not.toContain('Replaced by the Auth tab');

    await page.locator('.response-status-bar').getByText('200 OK').click();
    await page.keyboard.press('ControlOrMeta+a');
    expect(await selected()).not.toContain('Replaced by the Auth tab');

    const lastLine = viewer.locator('.response-line[data-line-number="2"] .response-line-code');
    const lineBox = (await lastLine.boundingBox())!;
    const warningBox = (await warning.boundingBox())!;
    await page.mouse.move(lineBox.x + lineBox.width - 4, lineBox.y + lineBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(warningBox.x + 20, warningBox.y + warningBox.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await selected()).toContain('parseQuery');
    expect(await selected()).not.toContain('Replaced by the Auth tab');
    await page.screenshot({ path: join(tmpdir(), 'kurlo-response-selection-warning.png'), animations: 'disabled' });
  });

  test('switches the response beside the request from the status bar', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 780 });
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await expect(page.locator('.request-split')).not.toHaveClass(/split-right/);
    await page.getByRole('button', { name: 'Show the response beside the request' }).click();
    await expect(page.locator('.request-split')).toHaveClass(/split-right/);
    const divider = await page.getByRole('button', { name: 'Resize panels' }).boundingBox();
    const editor = await page.locator('.request-editor').boundingBox();
    const response = await page.locator('.request-split > :last-child').boundingBox();
    expect(divider!.width).toBeLessThanOrEqual(1.5);
    expect(Math.abs(editor!.x + editor!.width - divider!.x)).toBeLessThan(1);
    expect(Math.abs(response!.x - (divider!.x + divider!.width))).toBeLessThan(1);
    const before = editor!.width;
    await page.mouse.move(divider!.x + 3, divider!.y + 200);
    await page.mouse.down();
    await page.mouse.move(divider!.x + 83, divider!.y + 200, { steps: 6 });
    await page.mouse.up();
    expect((await page.locator('.request-editor').boundingBox())!.width).toBeGreaterThan(before + 40);
    await page.getByRole('button', { name: 'Show the response below the request' }).click();
    await expect(page.locator('.request-split')).not.toHaveClass(/split-right/);
  });
});

test.describe('Binary responses', () => {
  test('keeps a binary body out of the window and saves it from Go', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/binary-response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText('This response is binary')).toBeVisible();
    await expect(page.getByText('Response body is empty')).toHaveCount(0);
    await expect(page.getByText('application/zip, 100.00 MB.', { exact: false })).toBeVisible();
    await page.locator('.response-binary-actions').getByRole('button', { name: 'Save to file' }).click();
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.calls as string[]).filter(call => call.startsWith('SaveResponseBody:')))).toHaveLength(1);
    const calls = await page.evaluate(() => window.__kurloE2E.calls as string[]);
    expect(calls.some(call => call === 'SaveFileDialog')).toBe(false);
  });
});

test.describe('Huge responses', () => {
  test('pages a 100 MB text response without freezing the window', async ({ page }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/huge-response');
    const started = Date.now();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible({ timeout: 60_000 });
    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer.locator('.response-line').first()).toBeVisible({ timeout: 60_000 });
    const shownMs = Date.now() - started;

    await expect(page.getByText('Large response preview')).toBeVisible();
    expect(await viewer.locator('.response-line').count()).toBeLessThan(200);

    const pageStarted = Date.now();
    await page.getByLabel('Next response page').click();
    await expect(page.locator('.response-page-count')).toHaveText(/^2\//);
    await expect(viewer.locator('.response-line').first()).toBeVisible();
    const nextPageMs = Date.now() - pageStarted;

    const probe = await page.evaluate(() => {
      const started = performance.now();
      return new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - started), 0));
    });

    console.log(`huge response: shown ${shownMs}ms, next page ${nextPageMs}ms, event loop delay ${Math.round(probe)}ms`);
    expect(pageErrors).toEqual([]);
    expect(shownMs).toBeLessThan(15_000);
    expect(nextPageMs).toBeLessThan(2_000);
  });
});
