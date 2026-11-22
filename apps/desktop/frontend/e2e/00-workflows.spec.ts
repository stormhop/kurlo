import { addRequestFromFolder, chooseRequestSection, chooseRequestType, clickTabClose, collectionRow, fillCodeEditor, fillPrompt, folderRow } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

import { expectResponseTabsToFit, expectScriptResultsPanelLayout } from './support/layout';

import { captureDocsScreenshot, maybeCaptureResponseScreenshot, tourPause, waitForTransientToasts } from './support/screenshots';

import { expect, test } from '@playwright/test';

import { mkdir } from 'node:fs/promises';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('full click-through flow: environment, collection, requests, send, history, runner, report', async ({ page }) => {
    if (docsScreenshotDir) {
      await mkdir(docsScreenshotDir, { recursive: true });
      await page.setViewportSize(DOCS_VIEWPORT);
    }
    await installKurloBridge(page);
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Kurlo' })).toBeVisible();
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await expect(page.locator('.shell')).toHaveClass(/sidebar-hidden/);
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await page.getByRole('button', { name: 'Collections' }).click();
    await expect(page.locator('.shell')).not.toHaveClass(/sidebar-hidden/);
    await page.getByRole('button', { name: 'Collections' }).click();
    await expect(page.locator('.shell')).not.toHaveClass(/sidebar-hidden/);
    await tourPause(page, 'App loaded');

    if (docsScreenshotDir) {
      try {
        await page.getByRole('button', { name: 'Cookies', exact: true }).click();
        await expect(page.locator('.cookie-workspace')).toBeVisible();
        await captureDocsScreenshot(page, 'cookie-jar-empty');
      } catch (err) { console.log('docs screenshot cookie-jar-empty skipped:', err); }
    }

    await page.getByRole('button', { name: 'Environments' }).click();
    await page.getByLabel('New environment').click();
    await fillPrompt(page, 'New environment', 'Local Smoke');

    const envRows = page.getByTestId('environment-variable-row');
    await envRows.nth(0).getByLabel('Environment variable key').fill('baseUrl');
    await envRows.nth(0).getByLabel('Environment variable value').fill('https://api.kurlo.test');
    await expect(envRows).toHaveCount(2);
    await envRows.nth(1).getByLabel('Environment variable key').fill('token');
    await envRows.nth(1).getByRole('button', { name: 'Default' }).click();
    await envRows.nth(1).getByLabel('Environment variable value').fill('secret-e2e-token');
    await expect(page.locator('.environment-select')).toContainText('Local Smoke');
    await expect(page.locator('.environment-workspace').getByRole('button', { name: 'In use', exact: true })).toHaveCount(0);
    await tourPause(page, 'Environment created and activated');
    await waitForTransientToasts(page);
    await captureDocsScreenshot(page, 'environments-panel');

    await page.getByRole('button', { name: 'Collections' }).click();
    await page.locator('.collections-head-actions').getByLabel('Import collection').click();
    const importDialog = page.getByRole('dialog', { name: 'Import collection' });
    await expect(importDialog).toBeVisible();
    for (const source of ['Bruno / OpenCollection', 'Postman collection', 'Insomnia export', 'OpenAPI / Swagger', 'HAR from DevTools']) {
      await expect(importDialog).toContainText(source);
    }
    await captureDocsScreenshot(page, 'import-postman');
    await importDialog.getByRole('button', { name: 'Cancel' }).click();

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Smoke API');
    await expect(collectionRow(page, 'Smoke API')).toBeVisible();

    await collectionRow(page, 'Smoke API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Smoke API').locator('.collection-menu').getByRole('button', { name: 'Add folder' }).click();
    await fillPrompt(page, 'New folder', 'Auth');
    await expect(folderRow(page, 'Auth')).toBeVisible();
    await tourPause(page, 'Collection and folder created');

    await folderRow(page, 'Auth').getByLabel('Folder menu').click();
    await folderRow(page, 'Auth').locator('.folder-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await expect(page.getByLabel('Request name')).toBeVisible();

    await page.getByLabel('Request name').fill('Login user');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Method and protocol').click();
    await expect(page.getByRole('option', { name: 'GraphQL' })).toHaveCount(1);
    if (docsScreenshotDir) {
      try { await captureDocsScreenshot(page, 'request-protocol-picker'); } catch (err) { console.log('docs screenshot request-protocol-picker skipped:', err); }
    }
    await page.getByRole('option', { name: 'POST' }).click();
    await page.getByLabel('Request URL').fill('{{baseUrl}}/login');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.collection-request-wrap').filter({ hasText: 'Login user' })).toHaveCount(1);
    await page.getByLabel('Method and protocol').click();
    await expect(page.getByRole('option', { name: 'GraphQL' })).toBeVisible();
    await page.getByRole('option', { name: 'POST' }).click();

    await chooseRequestSection(page, 'Params');
    await page.getByTestId('params-row').first().locator('input[placeholder="Key"]').fill('scope');
    await page.getByTestId('params-row').first().locator('input[placeholder="Value"]').fill('smoke');

    await chooseRequestSection(page, 'Authorization');
    await page.getByLabel('Auth Type').click();
    await page.getByRole('button', { name: 'Bearer token' }).click();
    await page.locator('#bearer-token').fill('{{token}}');
    await captureDocsScreenshot(page, 'auth-bearer');
    if (docsScreenshotDir) {
      try {
        await page.getByLabel('Auth Type').click();
        await page.getByRole('button', { name: 'OAuth 2.0' }).click();
        await page.locator('#oauth2-url').fill('https://auth.kurlo.test/oauth/token');
        await page.locator('#oauth2-id').fill('kurlo-docs-client');
        await page.locator('#oauth2-secret').fill('<redacted>');
        await page.locator('#oauth2-scope').fill('openid profile');
        await captureDocsScreenshot(page, 'auth-oauth2-token-fetch');
        await page.getByLabel('Auth Type').click();
        await page.getByRole('button', { name: 'Bearer token' }).click();
        await page.locator('#bearer-token').fill('{{token}}');
      } catch (err) { console.log('docs screenshot auth-oauth2-token-fetch skipped:', err); }
    }

    await chooseRequestSection(page, 'Headers');
    await page.getByTestId('request-header-row').first().locator('input[placeholder="Key"]').fill('X-Trace');
    await page.getByTestId('request-header-row').first().locator('input[placeholder="Value"]').fill('kurlo-e2e');
    await captureDocsScreenshot(page, 'headers-tab');

    await chooseRequestSection(page, 'Body');
    await page.locator('label.body-mode-label').filter({ hasText: 'raw' }).click();
    const requestPassword = docsScreenshotDir ? '<redacted>' : 'visible-test';
    await fillCodeEditor(
      page,
      'request-body-editor',
      JSON.stringify({ username: 'codex', password: requestPassword }, null, 2),
    );
    const requestBodyEditor = page.getByTestId('request-body-editor').locator('.cm-content');
    await requestBodyEditor.click();
    await page.keyboard.type('x');
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect(requestBodyEditor).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(page.getByRole('dialog', { name: 'Delete request' })).toHaveCount(0);
    await expect(requestBodyEditor).not.toContainText(/x$/);

    await chooseRequestSection(page, 'Scripts');
    await fillCodeEditor(page, 'pre-request-script-editor', 'pm.variables.set("requestId", "e2e-login")');
    await captureDocsScreenshot(page, 'scripting-pre-request');
    await page.locator('.script-section').getByRole('tab', { name: /^Tests/ }).click();
    await fillCodeEditor(page, 'test-script-editor', 'pm.test("status is 200", () => pm.expect(pm.response.code).to.eql(200))');
    await tourPause(page, 'HTTP request configured');

    const panelDivider = page.getByLabel('Resize panels');
    const dividerSteps = docsScreenshotDir ? 8 : 24;
    for (let i = 0; i < dividerSteps; i += 1) await panelDivider.press('ArrowDown');
    await chooseRequestSection(page, 'Settings');
    await captureDocsScreenshot(page, 'request-settings');
    const browserEmulationSetting = page.locator('label.postman-setting').filter({ hasText: 'Browser request emulation' });
    await browserEmulationSetting.locator('.switch-control').click();
    await page.getByPlaceholder('http://localhost:5173').fill('https://app.kurlo.test');
    const corsSetting = page.locator('label.postman-setting').filter({ hasText: 'Enforce CORS' });
    await corsSetting.locator('.switch-control').click();
    const cspSetting = page.locator('label.postman-setting').filter({ hasText: 'Enforce CSP connect-src' });
    await cspSetting.locator('.switch-control').click();
    await page.locator('label.postman-setting-tall textarea').fill("default-src 'self'; connect-src https://api.kurlo.test");
    await captureDocsScreenshot(page, 'browser-security', page.locator('.settings-list'));
    await page.locator('.settings-actions').getByRole('button', { name: 'Reset' }).click();
    for (let i = 0; i < dividerSteps; i += 1) await panelDivider.press('ArrowUp');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    await expectResponseTabsToFit(page);
    await expect(page.locator('.test-results-panel')).toContainText('status is 200');
    await expect(page.locator('.test-results-panel')).toContainText('test script accepted');
    await expectScriptResultsPanelLayout(page);
    await captureDocsScreenshot(page, 'response-viewer-tests');
    await page.locator('.response-mini-tabs').getByRole('tab', { name: 'Body' }).click();
    await captureDocsScreenshot(page, 'response-viewer-json');
    await chooseRequestSection(page, 'Body');
    await captureDocsScreenshot(page, 'request-editor');
    if (docsScreenshotDir) {
      try {
        await page.getByRole('button', { name: 'Search response', exact: true }).click();
        await page.getByLabel('Search response body').fill('login-e2e');
        await expect(page.locator('.response-search-count')).toHaveText('1/1');
        await captureDocsScreenshot(page, 'response-viewer-search');
        await page.getByRole('button', { name: 'Search response', exact: true }).click();
      } catch (err) { console.log('docs screenshot response-viewer-search skipped:', err); }
    }
    if (docsScreenshotDir) {
      try {
        await page.locator('.response-status-bar').screenshot({ path: join(docsScreenshotDir, 'status-bar.png'), animations: 'disabled' });
      } catch (err) { console.log('docs screenshot status-bar skipped:', err); }
      try {
        await page.getByLabel('Code snippet', { exact: true }).click();
        await expect(page.locator('.curl-preview')).not.toContainText('Loading snippet', { timeout: 4000 });
        await captureDocsScreenshot(page, 'code-snippets');
        await page.getByLabel('Code snippet', { exact: true }).click();
      } catch (err) { console.log('docs screenshot code-snippets skipped:', err); }
    }
    await maybeCaptureResponseScreenshot(page);
    const responseBodyViewer = page.getByRole('textbox', { name: 'Response body', exact: true });
    await responseBodyViewer.click();
    await expect(responseBodyViewer).toBeFocused();
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+A`);
    await expect.poll(() => responseBodyViewer.evaluate((viewer) => {
      const selection = window.getSelection();
      return Boolean(
        selection?.toString().includes('"requestId": "login-e2e"')
        && selection.anchorNode
        && selection.focusNode
        && viewer.contains(selection.anchorNode)
        && viewer.contains(selection.focusNode)
      );
    })).toBe(true);
    await page.getByLabel('Save to file').click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedFiles.length)).toBe(1);

    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.locator('.history-entry').first()).toContainText('POST');
    await expect(page.locator('.history-entry').first()).toContainText('/login?scope=smoke');
    await expect(page.locator('.history-entry').first()).toContainText('200');
    const historyRow = page.locator('.request-history-entry').first();
    await expect(historyRow.locator('.history-time')).toBeVisible();
    expect(await historyRow.locator('.history-url').evaluate(element => element.clientWidth)).toBeGreaterThan(95);
    await historyRow.hover();
    await expect(historyRow.getByRole('button', { name: 'History request menu' })).toBeVisible();
    await expect(historyRow.locator('.history-time')).toBeHidden();
    await tourPause(page, 'HTTP response saved and history checked');
    await captureDocsScreenshot(page, 'history');

    await page.locator('.history-entry-main').first().click();
    const historyDetail = page.getByRole('region', { name: 'History entry' });
    await expect(historyDetail).toBeVisible();
    await expect(historyDetail.locator('.history-detail-title h1')).toContainText('Login user');
    await expect(historyDetail.locator('.history-detail-title')).toContainText('from Smoke API / Auth');
    await expect(historyDetail.locator('.history-detail-stats')).toContainText('200');
    await expect(historyDetail.locator('.history-detail-url')).toContainText('/login?scope=smoke');
    await expect(historyDetail.getByRole('textbox', { name: 'Response body' })).toContainText('"requestId": "login-e2e"');
    await expect(page.locator('.history-entry.active')).toHaveCount(1);
    await captureDocsScreenshot(page, 'history-detail');
    await clickTabClose(page.getByLabel('Close history entry'));
    await expect(historyDetail).toBeHidden();

    await page.getByRole('tab', { name: 'Overview' }).click();
    const recent = page.getByRole('region', { name: 'Continue where you left off' });
    await expect(recent).toContainText('Login user');
    await expect(recent).toContainText('Smoke API / Auth');
    await expect(recent).toContainText('200');
    await recent.locator('.overview-row', { hasText: 'Login user' }).click();
    await expect(page.getByLabel('Request URL')).toHaveValue(/\/login/);
    if (docsScreenshotDir) {
      try {
        await page.getByRole('button', { name: 'Cookies', exact: true }).click();
        const cookieModal = page.locator('.cookie-workspace');
        await cookieModal.getByRole('button', { name: 'Add cookie for api.kurlo.test' }).click();
        await cookieModal.getByRole('button', { name: 'Raw' }).click();
        await cookieModal.getByLabel('Raw cookie').fill('session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax');
        await cookieModal.getByRole('button', { name: 'Save' }).click();
        await expect(cookieModal.locator('.cookie-row')).toContainText('session');
        await captureDocsScreenshot(page, 'cookie-jar-populated');
      } catch (err) {
        console.log('docs screenshot cookie-jar-populated skipped:', err);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    await page.getByRole('button', { name: 'Collections' }).click();
    await folderRow(page, 'Auth').getByLabel('Folder menu').click();
    await folderRow(page, 'Auth').locator('.folder-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'GraphQL Request');
    await page.getByLabel('Request name').fill('Current user GraphQL');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('{{baseUrl}}/graphql');
    await fillCodeEditor(page, 'graphql-query-editor', 'query CurrentUser { me { id name } }');
    await page.getByRole('button', { name: 'Query', exact: true }).click();
    await expect(page.getByText('200 OK')).toBeVisible();
    await expectResponseTabsToFit(page);
    await page.locator('.response-mini-tabs').getByRole('tab', { name: 'Body' }).click();
    await expect(page.locator('.response-body-viewer')).toContainText('Kurlo Tester');
    await captureDocsScreenshot(page, 'request-graphql');
    await tourPause(page, 'GraphQL request sent');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.collection-request-wrap').filter({ hasText: 'Current user GraphQL' })).toHaveCount(1);

    await page.getByRole('button', { name: 'Collections' }).click();
    await folderRow(page, 'Auth').getByLabel('Folder menu').click();
    await folderRow(page, 'Auth').locator('.folder-menu').getByRole('button', { name: 'Run folder' }).click();
    await expect(page.getByRole('region', { name: 'Collection runner' })).toBeVisible();
    await expect(page.getByTestId('runner-request-row')).toHaveCount(2);
    const runnerCheck = page.getByTestId('runner-request-row').first().locator('.check');
    await expect(runnerCheck).toBeChecked();
    const lockedMark = await runnerCheck.evaluate(async (input: HTMLInputElement) => {
      input.disabled = true;
      await new Promise(requestAnimationFrame);
      await Promise.all(input.getAnimations({ subtree: true }).map(animation => animation.finished));
      const transform = getComputedStyle(input, '::before').transform;
      input.disabled = false;
      return transform;
    });
    expect(lockedMark).toBe('matrix(1, 0, 0, 1, 0, 0)');
    await page.getByRole('button', { name: /Run 2 requests/i }).click();
    await expect(page.getByTestId('runner-result-row')).toHaveCount(2);
    await expect(page.locator('.runner-results-summary')).toContainText('Passed');
    await expect(page.locator('.runner-results-summary')).toContainText('Requests 2/2');
    await page.getByRole('button', { name: 'Download report' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedFiles.length)).toBe(2);
    await tourPause(page, 'Runner finished and report downloaded');
    await captureDocsScreenshot(page, 'collection-runner-results');
    const storedRuns = await page.evaluate(() => (window.__kurloE2E.store as { collectionRuns?: Record<string, { results: unknown[] }> }).collectionRuns ?? {});
    expect(Object.values(storedRuns).map(run => run.results.length)).toEqual([2]);

    await page.getByRole('button', { name: 'Collections' }).click();
    await collectionRow(page, 'Smoke API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Smoke API').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.collection-last-run')).toContainText('Last run just now');
    await expect(page.locator('.collection-last-run')).toContainText('2 of 2 passed');
    await page.locator('.collection-last-run-link').click();
    await expect(page.getByRole('region', { name: 'Collection runner' })).toBeVisible();
    await expect(page.getByTestId('runner-result-row')).toHaveCount(2);

    await page.getByRole('button', { name: 'Collections' }).click();
    await folderRow(page, 'Auth').getByLabel('Folder menu').click();
    await folderRow(page, 'Auth').locator('.folder-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Live events SSE');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Method and protocol').click();
    await page.getByRole('option', { name: 'SSE' }).click();
    await page.getByLabel('Request URL').fill('{{baseUrl}}/events');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.sse-panel')).toContainText('Connected');
    await expect(page.locator('.sse-event-list')).toContainText('Kurlo stream is live');
    await captureDocsScreenshot(page, 'request-sse');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Collections' }).click();
    await collectionRow(page, 'Smoke API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Smoke API').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    await page.locator('.collection-settings-shell').getByRole('tab', { name: /^Headers/ }).click();
    const collectionHeaderRows = page.locator('.collection-kv-table .kv-row');
    await collectionHeaderRows.nth(0).locator('input[placeholder="Header"]').fill('X-Client');
    await collectionHeaderRows.nth(0).locator('input[placeholder="Value"]').fill('kurlo-docs');
    await collectionHeaderRows.nth(1).locator('input[placeholder="Header"]').fill('Accept');
    await collectionHeaderRows.nth(1).locator('input[placeholder="Value"]').fill('application/json');
    await page.locator('.collection-workspace-head p').first().click();
    await captureDocsScreenshot(page, 'collection-defaults');

    await addRequestFromFolder(page, 'Auth', 'gRPC Request');
    await page.getByLabel('Request name').fill('Inventory gRPC');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('gRPC target').fill('grpc.kurlo.test:443');
    await page.getByLabel('gRPC method').click();
    await expect(page.getByRole('option', { name: /Inventory \/ GetItem/ })).toBeVisible();
    await page.getByRole('option', { name: /Inventory \/ GetItem/ }).click();
    await fillCodeEditor(page, 'grpc-message-editor', JSON.stringify({ sku: 'sku-42' }, null, 2));
    await chooseRequestSection(page, 'Metadata');
    await page.locator('.kv-row').first().locator('input[placeholder="Metadata key"]').fill('x-client');
    await page.locator('.kv-row').first().locator('input[placeholder="Value"]').fill('playwright');
    await page.getByRole('button', { name: 'Invoke', exact: true }).click();
    await expect(page.locator('.response-status-bar')).toContainText('OK');
    await expect(page.locator('.grpc-message-list')).toContainText('sku-42');
    await expect(page.locator('.grpc-message-list')).toContainText('stock');
    await captureDocsScreenshot(page, 'request-grpc');
    await tourPause(page, 'gRPC discovery and invoke checked');

    await addRequestFromFolder(page, 'Auth', 'WebSocket Request');
    await page.getByLabel('Request name').fill('Chat WebSocket');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('wss://ws.kurlo.test/socket');
    await fillCodeEditor(page, 'websocket-message-editor', JSON.stringify({ hello: 'socket' }, null, 2));
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.ws-panel')).toContainText('Connected');
    await expect(page.locator('.ws-message-list')).toContainText('Connected to wss://ws.kurlo.test/socket');
    await page.locator('.ws-message-actions .ws-message-send').click();
    await expect(page.locator('.ws-message-list')).toContainText('hello');
    await expect(page.locator('.ws-message-list')).toContainText('echo');
    await captureDocsScreenshot(page, 'request-websocket');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    await tourPause(page, 'WebSocket connect, send, echo, disconnect checked');

    await addRequestFromFolder(page, 'Auth', 'Socket.IO Request');
    await page.getByLabel('Request name').fill('Socket.IO chat');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('https://io.kurlo.test');
    await page.locator('.sio-event-name-input').fill('chat:message');
    await page.getByRole('checkbox', { name: 'Ack' }).check();
    await fillCodeEditor(page, 'socketio-message-editor', JSON.stringify({ text: 'hello sio' }, null, 2));
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.sio-panel')).toContainText('Connected');
    await page.locator('.sio-editor-toolbar .ws-message-send').click();
    await expect(page.locator('.sio-panel .ws-message-list')).toContainText('chat:message');
    await expect(page.locator('.sio-panel .ws-message-list')).toContainText('ack for "chat:message"');
    await captureDocsScreenshot(page, 'request-socketio');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    await tourPause(page, 'Socket.IO connect, emit, ack, disconnect checked');

    if (docsScreenshotDir) {
      await page.getByRole('button', { name: 'Collections' }).click();
      try { await page.locator('aside.sidebar').screenshot({ path: join(docsScreenshotDir, 'sidebar-collections.png'), animations: 'disabled' }); } catch (err) { console.log('docs screenshot sidebar-collections skipped:', err); }
      try {
        await page.getByLabel('Workspace switcher').click({ timeout: 4000 });
        await captureDocsScreenshot(page, 'workspace-switcher');
        await page.keyboard.press('Escape');
      } catch (err) { console.log('docs screenshot workspace-switcher skipped:', err); }
      try {
        await page.getByLabel('Workspace switcher').click({ timeout: 4000 });
        await page.getByRole('button', { name: 'View all workspaces' }).click({ timeout: 4000 });
        await page.getByRole('button', { name: 'Write README' }).click();
        const readmeRegion = page.getByRole('region', { name: 'README' });
        const workspaceNotes = readmeRegion.getByRole('textbox', { name: 'README', exact: true });
        const finishReadme = async () => {
          const save = readmeRegion.getByRole('button', { name: 'Save', exact: true });
          if (await save.isVisible()) await save.click();
          else await readmeRegion.getByRole('button', { name: 'Done' }).click();
        };
        await workspaceNotes.fill(
          [
            'Staging base URL: https://api.kurlo.test',
            'Auth: run Login user first — it writes {{token}} into the environment.',
            'Run the Smoke API collection before tagging a release.',
          ].join('\n'),
        );
        await finishReadme();
        await expect(readmeRegion.locator('.overview-readme-body br')).toHaveCount(2);
        await page.locator('.workspace-overview').evaluate((overview) => { overview.scrollTop = 0; });
        await captureDocsScreenshot(page, 'workspace-overview');
        await readmeRegion.getByRole('button', { name: 'Edit', exact: true }).click();
        await workspaceNotes.fill('');
        await finishReadme();
        await page.getByLabel('Open Git and storage status').click({ timeout: 4000 });
        await expect(page.locator('.git-workspace')).toContainText('feature/docs-refresh');
        await page.locator('.git-file-open').first().click();
        await expect(page.locator('.git-diff')).toContainText('oauth2RefreshToken');
        await captureDocsScreenshot(page, 'git-workspace');
      } catch (err) { console.log('docs screenshot workspace-overview skipped:', err); }
      try {
        await page.locator('.status-search-btn').click({ timeout: 4000 });
        await expect(page.getByRole('dialog', { name: 'Search requests, chats and commands' })).toBeVisible({ timeout: 4000 });
        await captureDocsScreenshot(page, 'global-search');
        await page.keyboard.press('Escape');
      } catch (err) { console.log('docs screenshot global-search skipped:', err); }
      await page.keyboard.press('Escape');
    }

    await page.getByLabel('Settings', { exact: true }).click();
    if (docsScreenshotDir) {
      try {
        await page.getByRole('tab', { name: 'General', exact: true }).click({ timeout: 4000 });
        await captureDocsScreenshot(page, 'settings-general');
      } catch (err) { console.log('docs screenshot settings-general skipped:', err); }
      try { await page.getByRole('tab', { name: 'Appearance', exact: true }).click({ timeout: 4000 }); await captureDocsScreenshot(page, 'settings-theme'); } catch (err) { console.log('docs screenshot settings-theme skipped:', err); }
      try { await page.getByRole('tab', { name: 'Shortcuts', exact: true }).click({ timeout: 4000 }); await captureDocsScreenshot(page, 'settings-shortcuts'); } catch (err) { console.log('docs screenshot settings-shortcuts skipped:', err); }
      try { await page.getByRole('tab', { name: 'About', exact: true }).click({ timeout: 4000 }); await captureDocsScreenshot(page, 'settings-updates-dev'); } catch (err) { console.log('docs screenshot settings-updates-dev skipped:', err); }
      try { await page.getByRole('tab', { name: 'About', exact: true }).click({ timeout: 4000 }); await captureDocsScreenshot(page, 'settings-about'); } catch (err) { console.log('docs screenshot settings-about skipped:', err); }
    }
    await page.getByRole('tab', { name: 'Proxy', exact: true }).click();
    await page.getByRole('radio', { name: 'On', exact: true }).check();
    await page.locator('#proxy-hostname').fill('proxy.corp.example');
    await page.locator('#proxy-port').fill('8080');
    await page.locator('#proxy-bypass').fill('localhost, 127.0.0.1, .internal');
    await captureDocsScreenshot(page, 'settings-proxy');

    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await page.getByRole('button', { name: 'Export all data', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Export all data' })).toBeVisible();
    await captureDocsScreenshot(page, 'backup-export-warning');
    await page.getByRole('dialog', { name: 'Export all data' }).getByRole('button', { name: 'Cancel' }).click();
    await page.getByLabel('Close settings').click();

    const state = await page.evaluate(() => window.__kurloE2E);
    expect(state.sentRequests).toHaveLength(4);
    const sentTo = (target: string) => state.sentRequests.some(req => {
      try {
        const url = new URL(String(req.url));
        return `${url.origin}${url.pathname}` === target;
      } catch {
        return false;
      }
    });
    expect(sentTo('https://api.kurlo.test/login')).toBe(true);
    expect(sentTo('https://api.kurlo.test/graphql')).toBe(true);
    expect(state.sentRequests.some(req => String(req.body).includes(requestPassword))).toBe(true);
    expect(state.sseConnects).toHaveLength(1);
    expect(state.grpcDiscoveries.some(req => String(req.target).includes('grpc.kurlo.test:443'))).toBe(true);
    expect(state.sentGrpcRequests.some(req => String(req.fullMethod).includes('shop.Inventory/GetItem'))).toBe(true);
    expect(state.webSocketConnects).toHaveLength(1);
    expect(state.webSocketMessages.some(entry => String(entry.message?.data).includes('hello'))).toBe(true);
    expect(state.socketIOConnects).toHaveLength(1);
    expect(state.socketIOEmits.some(entry => entry.message?.eventName === 'chat:message')).toBe(true);
    expect(state.savedStores.length).toBeGreaterThan(4);
    expect(state.savedFiles.some(file => file.content.includes('Kurlo collection runner report'))).toBe(true);
  });
});
