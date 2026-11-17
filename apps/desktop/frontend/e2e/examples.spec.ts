import type { E2EWindow } from './support/bridge';
import { chooseRequestType, collectionRow, fillPrompt } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test } from '@playwright/test';

test.describe("Kurlo desktop browser E2E", () => {
  test('compares a fresh response against a saved example', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const responseStatus = page.locator('.status-badge');
    await expect(responseStatus).toContainText('200 OK');
    await page.getByRole('button', { name: 'Save as example', exact: true }).click();
    await expect(page.locator('.examples-row')).toHaveCount(1);

    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders/moved');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(responseStatus).toContainText('200 OK');

    const diffTab = page.locator('.response-mini-tabs').getByRole('tab', { name: /Diff/ });
    await expect(diffTab).toBeVisible();
    await diffTab.click();

    const picker = page.getByRole('button', { name: /^Compare with/ });
    await expect(picker).toBeVisible();
    await picker.click();
    await page.getByRole('option', { name: '200 OK', exact: true }).click();

    await expect(page.locator('.diff-side-before')).toContainText('200 OK');
    await expect(page.locator('.diff-count-add')).toBeVisible();
    await expect(page.locator('.diff-line.diff-removed').first()).toContainText('/orders');
    await captureDocsScreenshot(page, 'response-diff-example');

    await page.getByRole('button', { name: 'Clear baseline' }).click();
    await expect(page.locator('.diff-side-before')).toContainText('previous');
  });

  test('saves a response as an example, and keeps it in the store', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Get order');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders/8123');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();

    await page.getByRole('button', { name: 'Save as example', exact: true }).click();

    await expect(page.locator('.examples-row')).toHaveCount(1);
    await expect(page.locator('.examples-name')).toHaveText('200 OK');
    await expect(page.locator('.request-editor-tabs-shell').getByRole('tab', { name: /Examples/ })).toContainText('1');

    await expect(page.locator('.examples-meta')).toContainText('/orders/:id');
    await expect(page.locator('.examples-status-input')).toHaveValue('200');
    await captureDocsScreenshot(page, 'examples-panel');

    await page.locator('.response-mini-tabs').getByRole('tab', { name: 'Body' }).click();
    await page.getByRole('button', { name: 'Save as example', exact: true }).click();
    await expect(page.locator('.examples-row')).toHaveCount(2);
    await expect(page.locator('.examples-name').nth(1)).toHaveText('200 OK (2)');

    await page.locator('.examples-row').nth(1).getByRole('button', { name: /^Delete/ }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete example' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.examples-row')).toHaveCount(1);

    const saveButton = page.locator('.save-btn:not(.revert-btn)').first();
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(saveButton).toBeDisabled();
    await expect.poll(async () => {
      const store = await page.evaluate(() => window.__kurloE2E.store as {
        requests: Array<{ url?: string; examples?: Array<{ name: string; response: { statusCode: number } }> }>;
      });
      const saved = store.requests.find(entry => entry.url === 'https://api.kurlo.test/orders/8123');
      return {
        examples: (saved?.examples ?? []).length,
        name: saved?.examples?.[0]?.name ?? '',
        statusCode: saved?.examples?.[0]?.response.statusCode ?? 0,
      };
    }).toEqual({ examples: 1, name: '200 OK', statusCode: 200 });
  });

  test('serves a collection from the mock server panel, and logs what a client asked for', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Get order');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders/8123');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    await page.getByRole('button', { name: 'Save as example', exact: true }).click();
    await expect(page.locator('.examples-row')).toHaveCount(1);
    await page.locator('.save-btn:not(.revert-btn)').first().click();
    await expect(page.locator('.save-btn:not(.revert-btn)').first()).toBeDisabled();

    await page.getByLabel('Mock server', { exact: true }).click();
    const panel = page.locator('section[aria-label="Mock server"]');
    await expect(panel).toBeVisible();

    await panel.locator('.mock-select').getByRole('button').first().click();
    await page.getByRole('option', { name: 'Orders API — 1 example' }).click();
    await expect(panel.locator('.mock-pane-title').first()).toContainText('1');

    await panel.getByRole('button', { name: 'Start server' }).click();
    await expect(panel.locator('.mock-live-label')).toHaveText('Running');
    await expect(panel.locator('.mock-url')).toContainText('http://127.0.0.1:3100');

    await page.evaluate(() => {
      const base = { timestamp: Date.now(), durationMs: 12 };
      window.__kurloE2E.emit('mock:request', {
        ...base,
        id: 'mock-1',
        method: 'GET',
        path: '/orders/8123',
        query: '',
        matched: true,
        exampleId: '',
        exampleName: '200 OK',
        requestName: 'Get order',
        statusCode: 200,
      });
      window.__kurloE2E.emit('mock:request', {
        ...base,
        id: 'mock-2',
        method: 'POST',
        path: '/orders',
        query: '',
        matched: false,
        statusCode: 404,
      });
    });

    const log = panel.locator('.mock-log-row');
    await expect(log).toHaveCount(2);
    await expect(log.first()).toContainText('no example matched');
    await expect(log.last()).toContainText('/orders/8123');
    await captureDocsScreenshot(page, 'mock-server');

    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(panel.locator('.mock-live-label')).toHaveCount(0);
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('StartMockServer')))).toEqual([
      'StartMockServer:Orders API:1',
    ]);
  });

  test('reloads a running mock after an example changes with the panel closed', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Get order');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders/8123');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    await page.getByRole('button', { name: 'Save as example', exact: true }).click();
    await page.locator('.save-btn:not(.revert-btn)').first().click();
    await expect(page.locator('.save-btn:not(.revert-btn)').first()).toBeDisabled();

    await page.getByLabel('Mock server', { exact: true }).click();
    const panel = page.locator('section[aria-label="Mock server"]');
    await panel.locator('.mock-select').getByRole('button').first().click();
    await page.getByRole('option', { name: 'Orders API — 1 example' }).click();
    await panel.getByRole('button', { name: 'Start server' }).click();
    await expect(panel.locator('.mock-live-label')).toHaveText('Running');

    await page.locator('.collection-request').filter({ hasText: 'Get order' }).click();
    await expect(panel).toHaveCount(0);

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Save as example', exact: true }).click();
    await expect(page.locator('.examples-row')).toHaveCount(2);
    await page.locator('.save-btn:not(.revert-btn)').first().click();
    await expect(page.locator('.save-btn:not(.revert-btn)').first()).toBeDisabled();

    await expect
      .poll(() => page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('StartMockServer'))))
      .toEqual(['StartMockServer:Orders API:1', 'StartMockServer:Orders API:2']);
  });
});

