import type { E2EWindow } from './support/bridge';
import { chooseRequestType } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { expect, test } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('preflights all selected requests and stops before sending when one linked secret is unavailable', async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 680 });
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-secret-preflight', workspaceId: 'workspace-e2e', name: 'Secret preflight' }],
      requests: [
        { id: 'preflight-plain', collectionId: 'col-secret-preflight', name: 'No linked secret', method: 'GET', url: 'https://api.kurlo.test/plain' },
        { id: 'preflight-valid', collectionId: 'col-secret-preflight', name: 'Working linked secret', method: 'GET', url: 'https://api.kurlo.test/valid', headers: [{ key: 'Authorization', value: '{{secret:vault:app#token}}', enabled: true }] },
        { id: 'preflight-broken', collectionId: 'col-secret-preflight', name: 'Broken linked secret', method: 'GET', url: 'https://api.kurlo.test/broken', headers: [{ key: 'Authorization', value: '{{secret:vault:missing#token}}', enabled: true }] },
      ],
    });
    await page.goto('/');
    await page.evaluate(() => {
      window.go!.api!.App!.PreflightCollectionRunner = async (_workspaceId, requests) => requests.map((request, index) => ({
        requestId: request.requestId,
        failures: index === 2 ? [{ provider: 'vault', path: 'missing', field: 'token', kind: 'not-found', message: 'Secret not found' }] : [],
      }));
      document.documentElement.style.zoom = '1.25';
    });
    await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
    const runner = page.getByRole('region', { name: 'Collection runner' });
    await runner.locator('.runner-select .app-select-trigger').click();
    await runner.getByRole('option', { name: 'Secret preflight' }).click();
    await runner.getByRole('button', { name: 'Run 3 requests' }).click();
    await expect(runner.getByRole('alert', { name: 'Linked secret preflight errors' })).toContainText('Run stopped before sending requests');
    await expect(runner.getByRole('alert', { name: 'Linked secret preflight errors' })).toContainText('vault:missing#token');
    expect(await page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(0);
    const alertBox = await runner.getByRole('alert', { name: 'Linked secret preflight errors' }).boundingBox();
    expect(alertBox).not.toBeNull();
    expect(alertBox!.y).toBeGreaterThanOrEqual(0);
    expect(alertBox!.y + alertBox!.height).toBeLessThanOrEqual(680);
    await page.screenshot({ path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), 'runner-linked-secret-preflight.png'), fullPage: false, animations: 'disabled' });
  });

  test('scrolls a runner with hundreds of requests and results without pages', async ({ page }) => {
    const requests = Array.from({ length: 1000 }, (_, index) => ({
      id: `big-${index}`, collectionId: 'col-big', name: `Request ${index}`, method: 'GET', url: `https://api.kurlo.test/slow?ms=1&n=${index}`, folderPath: [`Group ${Math.floor(index / 50)}`],
    }));
    await installKurloBridge(page, '', 'browser/e2e', false, { collections: [{ id: 'col-big', workspaceId: 'workspace-e2e', name: 'Big runner' }], requests });
    await page.goto('/');
    await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
    const runner = page.getByRole('region', { name: 'Collection runner' });
    await runner.locator('.runner-select .app-select-trigger').click();
    await runner.getByRole('option', { name: 'Big runner' }).click();
    await expect(runner.getByTestId('runner-request-row').first()).toContainText('Request 0');
    await expect(runner.getByRole('button', { name: /^(Next|Prev)$/ })).toHaveCount(0);
    expect(await runner.getByTestId('runner-request-row').count()).toBeLessThan(320);
    const body = runner.locator('.runner-page-body');
    const scrollToEnd = () => body.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect.poll(async () => {
      await scrollToEnd();
      return runner.getByTestId('runner-request-row').last().textContent();
    }).toContain('Request 999');
    await expect(runner.locator('.runner-folder').last()).toHaveText('Group 19');

    await body.evaluate(node => { node.scrollTop = 0; });
    await runner.getByRole('button', { name: 'Deselect all' }).click();
    for (const index of [0, 1, 2]) await runner.getByRole('checkbox', { name: `Select Request ${index}`, exact: true }).check();
    await runner.getByLabel('Iterations').fill('100');
    await runner.getByRole('button', { name: 'Run 300 requests' }).click();
    await expect(runner.locator('.runner-results-summary')).toContainText('Requests 300/300', { timeout: 60_000 });
    expect(await runner.getByTestId('runner-result-row').count()).toBeLessThan(320);
    await expect.poll(async () => {
      await body.evaluate(node => { node.scrollTop = node.querySelector<HTMLElement>('.runner-selection')!.offsetTop - node.clientHeight; });
      return runner.getByTestId('runner-result-row').last().textContent();
    }).toMatch(/Request 2.*iteration 100/);
  });

  test('keeps the runner list still when it is scrolled to the end', async ({ page }) => {
    const requests = Array.from({ length: 491 }, (_, index) => ({
      id: `drift-${index}`, collectionId: 'col-drift', name: `Request ${index}`, method: 'GET', url: `https://api.kurlo.test/n/${index}`, folderPath: [`Group ${index % 37}`],
    }));
    await installKurloBridge(page, '', 'browser/e2e', false, { collections: [{ id: 'col-drift', workspaceId: 'workspace-e2e', name: 'Drift runner' }], requests });
    await page.goto('/');
    await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
    const runner = page.getByRole('region', { name: 'Collection runner' });
    await runner.locator('.runner-select .app-select-trigger').click();
    await runner.getByRole('option', { name: 'Drift runner' }).click();
    await expect(runner.getByTestId('runner-request-row').first()).toContainText('Request 0');
    const body = runner.locator('.runner-page-body');
    const gaps = () => body.evaluate(node => Array.from(node.querySelectorAll<HTMLElement>('.virtual-list-row')).flatMap(row => {
      const next = row.nextElementSibling as HTMLElement | null;
      if (!next?.classList.contains('virtual-list-row')) return [];
      const gap = next.getBoundingClientRect().top - row.getBoundingClientRect().top - row.getBoundingClientRect().height;
      return Math.abs(gap) > 0.5 ? [gap] : [];
    }));
    expect(await gaps()).toEqual([]);
    await body.evaluate(node => { node.scrollTop = node.scrollHeight * 0.6; });
    await page.waitForTimeout(150);
    await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.waitForTimeout(16);
    const lastRowTop = () => body.evaluate(node => {
      const row = Array.from(node.querySelectorAll<HTMLElement>('[data-testid="runner-request-row"]')).find(item => item.textContent?.includes('Request 490'));
      return row ? Math.round(row.getBoundingClientRect().top - node.getBoundingClientRect().top) : null;
    });
    const tops: Array<number | null> = [];
    for (let frame = 0; frame < 20; frame++) {
      tops.push(await lastRowTop());
      await page.waitForTimeout(50);
    }
    expect(new Set(tops)).toEqual(new Set([tops[0]]));
    expect(tops[0]).not.toBeNull();
    expect(await body.evaluate(node => Math.round(node.scrollHeight - node.scrollTop - node.clientHeight))).toBe(0);
    await expect(runner.getByTestId('runner-request-row').last()).toContainText('Request 490');
    expect(await gaps()).toEqual([]);
    await page.screenshot({ path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), 'runner-scrolled-to-end.png'), animations: 'disabled' });
  });

  test('keeps a running collection on its original environment after switching to production', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      activeEnvironmentId: 'dev',
      collections: [{ id: 'col-owned', workspaceId: 'workspace-e2e', name: 'Owned scopes' }],
      environments: [
        { id: 'dev', workspaceId: 'workspace-e2e', name: 'Development', values: [{ id: 1, enabled: true, key: 'host', value: 'https://dev.kurlo.test' }] },
        { id: 'prod', workspaceId: 'workspace-e2e', name: 'Production', values: [{ id: 2, enabled: true, key: 'host', value: 'https://prod.kurlo.test' }] },
      ],
      requests: [
        { id: 'owned-login', collectionId: 'col-owned', name: 'First request', method: 'GET', url: '{{host}}/slow?ms=1500&setenv=token:dev-token', testScriptJs: 'pm.environment.set("token", "dev-token")' },
        { id: 'owned-next', collectionId: 'col-owned', name: 'Second request', method: 'GET', url: '{{host}}/slow?ms=1&seen={{token}}' },
      ],
    });
    await page.goto('/');
    await expect(page.locator('.environment-select')).toContainText('Development');
    await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
    const runner = page.getByRole('region', { name: 'Collection runner' });
    await runner.locator('.runner-select .app-select-trigger').click();
    await runner.getByRole('option', { name: 'Owned scopes' }).click();
    await runner.getByRole('button', { name: 'Run 2 requests' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(1);
    await page.locator('.environment-select').click();
    await page.locator('.environment-menu').getByRole('button', { name: /Production/ }).click();
    await expect(page.locator('.environment-select')).toContainText('Production');
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(2);
    await expect(runner.locator('.runner-results-summary')).toContainText('Requests 2/2');
    const sent = await page.evaluate(() => window.__kurloE2E.sentRequests);
    expect(sent.map(request => request.url)).toEqual(['https://dev.kurlo.test/slow', 'https://dev.kurlo.test/slow']);
    expect(sent[1]).toMatchObject({
      scriptEnvironment: { host: 'https://dev.kurlo.test', token: 'dev-token' },
      params: expect.arrayContaining([expect.objectContaining({ key: 'seen', value: 'dev-token' })]),
    });
    await expect.poll(() => page.evaluate(() => {
      const environments = window.__kurloE2E.store.environments as Array<{ id: string; values: Array<{ key: string; value: string }> }>;
      return environments.find(environment => environment.id === 'dev')?.values.find(row => row.key === 'token')?.value;
    })).toBe('dev-token');
    const production = await page.evaluate(() => {
      const environments = window.__kurloE2E.store.environments as Array<{ id: string; values: Array<{ key: string; value: string }> }>;
      return environments.find(environment => environment.id === 'prod')?.values;
    });
    expect(production).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: 'token' })]));
  });

  test('fits the data file button and lines up the result tiles in a compact window', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 780 });
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-compact', workspaceId: 'workspace-e2e', name: 'Compact run' }],
      requests: [
        { id: 'compact-one', collectionId: 'col-compact', name: 'First', method: 'GET', url: 'https://api.kurlo.test/one' },
        { id: 'compact-two', collectionId: 'col-compact', name: 'Second', method: 'GET', url: 'https://api.kurlo.test/two' },
      ],
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
    const runner = page.getByRole('region', { name: 'Collection runner' });
    await runner.locator('.runner-select .app-select-trigger').click();
    await runner.getByRole('option', { name: 'Compact run' }).click();
    const fileLabel = runner.locator('.runner-file-copy span');
    await expect(fileLabel).toHaveText('Use a CSV or JSON file');
    expect(await fileLabel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(runner.getByRole('button', { name: 'Reset settings' })).toHaveClass(/btn-secondary/);
    const rail = page.getByRole('navigation', { name: 'Kurlo' });
    await expect(rail.locator('.activity-rail-btn.active')).toHaveCount(1);
    await expect(rail.getByRole('button', { name: 'Collection runner' })).toHaveClass(/active/);
    await expect(rail.getByRole('button', { name: 'Collections' })).toHaveClass(/panel-open/);
    await runner.getByRole('button', { name: 'Run 2 requests' }).click();
    const summary = runner.locator('.runner-results-summary');
    await expect(summary).toContainText('Requests 2/2');
    const tops = await summary.locator('.runner-stat').evaluateAll(stats => stats.map(stat => Math.round(stat.getBoundingClientRect().bottom)));
    expect(new Set(tops).size).toBe(1);
    const [summaryBox, progressBox] = await Promise.all([summary.boundingBox(), summary.locator('.runner-progress-wrap').boundingBox()]);
    expect(progressBox!.width).toBeGreaterThan(summaryBox!.width * 0.8);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-runner-compact.png'), animations: 'disabled' });
  });

  test('keeps the full saved runner verdict when result details are limited', async ({ page, browserName }) => {
    const results = Array.from({ length: 501 }, (_, index) => ({
      runId: `run-${index}`, requestId: 'req-limited', iteration: index + 1,
      name: index === 500 ? 'Failure on iteration 501' : 'Health check', method: 'GET', url: 'https://api.kurlo.test/ping',
      status: index === 500 ? 'failed' : 'passed', statusCode: index === 500 ? 500 : 200,
      duration: 5, testsPassed: index === 500 ? 0 : 1, testsTotal: 1,
      error: index === 500 ? 'Unexpected server error' : '', tests: [],
    }));
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-limited', workspaceId: 'workspace-e2e', name: 'Health API' }],
      requests: [{ id: 'req-limited', collectionId: 'col-limited', name: 'Health check', method: 'GET', url: 'https://api.kurlo.test/ping' }],
      collectionRuns: {
        'col-limited': {
          collectionId: 'col-limited', title: 'Health API', startedAt: Date.now() - 6000, finishedAt: Date.now(),
          summary: { total: 501, passed: 500, failed: 1, skipped: 0, testsPassed: 500, testsTotal: 501 }, results,
        },
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
    const runner = page.getByRole('region', { name: 'Collection runner' });
    await runner.locator('.runner-select .app-select-trigger').click();
    await runner.getByRole('option', { name: 'Health API' }).click();
    await expect(runner.locator('.runner-verdict')).toContainText('Failed');
    await expect(runner.locator('.runner-results-summary')).toContainText('501/501');
    await expect(runner.locator('.runner-results-summary')).toContainText('500/501');
    await expect(runner.locator('.runner-last-run')).toContainText('500 of 501 results kept');
    await runner.getByRole('radio', { name: 'Failed 1', exact: true }).click();
    await expect(runner.getByTestId('runner-result-row')).toHaveCount(1);
    await expect(runner.getByTestId('runner-result-row')).toContainText('Failure on iteration 501');
    await page.screenshot({ path: join(tmpdir(), `kurlo-runner-retained-failures-${browserName}.png`), animations: 'disabled' });
    await runner.getByRole('button', { name: 'Download report' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedFiles.length)).toBe(1);
    const report = await page.evaluate(() => window.__kurloE2E.savedFiles.at(-1)?.content ?? '');
    expect(report).toContain('501/501');
    expect(report).toContain('Showing 500 of 501 results');
    expect(report).toContain('Failure on iteration 501');
    const reportPage = await page.context().newPage();
    await reportPage.setContent(report);
    await expect(reportPage.locator('.badge')).toHaveText('Failed');
    await reportPage.screenshot({ path: join(tmpdir(), `kurlo-runner-retained-report-${browserName}.png`), animations: 'disabled' });
    await reportPage.close();
  });

  test('shows only the failed runner results when asked, grouped requests by folder', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-filter', workspaceId: 'workspace-e2e', name: 'Filter API' }],
      requests: [
        { id: 'req-filter-ok', collectionId: 'col-filter', collection: 'Filter API', folderPath: ['Health'], name: 'Ping', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/ping', auth: { type: 'none' }, testScriptJs: 'pm.test("passes", () => {})' },
        { id: 'req-filter-bad', collectionId: 'col-filter', collection: 'Filter API', folderPath: ['Orders'], name: 'List orders', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/orders', auth: { type: 'none' }, testScriptJs: 'pm.test("breaks", () => pm.expect(1).to.eql(2))' },
      ],
    });
    await page.goto('/');
    await page.evaluate(() => {
      const send = (window as E2EWindow).go.api.App.SendRequest;
      (window as E2EWindow).go.api.App.SendRequest = async sent => {
        const response = await send(sent) as { testResult: { tests: Array<{ name: string; passed: boolean; error?: string }> } };
        if (JSON.stringify(sent).includes('/orders')) response.testResult.tests = [{ name: 'breaks', passed: false, error: 'expected 1 to deeply equal 2' }];
        return response;
      };
    });
    await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
    const runner = page.getByRole('region', { name: 'Collection runner' });
    await runner.locator('.runner-select .app-select-trigger').click();
    await runner.getByRole('option', { name: 'Filter API' }).click();
    await expect(runner.locator('.runner-folder')).toHaveText(['Health', 'Orders']);
    await expect(runner.locator('.runner-page-title p')).toContainText('2 of 2 requests × 1 iteration = 2 calls · one by one');
    await runner.getByRole('radio', { name: 'In parallel' }).click();
    await expect(runner.locator('.runner-page-title p')).toContainText('in parallel');
    await runner.getByRole('radio', { name: 'One by one' }).click();
    await runner.getByRole('button', { name: 'Run 2 requests' }).click();
    await expect(runner.getByTestId('runner-result-row')).toHaveCount(2);
    const filter = runner.getByRole('radiogroup', { name: 'Show results' });
    await expect(filter.getByRole('radio', { name: 'Failed 1' })).toBeEnabled();
    await filter.getByRole('radio', { name: 'Failed 1' }).click();
    await expect(runner.getByTestId('runner-result-row')).toHaveCount(1);
    await expect(runner.getByTestId('runner-result-row')).toContainText('breaks');
    await page.screenshot({ path: join(tmpdir(), 'kurlo-runner-failed-filter.png'), animations: 'disabled' });
    await filter.getByRole('radio', { name: 'All 2' }).click();
    await expect(runner.getByTestId('runner-result-row')).toHaveCount(2);
  });

  test('keeps the header actions anchored when the runner replaces the request view', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');

    const rightEdge = () => page.locator('.searchbar-right').evaluate(
      (el) => Math.round(el.getBoundingClientRect().right),
    );
    const settingsSize = () => page.getByRole('button', { name: /^Settings/ }).evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    });

    const inRequest = { edge: await rightEdge(), size: await settingsSize() };

    await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Collection runner', exact: true })).toHaveClass(/active/);

    expect(await rightEdge()).toBe(inRequest.edge);
    expect(await settingsSize()).toBe(inRequest.size);
  });
});

