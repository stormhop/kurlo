import { expect, test, type Page } from '@playwright/test';
import { reviewShot } from './support/reviewShot';
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
    url: protocol === 'ws' ? 'wss://example.test/two' : protocol === 'grpc' ? 'grpc.kurlo.test:443' : protocol === 'kafka' ? 'localhost:9092' : protocol === 'mqtt' ? 'mqtt://broker.example.test:1883' : request.url,
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
  await reviewShot(settings, { path: join(tmpdir(), 'kurlo-preview-tabs-general.png'), animations: 'disabled' });
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
  await reviewShot(page, { path: join(tmpdir(), 'kurlo-preview-tabs-strip.png'), animations: 'disabled' });
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

for (const protocol of ['ws', 'socketio', 'sse', 'mqtt']) {
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
      return (protocol === 'ws' ? state.webSocketConnects : protocol === 'sse' ? state.sseConnects : protocol === 'mqtt' ? state.mqttConnects : state.socketIOConnects).length;
    }, protocol);
    expect(connectCount).toBe(1);
  });
}

for (const protocol of ['http', 'grpc', 'kafka']) {
  test(`keeps a preview when its ${protocol} request is running in the background`, async ({ page }) => {
    await start(page, true, false, protocol);
    await page.evaluate(protocol => {
      const app = (window as E2EWindow).go.api.App;
      const wait = () => new Promise<void>(resolve => {
        window.__kurloE2E.responseGate = { ready: true, release: resolve };
      });
      if (protocol !== 'grpc') {
        const send = app.SendRequest;
        app.SendRequest = async request => { await wait(); return await send(request); };
      } else {
        const send = app.SendGrpcRequest;
        app.SendGrpcRequest = async request => { await wait(); return await send(request); };
      }
    }, protocol);
    await openRequest(page, 'Two');
    await expect(page.locator('.saved-request-tab.preview .tab-title')).toHaveText('Two');
    await page.getByRole('button', { name: protocol === 'http' ? 'Send' : protocol === 'kafka' ? 'Produce' : 'Invoke', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.responseGate?.ready)).toBe(true);
    await expect(page.locator('.saved-request-tab.preview')).toHaveCount(0);
    await openRequest(page, 'Three');
    await expect(requestTabs(page)).toHaveText(['One', 'Two', 'Three']);
    await page.evaluate(() => window.__kurloE2E.responseGate?.release());
    await openRequest(page, 'Two');
    await expect(page.locator(protocol === 'kafka' ? '.kafka-status' : '.response-status-bar .status-badge')).toContainText(protocol === 'grpc' ? 'OK' : '200');
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
    await reviewShot(page, { path: join(tmpdir(), `kurlo-${id}-resized.png`), animations: 'disabled' });
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

test('moves the script caret with the deleted character', async ({ page }) => {
  await start(page);
  await chooseRequestSection(page, 'Scripts');
  const editor = page.getByTestId('pre-request-script-editor');
  const content = editor.locator('.cm-content');
  await content.click();
  await page.keyboard.type('pm');
  await expect(page.getByRole('option', { name: 'pm', exact: true })).toBeVisible();
  await page.keyboard.press('Space');
  await page.keyboard.press('Backspace');
  await expect(content).toHaveText('pm');
  const measurement = await editor.evaluateHandle(root => {
    const frame = new Promise(resolve => {
      root.addEventListener('keyup', () => requestAnimationFrame(() => {
        const line = root.querySelector('.cm-line')!;
        const text = document.createRange();
        text.selectNodeContents(line);
        const caret = root.querySelector('.cm-cursor-primary')?.getBoundingClientRect();
        resolve({
          text: line.textContent,
          aligned: !!caret && Math.abs(caret.left - text.getBoundingClientRect().right) <= 1,
          nativeCaret: getComputedStyle(line).caretColor,
        });
      }), { once: true });
    });
    return { frame };
  });
  await page.keyboard.press('Backspace');
  expect(await measurement.evaluate(result => result.frame)).toEqual({
    text: 'p', aligned: true, nativeCaret: 'rgba(0, 0, 0, 0)',
  });
  await measurement.dispose();
});

async function expectCompletionOptions(page: Page, count: number) {
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(count);
  const codeMirrorInteractionDelayMs = 75;
  await page.clock.fastForward(codeMirrorInteractionDelayMs + 1);
}

test('completes script API members, inherited environment keys and collection request names', async ({ page }) => {
  const users = { ...collection, name: 'Accounts API' };
  const saved = (name: string, path: string) => ({
    ...requests[0], id: path, name, collection: users.name, url: `https://api.example.test/${path}`,
  });
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [users], activeId: 'users', openIds: ['users'], activeEnvironmentId: 'staging',
    requests: [saved('List users', 'users'), saved('Get profile', 'profile'), saved('Login', 'login')],
    environments: [
      { id: 'base', name: 'Base', workspaceId: collection.workspaceId, values: [
        { id: 1, enabled: true, key: 'baseUrl', value: 'https://api.example.test' },
      ] },
      { id: 'staging', name: 'Staging', workspaceId: collection.workspaceId, parentId: 'base', values: [
        { id: 2, enabled: true, key: 'apiToken', value: 'private-fixture-value', secret: true },
        { id: 3, enabled: false, key: 'disabledKey', value: 'unused' },
      ] },
    ],
  });
  await page.setViewportSize({ width: 1440, height: 850 });
  await page.clock.install();
  await page.goto('/');
  await chooseRequestSection(page, 'Scripts');
  const pre = page.getByTestId('pre-request-script-editor').locator('.cm-content');
  const options = page.getByRole('listbox');
  const panel = page.locator('.script-completion-hint');
  await pre.click();
  await page.keyboard.type('const baseUrl = pm.environment.');
  await expectCompletionOptions(page, 4);
  await pre.press('ArrowDown');
  await expect(panel).toContainText('pm.environment.get(key): string');
  await captureDocsScreenshot(page, 'script-completion-api');
  await pre.press('Enter');
  await expect(pre).toHaveText('const baseUrl = pm.environment.get');
  await page.keyboard.type('("');
  await expectCompletionOptions(page, 2);
  await expect(options).toContainText('apiToken');
  await expect(options).not.toContainText('private-fixture-value');
  await pre.press('ArrowDown');
  await expect(panel).toContainText('pm.environment.get("baseUrl")');
  await captureDocsScreenshot(page, 'script-completion-environment');
  await pre.press('Enter');
  await expect(pre).toHaveText('const baseUrl = pm.environment.get("baseUrl")');

  await page.locator('.script-section').getByRole('tab', { name: /^Tests/ }).click();
  const tests = page.getByTestId('test-script-editor').locator('.cm-content');
  await tests.click();
  await page.keyboard.type('if (pm.info.requestName === "');
  await expectCompletionOptions(page, 3);
  await tests.press('ArrowDown');
  await tests.press('ArrowDown');
  await expect(panel).toContainText('pm.info.requestName === "Login"');
  await captureDocsScreenshot(page, 'script-completion-requests');
  await page.keyboard.type('Lo');
  await expectCompletionOptions(page, 1);
  await tests.press('Enter');
  await expect(tests).toHaveText('if (pm.info.requestName === "Login")');
  await tests.fill('pm.response.to.have.st');
  await tests.press('Control+Space');
  await expect(options).toContainText('status');
  await tests.press('Escape');
  await expect(options).toHaveCount(0);
});

test('scopes script completion to the open collection and folder and saves the selected member', async ({ page }) => {
  const other = { ...collection, id: 'other', name: 'Other collection' };
  await installKurloBridge(page, '', 'windows/e2e', false, {
    activeId: 'one', openIds: ['one'], collections: [collection, other],
    requests: [{ ...requests[0], folderPath: ['Auth'] }, { ...requests[1], collectionId: other.id, collection: other.name }],
  });
  await page.clock.install();
  await page.goto('/');
  const row = collectionRow(page, collection.name);
  await row.getByLabel('Collection menu').click();
  await row.locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
  const tabs = page.locator('.collection-tabs');
  await tabs.getByRole('tab', { name: /^Tests/ }).click();
  const editor = page.locator('.collection-script-section .cm-content');
  await editor.click();
  await page.keyboard.type('pm.info.requestName === "');
  const options = page.getByRole('listbox').getByRole('option');
  await expectCompletionOptions(page, 1);
  await expect(options).toContainText('One');
  await editor.press('Enter');
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.collections[0].defaults?.testScriptJs)).toBe('pm.info.requestName === "One"');

  const folder = folderRow(page, 'Auth');
  await folder.getByLabel('Folder menu').click();
  await folder.locator('.folder-menu').getByRole('button', { name: 'Settings' }).click();
  await tabs.getByRole('tab', { name: /^Script/ }).click();
  await editor.click();
  await page.keyboard.type('pm.');
  await expect(options.filter({ hasText: /^request$/ })).toBeVisible();
  await expect(options.filter({ hasText: /^response$/ })).toHaveCount(0);
  await page.keyboard.type('request.auth.parameters().cou');
  await expectCompletionOptions(page, 1);
  await expect(options).toContainText('count');
  await editor.press('Enter');
  await page.keyboard.type('()');
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.collections[0].folderDefaults?.[0].preRequestScriptJs)).toBe('pm.request.auth.parameters().count()');
});

test('numbers untitled drafts and marks only edited ones as unsaved', async ({ page }) => {
  await start(page);
  const newDraft = page.getByRole('button', { name: 'New unsaved request' });
  await newDraft.click();
  await newDraft.click();
  const drafts = page.locator('.saved-request-tab.draft');
  await expect(drafts.locator('.tab-title')).toHaveText(['New Request', 'New Request 2']);
  await expect(page.getByRole('textbox', { name: 'Request name' })).toHaveValue('New Request 2');
  await expect(page.locator('.saved-request-tab.draft.unsaved')).toHaveCount(0);
  await page.getByLabel('Request URL').fill('https://example.test/orders');
  await expect(page.locator('.saved-request-tab.draft.unsaved')).toHaveCount(1);
  await expect(drafts.nth(1)).toHaveClass(/unsaved/);
  await drafts.nth(0).locator('.tab-close').click({ force: true });
  await expect(drafts.locator('.tab-title')).toHaveText(['New Request 2']);
  await newDraft.click();
  await expect(drafts.locator('.tab-title')).toHaveText(['New Request 2', 'New Request']);
  for (const title of await page.locator('.saved-request-tab:not(.overview-request-tab) .tab-title').all()) {
    expect(await title.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
});
