import { chooseRequestType, collectionRow, fillCodeEditor } from './support/actions';

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

  test('shows the send shortcut on GraphQL Query and runs it from the editor on macOS', async ({ page }) => {
    await installKurloBridge(page, '', 'darwin/e2e');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'GraphQL Request');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/graphql');
    const query = page.getByRole('button', { name: 'Query', exact: true });
    await expect(query.locator('kbd')).toHaveText('⌘↵');
    await expect(query.locator('kbd')).toBeVisible();
    await query.screenshot({ path: join(tmpdir(), 'kurlo-graphql-query-shortcut.png') });
    await page.getByTestId('graphql-query-editor').locator('.cm-content').press('Meta+Enter');
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.at(-1)?.url)).toBe('https://api.kurlo.test/graphql');
  });

  for (const scenario of [
    { type: 'http', action: 'Send', url: 'https://api.kurlo.test/slow?ms=4000', calls: 'sentRequests' },
    { type: 'grpc', action: 'Invoke', url: 'grpc.kurlo.test:443', calls: 'sentGrpcRequests' },
    { type: 'mcp', action: 'Send', url: 'https://mcp.kurlo.test/mcp', calls: 'sentMcpRequests' },
    { type: 'ai', action: 'Send', url: 'https://ai.kurlo.test/v1/chat/completions', calls: 'sentAiRequests' },
    { type: 'sse', action: 'Connect', url: 'https://api.kurlo.test/events', calls: 'sseConnects' },
  ] as const) {
    test(`shows and runs the primary shortcut for ${scenario.type} on macOS`, async ({ page }) => {
      await installKurloBridge(page, '', 'darwin/e2e', false, {
        activeId: 'shortcut', openIds: ['shortcut'],
        requests: [{
          id: 'shortcut', name: 'Shortcut test', collectionId: '', url: scenario.url,
          requestType: scenario.type === 'sse' ? 'http' : scenario.type,
          method: scenario.type === 'sse' ? 'SSE' : 'POST', requestTab: 'body',
          grpcMethod: 'shop.Inventory/GetItem', bodyContent: '{}',
          aiModel: 'test-model', aiPrompt: 'Hello', aiProvider: 'openai',
        }],
      });
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto('/');
      const primary = page.locator('.request-composer .btn-send');
      await expect(primary).toHaveAccessibleName(scenario.action);
      await expect(primary.locator('kbd')).toHaveText('⌘↵');
      await expect(primary.locator('kbd')).toBeVisible();
      if (scenario.type === 'grpc') {
        await primary.screenshot({ path: join(tmpdir(), 'kurlo-grpc-invoke-shortcut.png') });
        await page.getByTestId('grpc-message-editor').locator('.cm-content').press('Meta+Enter');
      } else {
        await primary.press('Meta+Enter');
      }
      if (scenario.type === 'http') {
        await expect(primary).toHaveAccessibleName('Cancel');
        await expect(primary.locator('kbd')).toHaveText('esc');
        await page.keyboard.press('Escape');
        await expect(primary).toHaveAccessibleName('Send');
        await expect(page.getByText('Request canceled')).toBeVisible();
      } else {
        await expect.poll(() => page.evaluate(key => window.__kurloE2E[key].length, scenario.calls)).toBe(1);
      }
      if (scenario.type === 'sse') {
        await expect(primary).toHaveAccessibleName('Disconnect');
        await expect(primary.locator('kbd')).toBeVisible();
        await primary.press('Meta+Enter');
        await expect(primary).toHaveAccessibleName('Connect');
      }
    });
  }

  for (const socket of [
    { type: 'WebSocket Request', editor: 'websocket-message-editor', url: 'wss://ws.kurlo.test/socket' },
    { type: 'Socket.IO Request', editor: 'socketio-message-editor', url: 'https://io.kurlo.test' },
  ]) {
    test(`connects, sends and disconnects ${socket.type} by shortcut on macOS`, async ({ page }) => {
      await installKurloBridge(page, '', 'darwin/e2e');
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto('/');
      await page.getByLabel('New unsaved request').click();
      await chooseRequestType(page, socket.type);
      const url = page.getByLabel('Request URL');
      await url.fill(socket.url);
      const connect = page.locator('.request-composer .btn-send');
      const send = page.locator('.ws-message-send');
      const isWebSocket = socket.type === 'WebSocket Request';
      if (!isWebSocket) await page.getByPlaceholder('Event name').fill('greeting');
      await fillCodeEditor(page, socket.editor, '"hello"');
      await expect(connect).toHaveAccessibleName('Connect');
      await expect(connect.locator('kbd')).toBeVisible();
      await expect(send).toBeDisabled();
      await page.keyboard.press('Meta+Enter');
      await expect(connect).toHaveAccessibleName('Disconnect');
      await expect(connect.locator('kbd')).toBeHidden();
      await expect(send.locator('kbd')).toBeVisible();
      await expect(send.locator('kbd')).toHaveText('⌘↵');
      await page.keyboard.press('Meta+Enter');
      if (isWebSocket) {
        await expect.poll(() => page.evaluate(() => window.__kurloE2E.webSocketMessages.map(m => m.message.data))).toEqual(['"hello"']);
        await send.screenshot({ path: join(tmpdir(), 'kurlo-websocket-send-shortcut.png') });
      } else {
        await expect.poll(() => page.evaluate(() => window.__kurloE2E.socketIOEmits.map(m => [m.message.eventName, m.message.args]))).toEqual([['greeting', ['"hello"']]]);
      }
      await url.focus();
      await expect(connect.locator('kbd')).toBeVisible();
      await expect(send.locator('kbd')).toBeHidden();
      if (isWebSocket) await connect.screenshot({ path: join(tmpdir(), 'kurlo-websocket-disconnect-shortcut.png') });
      await page.keyboard.press('Meta+Enter');
      await expect(connect).toHaveAccessibleName('Connect');
      await expect(send).toBeDisabled();
    });
  }

  test('uses the rebound shortcut for both WebSocket actions', async ({ page }) => {
    await installKurloBridge(page, '', 'darwin/e2e');
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'WebSocket Request');
    await page.getByLabel('Request URL').fill('wss://ws.kurlo.test/socket');
    await page.getByRole('button', { name: /^Settings/ }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
    const row = settings.locator('.shortcut-row').filter({ has: page.getByText('Send request', { exact: true }) });
    await row.locator('.shortcut-combo').click();
    await page.keyboard.press('Meta+Shift+Enter');
    const label = await row.locator('.keycaps').getAttribute('aria-label');
    expect(label).toContain('⇧');
    await page.keyboard.press('Escape');
    const connect = page.locator('.request-composer .btn-send');
    await expect(connect.locator('kbd')).toHaveText(label!);
    await fillCodeEditor(page, 'websocket-message-editor', 'hello');
    await page.keyboard.press('Meta+Shift+Enter');
    await expect(connect).toHaveAccessibleName('Disconnect');
    await expect(page.locator('.ws-message-send kbd')).toHaveText(label!);
    await page.keyboard.press('Meta+Shift+Enter');
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.webSocketMessages.map(m => m.message.data))).toEqual(['hello']);
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
