import { expect, test, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installKurloBridge, type E2EWindow } from './support/bridge';
import { chooseRequestSection, collectionRow, folderRow, fillCodeEditor } from './support/actions';
import { captureDocsScreenshot } from './support/screenshots';
import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

const collection = { id: 'tabs-collection', workspaceId: 'workspace-e2e', name: 'Tab requests' };
const requests = ['One', 'Two', 'Three', 'Four'].map(name => ({
  id: name.toLowerCase(), name, collectionId: collection.id, collection: collection.name,
  requestType: 'http', method: 'GET', url: `https://example.test/${name.toLowerCase()}`, auth: { type: 'none' },
}));

async function start(page: Page, preview = true, autosave = false, protocol = 'http') {
  const savedRequests = requests.map(request => request.id !== 'two' ? request : {
    ...request,
    requestType: protocol === 'sse' ? 'http' : protocol,
    method: protocol === 'sse' ? 'SSE' : protocol === 'grpc' ? 'POST' : 'GET',
    url: protocol === 'ws' ? 'wss://example.test/two' : protocol === 'grpc' ? 'grpc.kurlo.test:443' : request.url,
    ...(protocol === 'grpc' ? { grpcMethod: 'greeter.Greeter/Hello' } : {}),
  });
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [collection], requests: savedRequests, activeId: 'one', openIds: ['one'],
  });
  await page.addInitScript(({ preview, autosave }) => {
    localStorage.setItem('kurlo.previewTabs.v1', String(preview));
    localStorage.setItem('kurlo.autosave.v1', String(autosave));
  }, { preview, autosave });
  await page.goto('/');
  await expect(page.getByLabel('Request URL')).toHaveValue(requests[0].url);
}

async function openRequest(page: Page, name: string) {
  await page.locator('.collection-list .collection-request').filter({ hasText: name }).click();
  await expect(page.locator('.saved-request-tab.active .tab-title')).toHaveText(name);
}

const requestTabs = (page: Page) => page.locator('.saved-request-tabs .saved-request-tab:not(.overview-request-tab) .tab-title');

test('switches preview tabs in General and filters the setting through search', async ({ page }) => {
  if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
  await start(page, false);
  await openRequest(page, 'Two');
  await expect(requestTabs(page)).toHaveText(['One', 'Two']);
  await page.getByLabel('Settings', { exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('radiogroup', { name: 'Script engine' })).toHaveCount(0);
  const toggle = settings.getByRole('checkbox', { name: 'Preview tabs', exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.locator('..').click();
  await expect(toggle).toBeChecked();
  await settings.screenshot({ path: join(tmpdir(), 'kurlo-preview-tabs-general.png'), animations: 'disabled' });
  await captureDocsScreenshot(page, 'settings-general');
  await settings.getByLabel('Search settings').fill('preview');
  await expect(toggle).toBeVisible();
  await expect(settings.getByText('On launch', { exact: true })).toHaveCount(0);
  await settings.getByLabel('Close settings').click();
  await openRequest(page, 'Three');
  await openRequest(page, 'Four');
  await expect(requestTabs(page)).toHaveText(['One', 'Two', 'Four']);
  await page.getByLabel('Settings', { exact: true }).click();
  await toggle.locator('..').click();
  await settings.getByLabel('Close settings').click();
  await expect(page.locator('.saved-request-tab.preview')).toHaveCount(0);
  await openRequest(page, 'Three');
  await expect(requestTabs(page)).toHaveText(['One', 'Two', 'Four', 'Three']);
});

test('replaces preview tabs, retains tab order and keeps a tab after double click', async ({ page }) => {
  await start(page);
  await openRequest(page, 'Two');
  await expect(page.locator('.saved-request-tab.preview .tab-title')).toHaveCSS('font-style', 'italic');
  await page.locator('.saved-request-tabs').getByRole('tab', { name: 'GET One', exact: true }).click();
  await openRequest(page, 'Three');
  await expect(requestTabs(page)).toHaveText(['One', 'Three']);
  await page.locator('.saved-request-tab.preview').getByRole('tab').dblclick();
  await expect(page.locator('.saved-request-tab.preview')).toHaveCount(0);
  await openRequest(page, 'Two');
  await expect(requestTabs(page)).toHaveText(['One', 'Three', 'Two']);
  await openRequest(page, 'Three');
  await expect(page.locator('.saved-request-tab.preview .tab-title')).toHaveText('Two');
  await openRequest(page, 'Four');
  await expect(requestTabs(page)).toHaveText(['One', 'Three', 'Four']);
  await page.screenshot({ path: join(tmpdir(), 'kurlo-preview-tabs-strip.png'), animations: 'disabled' });
});

for (const autosave of [false, true]) {
  test(`keeps edited preview tabs with ${autosave ? 'autosave' : 'manual save'} and preserves their values`, async ({ page }) => {
    await start(page, true, autosave);
    await openRequest(page, 'Two');
    await page.getByLabel('Request URL').fill('https://edited.test/two');
    await expect(page.locator('.saved-request-tab.preview')).toHaveCount(0);
    if (autosave) {
      await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.find(request => request.id === 'two')?.url)).toBe('https://edited.test/two');
    }
    await openRequest(page, 'Three');
    await expect(requestTabs(page)).toHaveText(['One', 'Two', 'Three']);
    await openRequest(page, 'Two');
    await expect(page.getByLabel('Request URL')).toHaveValue('https://edited.test/two');
    if (!autosave) {
      await expect(page.locator('.saved-request-tab.active')).toHaveClass(/dirty/);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.find(request => request.id === 'two')?.url)).toBe('https://edited.test/two');
    }
  });
}

