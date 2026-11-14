import type { E2EWindow } from './support/bridge';
import { chooseRequestType, collectionRow, fillPrompt, folderRow } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

import { captureDocsScreenshot, waitForTransientToasts } from './support/screenshots';

import { expect, test } from '@playwright/test';

import { mkdir } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('captures load testing documentation', async ({ page }) => {
    test.skip(!docsScreenshotDir, 'Set KURLO_DOCS_SCREENSHOT_DIR to capture documentation');
    await mkdir(docsScreenshotDir, { recursive: true });
    await page.setViewportSize({ width: 1360, height: 1040 });
    await installKurloBridge(page, '', 'browser/e2e', true, {
      workspaces: [{ id: 'workspace-e2e', name: 'Shop API', filesystemName: 'Shop-API', description: '' }],
      activeEnvironmentId: 'env-staging',
      environments: [{ id: 'env-staging', workspaceId: 'workspace-e2e', name: 'Staging', values: [
        { id: 'base-url', key: 'baseUrl', value: 'https://shop.kurlo.test', enabled: true },
        { id: 'password', key: 'password', value: '', enabled: true, secret: true },
      ] }],
      collections: [{ id: 'col-shop', workspaceId: 'workspace-e2e', name: 'Checkout API', loadTests: [{
        id: 'lt-docs', name: 'Checkout flow', settings: { environment: 'Staging' },
        data: { path: 'data/users.csv', mode: 'per-vu' },
        scenarios: [{ id: 'main', name: 'Flow', executor: { type: 'ramping-vus', stages: [
          { durationMs: 120000, target: 50 }, { durationMs: 600000, target: 50 }, { durationMs: 60000, target: 0 },
        ] }, steps: [
          { id: 'step-login', requestId: 'req-login', once: true, extract: [{ var: 'token', from: 'json', path: '$.access_token' }], checks: [{ type: 'status', value: '200' }] },
          { id: 'step-orders', requestId: 'req-orders', thinkTimeMs: 500, thinkJitterMs: 1000, checks: [{ type: 'status', value: '200' }] },
        ] }],
        thresholds: [
          { metric: 'http_req_duration', stat: 'p(95)', op: '<', value: 500 },
          { metric: 'http_req_failed', stat: 'rate', op: '<', value: 0.01 },
          { metric: 'checks', stat: 'rate', op: '>', value: 0.99 },
        ],
      }] }],
      requests: [
        { id: 'req-login', collectionId: 'col-shop', collection: 'Checkout API', name: 'Login', requestType: 'http', method: 'POST', url: '{{baseUrl}}/login', auth: { type: 'none' }, bodyType: 'raw', rawBodyType: 'json', bodyContent: '{"email":"{{email}}","password":"{{password}}"}' },
        { id: 'req-orders', collectionId: 'col-shop', collection: 'Checkout API', name: 'List orders', requestType: 'http', method: 'GET', url: '{{baseUrl}}/orders', auth: { type: 'bearer', bearerToken: '{{token}}' } },
      ],
    });
    await page.goto('/');
    await page.locator('.collection-request-wrap').filter({ hasText: 'Checkout flow' }).click();
    const editor = page.locator('section[aria-label="Load test"]');
    const captureWorkspace = async (name: string) => {
      await waitForTransientToasts(page);
      let header = await editor.locator('.loadtest-head').boundingBox();
      let content = await editor.locator('.loadtest-content').boundingBox();
      expect(header).not.toBeNull();
      expect(content).not.toBeNull();
      if (!header || !content) return;
      const viewport = page.viewportSize() ?? DOCS_VIEWPORT;
      if (content.y + content.height + 48 > viewport.height) {
        await page.setViewportSize({ width: viewport.width, height: Math.ceil(content.y + content.height + 48) });
        header = await editor.locator('.loadtest-head').boundingBox();
        content = await editor.locator('.loadtest-content').boundingBox();
      }
      if (!header || !content) return;
      await page.screenshot({
        path: join(docsScreenshotDir, `${name}.png`), animations: 'disabled',
        clip: { x: header.x - 20, y: header.y - 20, width: header.width + 40, height: content.y + content.height - header.y + 40 },
      });
    };
    await expect(editor.getByLabel('Load test name')).toHaveValue('Checkout flow');
    await expect(editor.getByLabel('Variable name')).toHaveValue('token');
    await captureWorkspace('load-testing-flow');
    await editor.getByRole('tab', { name: /Load & thresholds/ }).click();
    await expect(editor.locator('.loadtest-threshold')).toHaveCount(3);
    await captureWorkspace('load-testing-profile');
    await editor.getByRole('tab', { name: 'Data & options' }).click();
    await expect(editor.getByRole('table', { name: 'Test data preview' })).toContainText('ada@shop.test');
    await captureWorkspace('load-testing-data');
    await editor.getByRole('button', { name: 'Export k6 script' }).click();
    const exportDialog = page.getByRole('dialog', { name: 'Export to k6' });
    await expect(exportDialog.locator('.cm-content')).not.toBeEmpty();
    await captureDocsScreenshot(page, 'load-testing-export');
    await exportDialog.press('Escape');
    await page.evaluate(() => { (window.__kurloE2E as unknown as { k6Found: boolean }).k6Found = false; });
    await editor.getByRole('button', { name: 'Run with k6' }).click();
    const missing = page.getByRole('dialog', { name: 'k6 is not installed' });
    await expect(missing).toBeVisible();
    await captureDocsScreenshot(page, 'load-testing-k6-missing');
    await page.evaluate(() => { (window.__kurloE2E as unknown as { k6Found: boolean }).k6Found = true; });
    await missing.getByRole('button', { name: 'Check again' }).click();
    await editor.getByRole('button', { name: 'Run with k6' }).click();
    await page.getByRole('dialog', { name: 'Run load test' }).getByRole('button', { name: 'Run load test' }).click();
    await page.evaluate(() => {
      const started = Date.UTC(2026, 9, 30, 9, 0);
      window.__kurloE2E.emit('load:progress', {
        running: true, stopping: false, loadTestId: 'lt-docs', collectionId: 'col-shop', startedAt: started,
        plannedMs: 780000, dashboardUrl: 'http://127.0.0.1:5665', k6Version: 'v1.3.0',
        progress: { elapsedMs: 312000, vus: 50, maxVUs: 50, iterations: 4210, interrupted: 0 },
      });
      for (const line of ['execution: local', 'scenario: main, ramping-vus, up to 50 users', 'running (05m12.0s), 50/50 VUs, 4210 complete and 0 interrupted iterations']) {
        window.__kurloE2E.emit('load:log', line);
      }
    });
    await expect(editor.locator('.loadrun-progress')).toContainText('4,210');
    await expect(editor.locator('.loadrun-log')).toContainText('4210 complete');
    await captureWorkspace('load-testing-run');
    await page.evaluate(() => {
      const started = Date.UTC(2026, 9, 30, 9, 0);
      window.__kurloE2E.emit('load:progress', { running: false, stopping: false, loadTestId: 'lt-docs', collectionId: 'col-shop', startedAt: started, plannedMs: 780000, dashboardUrl: '', k6Version: 'v1.3.0', progress: { elapsedMs: 780000, vus: 0, maxVUs: 50, iterations: 10000, interrupted: 0 } });
      window.__kurloE2E.emit('load:done', {
        loadTestId: 'lt-docs', collectionId: 'col-shop', loadTestName: 'Checkout flow', environment: 'Staging', k6Version: 'v1.3.0', status: 'passed', exitCode: 0,
        startedAt: started, finishedAt: started + 780000, hasReport: true, hasSummary: true,
        thresholds: [
          { metric: 'http_req_duration', expression: 'p(95)<500', ok: true, actual: 212.4, hasActual: true },
          { metric: 'http_req_failed', expression: 'rate<0.01', ok: true, actual: 0.002, hasActual: true },
          { metric: 'checks', expression: 'rate>0.99', ok: true, actual: 0.998, hasActual: true },
        ],
        totals: { requests: 10050, rps: 12.88, avg: 90, med: 74, p95: 212.4, p99: 300, max: 900, failedRate: 0.002, failedCount: 20, checksPassed: 10030, checksFailed: 20, iterations: 10000, interrupted: 0, maxVUs: 50 },
        steps: [
          { stepId: 'step-login', tag: 'login', requests: 50, med: 120, p95: 240, p99: 310, failedRate: 0, checksRate: 1, checksPassed: 50, checksFailed: 0 },
          { stepId: 'step-orders', tag: 'list_orders', requests: 10000, med: 74, p95: 212.4, p99: 300, failedRate: 0.002, checksRate: 0.998, checksPassed: 9980, checksFailed: 20 },
        ],
      });
    });
    await expect(editor.locator('.loadrun-banner')).toContainText('All pass criteria met');
    await captureWorkspace('load-testing-result');
  });

  test('creates a load test from the unsaved request snapshot', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Snapshot API');
    await collectionRow(page, 'Snapshot API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Snapshot API').getByRole('button', { name: 'Add request', exact: true }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('http://127.0.0.1:18080/old');
    await page.locator('.save-btn:not(.revert-btn)').first().click();
    await expect(page.locator('.save-btn:not(.revert-btn)').first()).toBeDisabled();
    await page.getByLabel('Request name', { exact: true }).fill('стресс');
    await page.getByLabel('Request URL').fill('http://127.0.0.1:18080/work');
    const request = page.locator('.collection-request-wrap').filter({ hasText: 'New Request' });
    await expect(request).toBeVisible();
    await request.hover();
    await request.getByLabel('Request menu').click();
    await request.getByRole('button', { name: 'Load test this request' }).click();
    const editor = page.locator('section[aria-label="Load test"]');
    await expect(editor.getByLabel('Load test name')).toHaveValue('New load test');
    await expect(editor.locator('.loadtest-step-main')).toContainText('стресс');
    await page.evaluate(() => {
      (window as E2EWindow).go.api.App.ExportLoadTestK6 = async (payload: string) => {
        const data = JSON.parse(payload) as { requests: Array<{ name: string; url: string }> };
        window.__kurloE2E.calls.push(`snapshot:${data.requests[0].name}:${data.requests[0].url}`);
        return { script: 'export default function () {}', fileName: 'stress.k6.js', warnings: [], steps: [], error: '' };
      };
    });
    await editor.getByRole('button', { name: 'Export k6 script' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('snapshot:')))).toEqual(['snapshot:стресс:http://127.0.0.1:18080/work']);
  });

  test('shows load flow errors beside the invalid extraction and check rows', async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 1100 });
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-fields', workspaceId: 'workspace-e2e', name: 'Fields API', loadTests: [{
        id: 'lt-fields', name: 'Field validation', scenarios: [{ id: 'main', name: 'Flow', executor: { type: 'constant-vus', vus: 2, durationMs: 60000 }, steps: [{ id: 'step-fields', requestId: 'req-fields' }] }],
      }] }],
      requests: [{ id: 'req-fields', collectionId: 'col-fields', collection: 'Fields API', name: 'Work', requestType: 'http', method: 'GET', url: 'http://127.0.0.1:18080/work' }],
    });
    await page.goto('/');
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
      (window as E2EWindow).go.api.App.ValidateLoadTest = async draft => {
        const errors: string[] = [];
        const step = draft.scenarios[0].steps[0];
        for (const extract of step.extract ?? []) {
          if (!extract.var) errors.push('Step 1: "" is not a valid variable name. Use letters, digits and _, not starting with a digit.');
          if (!extract.path.startsWith('$')) errors.push(`Step 1: the JSON path for ${extract.var} must start with $.`);
        }
        for (const check of step.checks ?? []) if (Number(check.value) > 599) errors.push('Step 1: the expected status must be a number from 100 to 599.');
        return errors;
      };
    });
    await page.locator('.collection-request-wrap').filter({ hasText: 'Field validation' }).click();
    const editor = page.locator('section[aria-label="Load test"]');
    await editor.getByRole('button', { name: 'Save a value' }).click();
    await expect(editor.getByLabel('Variable name')).toHaveAttribute('aria-invalid', 'true');
    await editor.getByRole('button', { name: 'Save a value' }).click();
    await editor.getByLabel('Variable name').nth(1).fill('token');
    await editor.getByRole('textbox', { name: 'Path', exact: true }).nth(1).fill('invalid');
    await expect(editor.getByRole('textbox', { name: 'Path', exact: true }).nth(1)).toHaveAttribute('aria-invalid', 'true');
    await editor.getByRole('button', { name: 'Add check' }).click();
    await editor.getByRole('button', { name: 'Add check' }).click();
    await editor.getByLabel('Expected value').nth(1).fill('999');
    await expect(editor.getByLabel('Expected value').nth(1)).toHaveAttribute('aria-invalid', 'true');
    await expect(editor.getByLabel('Expected value').first()).toHaveAttribute('aria-invalid', 'false');
    const rules = editor.locator('.loadtest-rule');
    await expect(rules.nth(0)).toContainText('not a valid variable name');
    await expect(rules.nth(1)).toContainText('JSON path for token');
    await expect(rules.nth(2).locator('.loadtest-errors')).toHaveCount(0);
    await expect(rules.nth(3)).toContainText('expected status');
    await expect(editor.locator('.loadtest-step-picker .loadtest-errors')).toHaveCount(0);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-flow-field-errors.png'), animations: 'disabled' });
  });

  test('keeps load-test navigation responsive during a 60000-line log flood', async ({ page }) => {
    test.setTimeout(45000);
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-flood', workspaceId: 'workspace-e2e', name: 'Flood API', loadTests: [{
        id: 'lt-flood', name: 'Log flood', scenarios: [{ id: 'main', name: 'Flow', executor: { type: 'constant-arrival-rate', rate: 1000, durationMs: 60000, preAllocatedVUs: 128, maxVUs: 256 }, steps: [{ id: 'step-flood', requestId: 'req-flood' }] }],
      }] }],
      requests: [{ id: 'req-flood', collectionId: 'col-flood', collection: 'Flood API', name: 'Work', requestType: 'http', method: 'GET', url: 'http://127.0.0.1:18080/work' }],
    });
    await page.goto('/');
    await page.locator('.collection-request-wrap').filter({ hasText: 'Log flood' }).click();
    const editor = page.locator('section[aria-label="Load test"]');
    await page.evaluate(() => window.__kurloE2E.emit('load:progress', { running: true, stopping: false, loadTestId: 'lt-flood', collectionId: 'col-flood', startedAt: Date.now(), plannedMs: 60000, dashboardUrl: '', k6Version: 'v1.4.2', progress: { elapsedMs: 18000, vus: 20, maxVUs: 128, iterations: 18000, interrupted: 0 } }));
    await editor.getByRole('tab', { name: /Results/ }).click();
    const flood = page.evaluate(async () => {
      let sent = 0;
      await new Promise<void>(resolve => {
        const timer = setInterval(() => {
          const lines = Array.from({ length: 1000 }, (_, index) => `Request Failed ${sent + index}: ${'network failure '.repeat(20)}`);
          window.__kurloE2E.emit('load:logs', lines);
          sent += lines.length;
          if (sent >= 60000) { clearInterval(timer); resolve(); }
        }, 50);
      });
    });
    await expect(editor.locator('.loadrun-log')).toContainText('Request Failed', { timeout: 2000 });
    await editor.getByRole('tab', { name: /Flow/ }).click({ timeout: 2000 });
    await expect(editor.getByRole('radio', { name: 'Every iteration' })).toBeVisible({ timeout: 2000 });
    await editor.getByRole('tab', { name: /Load & thresholds/ }).click({ timeout: 2000 });
    await editor.getByRole('tab', { name: /Results/ }).click({ timeout: 2000 });
    await editor.getByRole('button', { name: 'Stop', exact: true }).click({ timeout: 2000 });
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.includes('StopLoadRun'))).toBe(true);
    await flood;
    await expect(editor.locator('.loadrun-log')).toContainText('Request Failed 59999');
    expect((await editor.locator('.loadrun-log').textContent())!.split('\n')).toHaveLength(500);
    await page.evaluate(() => window.__kurloE2E.emit('load:progress', { running: false, stopping: false, loadTestId: 'lt-flood', collectionId: 'col-flood', startedAt: Date.now() - 10000, plannedMs: 60000, dashboardUrl: '', k6Version: 'v1.4.2', progress: { elapsedMs: 10000, vus: 0, maxVUs: 128, iterations: 10000, interrupted: 0 } }));
    await page.evaluate(() => window.__kurloE2E.emit('load:done', { loadTestId: 'lt-flood', collectionId: 'col-flood', loadTestName: 'Log flood', status: 'stopped', exitCode: 105, k6Version: 'v1.4.2', startedAt: Date.now() - 10000, finishedAt: Date.now(), hasReport: false, hasSummary: false, thresholds: [], steps: [] }));
    await expect(editor.locator('.loadrun-banner')).toContainText('Stopped before the end');
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-log-flood.png'), animations: 'disabled' });
  });

  test('keeps load parameter columns stable when a long pool error appears', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-pool', workspaceId: 'workspace-e2e', name: 'Pool API', loadTests: [{
        id: 'lt-pool', name: 'Pool test', scenarios: [{ id: 'main', name: 'Flow', executor: { type: 'constant-arrival-rate', rate: 1000, durationMs: 60000, preAllocatedVUs: 128, maxVUs: 256 }, steps: [{ id: 'step-pool', requestId: 'req-pool' }] }],
      }] }],
      requests: [{ id: 'req-pool', collectionId: 'col-pool', collection: 'Pool API', name: 'Work', requestType: 'http', method: 'GET', url: 'http://127.0.0.1:18080/work' }],
    });
    await page.goto('/');
    await page.evaluate(() => {
      (window as E2EWindow).go.api.App.ValidateLoadTest = async draft => {
        const pool = draft.scenarios[0].executor;
        return pool.maxVUs! < pool.preAllocatedVUs! ? ['The virtual user limit is lower than the number prepared.'] : [];
      };
    });
    await page.locator('.collection-request-wrap').filter({ hasText: 'Pool test' }).click();
    const editor = page.locator('section[aria-label="Load test"]');
    await editor.getByRole('tab', { name: /Load & thresholds/ }).click();
    const prepared = editor.getByRole('spinbutton', { name: 'Users prepared', exact: true });
    const maximum = editor.getByRole('spinbutton', { name: 'Users at most', exact: true });
    for (const width of [1360, 1100, 900]) {
      await page.setViewportSize({ width, height: 1100 });
      await maximum.fill('256');
      await expect(maximum).toHaveAttribute('aria-invalid', 'false');
      const before = await maximum.boundingBox();
      const preparedBefore = await prepared.boundingBox();
      await maximum.fill('2');
      await expect(maximum).toHaveAttribute('aria-invalid', 'true');
      const message = editor.getByText('The virtual user limit is lower than the number prepared.', { exact: true });
      await expect(message).toBeVisible();
      expect(await maximum.boundingBox()).toEqual(before);
      expect(await prepared.boundingBox()).toEqual(preparedBefore);
      const errorBounds = (await message.boundingBox())!;
      expect(errorBounds.x).toBeGreaterThanOrEqual(before!.x - 1);
      expect(errorBounds.x + errorBounds.width).toBeLessThanOrEqual(before!.x + before!.width + 1);
      expect(errorBounds.y).toBeGreaterThanOrEqual(before!.y + before!.height);
      await page.screenshot({ path: join(tmpdir(), `kurlo-load-pool-error-${width}.png`), animations: 'disabled' });
    }
  });

  test('shows the active load preset and validates fields without moving tabs', async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 1040 });
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-profile', workspaceId: 'workspace-e2e', name: 'Profile API', loadTests: [{
        id: 'lt-profile', name: 'Profile test', scenarios: [{ id: 'main', name: 'Flow', executor: { type: 'constant-vus', vus: 2, durationMs: 60000 }, steps: [{ id: 'step-get', requestId: 'req-get' }] }],
        thresholds: [{ metric: 'checks', stat: 'rate', op: '>', value: 0.99 }],
      }] }],
      requests: [{ id: 'req-get', collectionId: 'col-profile', collection: 'Profile API', name: 'Get orders', requestType: 'http', method: 'GET', url: 'http://localhost:8080/', auth: { type: 'none' } }],
    });
    await page.goto('/');
    await page.evaluate(() => {
      (window as E2EWindow).go.api.App.ValidateLoadTest = async draft => {
        const problems: string[] = [];
        if (!draft.name.trim()) problems.push('The load test needs a name.');
        if (!draft.scenarios[0].executor.vus) problems.push('Set the number of virtual users.');
        if (draft.thresholds![0].value > 1) problems.push('Threshold 1: the limit is out of range.');
        return problems;
      };
    });
    await page.locator('.collection-request-wrap').filter({ hasText: 'Profile test' }).click();
    const editor = page.locator('section[aria-label="Load test"]');
    await editor.getByRole('tab', { name: /Load & thresholds/ }).click();
    const smoke = editor.getByRole('button', { name: /^Smoke/ });
    await expect(smoke).toHaveAttribute('aria-pressed', 'true');
    await smoke.click();
    const tabs = editor.getByRole('tablist');
    const top = (await tabs.boundingBox())!.y;
    const users = editor.getByRole('spinbutton', { name: 'Virtual users', exact: true });
    await users.fill('0');
    await expect(users).toHaveAttribute('aria-invalid', 'true');
    await expect(editor.getByText('Set the number of virtual users.', { exact: true })).toBeVisible();
    await expect(smoke).toHaveAttribute('aria-pressed', 'false');
    const custom = editor.locator('.loadtest-preset-custom');
    await expect(custom).toHaveClass(/active/);
    await expect(custom).toContainText('your own settings, not a preset');
    expect((await tabs.boundingBox())!.y).toBe(top);
    await expect(editor.locator('.loadtest-problems')).toHaveCount(0);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-inline-validation.png'), animations: 'disabled' });
    await users.fill('2');
    await expect(users).toHaveAttribute('aria-invalid', 'false');
    await expect(smoke).toHaveAttribute('aria-pressed', 'true');
    await expect(custom).not.toHaveClass(/active/);
    expect((await tabs.boundingBox())!.y).toBe(top);
    await editor.getByRole('spinbutton', { name: 'Limit', exact: true }).fill('101');
    await expect(editor.getByRole('spinbutton', { name: 'Limit', exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(editor.getByText('Threshold 1: the limit is out of range.', { exact: true })).toBeVisible();
    expect((await tabs.boundingBox())!.y).toBe(top);
    await editor.getByRole('spinbutton', { name: 'Limit', exact: true }).fill('99');
    await expect(editor.getByRole('spinbutton', { name: 'Limit', exact: true })).toHaveAttribute('aria-invalid', 'false');
    await editor.getByRole('tab', { name: /Flow/ }).click();
    await editor.getByRole('tab', { name: /Load & thresholds/ }).click();
    await expect(smoke).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-smoke-selected.png'), animations: 'disabled' });
    const name = editor.getByRole('textbox', { name: 'Load test name', exact: true });
    expect((await name.boundingBox())!.width).toBeLessThanOrEqual(190);
    const headerBounds = await editor.locator('.loadtest-head').boundingBox();
    const environmentBounds = await editor.getByRole('button', { name: /^Environment:/ }).boundingBox();
    const runBounds = await editor.getByRole('button', { name: 'Run with k6', exact: true }).boundingBox();
    expect(environmentBounds!.x).toBeGreaterThan((await name.boundingBox())!.x + 190);
    expect(environmentBounds!.x + environmentBounds!.width).toBeLessThanOrEqual(runBounds!.x);
    expect(Math.round(runBounds!.x + runBounds!.width)).toBe(Math.round(headerBounds!.x + headerBounds!.width));
    await name.fill('Discard this rename');
    await users.fill('7');
    await editor.getByRole('button', { name: 'Revert unsaved changes', exact: true }).click();
    await expect(name).toHaveValue('Profile test');
    await expect(users).toHaveValue('2');
    await expect(editor.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    await expect(editor.getByRole('button', { name: 'Revert unsaved changes', exact: true })).toBeDisabled();
    await name.fill('Renamed load test');
    await name.press('Enter');
    await expect(name).not.toBeFocused();
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => {
      const store = window.__kurloE2E.store as { collections: Array<{ id: string; loadTests: Array<{ name: string }> }> };
      return store.collections.find(collection => collection.id === 'col-profile')?.loadTests[0]?.name;
    })).toBe('Renamed load test');
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-compact-header.png'), animations: 'disabled' });
  });

  test('keeps a new load test in its own tab and asks before closing it once edited', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-tab', workspaceId: 'workspace-e2e', name: 'Tab API' }],
      requests: [
        { id: 'req-tab-a', collectionId: 'col-tab', collection: 'Tab API', name: 'List items', requestType: 'http', method: 'GET', url: 'https://shop.kurlo.test/items', auth: { type: 'none' } },
        { id: 'req-tab-b', collectionId: 'col-tab', collection: 'Tab API', folderPath: ['Orders'], name: 'Create order', requestType: 'http', method: 'POST', url: 'https://shop.kurlo.test/orders', auth: { type: 'none' } },
        { id: 'req-tab-c', collectionId: 'col-tab', collection: 'Tab API', folderPath: ['Orders'], name: 'Order feed', requestType: 'ws', method: 'GET', url: 'wss://shop.kurlo.test/orders', auth: { type: 'none' } },
      ],
    });
    await page.goto('/');
    await collectionRow(page, 'Tab API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Tab API').getByRole('button', { name: 'New load test', exact: true }).click();
    const editor = page.locator('section[aria-label="Load test"]');
    const tab = page.locator('.loadtest-tab');
    await expect(tab).toContainText('New load test');
    await expect(tab).toHaveClass(/unsaved/);
    await editor.getByLabel('Load test name').fill('Draft check');
    await expect(tab).toContainText('Draft check');
    await page.locator('.collection-request-wrap').filter({ hasText: 'List items' }).locator('.collection-request').click();
    await expect(editor).toHaveCount(0);
    await expect(tab).toContainText('Draft check');
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-test-tab.png'), animations: 'disabled' });
    await tab.getByRole('tab').click();
    await expect(editor.getByLabel('Load test name')).toHaveValue('Draft check');
    await tab.getByRole('button', { name: 'Close load test tab' }).click();
    const dialog = page.getByRole('dialog', { name: 'Unsaved changes' });
    await expect(dialog).toContainText('Save changes to "Draft check"?');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(tab).toBeVisible();
    await tab.getByRole('button', { name: 'Close load test tab' }).click();
    await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: "Don't Save", exact: true }).click();
    await expect(tab).toHaveCount(0);
    await expect(page.locator('.collection-request-wrap').filter({ hasText: 'Draft check' })).toHaveCount(0);
    await collectionRow(page, 'Tab API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Tab API').getByRole('button', { name: 'New load test', exact: true }).click();
    await expect(tab).toHaveClass(/unsaved/);
    await tab.getByRole('button', { name: 'Close load test tab' }).click();
    await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toHaveCount(0);
    await expect(tab).toHaveCount(0);
    await expect(page.locator('.collection-request-wrap').filter({ hasText: 'New load test' })).toHaveCount(0);
    await collectionRow(page, 'Tab API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Tab API').getByRole('button', { name: 'New load test', exact: true }).click();
    await editor.getByLabel('Load test name').fill('Smoke');
    await tab.getByRole('button', { name: 'Close load test tab' }).click();
    await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(tab).toHaveCount(0);
    await expect(page.locator('.collection-request-wrap').filter({ hasText: 'Smoke' })).toHaveCount(1);
    await expect(page.locator('.sidebar-loadtest-group')).toContainText('Load tests');
    await page.locator('.sidebar-loadtest-group').screenshot({ path: join(tmpdir(), 'kurlo-load-sidebar-group.png'), animations: 'disabled' });
    await folderRow(page, 'Orders').getByLabel('Folder menu').click();
    await folderRow(page, 'Orders').locator('.folder-menu').getByRole('button', { name: 'New load test from folder' }).click();
    await expect(editor.locator('.loadtest-step-main')).toHaveCount(1);
    await expect(editor.locator('.loadtest-step-main')).toContainText('Create order');
    await expect(editor.getByLabel('Load test name')).toHaveValue('New load test');
  });

  test('keeps long load-test request menus inside the editor', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 620 });
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-many', workspaceId: 'workspace-e2e', name: 'Many requests' }],
      requests: Array.from({ length: 40 }, (_, index) => ({
        id: `req-many-${index}`, collectionId: 'col-many', collection: 'Many requests', name: `Request ${index + 1}`, requestType: 'http', method: 'GET', url: `https://shop.kurlo.test/${index}`, auth: { type: 'none' },
      })),
    });
    await page.goto('/');
    await collectionRow(page, 'Many requests').getByLabel('Collection menu').click();
    await collectionRow(page, 'Many requests').getByRole('button', { name: 'New load test', exact: true }).click();
    const editor = page.locator('section[aria-label="Load test"]');
    await expect(editor.getByLabel('Load test name')).toHaveValue('New load test');
    await expect(editor.locator('.loadtest-step-main')).toHaveCount(40);
    await expect(page.locator('.collection-request-wrap').filter({ hasText: 'New load test' })).toHaveCount(0);
    for (let index = 0; index < 40; index += 1) await editor.getByRole('button', { name: 'Remove step', exact: true }).first().click();
    const start = editor.getByRole('region', { name: 'Build the flow' });
    await expect(start.locator('.loadtest-start-item')).toHaveCount(40);
    await expect(start.getByRole('button', { name: 'Add requests to the flow' })).toBeDisabled();
    await expect(editor.locator('.loadtest-errors')).toHaveCount(0);
    await expect(editor.getByRole('tab', { name: /Flow/ }).locator('.loadtest-tab-issue')).toHaveCount(0);
    const list = await start.locator('.loadtest-start-list').boundingBox();
    expect(list!.height).toBeLessThanOrEqual(24 * 16 + 1);
    await start.getByRole('checkbox', { name: 'Add Request 3', exact: true }).check();
    await start.getByRole('checkbox', { name: 'Add Request 1', exact: true }).check();
    await expect(start.locator('.loadtest-start-item.picked .loadtest-start-order')).toHaveText(['2', '1']);
    await start.getByRole('checkbox', { name: 'Select all 40' }).check();
    await expect(start.getByRole('button', { name: 'Add 40 requests to the flow' })).toBeEnabled();
    await start.getByRole('checkbox', { name: 'Select all 40' }).uncheck();
    await start.getByRole('checkbox', { name: 'Add Request 2', exact: true }).check();
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-start-screen.png'), animations: 'disabled' });
    await start.getByRole('button', { name: 'Add 1 request to the flow' }).click();
    await expect(editor.locator('.loadtest-errors')).toHaveCount(0);
    await expect(editor.locator('.loadtest-step-main')).toHaveCount(1);
    await expect(editor.locator('.loadtest-step-main')).toContainText('Request 2');
    const card = (await editor.locator('.loadtest-step-main').boundingBox())!;
    const actions = (await editor.locator('.loadtest-step-actions').boundingBox())!;
    const gaps = [actions.y - card.y, card.x + card.width - actions.x - actions.width, card.y + card.height - actions.y - actions.height];
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    await editor.locator('.loadtest-step-card').screenshot({ path: join(tmpdir(), 'kurlo-load-step-actions.png'), animations: 'disabled' });
    const add = editor.getByRole('button', { name: 'Add request from collection' });
    await add.click();
    const menu = editor.getByRole('menu', { name: 'Requests', exact: true });
    const assertContained = async (selector: string) => {
      const bounds = await editor.locator(selector).boundingBox();
      const viewport = await editor.boundingBox();
      expect(bounds).not.toBeNull();
      expect(viewport).not.toBeNull();
      expect(bounds!.y).toBeGreaterThanOrEqual(viewport!.y);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width);
      expect(await editor.locator(selector).evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    };
    await assertContained('.loadtest-add-menu');
    const addBounds = await add.boundingBox();
    const menuBounds = await menu.boundingBox();
    expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(addBounds!.y);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-add-menu-bounds.png'), animations: 'disabled' });
    await menu.getByRole('menuitem', { name: /Request 40$/ }).click();
    await expect(editor.locator('.loadtest-step-main').last()).toContainText('Request 40');
    await editor.locator('.loadtest-step-main').last().click();
    await expect(editor.getByRole('listbox', { name: 'Replace request' })).toBeHidden();
    await editor.getByRole('button', { name: 'Replace request for step 2', exact: true }).click();
    const replacements = editor.getByRole('listbox', { name: 'Replace request' });
    await assertContained('.loadtest-request-menu');
    await page.setViewportSize({ width: 1000, height: 540 });
    await assertContained('.loadtest-request-menu');
    expect((await editor.locator('.loadtest-step-main').last().boundingBox())!.width).toBeGreaterThan(250);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-replace-menu-bounds.png'), animations: 'disabled' });
    await replacements.getByRole('option', { name: /Request 39$/ }).click();
    await expect(editor.locator('.loadtest-step-main').last()).toContainText('Request 39');
  });

  test('summarises the load test plan, flags problems and runs or exports it from the sidebar', async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 1000 });
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-plan', workspaceId: 'workspace-e2e', name: 'Plan API', loadTests: [{
        id: 'lt-plan', name: 'Plan test', data: { path: 'data/users.csv', mode: 'per-iteration' },
        scenarios: [{ id: 'main', name: 'Flow', executor: { type: 'ramping-vus', stages: [
          { durationMs: 120000, target: 40 }, { durationMs: 600000, target: 40 }, { durationMs: 60000, target: 0 },
        ] }, steps: [
          { id: 'step-login', requestId: 'req-plan-login', once: true, extract: [{ var: 'token', from: 'json', path: '$.token' }] },
          { id: 'step-orders', requestId: 'req-plan-orders', checks: [{ type: 'status', value: '200' }] },
        ] }],
        thresholds: [{ metric: 'http_req_duration', stat: 'p(95)', op: '<', value: 500 }],
      }] }],
      requests: [
        { id: 'req-plan-login', collectionId: 'col-plan', collection: 'Plan API', name: 'Login', requestType: 'http', method: 'POST', url: 'https://shop.kurlo.test/login', auth: { type: 'none' } },
        { id: 'req-plan-orders', collectionId: 'col-plan', collection: 'Plan API', name: 'Orders', requestType: 'http', method: 'GET', url: 'https://shop.kurlo.test/orders', auth: { type: 'bearer', bearerToken: '{{token}}' } },
      ],
    });
    await page.goto('/');
    await page.evaluate(() => {
      (window as E2EWindow).go.api.App.ValidateLoadTest = async (draft: { scenarios: Array<{ executor: { stages?: Array<{ target: number }> } }> }) =>
        (draft.scenarios[0].executor.stages ?? []).some(stage => stage.target > 1000) ? ['Stage 2 needs a smaller target.'] : [];
    });
    const sidebarRow = page.locator('.collection-request-wrap').filter({ hasText: 'Plan test' });
    await sidebarRow.locator('.collection-request').click();
    const editor = page.locator('section[aria-label="Load test"]');
    const steps = editor.locator('.loadtest-step-main');
    await expect(steps.nth(0)).toContainText('saves token');
    await expect(steps.nth(1)).toContainText('uses token');
    await expect(steps.nth(1)).toContainText('status 200');
    await expect(editor.locator('.loadtest-phase')).toHaveText(['Setup · once per user', 'Every iteration']);
    const plan = editor.getByRole('group', { name: 'Test plan' });
    await expect(plan).toContainText('2 steps');
    await expect(plan).toContainText('up to 40 users');
    await expect(plan).toContainText('1 pass criterion');
    await expect(plan).toContainText('users.csv · next row each iteration');
    await plan.getByRole('button', { name: '13m total' }).click();
    await expect(editor.getByRole('tab', { name: /Load & thresholds/ })).toHaveAttribute('aria-selected', 'true');
    await editor.getByRole('spinbutton', { name: 'Stage 2 target', exact: true }).fill('5000');
    await expect(editor.locator('.loadtest-stage.active')).toHaveCount(1);
    await expect(editor.getByRole('tab', { name: /Load & thresholds/ }).locator('.loadtest-tab-issue')).toHaveCount(1);
    await expect(plan.getByRole('button', { name: /issue/ })).toHaveCount(0);
    await editor.getByRole('spinbutton', { name: 'Stage 2 target', exact: true }).fill('40');
    await expect(editor.getByRole('tab', { name: /Load & thresholds/ }).locator('.loadtest-tab-issue')).toHaveCount(0);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-plan-strip.png'), animations: 'disabled' });

    await expect(sidebarRow.locator('.sidebar-loadtest-status')).toHaveCount(0);
    const group = page.locator('.sidebar-loadtest-group');
    await expect(group).toContainText('Load tests');
    await expect(group).toContainText('1');
    await group.getByRole('button', { name: 'Collapse load tests' }).click();
    await expect(sidebarRow).toHaveCount(0);
    await group.getByRole('button', { name: 'Expand load tests' }).click();
    await expect(sidebarRow).toHaveCount(1);
    await page.evaluate(() => {
      const started = Date.now() - 60000;
      window.__kurloE2E.emit('load:done', {
        loadTestId: 'lt-plan', collectionId: 'col-plan', loadTestName: 'Plan test', environment: '', k6Version: 'v1.3.0', status: 'failed', exitCode: 99,
        startedAt: started, finishedAt: Date.now(), hasReport: false, hasSummary: false, thresholds: [], steps: [],
        totals: { requests: 0, rps: 0, avg: 0, med: 0, p95: 0, p99: 0, max: 0, failedRate: 0, failedCount: 0, checksPassed: 0, checksFailed: 0, iterations: 0, interrupted: 0, maxVUs: 0 },
      });
    });
    await expect(sidebarRow.locator('.sidebar-loadtest-status')).toHaveClass(/failed/);
    await expect(editor.getByRole('tab', { name: /Results/ })).toContainText('failed');

    await sidebarRow.getByLabel('Load test menu').click();
    await sidebarRow.getByRole('button', { name: 'Export k6 script', exact: true }).click();
    const exportDialog = page.getByRole('dialog', { name: 'Export to k6' });
    await expect(exportDialog).toBeVisible();
    await exportDialog.press('Escape');
    await expect(exportDialog).toBeHidden();

    await sidebarRow.getByLabel('Load test menu').click();
    await sidebarRow.getByRole('button', { name: 'Run with k6', exact: true }).click();
    await page.getByRole('dialog', { name: 'Run load test' }).getByRole('button', { name: 'Run load test' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('StartLoadRun')))).toEqual(['StartLoadRun:lt-plan']);
    await expect(sidebarRow.locator('.sidebar-loadtest-status')).toHaveClass(/running/);
    await expect(editor.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true');
    await expect(editor.locator('.loadrun-progress')).toContainText('Ramping up to 40 users');
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-sidebar-running.png'), animations: 'disabled' });
  });

  test('builds a load test from collection requests and saves it to the workspace', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Shop API');
    for (const [name, url] of [['Login', 'https://shop.kurlo.test/login'], ['List orders', 'https://shop.kurlo.test/orders']]) {
      await collectionRow(page, 'Shop API').getByLabel('Collection menu').click();
      await collectionRow(page, 'Shop API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
      await chooseRequestType(page, 'HTTP Request');
      await page.getByLabel('Request name').fill(name);
      await page.getByLabel('Request name').press('Enter');
      await page.getByLabel('Request URL').fill(url);
      await page.locator('.save-btn:not(.revert-btn)').first().click();
      await expect(page.locator('.save-btn:not(.revert-btn)').first()).toBeDisabled();
    }

    const loginRow = page.locator('.collection-request-wrap').filter({ hasText: 'Login' }).first();
    await loginRow.hover();
    await loginRow.getByLabel('Request menu').click();
    await loginRow.getByRole('button', { name: 'Load test this request' }).click();

    const editor = page.locator('section[aria-label="Load test"]');
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel('Load test name')).toHaveValue('New load test');
    await expect(editor.getByText('Unsaved draft', { exact: true })).toBeVisible();
    await expect(page.locator('.collection-request-wrap').filter({ hasText: 'New load test' })).toHaveCount(0);
    expect(await page.evaluate(() => (window.__kurloE2E.store as { collections?: Array<{ loadTests?: unknown[] }> }).collections?.some(collection => collection.loadTests?.length) ?? false)).toBe(false);
    await editor.getByLabel('Load test name').fill('Login load test');
    await expect(editor.locator('.loadtest-step-main')).toHaveCount(1);
    await expect(editor.getByRole('complementary', { name: 'Step settings' }).getByRole('button', { name: /^Request:/ })).toHaveCount(0);

    await editor.locator('.loadtest-step-main').first().click();
    await editor.getByRole('radio', { name: 'Once per user' }).click();
    await editor.getByRole('button', { name: 'Save a value' }).click();
    await editor.getByLabel('Variable name').fill('token');
    await editor.getByRole('textbox', { name: 'Path' }).fill('$.access_token');

    await editor.getByRole('button', { name: 'Add request from collection' }).click();
    await editor.getByRole('menuitem', { name: /List orders/ }).click();
    await expect(editor.locator('.loadtest-step-main')).toHaveCount(2);
    await editor.getByLabel('Wait', { exact: true }).fill('500ms');
    await editor.getByLabel('Wait', { exact: true }).press('Enter');
    await expect(editor.locator('.loadtest-step-main').nth(1)).toContainText('wait 500ms');
    await expect(editor.getByLabel('Wait', { exact: true })).toHaveValue('500ms');
    await editor.getByLabel('Random extra wait', { exact: true }).fill('250ms');
    await editor.getByLabel('Random extra wait', { exact: true }).press('Tab');
    await expect(editor.getByLabel('Random extra wait', { exact: true })).toHaveValue('250ms');
    await expect(editor.locator('.loadtest-step-main').nth(1)).toContainText('wait 500ms ± 250ms');

    const stepRows = editor.locator('.loadtest-step-main');
    const replaceButtons = editor.getByRole('button', { name: /^Replace request for step/ });
    await stepRows.first().click();
    await expect(editor.getByLabel('Variable name')).toHaveValue('token');
    await expect(editor.getByRole('listbox', { name: 'Replace request' })).toBeHidden();
    await stepRows.nth(1).click();
    await expect(editor.getByLabel('Wait', { exact: true })).toHaveValue('500ms');
    await expect(editor.getByRole('listbox', { name: 'Replace request' })).toBeHidden();
    await replaceButtons.nth(1).click();
    const replacementMenu = editor.getByRole('listbox', { name: 'Replace request' });
    await expect(replacementMenu).toBeVisible();
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-replace-request.png'), fullPage: true, animations: 'disabled' });
    await replacementMenu.getByRole('option', { name: /Login/ }).click();
    await expect(replacementMenu).toBeHidden();
    await expect(stepRows).toHaveCount(2);
    await expect(stepRows.nth(1)).toContainText('Login');
    await expect(stepRows.nth(1)).toContainText('wait 500ms');
    await expect(editor.getByLabel('Wait', { exact: true })).toHaveValue('500ms');
    await replaceButtons.nth(1).click();
    await page.keyboard.press('Escape');
    await expect(replacementMenu).toBeHidden();
    await replaceButtons.nth(1).click();
    await editor.getByRole('heading', { name: 'Step 2', exact: true }).click();
    await expect(replacementMenu).toBeHidden();
    await replaceButtons.nth(1).focus();
    await page.keyboard.press('Enter');
    await replacementMenu.getByRole('option', { name: /List orders/ }).click();
    await replaceButtons.first().click();
    await replacementMenu.getByRole('option', { name: /List orders/ }).click();
    await expect(editor.getByRole('radio', { name: 'Once per user' })).toHaveAttribute('aria-checked', 'true');
    await expect(editor.getByLabel('Variable name')).toHaveValue('token');
    await expect(editor.getByRole('textbox', { name: 'Path' })).toHaveValue('$.access_token');
    await replaceButtons.first().click();
    await replacementMenu.getByRole('option', { name: /Login/ }).click();

    await editor.getByRole('tab', { name: /Load & thresholds/ }).click();
    await editor.getByRole('button', { name: /^Load normal traffic/ }).click();
    await expect(editor.locator('.loadtest-preview')).toContainText('Peak 50 users · 13m total');
    await editor.getByRole('radio', { name: 'Iterations per second' }).click();
    await expect(editor.locator('.loadtest-preview')).toContainText('iterations/s');

    await editor.getByRole('tab', { name: 'Data & options' }).click();
    await editor.getByRole('button', { name: 'Choose file…' }).click();
    await expect(editor.getByRole('textbox', { name: 'File', exact: true })).toHaveValue('data/users.csv');
    await expect(editor.getByRole('table', { name: 'Test data preview' })).toContainText('ada@shop.test');
    await editor.getByRole('radio', { name: 'Next row each iteration' }).click();
    await expect(editor.getByRole('radio', { name: 'Next row each iteration' })).toHaveAttribute('aria-checked', 'true');
    await expect(editor.getByRole('status', { name: 'Reading test data' })).toBeHidden();
    await expect(editor.getByRole('table', { name: 'Test data preview' })).toBeVisible();
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-data-preview.png'), fullPage: true, animations: 'disabled' });
    await editor.getByRole('textbox', { name: 'File', exact: true }).fill('data/missing.csv');
    await expect(editor.getByRole('alert')).toContainText('no such file');
    await expect(editor.getByRole('table', { name: 'Test data preview' })).toBeHidden();
    await editor.getByRole('textbox', { name: 'File', exact: true }).fill('data/users.csv');
    await expect(editor.getByRole('table', { name: 'Test data preview' })).toBeVisible();

    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const store = window.__kurloE2E.store as { collections?: Array<{ name: string; loadTests?: unknown[] }> };
      return store.collections?.find(candidate => candidate.name === 'Shop API')?.loadTests?.[0] ?? null;
    })).toMatchObject({
      name: 'Login load test',
      data: { path: 'data/users.csv', mode: 'per-iteration' },
      scenarios: [{
        executor: { type: 'ramping-arrival-rate' },
        steps: [
          { once: true, extract: [{ var: 'token', from: 'json', path: '$.access_token' }] },
          { thinkTimeMs: 500, thinkJitterMs: 250 },
        ],
      }],
    });

    await editor.getByRole('button', { name: 'Export k6 script' }).click();
    const exportDialog = page.getByRole('dialog', { name: 'Export to k6' });
    await expect(exportDialog).toBeVisible();
    await expect(exportDialog.locator('.k6-export-warnings li')).toHaveCount(1);
    await expect(exportDialog.locator('.k6-export-warnings')).toContainText('List orders are not exported');
    await expect(exportDialog.locator('.k6-export-command')).toHaveText('password=… k6 run login-load-test.k6.js');
    await exportDialog.getByRole('radio', { name: 'Write into the script' }).click();
    await expect(exportDialog).toContainText('Do not commit or share it');
    await exportDialog.getByRole('button', { name: 'Save script…' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedFiles.map(file => file.name))).toEqual(['login-load-test.k6.js']);
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('ExportLoadTestK6')))).toEqual([
      'ExportLoadTestK6:Login load test:Login,List orders:false',
      'ExportLoadTestK6:Login load test:Login,List orders:true',
    ]);
    await exportDialog.getByRole('radio', { name: 'Folder', exact: true }).click();
    await expect(exportDialog.getByRole('tab', { name: 'data.json' })).toBeVisible();
    await expect(exportDialog.locator('.k6-export-command')).toHaveText('k6 run script.k6.js');
    await exportDialog.getByRole('tab', { name: 'data.json' }).click();
    await expect(exportDialog.locator('.cm-content')).toContainText('ada@shop.test');
    await page.screenshot({ path: join(tmpdir(), 'kurlo-k6-folder-export.png'), fullPage: true, animations: 'disabled' });
    await exportDialog.getByRole('button', { name: 'Save folder…' }).click();
    await expect(exportDialog.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('SaveLoadTestK6Folder')))).toEqual([
      'SaveLoadTestK6Folder:/exports:true:data/users.csv:per-iteration',
    ]);
    await exportDialog.press('Escape');
    await expect(exportDialog).toBeHidden();

    const sidebarRow = page.locator('.collection-request-wrap').filter({ hasText: 'Login load test' });
    await expect(sidebarRow).toHaveClass(/active/);
    await expect(editor.getByRole('button', { name: 'Duplicate', exact: true })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await sidebarRow.getByLabel('Load test menu').click();
    await expect(sidebarRow.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
    await expect(sidebarRow.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0);
    await expect(sidebarRow.getByRole('button', { name: /Copy as cURL|Load test this request|^Star$/ })).toHaveCount(0);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-sidebar-menu.png'), fullPage: true, animations: 'disabled' });
    await sidebarRow.getByRole('button', { name: 'Rename', exact: true }).click();
    await fillPrompt(page, 'Rename load test', 'Renamed load test');
    await expect(editor.getByLabel('Load test name')).toHaveValue('Renamed load test');
    const renamedRow = page.locator('.collection-request-wrap').filter({ hasText: 'Renamed load test' });
    await renamedRow.locator('.collection-request').dblclick();
    const inlineName = page.locator('.sidebar-request-title-input');
    await expect(inlineName).toBeFocused();
    await inlineName.fill('Discard this name');
    await inlineName.press('Escape');
    await expect(editor.getByLabel('Load test name')).toHaveValue('Renamed load test');
    await renamedRow.locator('.collection-request').dblclick();
    await inlineName.fill('Login load test');
    await inlineName.press('Enter');
    await expect(editor.getByLabel('Load test name')).toHaveValue('Login load test');
    await sidebarRow.getByLabel('Load test menu').click();
    await sidebarRow.getByRole('button', { name: 'Duplicate' }).click();
    await expect(editor.getByLabel('Load test name')).toHaveValue('Login load test copy');
    await expect(page.locator('.collection-request-wrap').filter({ hasText: 'load test' })).toHaveCount(2);
  });

  test('runs a load test in k6 and shows the result of the run', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Shop API');
    await collectionRow(page, 'Shop API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Shop API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Login');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('https://shop.kurlo.test/login');
    await page.locator('.save-btn:not(.revert-btn)').first().click();
    await expect(page.locator('.save-btn:not(.revert-btn)').first()).toBeDisabled();
    const loginRow = page.locator('.collection-request-wrap').filter({ hasText: 'Login' }).first();
    await loginRow.hover();
    await loginRow.getByLabel('Request menu').click();
    await loginRow.getByRole('button', { name: 'Load test this request' }).click();
    const editor = page.locator('section[aria-label="Load test"]');
    await expect(editor).toBeVisible();
    await editor.getByLabel('Load test name').fill('Login load test');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor.getByText('Unsaved draft', { exact: true })).toHaveCount(0);
    const loadTestId = await page.evaluate(() => {
      const store = window.__kurloE2E.store as { collections?: Array<{ loadTests?: Array<{ id: string }> }> };
      return store.collections?.flatMap(collection => collection.loadTests ?? [])[0]?.id ?? '';
    });
    expect(loadTestId).not.toBe('');

    await editor.getByRole('tab', { name: /Load & thresholds/ }).click();
    await editor.locator('.loadtest-threshold').filter({ hasText: '%' }).getByLabel('Limit', { exact: true }).fill('0.00001');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();

    await page.evaluate(() => { (window.__kurloE2E as unknown as { k6Found: boolean }).k6Found = false; });
    await editor.getByRole('button', { name: 'Export k6 script' }).click();
    await page.getByRole('dialog', { name: 'Export to k6' }).getByRole('button', { name: 'Run with local k6' }).click();
    const missing = page.getByRole('dialog', { name: 'k6 is not installed' });
    await expect(missing).toBeVisible();
    await expect(missing).toContainText('brew install k6');
    await page.evaluate(() => { (window.__kurloE2E as unknown as { k6Found: boolean }).k6Found = true; });
    await missing.getByRole('button', { name: 'Check again' }).click();
    await expect(missing).toBeHidden();

    await editor.getByRole('button', { name: 'Export k6 script' }).click();
    await page.getByRole('dialog', { name: 'Export to k6' }).getByRole('button', { name: 'Run with local k6' }).click();
    const confirm = page.getByRole('dialog', { name: 'Run load test' });
    await expect(confirm).toContainText('shop.kurlo.test');
    await confirm.getByRole('button', { name: 'Run load test' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('StartLoadRun')))).toEqual([`StartLoadRun:${loadTestId}`]);
    await expect(editor.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true');

    await page.evaluate((id) => {
      const base = { running: true, stopping: false, loadTestId: id, collectionId: '', startedAt: Date.now(), plannedMs: 60000, dashboardUrl: 'http://127.0.0.1:5665', k6Version: 'v1.3.0' };
      window.__kurloE2E.emit('load:progress', { ...base, progress: { elapsedMs: 15000, vus: 2, maxVUs: 2, iterations: 42, interrupted: 0 } });
      window.__kurloE2E.emit('load:log', 'running (15.0s), 2/2 VUs, 42 complete and 0 interrupted iterations');
    }, loadTestId);
    await expect(editor.locator('.loadrun-progress')).toContainText('42');
    await expect(editor.locator('.loadrun-progress')).toContainText('0:15 / 1:00');
    await expect(editor.locator('.loadrun-bar')).toHaveAttribute('aria-valuenow', '25');
    await expect(editor.locator('.loadrun-log')).toContainText('42 complete');
    await expect(editor.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(1);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-single-stop.png'), animations: 'disabled' });
    await editor.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.includes('StopLoadRun'))).toBe(true);

    await page.evaluate((id) => {
      window.__kurloE2E.emit('load:progress', { running: false, stopping: false, loadTestId: '', collectionId: '', startedAt: 0, plannedMs: 0, dashboardUrl: '', k6Version: '', progress: { elapsedMs: 0, vus: 0, maxVUs: 0, iterations: 0, interrupted: 0 } });
      window.__kurloE2E.emit('load:done', {
        loadTestId: id, collectionId: '', loadTestName: 'Login load test', environment: '', k6Version: 'v1.3.0', status: 'failed', exitCode: 99,
        startedAt: Date.now() - 60000, finishedAt: Date.now(), hasReport: true, hasSummary: true,
        thresholds: [
          { metric: 'http_req_duration', expression: 'p(95)<500', ok: true, actual: 212.4, hasActual: true },
          { metric: 'http_req_failed', expression: 'rate<0.00000010000000000000001', ok: false, actual: 0.04, hasActual: true },
        ],
        totals: { requests: 1200, rps: 20, avg: 90, med: 74, p95: 212.4, p99: 300, max: 900, failedRate: 0.04, failedCount: 48, checksPassed: 0, checksFailed: 0, iterations: 1200, interrupted: 0, maxVUs: 2 },
        steps: [
          { stepId: 'missing', tag: 'login', requests: 1200, med: 74, p95: 212.4, p99: 300, failedRate: 0.04, checksRate: 0, checksPassed: 0, checksFailed: 0 },
          { stepId: 'empty', tag: 'empty', requests: 0, med: 0, p95: 0, p99: 0, failedRate: 0, checksRate: 0, checksPassed: 0, checksFailed: 0 },
          { stepId: 'fast', tag: 'fast', requests: 1, med: 0, p95: 0, p99: 0, failedRate: 0, checksRate: 0, checksPassed: 0, checksFailed: 0 },
        ],
      });
    }, loadTestId);
    const banner = editor.locator('.loadrun-banner');
    await expect(banner).toContainText('1 of 2 pass criteria not met');
    await expect(banner).toContainText('exit code 99');
    await expect(editor.locator('.loadrun-table').first()).toContainText('Not met');
    await expect(editor.locator('.loadrun-table').first().locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText('< 0.00001%');
    const stepRows = editor.locator('.loadrun-table').last().locator('tbody tr');
    await expect(stepRows.nth(1).locator('td')).toHaveText(['Removed step', '0', '—', '—', '—', '—', '—']);
    await expect(stepRows.nth(2).locator('td').nth(2)).toHaveText('0.0 ms');
    await expect(editor.locator('.loadrun-totals')).toContainText('1,200');
    await page.screenshot({ path: join(tmpdir(), 'kurlo-loadrun-regressions.png'), fullPage: true });
    await stepRows.last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(tmpdir(), 'kurlo-loadrun-steps.png'), fullPage: true });
    await editor.getByRole('button', { name: 'Open HTML report' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('OpenLoadRunReport')))).toEqual([`OpenLoadRunReport:${loadTestId}`]);
    await editor.getByRole('button', { name: 'Save summary JSON' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedFiles.map(file => file.name))).toEqual(['login-load-test-summary.json']);
    await page.evaluate((id) => {
      window.__kurloE2E.emit('load:done', {
        loadTestId: id, collectionId: '', loadTestName: 'Login load test', environment: 'Dev', k6Version: 'v1.4.2', status: 'stopped', exitCode: 105,
        startedAt: Date.now() - 3278, finishedAt: Date.now(), hasReport: false, hasSummary: false, thresholds: [], steps: [],
      });
    }, loadTestId);
    await expect(banner).toContainText('Stopped before the end');
    await banner.scrollIntoViewIfNeeded();
    const badgeBounds = await banner.locator('.tag').boundingBox();
    const titleBounds = await banner.locator('strong').boundingBox();
    expect(Math.abs(badgeBounds!.y + badgeBounds!.height / 2 - titleBounds!.y - titleBounds!.height / 2)).toBeLessThan(1);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-load-stopped-alignment.png'), animations: 'disabled' });

  });
});
