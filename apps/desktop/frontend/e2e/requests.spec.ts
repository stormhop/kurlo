import { addRequestFromFolder, chooseRequestSection, chooseRequestType, collectionRow, fillCodeEditor, fillPrompt, folderRow } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test, type Page } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('sets NTLM auth on an HTTP request', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Corporate API');
    await collectionRow(page, 'Corporate API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Corporate API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.example.test/orders');
    await chooseRequestSection(page, 'Authorization');
    await page.getByLabel('Auth Type').click();
    await page.getByRole('button', { name: 'NTLM', exact: true }).click();
    await page.getByLabel('Username').fill('EXAMPLE\\api-user');
    await page.getByLabel('Password').fill('{{ntlmPassword}}');
    await captureDocsScreenshot(page, 'auth-ntlm');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.at(-1))).toMatchObject({
      auth: { type: 'ntlm', username: 'EXAMPLE\\api-user', password: '{{ntlmPassword}}' },
    });
  });

  test('keeps a long request URL on one line and scrolls it sideways', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Long URLs');
    await collectionRow(page, 'Long URLs').getByLabel('Collection menu').click();
    await collectionRow(page, 'Long URLs').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    const url = page.getByLabel('Request URL');
    const bar = page.locator('.request-bar');
    const before = await bar.boundingBox();
    const longUrl = `https://api.example.test/search?${Array.from({ length: 60 }, (_, i) => `filter${i}={{value${i}}}`).join('&')}`;
    await url.fill(longUrl.slice(0, -1));
    await url.pressSequentially(longUrl.slice(-1));
    await expect(url).toHaveValue(longUrl);
    expect(await url.evaluate((el) => el.tagName)).toBe('INPUT');
    const after = await bar.boundingBox();
    expect(after!.height).toBe(before!.height);
    expect(await url.evaluate((el) => el.scrollWidth > el.clientWidth && el.scrollLeft > 0)).toBe(true);
    await url.blur();
    expect((await bar.boundingBox())!.height).toBe(before!.height);
    await expect.poll(() => url.evaluate((el) => el.scrollLeft)).toBe(0);
    const box = (await url.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(300, 0);
    await expect.poll(() => url.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    const afterSwipe = await url.evaluate((el) => el.scrollLeft);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => url.evaluate((el) => el.scrollLeft)).toBeGreaterThan(afterSwipe + 50);
    await page.mouse.wheel(0, -100000);
    await expect.poll(() => url.evaluate((el) => el.scrollLeft)).toBe(0);
    expect((await bar.boundingBox())!.height).toBe(before!.height);
  });

  test('sends request vars from the Vars tab and saves them', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Vars API');
    await collectionRow(page, 'Vars API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Vars API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.example.test/users/{{userId}}');
    await chooseRequestSection(page, 'Vars');
    const tables = page.locator('.request-vars-table');
    await tables.nth(0).getByPlaceholder('userId').first().fill('userId');
    await tables.nth(0).getByPlaceholder('Value').first().fill('42');
    await tables.nth(1).getByPlaceholder('token').first().fill('token');
    await tables.nth(1).getByPlaceholder('res.body.token').first().fill('res.body.token');
    await expect(page.locator('.request-editor-tabs-shell').getByRole('tab', { name: /Vars/ })).toContainText('2');
    await captureDocsScreenshot(page, 'request-vars');

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.at(-1))).toMatchObject({
      requestVariables: { userId: '42' },
      postResponseVars: [{ key: 'token', value: 'res.body.token', enabled: true }],
    });
    const sent = await page.evaluate(() => window.__kurloE2E.sentRequests.at(-1) as { url: string; templateValues?: Record<string, string> });
    expect(sent.url === 'https://api.example.test/users/42' || sent.templateValues?.userId === '42').toBe(true);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const requests = (window.__kurloE2E.savedStores.at(-1)?.requests ?? []) as Array<{ vars?: Array<{ key: string; value: string }>; postResponseVars?: Array<{ key: string; value: string }> }>;
      const saved = requests.find(request => request.vars?.length);
      return saved ? { vars: saved.vars?.map(row => [row.key, row.value]), post: saved.postResponseVars?.map(row => [row.key, row.value]) } : null;
    })).toEqual({ vars: [['userId', '42']], post: [['token', 'res.body.token']] });
  });

  test('closes a labelled dropdown after an option is picked', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Billing');
    await page.getByRole('button', { name: 'Collection runner' }).click();

    const picker = page.locator('.runner-select');
    const trigger = picker.locator('.app-select-trigger');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await picker.getByRole('option', { name: 'Billing' }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(picker.getByRole('option')).toHaveCount(0);
    await expect(trigger).toContainText('Billing');
  });

  test('preserves source edits when duplicating before autosave fires', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      activeId: 'duplicate-source', openIds: ['duplicate-source'],
      collections: [{ id: 'col-duplicate', workspaceId: 'workspace-e2e', name: 'Duplicate API' }],
      requests: [{ id: 'duplicate-source', collectionId: 'col-duplicate', name: 'Source request', method: 'GET', url: 'https://source.kurlo.test' }],
    });
    await page.goto('/');
    const url = page.getByLabel('Request URL');
    await expect(url).toHaveValue('https://source.kurlo.test');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('radio', { name: 'Autosave', exact: true }).click();
    await page.getByLabel('Close settings').click();
    await page.evaluate(() => {
      const original = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
        original(handler, delay === 1200 ? 60000 : delay, ...args)) as typeof window.setTimeout;
    });
    await url.fill('https://edited.kurlo.test');
    const source = page.locator('.collection-request-wrap').filter({ hasText: 'Source request' });
    await source.getByLabel('Request menu').click();
    await source.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Source request Copy/ })).toBeVisible();
    await page.getByRole('tab', { name: /^GET Source request(?: \(Unsaved changes\))?$/ }).click();
    await expect(url).toHaveValue('https://edited.kurlo.test');
    expect(await page.evaluate(() => {
      const requests = window.__kurloE2E.store.requests as Array<{ id: string; url: string }>;
      return requests.find(request => request.id === 'duplicate-source')?.url;
    })).toBe('https://edited.kurlo.test');
  });

  test('does not mark a request from collection settings as changed after an edit is undone', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-clean', workspaceId: 'workspace-e2e', name: 'Clean API' }],
      requests: [],
    });
    await page.goto('/');
    await collectionRow(page, 'Clean API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Clean API').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    await page.locator('.overview-actions').getByRole('button', { name: 'New request' }).click();
    const url = page.getByLabel('Request URL');
    await expect(url).toBeVisible();
    const tab = page.locator('.saved-request-tab.active');
    await expect(tab).toHaveClass(/\bdraft\b/);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(tab).not.toHaveClass(/\bdraft\b/);
    await expect(tab).not.toHaveClass(/\bdirty\b/);
    await url.click();
    await page.keyboard.type(' ');
    await expect(tab).toHaveClass(/\bdirty\b/);
    await page.keyboard.press('Backspace');
    await expect(tab).not.toHaveClass(/\bdirty\b/);
  });

  test('sends the request when Enter is pressed in the URL field', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    const url = page.getByLabel('Request URL');
    await url.fill('https://api.kurlo.test/orders/8123');
    await url.press('Enter');

    await expect(page.getByText('200 OK')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(1);
    await expect(url).toHaveValue('https://api.kurlo.test/orders/8123');

    await url.press('Shift+Enter');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(1);
  });

  test('keeps a renamed request in the editor until it is saved', async ({ page }, testInfo) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-names', workspaceId: 'workspace-e2e', name: 'Names' }],
      requests: [{ id: 'req-name', collectionId: 'col-names', name: 'Saved name', requestType: 'http', method: 'GET', url: 'https://example.test', auth: { type: 'none' } }],
      activeId: 'req-name', openIds: ['req-name'],
    });
    await page.goto('/');
    const row = page.locator('.collection-request .collection-title');
    const name = page.getByRole('textbox', { name: 'Request name', exact: true });
    await name.fill('Unsaved name');
    await name.press('Enter');
    await expect(row).toHaveText('Saved name');
    await expect(page.getByRole('tab', { name: /Unsaved name/ })).toBeVisible();
    await page.getByRole('button', { name: 'Revert unsaved changes', exact: true }).click();
    await expect(name).toHaveValue('Saved name');
    await name.fill('Renamed request');
    await name.press('Enter');
    await expect(row).toHaveText('Saved name');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row).toHaveText('Renamed request');
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.store.requests as Array<{ name: string }>)[0].name)).toBe('Renamed request');
    await page.screenshot({ path: join(tmpdir(), `kurlo-manual-name-${testInfo.project.name}.png`), animations: 'disabled' });
  });

  test('applies the headers and auth a folder sets to the requests inside it', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Shop API');
    await collectionRow(page, 'Shop API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Shop API').locator('.collection-menu').getByRole('button', { name: 'Add folder' }).click();
    await fillPrompt(page, 'New folder', 'Orders');

    await folderRow(page, 'Orders').getByLabel('Folder menu').click();
    await folderRow(page, 'Orders').locator('.folder-menu').getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
    await expect(page.getByText('Folder in Shop API', { exact: false })).toBeVisible();
    const tabs = page.locator('.collection-tabs').getByRole('tab');
    await expect(tabs).toHaveText(['Headers', 'Auth', 'Script', 'Tests']);
    await expect(page.locator('.saved-request-tab.runner-tab .tab-title').last()).toHaveText('Orders');

    const content = page.locator('.collection-settings-content');
    await content.getByPlaceholder('Header').first().fill('X-Scope');
    await content.getByPlaceholder('Value').first().fill('orders');
    await tabs.filter({ hasText: 'Auth' }).click();
    await expect(page.getByRole('button', { name: 'Auth type' })).toHaveText('Inherit from parent');
    await expect(page.getByText('take it from the collection, which sets no auth')).toBeVisible();
    await page.getByRole('button', { name: 'Auth type' }).click();
    await page.locator('.auth-select-menu').getByRole('button', { name: 'Bearer token' }).click();
    await page.locator('#collection-bearer-token').fill('folder-token');
    const save = page.getByRole('button', { name: 'Save', exact: true });
    if (await save.isVisible()) await save.click();
    await expect.poll(async () => {
      const store = await page.evaluate(() => window.__kurloE2E.store as { collections?: Array<{ name: string; folderDefaults?: Array<{ path: string[]; auth: { type: string }; headers: Array<{ key: string; value: string }> }> }> });
      const folder = store.collections?.find(item => item.name === 'Shop API')?.folderDefaults?.[0];
      return folder ? { path: folder.path, auth: folder.auth.type, headers: folder.headers.map(row => `${row.key}=${row.value}`) } : null;
    }).toEqual({ path: ['Orders'], auth: 'bearer', headers: ['X-Scope=orders'] });
    await captureDocsScreenshot(page, 'folder-settings');

    await addRequestFromFolder(page, 'Orders', 'HTTP Request');
    const url = page.getByLabel('Request URL');
    await url.fill('https://api.kurlo.test/orders');
    await url.press('Enter');
    await expect.poll(() => page.evaluate(() => {
      const sent = window.__kurloE2E.sentRequests.at(-1) as { headers?: Array<{ key: string; value: string }>; auth?: { type?: string; token?: string } } | undefined;
      return sent ? { headers: (sent.headers ?? []).filter(row => row.key === 'X-Scope').map(row => row.value), auth: sent.auth?.type, token: sent.auth?.token } : null;
    })).toEqual({ headers: ['orders'], auth: 'bearer', token: 'folder-token' });

    await page.getByRole('button', { name: 'Collections' }).click();
    await folderRow(page, 'Orders').getByLabel('Folder menu').click();
    await folderRow(page, 'Orders').locator('.folder-menu').getByRole('button', { name: 'Rename' }).click();
    await fillPrompt(page, 'Rename folder', 'Sales');
    await expect.poll(async () => {
      const store = await page.evaluate(() => window.__kurloE2E.store as { collections?: Array<{ name: string; folderDefaults?: Array<{ path: string[] }> }> });
      return store.collections?.find(item => item.name === 'Shop API')?.folderDefaults?.map(item => item.path.join('/'));
    }).toEqual(['Sales']);
  });

  test('sending a saved request leaves it saved', async ({ page }) => {
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

    const saveButton = page.locator('.save-btn:not(.revert-btn)');
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(saveButton).toBeDisabled();

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    await expect(saveButton).toBeDisabled();
    await expect(saveButton).toHaveText('Saved');
    await expect(page.locator('.saved-request-tab.dirty')).toHaveCount(0);
  });

  test('suggests the rest of a URL and the next JSON key as ghost text', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Create order');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Method and protocol').click();
    await page.getByRole('option', { name: 'POST' }).click();
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders');
    await chooseRequestSection(page, 'Body');
    await page.locator('label.body-mode-label').filter({ hasText: 'raw' }).click();
    await fillCodeEditor(page, 'request-body-editor', '{\n  "customerId": "cus_1",\n  "currency": "EUR"\n}');
    await page.getByRole('button', { name: /^Send( |$)/ }).first().click();
    await expect(page.locator('.response-status-bar')).toContainText(/\d{3}/);
    await page.getByRole('button', { name: 'Save as example', exact: true }).click();
    await expect(page.locator('.examples-row')).toHaveCount(1);

    await chooseRequestSection(page, 'Body');
    await fillCodeEditor(page, 'request-body-editor', '{\n  "customerId": "cus_2",\n  ');
    const editorGhost = page.getByTestId('editor-ghost-text');
    await expect(editorGhost).toHaveText('"currency": ');
    await page.keyboard.press('Tab');
    await expect(editorGhost).toHaveCount(0);
    await expect(page.getByTestId('request-body-editor').locator('.cm-content')).toContainText('"currency":');

    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Another');
    await page.getByLabel('Request name').press('Enter');
    const url = page.getByLabel('Request URL');
    await url.click();
    await url.pressSequentially('https://api.k');
    const urlGhost = page.getByTestId('ghost-text');
    await expect(urlGhost).toHaveText('urlo.test/orders');
    await url.press('Escape');
    await expect(urlGhost).toHaveCount(0);
    await url.pressSequentially('u');
    await expect(urlGhost).toHaveText('rlo.test/orders');
    await url.press('Tab');
    await expect(url).toHaveValue('https://api.kurlo.test/orders');
    await expect(urlGhost).toHaveCount(0);

    await url.fill('');
    await url.pressSequentially('crea');
    await expect(urlGhost).toHaveText('te order → https://api.kurlo.test/orders');
    await url.press('Tab');
    await expect(url).toHaveValue('https://api.kurlo.test/orders');
  });

  test('writes request docs in Markdown with a live preview and an automatic reference', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/users?page=2');
    await page.getByRole('tab', { name: 'Docs' }).click();
    const docs = page.locator('.docs-tab');
    await expect(docs.getByRole('radio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'true');
    await docs.getByLabel('Docs', { exact: true }).fill('# List users\n\nReturns **active** users.\n\n| Field | Type |\n|---|---|\n| id | `string` |\n\n[API guide](https://kurlo.dev/docs)');
    await expect(docs.locator('.docs-preview h2')).toHaveText('List users');
    await expect(docs.locator('.docs-preview strong')).toHaveText('active');
    await expect(docs.locator('.docs-preview table td').first()).toHaveText('id');
    await docs.getByRole('radio', { name: 'Preview' }).click();
    await expect(docs.locator('textarea')).toHaveCount(0);
    await expect(docs.locator('.docs-ref-url')).toHaveText('https://api.kurlo.test/users?page=2');
    await expect(docs.locator('.docs-ref-row').first()).toContainText('page');
    await expect(docs.locator('.md-link')).toHaveAttribute('href', 'https://kurlo.dev/docs');
    await captureDocsScreenshot(page, 'request-docs');
  });
});