test('loads saved examples only when a request or the mock server needs them', async ({ page }) => {
  const lazy = { id: 'lazy-col', workspaceId: 'workspace-e2e', name: 'Lazy API' };
  const example = (id: string, requestId: string, name: string, statusCode: number, path: string) => ({
    id, requestId, name, filesystemName: name, source: 'manual', createdAt: 1,
    snapshot: { method: 'GET', url: `https://api.kurlo.test${path}`, params: [], headers: [], bodyType: 'none', bodyContent: '' },
    response: { statusCode, status: String(statusCode), headers: [], body: `{"name":"${name}"}`, bodyMediaType: 'application/json' },
    match: { pathTemplate: path },
  });
  const request = (id: string, name: string, path: string, examples?: unknown[]) => ({
    id, name, url: `https://api.kurlo.test${path}`, collectionId: lazy.id, collection: lazy.name, requestType: 'http', method: 'GET', auth: { type: 'none' },
    ...(examples ? { examples } : {}),
  });
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [lazy],
    requests: [
      request('plain', 'Plain', '/plain'),
      request('orders', 'Orders', '/orders', [example('ex-ok', 'orders', 'OK', 200, '/orders'), example('ex-missing', 'orders', 'Missing', 404, '/orders')]),
      request('users', 'Users', '/users', [example('ex-users', 'users', 'Users OK', 200, '/users')]),
    ],
    activeId: 'plain',
    openIds: ['plain'],
    folderCollapsed: {},
  });
  await page.addInitScript(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
    const cache: Record<string, unknown[]> = {};
    const lazyState = { loads: [] as string[], payloads: [] as Array<{ requests: Array<Record<string, unknown>> }> };
    (window as unknown as { __lazy: typeof lazyState & { cache: typeof cache } }).__lazy = { ...lazyState, cache };
    const tracked = (window as unknown as { __lazy: typeof lazyState }).__lazy;
    const loadStore = app.LoadRequestStore;
    app.LoadWorkspace = async () => {
      const store = JSON.parse(await loadStore() as string) as { requests: Array<Record<string, unknown>> };
      for (const req of store.requests ?? []) {
        const list = req.examples as unknown[] | undefined;
        if (Array.isArray(list) && list.length) {
          cache[req.id as string] = copy(list);
          req.exampleCount = list.length;
        }
        delete req.examples;
      }
      return { payload: JSON.stringify(store), diagnostics: [] };
    };
    app.LoadRequestExamples = async (ids: unknown) => {
      tracked.loads.push(...(ids as string[]));
      return Object.fromEntries((ids as string[]).map(id => [id, copy(cache[id] ?? [])]));
    };
    const save = app.SaveRequestStoreWithError;
    app.SaveRequestStoreWithError = async (payload: unknown) => {
      const store = JSON.parse(payload as string) as { requests: Array<Record<string, unknown>> };
      tracked.payloads.push(copy(store));
      for (const req of store.requests ?? []) {
        delete req.exampleCount;
        const id = req.id as string;
        if (!('examples' in req)) {
          if (cache[id]) req.examples = copy(cache[id]);
        } else if (Array.isArray(req.examples) && req.examples.length) {
          cache[id] = copy(req.examples);
        } else {
          delete cache[id];
        }
      }
      return save(JSON.stringify(store));
    };
  });
  await page.goto('/');
  const loads = () => page.evaluate(() => (window as unknown as { __lazy: { loads: string[] } }).__lazy.loads);
  const lastPayload = () => page.evaluate(() => {
    const payloads = (window as unknown as { __lazy: { payloads: Array<{ requests: Array<Record<string, unknown>> }> } }).__lazy.payloads;
    return payloads[payloads.length - 1];
  });
  const row = (name: string) => page.locator('.collection-list .collection-request-wrap').filter({ has: page.locator('.collection-title', { hasText: new RegExp(`^${name}$`) }) });
  await expect(row('Orders')).toBeVisible();
  expect(await loads()).toEqual([]);

  await row('Orders').locator('.collection-request').click();
  const examplesTab = page.locator('.request-editor-tabs-shell').getByRole('tab', { name: /Examples/ });
  await expect(examplesTab).toContainText('2');
  await examplesTab.click();
  await expect(page.locator('.examples-row')).toHaveCount(2);
  expect(await loads()).toEqual(['orders']);

  await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders?page=2');
  const saveButton = page.locator('.save-btn:not(.revert-btn)').first();
  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  let payload = await lastPayload();
  const sentOrders = payload.requests.find(req => req.id === 'orders')!;
  const sentUsers = payload.requests.find(req => req.id === 'users')!;
  expect('examples' in sentOrders).toBe(false);
  expect(sentOrders.exampleCount).toBe(2);
  expect('examples' in sentUsers).toBe(false);
  expect(sentUsers.exampleCount).toBe(1);
  await expect.poll(() => page.evaluate(() => {
    const store = window.__kurloE2E.store as { requests: Array<{ id: string; examples?: unknown[] }> };
    return store.requests.find(req => req.id === 'users')?.examples?.length;
  })).toBe(1);

  for (let index = 0; index < 2; index += 1) {
    await page.locator('.examples-row').first().getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog', { name: 'Delete example' }).getByRole('button', { name: 'Delete', exact: true }).click();
  }
  await expect(page.locator('.examples-row')).toHaveCount(0);
  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  payload = await lastPayload();
  expect(payload.requests.find(req => req.id === 'orders')!.examples).toEqual([]);
  expect(await page.evaluate(() => Object.keys((window as unknown as { __lazy: { cache: Record<string, unknown> } }).__lazy.cache))).toEqual(['users']);

  await row('Users').locator('.collection-request').click();
  await expect(examplesTab).toContainText('1');
  await row('Plain').locator('.collection-request').click();
  await page.getByLabel('Request URL').fill('https://api.kurlo.test/plain?v=2');
  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  payload = await lastPayload();
  const resentUsers = payload.requests.find(req => req.id === 'users')!;
  expect('examples' in resentUsers).toBe(false);
  expect(resentUsers.exampleCount).toBe(1);

  const loadsBeforeMock = (await loads()).length;
  await page.getByLabel('Mock server', { exact: true }).click();
  const panel = page.locator('section[aria-label="Mock server"]');
  await panel.locator('.mock-select').getByRole('button').first().click();
  await page.getByRole('option', { name: 'Lazy API — 1 example' }).click();
  await panel.getByRole('button', { name: 'Start server' }).click();
  await expect(panel.locator('.mock-live-label')).toHaveText('Running');
  expect((await loads()).length).toBe(loadsBeforeMock);
  expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('StartMockServer')))).toEqual(['StartMockServer:Lazy API:1']);
});