test('keeps new drafts alongside a replaceable preview and clears closed previews', async ({ page }) => {
  await start(page);
  await openRequest(page, 'Two');
  await page.getByLabel('New unsaved request').click();
  await expect(page.locator('.saved-request-tab.active')).toHaveClass(/draft/);
  await openRequest(page, 'Three');
  await expect(requestTabs(page)).toHaveText(['One', 'Three', 'New Request']);
  const preview = page.locator('.saved-request-tab.preview');
  await preview.hover();
  await preview.getByLabel('Close tab').click();
  await expect(page.locator('.saved-request-tab.preview')).toHaveCount(0);
  await openRequest(page, 'Four');
  await expect(requestTabs(page)).toHaveText(['One', 'New Request', 'Four']);
});

for (const protocol of ['ws', 'socketio', 'sse']) {
  test(`keeps a preview with an active ${protocol} connection`, async ({ page }) => {
    await start(page, true, false, protocol);
    await openRequest(page, 'Two');
    await expect(page.locator('.saved-request-tab.preview .tab-title')).toHaveText('Two');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
    await expect(page.locator('.saved-request-tab.preview')).toHaveCount(0);
    await openRequest(page, 'Three');
    await expect(requestTabs(page)).toHaveText(['One', 'Two', 'Three']);
    await openRequest(page, 'Two');
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
    const connectCount = await page.evaluate(protocol => {
      const state = window.__kurloE2E;
      return (protocol === 'ws' ? state.webSocketConnects : protocol === 'sse' ? state.sseConnects : state.socketIOConnects).length;
    }, protocol);
    expect(connectCount).toBe(1);
  });
}

for (const protocol of ['http', 'grpc']) {
  test(`keeps a preview when its ${protocol} request is running in the background`, async ({ page }) => {
    await start(page, true, false, protocol);
    await page.evaluate(protocol => {
      const app = (window as E2EWindow).go.api.App;
      const wait = () => new Promise<void>(resolve => {
        window.__kurloE2E.responseGate = { ready: true, release: resolve };
      });
      if (protocol === 'http') {
        const send = app.SendRequest;
        app.SendRequest = async request => { await wait(); return await send(request); };
      } else {
        const send = app.SendGrpcRequest;
        app.SendGrpcRequest = async request => { await wait(); return await send(request); };
      }
    }, protocol);
    await openRequest(page, 'Two');
    await expect(page.locator('.saved-request-tab.preview .tab-title')).toHaveText('Two');
    await page.getByRole('button', { name: protocol === 'http' ? 'Send' : 'Invoke', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.responseGate?.ready)).toBe(true);
    await expect(page.locator('.saved-request-tab.preview')).toHaveCount(0);
    await openRequest(page, 'Three');
    await expect(requestTabs(page)).toHaveText(['One', 'Two', 'Three']);
    await page.evaluate(() => window.__kurloE2E.responseGate?.release());
    await openRequest(page, 'Two');
    await expect(page.locator('.response-status-bar .status-badge')).toContainText(protocol === 'http' ? '200' : 'OK');
  });
}

test('restores the preview preference and identity after a restart', async ({ page }) => {
  await start(page);
  await page.addInitScript(() => {
    const snapshot = sessionStorage.getItem('preview-tabs-restart');
    if (!snapshot) return;
    const { store, previewTabs, previewRequest } = JSON.parse(snapshot);
    window.__kurloE2E.store = store;
    localStorage.setItem('kurlo.previewTabs.v1', previewTabs);
    if (previewRequest) localStorage.setItem('kurlo.previewRequest.v1', previewRequest);
  });
  await openRequest(page, 'Two');
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.openIds)).toEqual(['one', 'two']);
  await page.evaluate(() => sessionStorage.setItem('preview-tabs-restart', JSON.stringify({
    store: window.__kurloE2E.store,
    previewTabs: localStorage.getItem('kurlo.previewTabs.v1'),
    previewRequest: localStorage.getItem('kurlo.previewRequest.v1'),
  })));
  await page.reload();
  await expect(page.locator('.saved-request-tab.preview .tab-title')).toHaveText('Two');
  await openRequest(page, 'Three');
  await expect(requestTabs(page)).toHaveText(['One', 'Three']);
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.openIds)).toEqual(['one', 'three']);
});


