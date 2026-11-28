import type { E2EWindow } from './support/bridge';
import { reviewShot } from './support/reviewShot';
import { chooseAppSelect, chooseRequestType, fillCodeEditor } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

import { openRequestWithSavedMessages } from './support/protocols';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test, type Locator } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('creates requests of each protocol without a chooser dialog', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await expect(page.getByRole('dialog', { name: 'New request' })).toHaveCount(0);
    await expect(page.getByLabel('Method and protocol')).toHaveText('GET');

    const palette = page.getByRole('dialog', { name: 'Search requests, chats and commands' });
    const input = palette.getByRole('combobox', { name: 'Search requests, chats and commands' });
    await page.locator('.status-search-btn').click();
    await input.fill('> new websocket');
    await expect(palette.getByRole('option').first()).toHaveAttribute('data-command-id', 'create-request-ws');
    await input.press('Enter');
    await expect(page.getByRole('dialog', { name: 'New request' })).toHaveCount(0);
    await expect(page.getByLabel('Method and protocol')).toHaveText('WS');
  });

  test('sends a WebSocket message with the send shortcut and stays connected', async ({ page }) => {
    await installKurloBridge(page, '', 'windows/e2e');
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'WebSocket Request');
    await page.getByLabel('Request URL').fill('wss://ws.kurlo.test/socket');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.ws-panel')).toContainText('Connected');
    await fillCodeEditor(page, 'websocket-message-editor', JSON.stringify({ hello: 'shortcut' }));
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.ws-message-list')).toContainText('shortcut');
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  });

  test('saves WebSocket messages with the request and sends them again from the menu', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'WebSocket Request');
    await page.getByLabel('Request URL').fill('wss://ws.kurlo.test/socket');

    const savedButton = page.getByRole('button', { name: /^Saved messages/ });
    await fillCodeEditor(page, 'websocket-message-editor', '{"op":"subscribe","channel":"orders"}');
    await savedButton.click();
    const menu = page.getByRole('dialog', { name: 'Saved messages' });
    await expect(menu).toContainText('Save the message in the editor');
    const nameField = menu.getByLabel('Saved message name');
    await expect(nameField).toBeFocused();
    await expect(nameField).toHaveValue('Message 1');
    await nameField.fill('Subscribe orders');
    await nameField.press('Enter');
    await expect(menu.getByRole('button', { name: 'Load Subscribe orders' })).toContainText('{"op":"subscribe","channel":"orders"}');
    await expect(nameField).toHaveValue('Message 2');
    await expect(menu.getByRole('button', { name: 'Send Subscribe orders' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(savedButton).toHaveAccessibleName('Saved messages, 1');

    await fillCodeEditor(page, 'websocket-message-editor', 'ping');
    await savedButton.click();
    await menu.getByLabel('Saved message name').fill('Plain ping');
    await menu.getByRole('button', { name: 'Save current' }).click();
    await menu.getByRole('button', { name: 'Load Subscribe orders' }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('websocket-message-editor').locator('.cm-content')).toHaveText('{"op":"subscribe","channel":"orders"}');

    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.ws-panel')).toContainText('Connected');
    await savedButton.click();
    await captureDocsScreenshot(page, 'websocket-saved-messages');
    await menu.getByRole('button', { name: 'Send Plain ping' }).click();
    await expect(page.locator('.ws-message-list')).toContainText('echo:ping');
    await expect(page.getByTestId('websocket-message-editor').locator('.cm-content')).toHaveText('ping');
    await menu.getByRole('button', { name: 'Delete Plain ping' }).click();
    await expect(menu.getByRole('button', { name: 'Load Plain ping' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click().catch(() => {});
    await expect.poll(async () => page.evaluate(() => {
      const store = window.__kurloE2E.store as { requests?: Array<{ url?: string; savedMessages?: unknown }> };
      return store.requests?.find(request => request.url === 'wss://ws.kurlo.test/socket')?.savedMessages ?? null;
    })).toEqual([{ id: expect.any(String), name: 'Subscribe orders', content: '{"op":"subscribe","channel":"orders"}', bodyType: 'text' }]);
  });

  test('saves a Socket.IO event with its arguments and ack and loads it back', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'Socket.IO Request');
    await page.getByLabel('Request URL').fill('https://io.kurlo.test');
    await page.locator('.sio-event-name-input').fill('room:join');
    await page.getByRole('checkbox', { name: 'Ack' }).check();
    await fillCodeEditor(page, 'socketio-message-editor', '{"room":"orders"}');

    await page.getByRole('button', { name: /^Saved messages/ }).click();
    const menu = page.getByRole('dialog', { name: 'Saved messages' });
    await expect(menu.getByLabel('Saved message name')).toHaveValue('room:join');
    await menu.getByRole('button', { name: 'Save current' }).click();
    await expect(menu.getByRole('button', { name: 'Load room:join' })).toContainText('room:join · 1 arg · ack');
    await page.keyboard.press('Escape');

    await page.locator('.sio-event-name-input').fill('room:leave');
    await page.getByRole('checkbox', { name: 'Ack' }).uncheck();
    await fillCodeEditor(page, 'socketio-message-editor', 'bye');

    await page.getByRole('button', { name: /^Saved messages/ }).click();
    await menu.getByRole('button', { name: 'Load room:join' }).click();
    await expect(page.locator('.sio-event-name-input')).toHaveValue('room:join');
    await expect(page.getByRole('checkbox', { name: 'Ack' })).toBeChecked();
    await expect(page.getByTestId('socketio-message-editor').locator('.cm-content')).toHaveText('{"room":"orders"}');

    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.sio-panel')).toContainText('Connected');
    await page.getByRole('button', { name: /^Saved messages/ }).click();
    await menu.getByRole('button', { name: 'Send room:join' }).click();
    await expect(page.locator('.sio-panel .ws-message-list')).toContainText('ack for "room:join"');
  });

  for (const scale of [1, 1.5]) {
    test(`scrolls through 100 saved messages and stops saving at the limit at ${scale}`, async ({ page }, testInfo) => {
      await page.addInitScript(value => localStorage.setItem('kurlo.uiScale.v1', String(value)), scale);
      await page.setViewportSize({ width: 1100, height: 720 });
      const menu = await openRequestWithSavedMessages(page, 100);
      const list = menu.getByRole('list', { name: 'Saved messages list' });

      await expect(menu.getByRole('button', { name: 'Save current' })).toBeDisabled();
      await expect(menu.getByRole('status').filter({ hasText: 'up to 100 saved messages' })).toBeVisible();
      await expect(list.getByRole('listitem')).toHaveCount(100);
      const geometry = await list.evaluate(node => {
        const menuBox = node.closest('[role="dialog"]')!.getBoundingClientRect();
        return { scrolls: node.scrollHeight > node.clientHeight, sideways: node.scrollWidth > node.clientWidth, fits: menuBox.bottom <= window.innerHeight && menuBox.right <= window.innerWidth };
      });
      expect(geometry).toEqual({ scrolls: true, sideways: false, fits: true });

      const visibleAt = (locator: Locator) => locator.evaluate(node => {
        const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return Boolean(hit && node.contains(hit));
      });
      const trigger = page.getByRole('button', { name: /^Saved messages/ });
      const triggerTop = await trigger.evaluate(node => node.getBoundingClientRect().top);
      expect(await visibleAt(menu.getByRole('button', { name: 'Save current' }))).toBe(true);

      const last = menu.getByRole('button', { name: 'Load Message 100', exact: true });
      await list.hover();
      for (let step = 0; step < 4; step += 1) await page.mouse.wheel(0, 30000);
      await expect.poll(() => list.evaluate(node => Math.ceil(node.scrollTop + node.clientHeight) >= node.scrollHeight)).toBe(true);
      await expect.poll(() => visibleAt(last)).toBe(true);
      expect(await trigger.evaluate(node => node.getBoundingClientRect().top)).toBe(triggerTop);
      expect(await visibleAt(menu.getByRole('searchbox', { name: 'Search saved messages' }))).toBe(true);
      await reviewShot(page, { path: join(tmpdir(), `kurlo-saved-messages-100-${scale}-${testInfo.project.name}.png`), animations: 'disabled' });

      await menu.getByRole('searchbox', { name: 'Search saved messages' }).fill('orders-42"');
      await expect(list.getByRole('listitem')).toHaveCount(1);
      await expect(menu.getByRole('button', { name: 'Load Message 42', exact: true })).toBeVisible();
      await menu.getByRole('searchbox', { name: 'Search saved messages' }).fill('nothing-like-this');
      await expect(menu).toContainText('No saved message matches “nothing-like-this”.');
      await menu.getByRole('searchbox', { name: 'Search saved messages' }).fill('');

      await menu.getByRole('button', { name: 'Delete Message 7', exact: true }).click();
      await expect(menu.getByRole('button', { name: 'Save current' })).toBeEnabled();
      await expect(menu.getByRole('status').filter({ hasText: 'up to 100 saved messages' })).toHaveCount(0);

      await menu.getByRole('button', { name: 'Load Message 100', exact: true }).click();
      await expect(page.getByTestId('websocket-message-editor').locator('.cm-content')).toHaveText('{"op":"subscribe","channel":"orders-100"}');
    });
  }

  test('keeps long saved messages inside the menu without sideways scrolling', async ({ page }, testInfo) => {
    const savedMessages = Array.from({ length: 12 }, (_, index) => ({
      id: `long-${index}`,
      name: index % 2 ? `Echo order ${index} for the warehouse in the northern distribution region` : `Echo order ${index}`,
      content: JSON.stringify({ type: 'order', id: index, items: [{ sku: `SKU-${index}`, qty: 2 }], total: index * 3.75, note: 'x'.repeat(200) }),
      bodyType: 'json',
    }));
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-ws', workspaceId: 'workspace-e2e', name: 'Test' }],
      requests: [{ id: 'ws-echo', collectionId: 'col-ws', collection: 'Test', name: 'WS echo', requestType: 'ws', method: 'GET', url: 'ws://localhost:4567/ws', auth: { type: 'none' }, savedMessages }],
      activeId: 'ws-echo',
      openIds: ['ws-echo'],
    });
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: /^Saved messages/ }).click();
    const menu = page.getByRole('dialog', { name: 'Saved messages' });
    const list = menu.getByRole('list', { name: 'Saved messages list' });
    await expect(list.getByRole('listitem')).toHaveCount(12);
    const layout = await list.evaluate(node => {
      const rows = [...node.querySelectorAll('li')].map(item => {
        const load = item.querySelector('.saved-messages-load')!.getBoundingClientRect();
        const actions = [...item.querySelectorAll('button:not(.saved-messages-load)')].map(button => button.getBoundingClientRect());
        const texts = [...item.querySelectorAll('.saved-messages-item-name, .saved-messages-item-hint')].map(span => span.getBoundingClientRect());
        return { textInside: texts.every(text => text.right <= load.right + 0.5), actionsAfter: actions.every(action => action.left >= load.right - 0.5) };
      });
      return { sideways: node.scrollWidth > node.clientWidth, rows: rows.every(row => row.textInside && row.actionsAfter) };
    });
    expect(layout).toEqual({ sideways: false, rows: true });
    await expect(menu.getByRole('button', { name: /^Load Echo order 1 for the warehouse/ })).toHaveAttribute('title', /northern distribution region/);
    await reviewShot(page, { path: join(tmpdir(), `kurlo-saved-messages-long-${testInfo.project.name}.png`), animations: 'disabled' });
  });

  test('shows the first 100 of a longer saved message list and finds the rest by search', async ({ page }) => {
    const menu = await openRequestWithSavedMessages(page, 120);
    const list = menu.getByRole('list', { name: 'Saved messages list' });
    await expect(list.getByRole('listitem')).toHaveCount(100);
    await expect(menu).toContainText('20 more not shown. Search to find them.');
    await menu.getByRole('searchbox', { name: 'Search saved messages' }).fill('orders-115"');
    await expect(menu.getByRole('button', { name: 'Load Message 115', exact: true })).toBeVisible();
  });

  test('emits a Socket.IO event without arguments when the message is empty', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'Socket.IO Request');
    await page.getByLabel('Request URL').fill('https://io.kurlo.test');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.sio-panel')).toContainText('Connected');

    await page.locator('.sio-event-name-input').fill('ping');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await fillCodeEditor(page, 'socketio-message-editor', '"fast"');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect.poll(() => page.evaluate(() => window.__kurloE2E.socketIOEmits.map(entry => (entry.message as { args: string[] }).args))).toEqual([[], ['"fast"']]);
    await expect(page.locator('.sio-panel .ws-message-list')).toContainText('"fast"');
  });

  test('shows skipped gRPC requests without an unknown or sent status', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      activeId: 'grpc-skipped', openIds: ['grpc-skipped'],
      collections: [{ id: 'col-grpc-skip', workspaceId: 'workspace-e2e', name: 'gRPC API' }],
      requests: [{ id: 'grpc-skipped', collectionId: 'col-grpc-skip', name: 'Skipped call', requestType: 'grpc', method: 'POST', url: 'grpc.kurlo.test:443', grpcMethod: 'greeter.Greeter/Hello' }],
    });
    await page.goto('/');
    await page.evaluate(() => {
      (window as E2EWindow).go.api.App.SendGrpcRequest = async () => ({
        grpcCode: '', grpcMessage: '', status: '', headers: [], trailers: [], messages: [], body: '', duration: 0, size: 0,
        skipped: true, skipReason: 'Skipped by pre-request script', preRequestResult: { tests: [], logs: [] }, testResult: { tests: [], logs: [] },
      });
    });
    await page.getByRole('button', { name: 'Invoke', exact: true }).click();
    await expect(page.locator('.status-badge')).toHaveText('SKIPPED');
    await expect(page.locator('.response-status-bar')).toContainText('Skipped by pre-request script');
    await expect(page.getByText('Request skipped before sending', { exact: true })).toBeVisible();
    await reviewShot(page, { path: join(tmpdir(), 'kurlo-grpc-skipped.png'), animations: 'disabled' });
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.store.history as Array<{ status: string }>)[0]?.status)).toBe('SKIPPED');
  });

  test('shows HTTP methods and other protocols side by side in the method menu', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await page.getByLabel('Method and protocol').click();
    const groups = page.locator('.method-menu-group');
    await expect(groups).toHaveCount(2);
    const [http, other] = [await groups.first().boundingBox(), await groups.last().boundingBox()];
    expect(other!.x).toBeGreaterThan(http!.x + http!.width - 2);
    expect(Math.abs(other!.y - http!.y)).toBeLessThan(2);
    await page.getByRole('option', { name: 'AI', exact: true }).click();
    await expect(page.getByLabel('Provider base URL')).toBeVisible();
  });

  test('discovers an MCP server, calls a tool, and keeps the raw exchange', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'MCP Request');
    await page.getByLabel('Request URL').fill('https://mcp.kurlo.test/mcp');

    await page.getByLabel('Request URL').press('Tab');

    const discover = page.locator('.mcp-discover');
    await expect(discover).toBeEnabled();
    await discover.click();

    await expect(page.locator('.mcp-server')).toContainText('E2E Weather');
    await expect(page.locator('.mcp-server')).toContainText('1 tool');

    await chooseAppSelect(page, page.locator('.mcp-select').first(), 'tools/call');
    await chooseAppSelect(page, page.locator('.mcp-select').nth(1), 'Weather lookup');
    await expect(page.locator('.mcp-editor')).toContainText('location');

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.mcp-result-panel')).toContainText('It is 21C and clear.');
    await captureDocsScreenshot(page, 'request-mcp');

    await page.getByRole('tab', { name: 'Raw exchange' }).click();
    await expect(page.locator('.mcp-code')).toContainText('jsonrpc');

    const sent = await page.evaluate(() => window.__kurloE2E.sentMcpRequests.map(r => r.mcpMethod));
    expect(sent).toEqual(['server/discover', 'tools/list', 'tools/call']);
  });

  test('names the MCP revision of a server that needs a session', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'MCP Request');
    await page.getByLabel('Request URL').fill('https://legacy.kurlo.test/mcp');
    await page.getByLabel('Request URL').press('Tab');
    await page.locator('.mcp-discover').click();

    await expect(page.locator('.mcp-server')).toContainText('E2E Legacy');
    await expect(page.locator('.mcp-server')).toContainText('MCP 2025-06-18');
    if (process.env.KURLO_E2E_SHOT) await page.locator('.mcp-call').screenshot({ path: process.env.KURLO_E2E_SHOT });

    await page.getByLabel('Request URL').fill('https://mcp.kurlo.test/mcp');
    await page.getByLabel('Request URL').press('Tab');
    await page.locator('.mcp-discover').click();
    await expect(page.locator('.mcp-server')).toContainText('E2E Weather');
    await expect(page.locator('.mcp-server')).not.toContainText('MCP 2026');
  });
});