test('keeps a mock server with thousands of examples to a window of rendered routes', async ({ page }) => {
  const col = { id: 'big-col', workspaceId: 'workspace-e2e', name: 'Big API' };
  const requests = Array.from({ length: 1150 }, (_, r) => ({
    id: `r${r}`, name: `Operation ${r}`, url: `https://api.kurlo.test/v1/things/${r}`, collectionId: col.id, collection: col.name, requestType: 'http', method: 'GET', auth: { type: 'none' },
    examples: [200, 422, 500].map(code => ({
      id: `e${r}-${code}`, requestId: `r${r}`, name: String(code), filesystemName: String(code), source: 'openapi', createdAt: 1,
      snapshot: { method: 'GET', url: `https://api.kurlo.test/v1/things/${r}`, params: [], headers: [], bodyType: 'none', bodyContent: '' },
      response: { statusCode: code, status: String(code), headers: [], body: `{"id":${r}}`, bodyMediaType: 'application/json' },
      match: { pathTemplate: `/v1/things/${r}` },
    })),
  }));
  await installKurloBridge(page, '', 'browser/e2e', false, { collections: [col], requests, activeId: 'r0', openIds: ['r0'], folderCollapsed: {} });
  await page.addInitScript(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const cache: Record<string, unknown[]> = {};
    const gate: { open?: () => void } = {};
    const opened = new Promise<void>(resolve => { gate.open = resolve; });
    (window as unknown as { __openExamples: () => void }).__openExamples = () => gate.open!();
    const loadStore = app.LoadRequestStore;
    app.LoadWorkspace = async () => {
      const store = JSON.parse(await loadStore() as string) as { requests: Array<Record<string, unknown>> };
      for (const req of store.requests ?? []) {
        const list = req.examples as unknown[] | undefined;
        if (Array.isArray(list) && list.length) { cache[req.id as string] = list; req.exampleCount = list.length; }
        delete req.examples;
      }
      return { payload: JSON.stringify(store), diagnostics: [] };
    };
    const loadRoutes = app.LoadMockRoutes;
    app.LoadMockRoutes = async (refs: unknown) => {
      await opened;
      return loadRoutes(refs);
    };
    (window as unknown as { __exampleLoads: string[] }).__exampleLoads = [];
    app.LoadRequestExamples = async (ids: unknown) => {
      (window as unknown as { __exampleLoads: string[] }).__exampleLoads.push(...(ids as string[]));
      return JSON.parse(JSON.stringify(Object.fromEntries((ids as string[]).map(id => [id, cache[id] ?? []]))));
    };
  });
  await page.goto('/');
  await page.getByLabel('Mock server', { exact: true }).click();
  const panel = page.locator('section[aria-label="Mock server"]');
  await expect(panel.locator('.mock-route-list').getByRole('status', { name: 'Loading examples' }).locator('.kurlo-bird-flying')).toBeVisible();
  await expect(panel.locator('.mock-route-list')).toHaveText('');
  await expect(panel.getByText(/Loading|No examples in this collection/)).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __openExamples: () => void }).__openExamples());
  await expect(panel.locator('.mock-count').first()).toHaveText('3450');
  const list = panel.locator('.mock-route-list');
  await expect(list.locator('.mock-group').first()).toHaveText('Operation 0');
  expect(await list.locator('.mock-row').count()).toBeLessThan(300);
  expect(await list.evaluate(node => getComputedStyle(node).zIndex)).toBe('0');
  await expect.poll(async () => {
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    return list.evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight - 1
      && [...node.querySelectorAll('.mock-path')].at(-1)?.textContent);
  }).toBe('/v1/things/1149');
  await expect(list.locator('.mock-group', { hasText: /^Operation 1149$/ })).toBeVisible();
  expect(await list.locator('.mock-row').count()).toBeLessThan(300);
  await panel.getByLabel('Filter routes').fill('things/77');
  await expect(list.locator('.mock-group')).toHaveText(['Operation 77', 'Operation 770', 'Operation 771', 'Operation 772', 'Operation 773', 'Operation 774', 'Operation 775', 'Operation 776', 'Operation 777', 'Operation 778', 'Operation 779']);
  await expect(list.locator('.mock-row')).toHaveCount(33);
  expect(await page.evaluate(() => (window as unknown as { __exampleLoads: string[] }).__exampleLoads.length)).toBeLessThanOrEqual(1);
});