test.describe('Key-value tables', () => {
  test('centres the row checkbox in its column', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'below'));
    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    await page.getByRole('tab', { name: /^Headers/ }).click();
    const row = page.getByTestId('request-header-row').first();
    await row.getByPlaceholder('Key').fill('Accept');
    const offsets = await row.evaluate(rowEl => {
      const check = rowEl.querySelector('.check')!.getBoundingClientRect();
      const rowBox = rowEl.getBoundingClientRect();
      const column = parseFloat(getComputedStyle(rowEl).gridTemplateColumns.split(' ')[0]);
      return { left: check.left - rowBox.left, centre: check.left + check.width / 2 - rowBox.left, column };
    });
    expect(offsets.left).toBeGreaterThan(0);
    expect(Math.abs(offsets.centre - offsets.column / 2)).toBeLessThan(1);
  });
});

test.describe('Send races', () => {
  async function openRequest(page: Page, url: string) {
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill(url);
  }

  test('twenty rapid Send clicks settle on the last send', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await openRequest(page, 'https://api.kurlo.test/slow?ms=600&cancelLag=200');

    const send = page.locator('.send-split .btn-send');
    for (let click = 0; click < 21; click += 1) await send.click({ delay: 0 });

    await expect(send).toHaveText(/^Send/, { timeout: 10_000 });
    const sent = await page.evaluate(() => (window.__kurloE2E.sentRequests as unknown[]).length);
    expect(sent).toBe(11);
    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toContainText(`"sequence": ${sent}`);
    await page.waitForTimeout(600);
    await expect(viewer).toContainText(`"sequence": ${sent}`);
    await expect(page.getByText('Request canceled')).toHaveCount(0);
    await expect(send).toHaveText(/^Send/);
  });

  test('the bird waits in an empty response and while a request is out, and the status lands', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await openRequest(page, 'https://api.kurlo.test/slow?ms=1600');

    await expect(page.locator('.response-empty-state .kurlo-bird-perched')).toBeVisible();

    await page.locator('.send-split .btn-send').click();
    await expect(page.locator('.response-loading-state .kurlo-bird-flying')).toBeVisible();
    await expect(page.locator('.response-waiting-time')).toHaveText(/^1\.\d s$/);

    const badge = page.locator('.response-status-bar .status-badge');
    await expect(badge).toHaveText(/200 OK/);
    await expect(badge).toHaveClass(/status-arrived/);
    await expect(badge).not.toHaveClass(/status-arrived/);
    await expect(page.locator('.response-loading-state')).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/slow?ms=400');
    await page.locator('.send-split .btn-send').click();
    await expect(page.locator('.send-split .btn-send')).toHaveText(/^Send/);
    await expect(badge).not.toHaveClass(/status-arrived/);
  });

  test('Send, Cancel, Send keeps the spinner until the second answer', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await openRequest(page, 'https://api.kurlo.test/slow?ms=1500&cancelLag=500');

    const send = page.locator('.send-split .btn-send');
    await send.click();
    await expect(send).toHaveText(/Cancel/);
    await send.click();
    await expect(send).toHaveText(/^Send/);
    await send.click();
    await expect(send).toHaveText(/Cancel/);
    await page.waitForTimeout(300);
    await expect(send).toHaveText(/Cancel/);
    await expect(page.getByText('Request canceled')).toHaveCount(0);
    const viewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await expect(viewer).toContainText('"sequence": 2', { timeout: 5_000 });
    await expect(send).toHaveText(/^Send/);
  });

  test('switching environment mid-request keeps script changes in the environment the request used', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const row = (key: string, value: string) => ({ id: `${key}-${value}`, key, value, enabled: true, description: '' });
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.environments = [
        { id: 'env-a', workspaceId: 'workspace-e2e', name: 'Alpha', values: [row('host', 'a.kurlo.test')] },
        { id: 'env-b', workspaceId: 'workspace-e2e', name: 'Beta', values: [row('host', 'b.kurlo.test'), row('only-b', 'yes')] },
      ];
      store.activeEnvironmentId = 'env-a';
    });
    await page.goto('/');
    await openRequest(page, 'https://{{host}}/slow?ms=800&setenv=token:from-alpha');

    await page.locator('.send-split .btn-send').click();
    await page.locator('.environment-select').click();
    await page.getByRole('button', { name: 'Beta' }).click();
    await expect(page.locator('.environment-select')).toContainText('Beta');

    await expect(page.getByRole('textbox', { name: 'Response body', exact: true })).toContainText('a.kurlo.test', { timeout: 5_000 });
    await expect.poll(async () => page.evaluate(() => {
      const stores = window.__kurloE2E.savedStores as Array<{ environments?: Array<{ id: string; values: Array<{ key: string; value: string }> }> }>;
      const last = stores[stores.length - 1];
      const values = (id: string) => Object.fromEntries((last?.environments?.find(env => env.id === id)?.values ?? []).filter(row => row.key).map(row => [row.key, row.value]));
      return { alpha: values('env-a'), beta: values('env-b') };
    })).toEqual({
      alpha: { host: 'a.kurlo.test', token: 'from-alpha' },
      beta: { host: 'b.kurlo.test', 'only-b': 'yes' },
    });
    expect(await page.evaluate(() => window.__kurloE2E.environment)).toEqual({ host: 'b.kurlo.test', 'only-b': 'yes' });
  });

  test('deleting a request while it is in flight does not bring it back', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-race', workspaceId: 'workspace-e2e', name: 'Race', filesystemName: 'Race' }];
      store.requests = [{ id: 'req-doomed', name: 'Doomed', collectionId: 'collection-race', collection: 'Race', folderPath: [], method: 'GET', url: 'https://api.kurlo.test/slow?ms=800' }];
      store.activeId = 'req-doomed';
      store.openIds = ['req-doomed'];
    });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto('/');
    await expect(page.getByLabel('Request URL')).toHaveValue('https://api.kurlo.test/slow?ms=800');

    await page.locator('.send-split .btn-send').click();
    const row = page.locator('.sidebar').getByText('Doomed', { exact: true }).first();
    await row.hover();
    await page.getByLabel('Request menu').first().click();
    await page.locator('.request-menu').getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog').getByRole('button', { name: /Delete/ });
    if (await confirm.count()) await confirm.click();

    await page.waitForTimeout(1_200);
    const stored = await page.evaluate(() => {
      const stores = window.__kurloE2E.savedStores as Array<{ requests: Array<{ id: string }> }>;
      return stores[stores.length - 1]?.requests.map(request => request.id) ?? [];
    });
    expect(stored).not.toContain('req-doomed');
    await expect(page.getByText('Doomed', { exact: true })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('Starred requests', () => {
  const collections = [{ id: 'col-api', workspaceId: 'workspace-e2e', name: 'API' }];
  const requestsFor = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `req-${index + 1}`, collectionId: 'col-api', collection: 'API', name: `Order ${index + 1}`, method: 'GET', url: `https://example.test/orders/${index + 1}`, auth: { type: 'none' },
  }));

  for (const scale of [1, 1.5]) {
    test(`keeps 40 starred requests in a ten-row list above the collections at ${scale}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1100, height: 900 });
      const requests = requestsFor(40);
      await installKurloBridge(page, '', 'browser/e2e', false, {
        collections,
        requests,
        starredRequestIds: requests.map(request => request.id),
        activeId: 'req-1',
        openIds: ['req-1'],
      });
      await page.addInitScript(value => localStorage.setItem('kurlo.uiScale.v1', String(value)), scale);
      await page.goto('/');
      const head = page.getByRole('button', { name: 'Starred 40' });
      await expect(head).toHaveAttribute('aria-expanded', 'true');
      const list = page.locator('.starred-list');
      const collectionsHead = page.locator('.collections-head');

      const geometry = await list.evaluate(node => {
        const row = node.querySelector('.collection-request-wrap')!.getBoundingClientRect().height;
        return { rows: Math.round(node.clientHeight / row), scrolls: node.scrollHeight > node.clientHeight };
      });
      expect(geometry.rows).toBe(10);
      expect(geometry.scrolls).toBe(true);
      await expect.poll(() => list.locator('.collection-request-wrap').count()).toBe(40);
      const listBottom = await list.evaluate(node => node.getBoundingClientRect().bottom);
      const headTop = await collectionsHead.evaluate(node => node.getBoundingClientRect().top);
      expect(headTop).toBeGreaterThanOrEqual(listBottom - 1);

      await list.hover();
      for (let step = 0; step < 4; step += 1) await page.mouse.wheel(0, 3000);
      await expect.poll(() => list.evaluate(node => Math.ceil(node.scrollTop + node.clientHeight) >= node.scrollHeight)).toBe(true);
      const last = list.locator('.collection-request-wrap').filter({ hasText: 'Order 40' });
      await expect(last).toBeVisible();
      expect(await collectionsHead.evaluate(node => node.getBoundingClientRect().top)).toBe(headTop);

      await last.hover();
      await last.getByRole('button', { name: 'Request menu' }).click();
      const menu = last.locator('.request-menu');
      await expect(menu.getByRole('button', { name: 'Unstar' })).toBeVisible();
      const menuShown = await menu.evaluate(node => {
        const box = node.getBoundingClientRect();
        const corners = [[box.left + 4, box.top + 4], [box.right - 4, box.bottom - 4]];
        return corners.every(([x, y]) => node.contains(document.elementFromPoint(x, y)));
      });
      expect(menuShown).toBe(true);
      await page.screenshot({ path: join(tmpdir(), `kurlo-starred-40-${scale}-${testInfo.project.name}.png`), animations: 'disabled' });

      await menu.getByRole('button', { name: 'Unstar' }).click();
      await expect(page.getByRole('button', { name: 'Starred 39' })).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window.__kurloE2E.store as { starredRequestIds?: string[] }).starredRequestIds?.length)).toBe(39);

      await page.getByRole('button', { name: 'Starred 39' }).click();
      await expect(list).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('kurlo.sidebar.starredCollapsed.v1'))).toBe('1');
    });
  }

  test('moves stars from request files into the local store', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections,
      requests: requestsFor(3).map((request, index) => ({ ...request, isPinned: index === 1 })),
      activeId: 'req-1',
      openIds: ['req-1'],
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Starred 1' })).toBeVisible();
    await expect(page.locator('.starred-list')).toContainText('Order 2');

    await page.locator('.collection-list .collection-request-wrap').filter({ hasText: 'Order 3' }).getByRole('button', { name: 'Star request' }).click();
    await expect(page.getByRole('button', { name: 'Starred 2' })).toBeVisible();
    const saved = await page.evaluate(() => window.__kurloE2E.store as { starredRequestIds?: string[]; requests: Array<Record<string, unknown>> });
    expect(saved.starredRequestIds).toEqual(['req-2', 'req-3']);
    expect(saved.requests.some(request => 'isPinned' in request)).toBe(false);
  });
});

test('signs a request with JWT Bearer auth and previews the token', async ({ page }, testInfo) => {
  if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
  await installKurloBridge(page);
  await page.goto('/');
  await page.getByLabel('New collection').click();
  await fillPrompt(page, 'New collection', 'Partner API');
  await collectionRow(page, 'Partner API').getByLabel('Collection menu').click();
  await collectionRow(page, 'Partner API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
  await chooseRequestType(page, 'HTTP Request');
  await page.getByLabel('Request URL').fill('https://api.example.test/me');
  await chooseRequestSection(page, 'Authorization');
  await page.getByLabel('Auth Type').click();
  await page.getByRole('button', { name: 'JWT Bearer', exact: true }).click();
  await page.getByLabel('Secret', { exact: true }).fill('{{jwtSigningKey}}');
  const payload = page.getByLabel('JWT payload');
  await page.getByRole('button', { name: 'Preview token', exact: true }).click();
  const inspector = page.locator('.jwt-inspector');
  await expect(inspector.getByText('No claims')).toBeVisible();
  await expect(inspector.locator('.jwt-state')).toHaveText('No expiry');
  await expect(page.getByTestId('jwt-preview-token')).toHaveText(/^eyJ[\w-]+\.e30\.[\w-]+$/);
  await page.getByLabel('Expires in, seconds (adds iat and exp)').fill('300');
  await payload.click();
  await page.keyboard.insertText('{ "sub": "user-42", "role": "admin" }');
  await expect(inspector).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview token', exact: true }).click();
  await expect(inspector).toContainText('With the active environment');
  await expect(inspector).toContainText('user-42');
  await expect(inspector).toContainText('exp');
  await expect(inspector.locator('.jwt-state')).toHaveText('Valid time window');
  const token = page.getByTestId('jwt-preview-token');
  await expect(token).toHaveText(/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/);
  await inspector.getByRole('button', { name: 'Copy token' }).click();
  await expect(inspector.getByRole('button', { name: 'Copied' })).toBeVisible();
  await page.getByLabel('Auth Type').scrollIntoViewIfNeeded();
  await captureDocsScreenshot(page, 'auth-jwt');
  if (!docsScreenshotDir) {
    await page.getByLabel('Auth Type').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(tmpdir(), `kurlo-auth-jwt-top-${testInfo.project.name}.png`), animations: 'disabled' });
    await inspector.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(tmpdir(), `kurlo-auth-jwt-${testInfo.project.name}.png`), animations: 'disabled' });
  }

  await page.getByRole('radio', { name: 'Query string' }).check();
  await expect(page.getByLabel('Query parameter', { exact: true })).toHaveValue('token');
  await page.getByRole('radio', { name: 'Header' }).check();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.at(-1))).toMatchObject({
    auth: { type: 'jwt', token: '', jwtAlgorithm: 'HS256', jwtSecret: '{{jwtSigningKey}}', jwtExpiresIn: '300', jwtAddTo: 'header', jwtHeaderPrefix: 'Bearer', jwtPayload: '{ "sub": "user-42", "role": "admin" }' },
  });

  await page.getByLabel('JWT algorithm').click();
  await page.getByRole('option', { name: 'ES256', exact: true }).click();
  await expect(page.getByLabel('Secret', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel(/Private key \(PEM\)/)).toBeVisible();
});

test('checks a response with assertions and sends them with the request', async ({ page }, testInfo) => {
  if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
  await installKurloBridge(page);
  await page.goto('/');
  await page.getByLabel('New collection').click();
  await fillPrompt(page, 'New collection', 'Orders API');
  await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
  await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
  await chooseRequestType(page, 'HTTP Request');
  await page.getByLabel('Request URL').fill('https://api.example.test/orders');
  await chooseRequestSection(page, 'Scripts');
  await page.getByRole('tab', { name: 'Assertions' }).click();
  await expect(page.locator('.assertions-empty')).toContainText('Check the response without code');
  await page.screenshot({ path: join(tmpdir(), `kurlo-assertions-empty-${testInfo.project.name}.png`), animations: 'disabled' });
  await page.getByRole('button', { name: 'Status is 200', exact: true }).click();
  await page.getByRole('button', { name: 'JSON response', exact: true }).click();
  await page.getByRole('button', { name: 'Assertion', exact: true }).click();
  const rows = page.getByTestId('assertion-row');
  await expect(rows).toHaveCount(3);
  await rows.nth(2).getByLabel('Assertion target').fill('body.items');
  await rows.nth(2).getByLabel('Assertion check').click();
  await page.getByRole('option', { name: 'has length', exact: true }).click();
  await rows.nth(2).getByLabel('Expected value').fill('{{expectedCount}}');
  await rows.nth(1).getByLabel('Enable assertion').uncheck();
  await expect(page.getByRole('tab', { name: /Assertions\s*3/ })).toBeVisible();
  await captureDocsScreenshot(page, 'request-assertions');
  await page.screenshot({ path: join(tmpdir(), `kurlo-assertions-${testInfo.project.name}.png`), animations: 'disabled' });

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.at(-1)?.assertions)).toEqual([
    { enabled: true, target: 'status', operator: 'eq', value: '200' },
    { enabled: true, target: 'body.items', operator: 'length', value: '{{expectedCount}}' },
  ]);

  await rows.nth(0).getByLabel('Assertion check').click();
  await page.getByRole('option', { name: 'exists', exact: true }).click();
  await expect(rows.nth(0).getByLabel('Expected value')).toHaveCount(0);
  await rows.nth(0).getByLabel('Remove assertion').click();
  await expect(rows).toHaveCount(2);
});

for (const count of [200, 250]) {
  test(`edits a request with ${count} assertions without losing any`, async ({ page }, testInfo) => {
    const assertions = Array.from({ length: count }, (_, index) => ({ enabled: true, target: `body.items[${index}].id`, operator: 'exists', value: '' }));
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-checks', workspaceId: 'workspace-e2e', name: 'Checks' }],
      requests: [{ id: 'checked', collectionId: 'col-checks', collection: 'Checks', name: 'Checked', requestType: 'http', method: 'GET', url: 'https://api.example.test/items', auth: { type: 'none' }, assertions }],
      activeId: 'checked',
      openIds: ['checked'],
    });
    await page.goto('/');
    await chooseRequestSection(page, 'Scripts');
    await page.getByRole('tab', { name: /Assertions/ }).click();
    const rows = page.getByTestId('assertion-row');
    await expect(rows).toHaveCount(count);
    await expect(page.getByRole('tab', { name: new RegExp(`Assertions\\s*${count}`) })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assertion', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Status is 200', exact: true })).toBeDisabled();
    await expect(page.locator('.assertions-limit')).toContainText('Up to 200 assertions');

    const last = rows.nth(count - 1);
    await last.scrollIntoViewIfNeeded();
    const started = Date.now();
    await last.getByLabel('Assertion check').click();
    await page.getByRole('option', { name: 'equals', exact: true }).click();
    await last.getByLabel('Expected value').fill('42');
    expect(Date.now() - started).toBeLessThan(5000);
    await page.screenshot({ path: join(tmpdir(), `kurlo-assertions-${count}-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.keyboard.press('Control+s');
    await expect.poll(() => page.evaluate(() => (window as any).__kurloE2E.store.requests.find((request: { id: string }) => request.id === 'checked')?.assertions?.length)).toBe(count);
    await expect.poll(() => page.evaluate(() => (window as any).__kurloE2E.store.requests.find((request: { id: string }) => request.id === 'checked')?.assertions?.at(-1))).toMatchObject({ operator: 'eq', value: '42' });

    await rows.nth(0).getByLabel('Remove assertion').click();
    await expect(rows).toHaveCount(count - 1);
    if (count - 1 < 200) await expect(page.getByRole('button', { name: 'Assertion', exact: true })).toBeEnabled();
  });
}