for (const dockOpen of [false, true]) {
  for (const target of ['text', 'edge']) {
    test(`runner keeps forward wheel scrolling ${dockOpen ? 'with Performance open' : 'without Performance'} over ${target}`, async ({ page }) => {
      const requests = Array.from({ length: 500 }, (_, index) => ({ id: `wheel-${index}`, collectionId: 'wheel-runner', name: `Request ${index}`, method: 'GET', url: 'http://localhost:8080', folderPath: [`Group ${index}`] }));
      await installKurloBridge(page, '', 'browser/e2e', false, { collections: [{ id: 'wheel-runner', workspaceId: 'workspace-e2e', name: 'Wheel runner' }], requests });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('/');
      await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
      const runner = page.getByRole('region', { name: 'Collection runner' });
      await runner.locator('.runner-select .app-select-trigger').click();
      await runner.getByRole('option', { name: 'Wheel runner' }).click();
      if (dockOpen) {
        await page.getByRole('button', { name: 'Toggle performance dock' }).click();
        await expect(page.getByRole('region', { name: 'Performance dock' })).toBeVisible();
      }
      const body = runner.locator('.runner-page-body');
      const bodyBounds = (await body.boundingBox())!;
      await body.hover({ position: { x: target === 'edge' ? bodyBounds.width - 24 : bodyBounds.width / 2, y: bodyBounds.height / 2 } });
      const recording = body.evaluate(element => new Promise<Array<{ top: number; index: number }>>(resolve => {
        const started = performance.now();
        const frames: Array<{ top: number; index: number }> = [];
        const record = () => {
          const edge = element.getBoundingClientRect().top;
          const row = Array.from(element.querySelectorAll<HTMLElement>('[data-testid="runner-request-row"]')).find(row => row.getBoundingClientRect().bottom > edge);
          const index = Number(row?.querySelector('input')?.getAttribute('aria-label')?.match(/Request (\d+)/)?.[1] ?? -1);
          frames.push({ top: element.scrollTop, index });
          if (performance.now() - started > 2000) resolve(frames);
          else requestAnimationFrame(record);
        };
        requestAnimationFrame(record);
      }));
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(70);
      }
      const frames = await recording;
      for (let i = 1; i < frames.length; i++) {
        expect(frames[i].index, JSON.stringify(frames.slice(Math.max(0, i - 2), i + 1))).toBeGreaterThanOrEqual(frames[i - 1].index);
      }
      expect(frames.at(-1)!.index).toBeGreaterThan(20);
      await page.screenshot({ path: `/tmp/kurlo-runner-wheel-${dockOpen ? 'performance' : 'plain'}-${target}.png`, animations: 'disabled' });
    });
  }
}