test('script editors fill resized panels and scroll throughout the available area', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await start(page, false);
  await page.getByRole('button', { name: 'Show the response below the request', exact: true }).click();
  await chooseRequestSection(page, 'Scripts');
  const divider = page.getByRole('button', { name: 'Resize panels', exact: true });
  const dragDivider = async (y: number) => {
    const box = await divider.boundingBox();
    if (!box) throw new Error('Panel divider is missing');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, y, { steps: 8 });
    await page.mouse.up();
  };
  await dragDivider(1000);
  for (const [tab, id] of [['Pre-request', 'pre-request-script-editor'], ['Tests', 'test-script-editor']]) {
    await page.locator('.script-section').getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await fillCodeEditor(page, id, Array.from({ length: 100 }, (_, i) => `console.log(${i + 1});`).join('\n'));
    const scroller = page.getByTestId(id).locator('.cm-scroller');
    const fillsPanel = () => scroller.evaluate(node => {
      const panel = node.closest('.tab-content')!.getBoundingClientRect();
      return Math.abs(node.getBoundingClientRect().bottom - panel.bottom) < 3;
    });
    await expect.poll(fillsPanel).toBe(true);
    await scroller.evaluate(node => { node.scrollTop = 0; });
    const box = await scroller.boundingBox();
    if (!box) throw new Error('Script scroller is missing');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30);
    await page.mouse.wheel(0, 550);
    await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
    await page.screenshot({ path: join(tmpdir(), `kurlo-${id}-resized.png`), animations: 'disabled' });
    const expandedHeight = await scroller.evaluate(node => node.clientHeight);
    await dragDivider(550);
    await expect.poll(() => scroller.evaluate(node => node.clientHeight)).toBeLessThan(expandedHeight - 100);
    await expect.poll(fillsPanel).toBe(true);
    await expect(scroller).toBeVisible();
    await dragDivider(1000);
    await expect.poll(fillsPanel).toBe(true);
  }
});

for (const [runtime, shortcut] of [['windows/e2e', 'Control+s'], ['darwin/e2e', 'Meta+s']]) {
  test(`saves scripts at the active request, collection and folder with ${shortcut}`, async ({ page }) => {
    const oldScript = 'throw new Error("retired script field")';
    const original = 'console.log("existing JavaScript")';
    await installKurloBridge(page, '', runtime, false, {
      collections: [{
        ...collection,
        defaults: { testScript: oldScript, testScriptJs: original },
        folderDefaults: [{ path: ['Auth'], preRequestScript: oldScript, preRequestScriptJs: original }],
      }],
      activeId: 'one',
      openIds: ['one'],
      requests: [{ ...requests[0], folderPath: ['Auth'], preRequestScript: oldScript, preRequestScriptJs: original }],
    });
    await page.goto('/');
    await chooseRequestSection(page, 'Scripts');
    await expect(page.getByTestId('pre-request-script-editor').locator('.cm-content')).toHaveText(original);
    const source = 'pm.variables.set("trace", "test")';
    await fillCodeEditor(page, 'pre-request-script-editor', source);
    await page.keyboard.press(shortcut);
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests[0].preRequestScriptJs)).toBe(source);

    const row = collectionRow(page, collection.name);
    await row.getByLabel('Collection menu').click();
    await row.locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    await page.locator('.collection-tabs').getByRole('tab', { name: /^Tests/ }).click();
    const editor = page.locator('.collection-script-section .cm-content');
    await expect(editor).toHaveText(original);
    await editor.fill(source);
    await editor.press(shortcut);
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.collections[0].defaults?.testScriptJs)).toBe(source);

    const folder = folderRow(page, 'Auth');
    await folder.getByLabel('Folder menu').click();
    await folder.locator('.folder-menu').getByRole('button', { name: 'Settings' }).click();
    await page.locator('.collection-tabs').getByRole('tab', { name: /^Script/ }).click();
    await expect(editor).toHaveText(original);
    await editor.fill(source);
    await editor.press(shortcut);
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.collections[0].folderDefaults?.[0].preRequestScriptJs)).toBe(source);
    const saved = await page.evaluate(() => {
      const { requests, collections } = window.__kurloE2E.store;
      return [requests[0], collections[0].defaults, collections[0].folderDefaults?.[0]];
    });
    for (const item of saved) {
      expect(item).not.toHaveProperty('preRequestScript');
      expect(item).not.toHaveProperty('testScript');
    }
    await captureDocsScreenshot(page, 'folder-javascript-editor', page.locator('.collection-script-section'));
  });
}