test.describe('Protocol badge', () => {
  test('stays as narrow as its label after the request is created', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const request = (id: string, requestType: string, url: string, method = 'GET') => ({ id, name: id, collectionId: 'collection-ef', collection: 'EF', folderPath: [], requestType, method, url });
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-ef', workspaceId: 'workspace-e2e', name: 'EF', filesystemName: 'EF' }];
      store.requests = [
        request('http', 'http', 'https://api.example.test/'),
        request('ws', 'ws', 'wss://echo.websocket.org'),
        request('gql', 'graphql', 'https://countries.trevorblades.com/', 'POST'),
        request('sio', 'socketio', 'https://api.example.test/'),
      ];
      store.activeId = 'http';
      store.openIds = ['http', 'ws', 'gql', 'sio'];
    });
    await page.goto('/');
    const widths: Record<string, number> = {};
    for (const id of ['http', 'ws', 'gql', 'sio']) {
      await page.getByRole('tab', { name: new RegExp(`\\b${id}$`) }).first().click();
      const trigger = page.getByRole('button', { name: 'Method and protocol' });
      await expect(trigger).toBeVisible();
      widths[id] = Math.round((await trigger.boundingBox())!.width);
    }
    await page.getByRole('tab', { name: /\bws$/ }).first().click();
    for (const type of ['WebSocket', 'Socket.IO', 'GraphQL']) {
      await page.getByLabel('New unsaved request').click();
      await chooseRequestType(page, type);
      const trigger = page.getByRole('button', { name: 'Method and protocol' });
      widths[`${type} draft`] = Math.round((await trigger.boundingBox())!.width);
      await page.getByLabel('Request URL').fill(type === 'WebSocket' ? 'wss://echo.websocket.org' : 'https://api.example.test/');
      widths[`${type} with url`] = Math.round((await trigger.boundingBox())!.width);
    }
    for (const [label, width] of Object.entries(widths)) expect(width, label).toBeLessThanOrEqual(widths.http + 32);
    expect(widths.ws, 'the WS picker leaves room for the URL').toBeLessThanOrEqual(78);
  });
});