test('keeps the first visible mock route in place when the sidebar slides away and back', async ({ page }) => {
  const col = { id: 'wrap-col', workspaceId: 'workspace-e2e', name: 'Wrap API' };
  const requests = Array.from({ length: 400 }, (_, r) => ({
    id: `r${r}`, name: `Получить результат добавления самозанятого по реквизитам ${r}`, url: `https://api.kurlo.test/v1/self-employed/recipients/${r}`, collectionId: col.id, collection: col.name, requestType: 'http', method: 'GET', auth: { type: 'none' },
    examples: [200, 400, 401, 403, 422, 500].map(code => ({
      id: `e${r}-${code}`, requestId: `r${r}`, name: String(code), filesystemName: String(code), source: 'openapi', createdAt: 1,
      snapshot: { method: 'GET', url: `https://api.kurlo.test/v1/self-employed/recipients/${r}`, params: [], headers: [], bodyType: 'none', bodyContent: '' },
      response: { statusCode: code, status: String(code), headers: [], body: `{"id":${r}}`, bodyMediaType: 'application/json' },
      match: { pathTemplate: `/v1/self-employed/recipients/${r}` },
    })),
  }));
  await installKurloBridge(page, '', 'browser/e2e', false, { collections: [col], requests, activeId: 'r0', openIds: ['r0'], folderCollapsed: {} });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/');
  await page.getByLabel('Mock server', { exact: true }).click();
  const panel = page.locator('section[aria-label="Mock server"]');
  await expect(panel.locator('.mock-count').first()).toHaveText('2400');
  const list = panel.locator('.mock-route-list');
  await list.evaluate(node => { node.scrollTop = node.scrollHeight * 0.4; });
  await page.waitForTimeout(600);
  const firstVisible = () => list.evaluate(node => {
    const top = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll<HTMLElement>('.mock-row')].find(item => item.getBoundingClientRect().top >= top - 0.5)!;
    return { key: `${row.querySelector('.mock-path')!.textContent} ${row.querySelector('.status-badge')!.textContent}`, offset: Math.round(row.getBoundingClientRect().top - top) };
  });
  await expect.poll(() => list.locator('.mock-row-warning').first().evaluate(node => node.getClientRects().length)).toBeGreaterThan(0);
  const before = await firstVisible();
  const slide = () => list.evaluate((node, anchor) => new Promise<{ frames: number; shifts: Array<number | null> }>((resolve) => {
    const row = [...node.querySelectorAll<HTMLElement>('.mock-row')].find(item => `${item.querySelector('.mock-path')!.textContent} ${item.querySelector('.status-badge')!.textContent}` === anchor.key)!;
    const position = row.style.position;
    row.style.position = 'relative';
    const marker = document.createElement('span');
    marker.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
    row.append(marker);
    const shifts: Array<number | null> = [];
    let observer: IntersectionObserver | undefined;
    let height = -1;
    const observe = () => {
      if (height === node.clientHeight) return;
      height = node.clientHeight;
      observer?.disconnect();
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.intersectionRatio < 1) shifts.push(entry.rootBounds ? Math.round(entry.boundingClientRect.top - entry.rootBounds.top - 2.5) : null);
        }
      }, { root: node, rootMargin: `${2.5 - anchor.offset}px 0px ${anchor.offset + 3.5 - height}px 0px`, threshold: 1 });
      observer.observe(marker);
    };
    observe();
    const resize = new ResizeObserver(observe);
    resize.observe(node);
    const started = performance.now();
    let frames = 0;
    const sample = () => {
      frames++;
      if (performance.now() - started > 1500) {
        observer?.disconnect();
        resize.disconnect();
        marker.remove();
        row.style.position = position;
        resolve({ frames, shifts });
      } else requestAnimationFrame(sample);
    };
    document.querySelector<HTMLElement>('[aria-label="Toggle sidebar"]')!.click();
    requestAnimationFrame(sample);
  }), before);
  for (const sample of [await slide(), await slide()]) {
    expect(sample.frames).toBeGreaterThan(20);
    expect(sample.shifts).toEqual([]);
  }
  expect(await firstVisible()).toEqual(before);
});
