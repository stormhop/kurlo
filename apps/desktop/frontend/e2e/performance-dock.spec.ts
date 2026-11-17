import { expect, test } from '@playwright/test';
import { installKurloBridge } from './support/bridge';
import { agentStore, connection, installAgentBridge } from './support/agent';

test('performance dock renders live metrics, filters, restores and stops sampling', async ({ page }) => {
  await installKurloBridge(page, '', 'browser/e2e', false, null, { preserveStorage: true });
  await page.addInitScript(() => localStorage.setItem('kurlo.theme.v2', JSON.stringify({ mode: 'dark', light: 'light', dark: 'dark' })));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Toggle performance dock' });
  await toggle.click();
  const dock = page.getByRole('region', { name: 'Performance dock' });
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId('perf-cpu')).toHaveText('0.4%');
  await expect(dock.getByTestId('perf-memory')).toHaveText('286.0 MB');
  await expect(dock.getByTestId('perf-uptime')).toHaveText('1h 22m 31s');
  await page.evaluate(async () => {
    const sample = await window.go!.api!.App!.PerformanceStatus!();
    const now = Date.now();
    for (let i = 0; i < 120; i++) {
      const cpu = i === 119 ? 2.5 : 0.4 + Math.abs(Math.sin(i / 13)) * 3;
      window.__kurloE2E.emit('perf:sample', { ...sample, sampledAt: now + i * 1000, totalCpuPercent: cpu, totalMemoryBytes: 308281344, processes: [...sample.processes, { pid: 44, parentPid: 42, name: 'node', role: 'MCP server', kind: 'child', cpuPercent: cpu - 0.4, memoryBytes: 8388608, uptimeSeconds: 40 }] });
    }
  });
  await expect(dock.getByTestId('perf-cpu')).toHaveText('2.5%');
  await expect(dock.locator('.performance-chart-area')).toHaveCount(2);
  await dock.getByRole('button', { name: 'Main', exact: true }).click();
  await expect(dock.getByTestId('perf-cpu')).toHaveText('0.3%');
  await expect(dock.getByTestId('perf-memory')).toHaveText('56.0 MB');
  await expect(dock.getByRole('row')).toHaveCount(4);
  await page.screenshot({ path: '/tmp/kurlo-performance-dark.png', animations: 'disabled' });
  await dock.getByRole('button', { name: 'Webview', exact: true }).click();
  await expect(dock.getByTestId('perf-pid')).toHaveText('43');
  await dock.getByRole('button', { name: 'Child', exact: true }).click();
  await expect(dock.getByTestId('perf-memory')).toHaveText('8.0 MB');
  await dock.getByRole('button', { name: 'Close performance dock' }).click();
  await expect(dock).toBeHidden();
  expect(await page.evaluate(() => window.__kurloE2E.calls.filter(call => call === 'StopPerformanceStream').length)).toBe(1);
  await page.keyboard.press('Control+Alt+p');
  await expect(dock).toBeVisible();
  await page.reload();
  await expect(dock).toBeVisible();
  await expect(dock.getByRole('button', { name: 'Child', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('performance dock handles unavailable metrics and compact light layout', async ({ page }) => {
  await installKurloBridge(page, '', 'browser/e2e', false, null, { preserveStorage: true });
  await page.addInitScript(() => localStorage.setItem('kurlo.theme.v2', JSON.stringify({ mode: 'light', light: 'light', dark: 'dark' })));
  await page.setViewportSize({ width: 900, height: 650 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle performance dock' }).click();
  await page.evaluate(() => window.__kurloE2E.emit('perf:sample', { sampledAt: Date.now() + 1000, mainPid: 42, mainUptimeSeconds: 30, intervalMs: 1000, totalCpuPercent: null, totalMemoryBytes: null, sensorLimited: true, processes: [{ pid: 42, parentPid: 1, name: 'Kurlo (main)', kind: 'main', role: 'Application', cpuPercent: null, memoryBytes: null, uptimeSeconds: 30 }] }));
  const dock = page.getByRole('region', { name: 'Performance dock' });
  await expect(dock.getByTestId('perf-cpu')).toHaveText('—');
  await expect(dock.getByText('Process metrics are limited', { exact: false })).toBeVisible();
  await page.screenshot({ path: '/tmp/kurlo-performance-light.png', animations: 'disabled' });
  expect(await dock.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('performance dock opens with its first snapshot and keeps content aligned as processes change', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    const app = window.go!.api!.App!;
    const original = app.PerformanceStatus!;
    app.PerformanceStatus = async () => {
      await new Promise<void>(resolve => { window.__kurloE2E.responseGate = { ready: true, release: resolve }; });
      const sample = await original();
      return { ...sample, processes: [...sample.processes, ...Array.from({ length: 60 }, (_, index) => ({ ...sample.processes[0], pid: 100 + index, name: `Worker ${index}`, kind: 'child' }))] };
    };
  });
  await page.getByRole('button', { name: 'Toggle performance dock' }).click();
  const dock = page.getByRole('region', { name: 'Performance dock' });
  await page.waitForFunction(() => window.__kurloE2E.responseGate?.ready);
  await expect(dock).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Toggle performance dock' })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.__kurloE2E.responseGate!.release());
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId('perf-memory')).toHaveText('286.0 MB');
  await expect(dock.getByRole('row')).toHaveCount(63);
  const positions = () => dock.locator('.performance-toolbar, .performance-card, .performance-chart').evaluateAll(elements => elements.map(element => ({ x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width })));
  const before = await positions();
  await page.evaluate(async () => {
    window.__kurloE2E.emit('perf:sample', { sampledAt: Date.now() + 1000, intervalMs: 1000, mainPid: 42, mainUptimeSeconds: 4951, totalCpuPercent: 0.4, totalMemoryBytes: 299892736, sensorLimited: false, processes: [
      { pid: 42, parentPid: 1, name: 'Kurlo (main)', kind: 'main', role: 'Application', cpuPercent: 0.3, memoryBytes: 58720256, uptimeSeconds: 4951 },
      { pid: 43, parentPid: 42, name: 'Webview', kind: 'webview', role: 'Webview', cpuPercent: 0.1, memoryBytes: 241172480, uptimeSeconds: 4950 },
    ] });
  });
  await expect(dock.getByRole('row')).toHaveCount(3);
  expect(await positions()).toEqual(before);
  await page.screenshot({ path: '/tmp/kurlo-performance-first-snapshot.png', animations: 'disabled' });
});

test('performance dock resizes within bounds and remembers its height', async ({ page }) => {
  await installKurloBridge(page, '', 'browser/e2e', false, null, { preserveStorage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle performance dock' }).click();
  const dock = page.getByRole('region', { name: 'Performance dock' });
  const handle = dock.getByRole('separator', { name: 'Resize performance dock' });
  await expect(handle).toBeVisible();
  const initial = (await dock.boundingBox())!;
  const bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 120, { steps: 8 });
  await page.mouse.up();
  expect(await handle.evaluate(element => document.activeElement === element)).toBe(false);
  expect(await handle.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none');
  expect((await dock.boundingBox())!.height).toBeGreaterThan(initial.height + 50);
  await handle.focus();
  await page.keyboard.press('End');
  const max = Number(await handle.getAttribute('aria-valuemax'));
  expect(Number(await handle.getAttribute('aria-valuenow'))).toBe(max);
  const maxBounds = (await handle.boundingBox())!;
  await page.mouse.move(maxBounds.x + maxBounds.width / 2, maxBounds.y + maxBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(maxBounds.x + maxBounds.width / 2, 0, { steps: 8 });
  await page.mouse.up();
  expect(Number(await handle.getAttribute('aria-valuenow'))).toBe(max);
  await handle.press('Home');
  const min = Number(await handle.getAttribute('aria-valuemin'));
  expect(Number(await handle.getAttribute('aria-valuenow'))).toBe(min);
  const minBounds = (await handle.boundingBox())!;
  await page.mouse.move(minBounds.x + minBounds.width / 2, minBounds.y + minBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(minBounds.x + minBounds.width / 2, 880, { steps: 8 });
  await page.mouse.up();
  expect(Number(await handle.getAttribute('aria-valuenow'))).toBe(min);
  await handle.press('ArrowUp');
  const selectedHeight = (await dock.boundingBox())!.height;
  await dock.getByRole('button', { name: 'Close performance dock' }).click();
  await page.getByRole('button', { name: 'Toggle performance dock' }).click();
  await expect(handle).toHaveAttribute('aria-valuenow', String(min + 1));
  expect((await dock.boundingBox())!.height).toBe(selectedHeight);
  await page.reload();
  await expect(handle).toHaveAttribute('aria-valuenow', String(min + 1));
  await page.setViewportSize({ width: 900, height: 650 });
  await handle.press('End');
  expect((await dock.boundingBox())!.height).toBeLessThanOrEqual(650 * 0.5 + 1);
  await page.screenshot({ path: '/tmp/kurlo-performance-resized.png', animations: 'disabled' });
});

test('performance samples preserve runner scroll position in a reduced workspace', async ({ page }) => {
  const requests = Array.from({ length: 500 }, (_, index) => ({ id: `perf-runner-${index}`, collectionId: 'perf-runner', name: `Request ${index}`, method: 'GET', url: 'http://localhost:8080', folderPath: [`Group ${Math.floor(index / 10)}`] }));
  await installKurloBridge(page, '', 'browser/e2e', false, { collections: [{ id: 'perf-runner', workspaceId: 'workspace-e2e', name: 'Performance runner' }], requests });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Collection runner', exact: true }).click();
  const runner = page.getByRole('region', { name: 'Collection runner' });
  await runner.locator('.runner-select .app-select-trigger').click();
  await runner.getByRole('option', { name: 'Performance runner' }).click();
  await page.getByRole('button', { name: 'Toggle performance dock' }).click();
  const dock = page.getByRole('region', { name: 'Performance dock' });
  await expect(dock).toBeVisible();
  await dock.getByRole('separator').press('End');
  const body = runner.locator('.runner-page-body');
  await body.evaluate(element => { element.scrollTop = 1800; });
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(1700);
  const samples = await body.evaluate(async element => {
    const app = window.go!.api!.App!;
    const sample = await app.PerformanceStatus!();
    const positions = [];
    for (let i = 0; i < 12; i++) {
      element.scrollTop += 12;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const before = element.scrollTop;
      const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-testid="runner-request-row"]')).find(row => row.getBoundingClientRect().bottom > element.getBoundingClientRect().top);
      const anchorName = anchor?.textContent;
      const anchorY = anchor?.getBoundingClientRect().top;
      window.__kurloE2E.emit('perf:sample', { ...sample, sampledAt: Date.now() + i * 1000 });
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      const sameRow = Array.from(element.querySelectorAll<HTMLElement>('[data-testid="runner-request-row"]')).find(row => row.textContent === anchorName);
      positions.push({ before, after: element.scrollTop, anchorY, afterY: sameRow?.getBoundingClientRect().top });
    }
    return positions;
  });
  for (const position of samples) {
    expect(Math.abs(position.before - position.after)).toBeLessThan(2);
    expect(position.anchorY).toBeDefined();
    expect(position.afterY).toBeDefined();
    expect(Math.abs(position.anchorY! - position.afterY!)).toBeLessThan(2);
  }
  const anchor = await body.evaluate(element => {
    const row = Array.from(element.querySelectorAll<HTMLElement>('[data-testid="runner-request-row"]')).find(row => row.getBoundingClientRect().top >= element.getBoundingClientRect().top)!;
    const value = { text: row.textContent, y: row.getBoundingClientRect().top };
    const style = document.createElement('style');
    style.textContent = '.runner-request-row { min-height: 4rem; }';
    document.head.append(style);
    return value;
  });
  await expect.poll(() => body.evaluate((element, text) => {
    const row = Array.from(element.querySelectorAll<HTMLElement>('[data-testid="runner-request-row"]')).find(row => row.textContent === text);
    return row?.getBoundingClientRect().height ?? 0;
  }, anchor.text)).toBeGreaterThan(60);
  const after = await body.evaluate((element, text) => Array.from(element.querySelectorAll<HTMLElement>('[data-testid="runner-request-row"]')).find(row => row.textContent === text)?.getBoundingClientRect().top, anchor.text);
  expect(after).toBeDefined();
  expect(Math.abs(after! - anchor.y)).toBeLessThan(2);
});

test('performance dock caps saved heights at half the window and keeps the agent composer accessible', async ({ page }) => {
  await installKurloBridge(page, '', 'browser/e2e', false, agentStore, { preserveStorage: true });
  await installAgentBridge(page, [connection]);
  await page.addInitScript(() => {
    localStorage.setItem('kurlo.performanceDockHeight.v1', '100');
    localStorage.setItem('kurlo.performanceDock.v1', JSON.stringify({ open: true, view: 'all' }));
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const dock = page.getByRole('region', { name: 'Performance dock' });
  const handle = dock.getByRole('separator');
  await expect(handle).toBeVisible();
  for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 650 }]) {
    await page.setViewportSize(viewport);
    await handle.press('End');
    const area = (await dock.boundingBox())!;
    expect(area.height).toBeLessThanOrEqual(viewport.height / 2 + 1);
    const composer = page.locator('.agent-composer');
    await expect(composer).toBeVisible();
    const box = (await composer.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(area.y + 1);
    const input = composer.locator('textarea');
    await input.fill('Draft remains editable with Performance open');
    await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  }
  await page.screenshot({ path: '/tmp/kurlo-performance-agent-half.png', animations: 'disabled' });
});