test.describe('GraphQL explorer', () => {
  test('keeps every field row whole when the schema does not fit', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const fields = [
        'continent(code: ID!): Continent',
        'continents(filter: ContinentFilterInput = {}): [Continent!]!',
        'countries(filter: CountryFilterInput = {}): [Country!]!',
        'country(code: ID!): Country',
        'language(code: ID!): Language',
        'languages(filter: LanguageFilterInput = {}): [Language!]!',
        ...Array.from({ length: 14 }, (_, index) => `extra${index}(id: ID!, first: Int = 10, after: String): [Country!]!`),
        'ordersByCustomerAndWarehouseAndRegionWithPaginationAndFilters(customerId: ID!, warehouseId: ID!, region: String, first: Int = 10, after: String, filter: String): [CountryConnectionPayloadWithPagination!]!',
      ];
      const schema = `type Query {\n  ${fields.join('\n  ')}\n}\ntype Continent { code: ID! }\ntype Country { code: ID! }\ntype Language { code: ID! }`;
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-ef', workspaceId: 'workspace-e2e', name: 'EF', filesystemName: 'EF' }];
      store.requests = [{
        id: 'req-countries', name: 'New Request', collectionId: 'collection-ef', collection: 'EF', folderPath: [],
        requestType: 'graphql', method: 'POST', url: 'https://countries.trevorblades.com/', requestTab: 'query',
        bodyType: 'graphql', bodyContent: JSON.stringify({ query: 'query {\n  continents {\n    code\n  }\n}', variables: {} }),
        graphqlSchema: schema,
      }];
      store.activeId = 'req-countries';
      store.openIds = ['req-countries'];
    });
    await page.setViewportSize({ width: 1100, height: 640 });
    await page.goto('/');

    const rows = page.locator('.graphql-explorer-field');
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBe(21);
    const layout = await rows.evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect();
      const args = button.querySelector('.graphql-field-args')?.getBoundingClientRect();
      const textRight = Math.max(...[...button.querySelectorAll('span')].map(span => span.getBoundingClientRect().right));
      return { top: box.top, bottom: box.bottom, argsBottom: args?.bottom ?? box.top, textInside: textRight <= box.right + 0.5 };
    }));
    expect(layout.filter(row => !row.textInside), 'field text stays inside its row').toEqual([]);
    for (let index = 0; index < layout.length; index += 1) {
      expect(layout[index].argsBottom, `arguments of row ${index} stay inside it`).toBeLessThanOrEqual(layout[index].bottom + 0.5);
      if (index) expect(layout[index].top, `row ${index} starts below row ${index - 1}`).toBeGreaterThanOrEqual(layout[index - 1].bottom - 0.5);
    }
    const clipped = await page.locator('.graphql-field-args, .graphql-field-name, .graphql-field-type').evaluateAll(elements => elements
      .filter(element => element.scrollHeight > element.clientHeight + 1)
      .map(element => `${element.className}: ${element.clientHeight}px of ${element.scrollHeight}px, line-height ${getComputedStyle(element).lineHeight}`));
    expect(clipped, 'text lines are not cut vertically').toEqual([]);
    const list = page.locator('.graphql-explorer-list');
    expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await list.evaluate(element => element.scrollWidth > element.clientWidth), 'the field list does not scroll sideways').toBe(false);
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await reviewShot(page, { path: join(tmpdir(), `kurlo-graphql-explorer-long-${test.info().project.name}.png`), animations: 'disabled' });
  });
});

for (const protocol of [
  { requestType: 'http', method: 'GET' },
  { requestType: 'http', method: 'SSE' },
  { requestType: 'graphql', method: 'POST' },
  { requestType: 'ai', method: 'POST' },
  { requestType: 'mcp', method: 'POST' },
  { requestType: 'grpc', method: 'POST' },
  { requestType: 'ws', method: 'GET' },
  { requestType: 'socketio', method: 'GET' },
  { requestType: 'kafka', method: 'GET' },
  { requestType: 'mqtt', method: 'GET' },
]) {
  test(`shows each request section once for ${protocol.requestType} ${protocol.method}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 2800, height: 900 });
    await installKurloBridge(page, '', 'browser/e2e', false, {
      activeId: 'req-tabs',
      openIds: ['req-tabs'],
      requests: [{ id: 'req-tabs', collectionId: '', name: 'Sections test', ...protocol, url: '', requestTab: 'vars' }],
    });
    await page.goto('/');
    const shell = page.locator('.request-editor-tabs-shell');
    await expect(shell).toBeVisible();
    await expect(shell).not.toHaveClass(/compact/);
    const tabs = shell.getByRole('tab');
    const labels = await tabs.allTextContents();
    expect(labels.length).toBeGreaterThan(4);
    expect(new Set(labels).size).toBe(labels.length);
    await expect(shell.getByRole('tab', { name: 'Vars', exact: true })).toHaveCount(1);
    await expect(shell.getByRole('tab', { name: 'Vars', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.setViewportSize({ width: 600, height: 700 });
    await expect(shell).toHaveClass(/compact/);
    await page.getByRole('button', { name: 'Request section', exact: true }).click();
    const sections = page.getByRole('listbox', { name: 'Request sections' });
    await expect(sections.getByRole('option', { name: 'Vars', exact: true, selected: true })).toHaveCount(1);
    const compactLabels = await sections.getByRole('option').allTextContents();
    expect(compactLabels.length).toBe(labels.length);
    expect(new Set(compactLabels).size).toBe(compactLabels.length);
    await reviewShot(page, { path: join(tmpdir(), `kurlo-sections-${protocol.requestType}-${protocol.method}-${testInfo.project.name}.png`), animations: 'disabled' });
    await sections.getByRole('option', { name: 'Vars', exact: true, selected: true }).click();
    await expect(page.getByRole('button', { name: 'Request section', exact: true })).toContainText('Vars');
  });
}

test('inherits collection auth in a gRPC request', async ({ page }) => {
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{
      id: 'col-grpc-auth', workspaceId: 'workspace-e2e', name: 'gRPC API',
      defaults: { headers: [], variables: [], auth: { type: 'bearer', bearerToken: 'collection-token' }, preRequestScriptJs: '', testScriptJs: '', settings: {} },
    }],
    requests: [{
      id: 'grpc-auth', collectionId: 'col-grpc-auth', collection: 'gRPC API', name: 'Inventory', folderPath: [],
      requestType: 'grpc', method: 'POST', url: 'grpc.kurlo.test:443', grpcMethod: 'shop.Inventory/GetItem', auth: { type: 'inherit' },
    }],
    activeId: 'grpc-auth', openIds: ['grpc-auth'],
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /^Authorization/ }).click();
  await expect(page.getByRole('button', { name: 'Auth type' })).toHaveText('Inherit auth');
  await page.getByRole('button', { name: 'Invoke', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const sent = window.__kurloE2E.sentGrpcRequests.at(-1) as { auth?: { type?: string; token?: string } } | undefined;
    return sent && { type: sent.auth?.type, token: sent.auth?.token };
  })).toEqual({ type: 'bearer', token: 'collection-token' });
});

test('keeps Inherit auth when an HTTP request is switched to gRPC', async ({ page }) => {
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'col-switch', workspaceId: 'workspace-e2e', name: 'Switch API' }],
    requests: [{ id: 'req-switch', collectionId: 'col-switch', collection: 'Switch API', name: 'Switch', folderPath: [], requestType: 'http', method: 'GET', url: '', auth: { type: 'inherit' } }],
    activeId: 'req-switch', openIds: ['req-switch'],
  });
  await page.goto('/');
  await page.getByLabel('Method and protocol').click();
  await page.getByRole('option', { name: 'gRPC', exact: true }).click();
  await page.getByRole('tab', { name: /^Authorization/ }).click();
  await expect(page.getByRole('button', { name: 'Auth type' })).toHaveText('Inherit auth');
});

test('sends the client certificate with a gRPC call', async ({ page }) => {
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'col-grpc-mtls', workspaceId: 'workspace-e2e', name: 'gRPC API' }],
    requests: [{
      id: 'grpc-mtls', collectionId: 'col-grpc-mtls', collection: 'gRPC API', name: 'Secure call', folderPath: [],
      requestType: 'grpc', method: 'POST', url: 'grpcs://grpc.kurlo.test:443', grpcMethod: 'shop.Inventory/GetItem',
    }],
    activeId: 'grpc-mtls', openIds: ['grpc-mtls'],
  });
  await page.goto('/');
  await page.evaluate(() => {
    (window as E2EWindow).go.api.App.OpenFileDialog = async (title: string) => (title.includes('key') ? '/certs/client.key' : '/certs/client.crt');
  });
  await page.getByRole('tab', { name: /^Settings/ }).click();
  const certSetting = page.locator('.client-cert-setting');
  await expect(certSetting).toContainText('Client certificate (mTLS)');
  await expect(certSetting.getByRole('button', { name: 'Choose file…' }).nth(1)).toBeDisabled();
  await certSetting.getByRole('button', { name: 'Choose file…' }).first().click();
  await expect(certSetting.getByRole('textbox', { name: 'Client certificate path' })).toHaveValue('/certs/client.crt');
  await certSetting.getByRole('button', { name: 'Choose file…' }).nth(1).click();
  await expect(certSetting.getByRole('textbox', { name: 'Private key path' })).toHaveValue('/certs/client.key');
  await certSetting.getByPlaceholder('Leave blank if the key is unencrypted').fill('{{keyPassword}}');
  await reviewShot(page, { path: join(tmpdir(), 'kurlo-grpc-client-cert.png'), animations: 'disabled' });

  await page.getByRole('button', { name: 'Invoke', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const sent = window.__kurloE2E.sentGrpcRequests.at(-1) as { clientCertPath?: string; clientKeyPath?: string; clientKeyPassword?: string } | undefined;
    return sent && { cert: sent.clientCertPath, key: sent.clientKeyPath, password: sent.clientKeyPassword };
  })).toEqual({ cert: '/certs/client.crt', key: '/certs/client.key', password: '{{keyPassword}}' });
});

test('persists a PFX container and passphrase for gRPC without a separate key', async ({ page }) => {
  if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'pfx-api', workspaceId: 'workspace-e2e', name: 'PFX API' }],
    requests: [{ id: 'pfx-call', collectionId: 'pfx-api', name: 'PFX call', requestType: 'grpc', method: 'POST', url: 'grpcs://grpc.kurlo.test:443', grpcMethod: 'shop.Inventory/GetItem' }],
    activeId: 'pfx-call', openIds: ['pfx-call'],
  });
  await page.goto('/');
  await page.evaluate(() => { (window as E2EWindow).go.api.App.OpenFileDialog = async () => '/certs/client.pfx'; });
  await page.getByRole('tab', { name: /^Settings/ }).click();
  const certSetting = page.locator('.client-cert-setting');
  await certSetting.getByRole('button', { name: 'Choose file…' }).first().click();
  await certSetting.getByPlaceholder('Leave blank if the key is unencrypted').fill('{{pfxPassword}}');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.__kurloE2E.store.requests as Array<{ settings?: { clientCertPath?: string; clientKeyPassword?: string } }>)[0]?.settings)).toMatchObject({ clientCertPath: '/certs/client.pfx', clientKeyPassword: '{{pfxPassword}}' });
  const saved = await page.evaluate(() => window.__kurloE2E.store);
  await page.addInitScript(store => { window.__kurloE2E.store = store; }, saved);
  await page.reload();
  await page.getByRole('tab', { name: /^Settings/ }).click();
  await expect(certSetting.getByRole('textbox', { name: 'Client certificate path' })).toHaveValue('/certs/client.pfx');
  await expect(certSetting.getByPlaceholder('Leave blank if the key is unencrypted')).toHaveValue('{{pfxPassword}}');
  await certSetting.scrollIntoViewIfNeeded();
  if (docsScreenshotDir) await certSetting.screenshot({ path: join(docsScreenshotDir, 'client-certificate-pfx.png'), animations: 'disabled' });
  await reviewShot(page, { path: join(tmpdir(), 'kurlo-pfx-client-cert.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Invoke', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const sent = window.__kurloE2E.sentGrpcRequests.at(-1) as { clientCertPath?: string; clientKeyPath?: string; clientKeyPassword?: string } | undefined;
    return sent && { cert: sent.clientCertPath, key: sent.clientKeyPath || '', password: sent.clientKeyPassword };
  })).toEqual({ cert: '/certs/client.pfx', key: '', password: '{{pfxPassword}}' });
});

test('builds and sends a nested GraphQL operation from live introspection', async ({ page }) => {
  const { startCatalogServer } = await import('./support/graphqlCatalog');
  const { server, url } = await startCatalogServer();
  try {
    await installKurloBridge(page, '', 'windows/e2e', false, {
      collections: [{ id: 'books', name: 'Library', workspaceId: 'workspace-e2e' }],
      requests: [{ id: 'catalog', name: 'Book catalog', collectionId: 'books', collection: 'Library',
        requestType: 'graphql', method: 'POST', url, requestTab: 'query', bodyType: 'graphql',
        bodyContent: JSON.stringify({ query: 'query BookDetails {\n  __typename\n}', variables: {} }) }],
      activeId: 'catalog', openIds: ['catalog'],
    });
    await page.setViewportSize({ width: 1440, height: 1020 });
    await page.goto('/');
    await page.exposeFunction('executeCatalogPayload', async (body: string) => {
      const result = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
      return result.text();
    });
    await page.evaluate(() => {
      const app = (window as unknown as E2EWindow).go.api.App;
      const send = app.SendRequest;
      const transport = window as unknown as { executeCatalogPayload: (body: string) => Promise<string> };
      app.SendRequest = async request => {
        const result = await send(request);
        const body = await transport.executeCatalogPayload(window.__kurloE2E.sentRequests.at(-1)!.body);
        return { ...result, body, size: body.length, preRequestResult: { logs: [], tests: [] }, testResult: { logs: [], tests: [] } };
      };
    });
    await page.getByRole('button', { name: 'Show the response below the request' }).click();
    await page.getByRole('button', { name: 'Use GraphQL introspection' }).click();
    const check = (name: string) => page.getByRole('checkbox', { name, exact: true });
    await check('book').check();
    await expect(page.getByLabel('Argument id')).toHaveValue('$id');
    await check('title').check();
    await check('year').check();
    await check('author').check();
    await check('name').check();
    await page.getByLabel('Edit variable $id').click();
    await fillCodeEditor(page, 'graphql-variables-editor', '{\n  "id": "1"\n}');
    await page.getByRole('button', { name: 'Query', exact: true }).click();
    await expect(page.locator('.response-body-viewer')).toContainText('A Wizard of Earthsea');
    await expect(page.locator('.response-body-viewer')).toContainText('Ursula K. Le Guin');
    const divider = await page.getByRole('button', { name: 'Resize panels' }).boundingBox();
    if (!divider) throw Error('Missing response divider');
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
    await page.mouse.down();
    await page.mouse.move(divider.x + divider.width / 2, 686, { steps: 8 });
    await page.mouse.up();
    await captureDocsScreenshot(page, 'graphql-builder-variables');
    await page.getByRole('button', { name: 'Query editor', exact: true }).click();
    await expect(page.getByTestId('graphql-query-editor')).toContainText('book(id: $id)');
    if (docsScreenshotDir) {
      await page.locator('.graphql-query-grid').screenshot({ path: join(docsScreenshotDir, 'graphql-query-builder.png'), animations: 'disabled' });
    }

    const input = page.getByLabel('Argument id', { exact: true });
    await input.fill('"3"');
    await input.press('Enter');
    await expect(page.getByTestId('graphql-query-editor')).toContainText('book(id: "3")');
    await page.getByRole('button', { name: 'Query', exact: true }).click();
    await expect(page.locator('.response-body-viewer')).toContainText('Kindred');
    await input.press('Control+s');
    await expect.poll(() => page.evaluate(() => JSON.parse(window.__kurloE2E.store.requests[0].bodyContent))).toMatchObject({ variables: {}, query: expect.stringContaining('book(id: "3")') });
    await fillCodeEditor(page, 'graphql-query-editor', 'query Catalog { books { title } }');
    await expect(check('book')).not.toBeChecked();
    await page.getByRole('button', { name: 'Collapse book', exact: true }).click();
    await expect(check('books')).toBeChecked();
    await page.getByRole('button', { name: 'Expand books', exact: true }).click();
    await page.getByLabel('Use variable for limit').click();
    await expect(page.getByLabel('Argument limit')).toHaveValue('$limit');
    await expect(page.getByTestId('graphql-query-editor')).toContainText('$limit: Int');
    await page.getByLabel('Edit variable $limit').click();
    await fillCodeEditor(page, 'graphql-variables-editor', '{"limit": 2}');
    await page.getByRole('button', { name: 'Query', exact: true }).click();
    await expect(page.locator('.response-body-viewer')).toContainText('The Tombs of Atuan');
    await expect(page.locator('.response-body-viewer')).not.toContainText('Kindred');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
