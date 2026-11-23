import { expect, test } from '@playwright/test';
import { installKurloBridge } from './support/bridge';
import { connection, installAgentBridge } from './support/agent';
import type { ProxyConfig, ProxyEntry, ProxyRule } from '../src/lib/wire';

async function installSaveCapture(page: import('@playwright/test').Page, content: Record<string, unknown>) {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(responseContent => {
    let running = false;
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const entry: ProxyEntry = { id: 1, started: '2026-11-23T10:00:00Z', duration: 15, sent: 0, received: 12, host: 'shop.test', url: 'https://shop.test/orders', method: 'GET', path: '/orders', status: 200 };
    const status = () => ({ running, address: running ? '127.0.0.1:9090' : '', count: running ? 1 : 0, config, rules: 0, systemProxy: false });
    const app = window.go!.api!.App!;
    Object.assign(app, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => running ? [entry] : [],
      StartProxyCapture: async () => { running = true; return status(); },
      StopProxyCapture: async () => { running = false; return status(); },
      ProxyCaptureEntry: async () => ({ entry, request: { headers: {}, body: '', binary: false, truncated: false }, response: { headers: { 'Content-Type': ['application/octet-stream'] }, body: '', binary: false, truncated: false } }),
      ProxyCaptureHAR: async () => JSON.stringify({ log: { entries: [{ request: { method: 'GET', url: entry.url, queryString: [] }, response: { status: 200, statusText: 'OK', content: responseContent } }] } }),
    });
  }, content);
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  const row = page.locator('.capture-row').filter({ hasText: '/orders' });
  await expect(row).toBeVisible();
  await row.click();
}

test('capture, inspect a tunnel and save an HTTP request with its example', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    let running = false;
    let config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const rows: ProxyEntry[] = [];
    const status = () => ({ running, address: rows.length ? '127.0.0.1:9090' : '', count: rows.length, config, rules: 0 });
    const base = { started: '2026-11-18T14:32:00Z', duration: 12, sent: 0, received: 12 };
    const msg = { headers: { 'Content-Type': ['application/json'] }, body: '', binary: false, truncated: false };
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [...rows],
      StartProxyCapture: async (value: ProxyConfig) => {
        running = true; config = value;
        rows.push({ ...base, id: 1, host: 'shop.test', url: 'http://shop.test/orders', method: 'GET', path: '/orders', status: 200 },
          { ...base, id: 2, host: 'cdn.test:443', url: '', path: '', method: 'CONNECT', status: 200 });
        const paths = ['/orders/184', '/orders/184/items', '/orders/184/payment', '/inventory', '/orders/184/receipt'];
        for (const [index, path] of paths.entries()) {
          const status = [200, 200, 202, 304, 404][index];
          rows.push({ ...base, id: index + 3, host: 'shop.test', method: index === 2 ? 'POST' : 'GET', url: 'http://shop.test' + path, path, status, duration: 15 + index * 4 });
        }
        return status();
      },
      StopProxyCapture: async () => { running = false; return status(); },
      ProxyCaptureEntry: async (id: number) => ({ entry: rows.find(r => r.id === id), request: msg, response: { ...msg, body: '{"total":42}' } }),
      ProxyCaptureHAR: async () => JSON.stringify({ log: { entries: [{ request: { method: 'GET', url: 'http://shop.test/orders' }, response: { status: 200, content: { mimeType: 'application/json', text: '{"total":42}' } } }] } })
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await page.getByRole('button', { name: 'Capture settings' }).click();
  await expect(page.getByText('http://127.0.0.1:9090/proxy.pac', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  expect(page.context().pages()).toEqual([page]);
  await expect(page.getByText('"total": 42', { exact: false })).toBeVisible();
  await page.getByRole('radio', { name: 'By host' }).click();
  await page.getByRole('navigation', { name: 'Capture hosts' }).getByRole('button', { name: /cdn\.test:443/ }).click();
  await expect(page.getByText('HTTPS tunnel · metadata only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as request' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Timeline' }).click();
  await page.getByLabel('Filter traffic').fill('/orders');
  await page.getByRole('tab', { name: 'Request', exact: true }).click();
  await expect(page.getByText('Content-Type').first()).toBeVisible();
  await page.getByRole('tab', { name: /^Response/ }).click();
  await page.getByLabel('Filter traffic').fill('');
  const screenshot = process.env.KURLO_PROXY_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot, animations: 'disabled' });
  await page.getByRole('button', { name: 'Stop capture' }).click();
  await page.getByRole('button', { name: 'Save as request' }).click();
  await page.getByLabel('Request name').fill('Captured orders');
  await page.getByRole('button', { name: 'Save request', exact: true }).click();
  await expect(page.getByRole('tab', { name: /Captured orders/ })).toBeVisible();
  const saved = await page.evaluate(() => window.__kurloE2E.store.requests.find(r => r.name === 'Captured orders'));
  expect(saved?.folderPath).toEqual(['Captured']);
  expect(saved?.url).toBe('http://shop.test/orders');
  expect(saved?.examples?.[0]?.response.body).toBe('{"total":42}');
});

test('refuses Save as request for binary responses and keeps HAR export available', async ({ page }) => {
  await installSaveCapture(page, { mimeType: 'application/octet-stream', text: 'AAE=', encoding: 'base64' });
  await page.getByRole('button', { name: 'Save as request' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save as request' });
  await dialog.getByLabel('Request name').fill('Binary response');
  await dialog.getByRole('button', { name: 'Save request', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('binary response');
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.length)).toBe(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Export HAR', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedFiles.length)).toBe(1);
  const exported = await page.evaluate(() => window.__kurloE2E.savedFiles[0]?.content ?? '');
  expect(exported).toContain('"encoding":"base64"');
  expect(exported).toContain('AAE=');
});

test('refuses Create collection for incomplete responses without importing a partial example', async ({ page }) => {
  await installSaveCapture(page, { mimeType: 'text/plain', text: 'partial preview', _incomplete: true });
  await page.getByRole('button', { name: 'Create collection', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('incomplete response');
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.length)).toBe(0);
});

test('opens a captured request with a binary response without creating an empty example', async ({ page }) => {
  await installSaveCapture(page, { mimeType: 'application/octet-stream', text: 'AAE=', encoding: 'base64' });
  await page.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(page.getByLabel('Request URL')).toHaveValue('https://shop.test/orders');
  const examples = await page.evaluate(() => window.__kurloE2E.store.requests.at(-1)?.examples ?? []);
  expect(examples).toEqual([]);
});

test('decrypt a tunnelled host with the trusted Kurlo certificate', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'darwin';
    let running = false;
    let config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const certificate = { exists: false, trusted: false, path: '/tmp/kurlo-capture-ca.pem', subject: '', fingerprint: '', notAfter: '' };
    const calls: string[][] = [];
    (window as unknown as { proxyCalls: string[][] }).proxyCalls = calls;
    const rows: ProxyEntry[] = [{ id: 1, started: '2026-11-18T14:32:00Z', duration: 40, sent: 512, received: 4096, host: 'api.shop.test:443', url: '', path: '', method: 'CONNECT', status: 200 }];
    const status = () => ({ running, address: '127.0.0.1:9090', count: rows.length, config, rules: 0 });
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => running ? [...rows] : [],
      ProxyCaptureEntry: async (id: number) => ({ entry: rows.find(r => r.id === id), request: { headers: {}, body: '', binary: false, truncated: false }, response: { headers: {}, body: '', binary: false, truncated: false } }),
      StartProxyCapture: async (value: ProxyConfig) => { calls.push(['start', ...(value.sslHosts ?? [])]); running = true; config = value; return status(); },
      StopProxyCapture: async () => { running = false; return status(); },
      SetProxySSLHosts: async (hosts: string[]) => { calls.push(['hosts', ...hosts]); config = { ...config, sslHosts: hosts }; return status(); },
      ProxyCertificate: async () => ({ ...certificate }),
      ProxyCertificatePEM: async () => { certificate.exists = true; certificate.subject = 'Kurlo Capture CA 1A2B3C4D'; certificate.fingerprint = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF'; return '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n'; },
      TrustProxyCertificate: async () => { calls.push(['trust']); Object.assign(certificate, { exists: true, trusted: true, subject: 'Kurlo Capture CA 1A2B3C4D', fingerprint: 'AB:CD:EF:01:23:45:67:89:AB:CD:EF' }); return { ...certificate }; }
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await page.getByRole('button', { name: 'Capture settings' }).click();
  const decryption = page.getByRole('region', { name: 'HTTPS decryption' });
  await decryption.getByLabel('Host to decrypt').fill('*.payments.test');
  await decryption.getByRole('button', { name: 'Add host' }).click();
  await expect(decryption.getByRole('listitem').filter({ hasText: '*.payments.test' })).toBeVisible();
  await expect(decryption.getByText('A wildcard decrypts every matching site')).toBeVisible();
  await decryption.getByRole('button', { name: 'Trust Kurlo certificate…' }).click();
  await expect(decryption.getByText('Certificate trusted')).toBeVisible();
  await expect(decryption.getByRole('button', { name: 'Remove trust…' })).toBeVisible();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await page.getByRole('button', { name: 'api.shop.test:443' }).click();
  await expect(page.getByText('HTTPS tunnel · metadata only')).toBeVisible();
  const hintScreenshot = process.env.KURLO_PROXY_SSL_HINT_SCREENSHOT;
  if (hintScreenshot) await page.screenshot({ path: hintScreenshot, animations: 'disabled' });
  await page.getByRole('button', { name: 'Decrypt api.shop.test' }).click();
  await expect(page.getByRole('button', { name: 'Decrypt api.shop.test' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Capture settings' }).click();
  await expect(decryption.getByRole('listitem').filter({ hasText: 'api.shop.test' })).toBeVisible();
  const screenshot = process.env.KURLO_PROXY_SSL_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot, animations: 'disabled' });
  await decryption.getByRole('button', { name: 'Stop decrypting *.payments.test' }).click();
  await expect(decryption.getByRole('listitem')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { proxyCalls: string[][] }).proxyCalls)).toEqual([
    ['trust'], ['start', '*.payments.test'], ['hosts', '*.payments.test', 'api.shop.test'], ['hosts', 'api.shop.test']
  ]);
  expect(await page.evaluate(() => localStorage.getItem('kurlo.proxy.sslHosts'))).toBe('["api.shop.test"]');
});

test('record through the system proxy and turn it off for the next session', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'darwin';
    let running = false;
    let config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const starts: boolean[] = [];
    (window as unknown as { proxyStarts: boolean[] }).proxyStarts = starts;
    const status = () => ({ running, address: '127.0.0.1:9090', count: 0, config, rules: 0, systemProxy: running && config.systemProxy });
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [],
      ProxyCertificate: async () => ({ exists: false, trusted: false, path: '', subject: '', fingerprint: '', notAfter: '' }),
      StartProxyCapture: async (value: ProxyConfig) => { starts.push(value.systemProxy); running = true; config = value; return status(); },
      StopProxyCapture: async () => { running = false; return status(); }
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await expect(page.locator('.empty-state').getByText('Click Record, then open a site in any browser.')).toBeVisible();
  await page.getByRole('button', { name: 'Capture settings' }).click();
  const option = page.getByRole('checkbox', { name: /Use as system proxy while recording/ });
  await expect(option).toBeChecked();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.locator('.capture .mock-head').getByText('System proxy', { exact: true })).toBeVisible();
  const screenshot = process.env.KURLO_PROXY_SYSTEM_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot, animations: 'disabled' });
  await expect(page.locator('.empty-state').getByText('Open or reload a site in any browser.')).toBeVisible();
  await page.getByRole('button', { name: 'Stop capture' }).click();
  await expect(page.locator('.capture .mock-head').getByText('System proxy', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Capture settings' }).click();
  await option.uncheck();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.locator('.empty-state').getByText('Open or reload a site in your configured browser.')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { proxyStarts: boolean[] }).proxyStarts)).toEqual([true, false]);
  expect(await page.evaluate(() => localStorage.getItem('kurlo.proxy.systemProxy'))).toBe('0');
});

async function installSlowCapture(page: import('@playwright/test').Page, statusDelay: number) {
  await page.evaluate(delay => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const rows: ProxyEntry[] = ['/alpha', '/bravo', '/charlie'].map((path, index) => ({ id: index + 1, started: '2026-11-18T14:32:00Z', duration: 10 + index, sent: 0, received: 20, host: 'shop.test', url: 'http://shop.test' + path, method: 'GET', path, status: 200 }));
    const config: ProxyConfig = { port: 9191, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const msg = { headers: { 'Content-Type': ['application/json'] }, body: '', binary: false, truncated: false };
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => { await wait(delay); return { running: true, address: '127.0.0.1:9191', count: rows.length, config, rules: 0, systemProxy: false }; },
      ProxyPausedResponses: async () => [],
      StartProxyCapture: async () => ({ running: true, address: '127.0.0.1:9191', count: rows.length, config, rules: 0, systemProxy: false }),
      ProxyCaptureEntries: async () => { await wait(delay); return [...rows]; },
      ProxyCaptureEntry: async (id: number) => { await wait(120); return { entry: rows.find(row => row.id === id), request: msg, response: { ...msg, body: JSON.stringify({ marker: 'body-' + id }) } }; },
    });
  }, statusDelay);
}

function sampleFrames(page: import('@playwright/test').Page, action: string) {
  return page.evaluate(async selector => {
    const frames: Array<{ viewer: string; empty: boolean; rows: number; selected: string; detail: boolean }> = [];
    const target = document.querySelector<HTMLElement>(selector);
    target?.click();
    const started = performance.now();
    while (performance.now() - started < 600) {
      await new Promise(requestAnimationFrame);
      frames.push({
        viewer: document.querySelector('.capture-viewer')?.textContent ?? '',
        empty: Boolean(document.querySelector('.capture .empty-state')),
        rows: document.querySelectorAll('.capture-row').length,
        selected: document.querySelector('.capture-row.active')?.getAttribute('aria-label') ?? '',
        detail: Boolean(document.querySelector('.capture-detail')),
      });
    }
    return frames;
  }, action);
}

test('switching captured rows never shows the previous response', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await installSlowCapture(page, 0);
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await page.getByRole('button', { name: 'http://shop.test/alpha', exact: true }).click();
  await expect(page.locator('.capture-viewer')).toContainText('body-1');
  const frames = await sampleFrames(page, '[aria-label="http://shop.test/bravo"]');
  expect(frames.filter(frame => frame.selected === 'http://shop.test/bravo' && frame.viewer.includes('body-1'))).toEqual([]);
  expect(frames.filter(frame => !frame.detail)).toEqual([]);
  expect(frames.at(-1)?.viewer).toContain('body-2');
  await page.getByRole('button', { name: 'http://shop.test/charlie', exact: true }).hover();
  await page.waitForTimeout(200);
  const prefetched = await sampleFrames(page, '[aria-label="http://shop.test/charlie"]');
  expect(prefetched[0].viewer).toContain('body-3');
  const back = await sampleFrames(page, '[aria-label="http://shop.test/alpha"]');
  expect(back[0].viewer).toContain('body-1');
});

test('opening the capture tab does not flash an empty screen', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await installSlowCapture(page, 150);
  const first = await sampleFrames(page, '[aria-label="Capture proxy"]');
  expect(first.filter(frame => frame.empty)).toEqual([]);
  expect(first.at(-1)?.rows).toBe(3);
  await page.getByRole('tab', { name: /New Request/ }).first().click();
  await expect(page.locator('.capture')).toHaveCount(0);
  const again = await sampleFrames(page, '[aria-label="Capture proxy"]');
  expect(again.filter(frame => frame.empty)).toEqual([]);
  expect(again[0].rows).toBe(3);
});

test('search captured bodies and clear the list while recording', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.evaluate(() => {
    const bodies: Record<number, string> = { 1: '{"invoice":"INV-42"}', 2: '{"items":[]}', 3: '{"user":"ada"}' };
    let rows: ProxyEntry[] = ['/orders?color=aquamarine', '/cart', '/profile'].map((path, index) => ({ id: index + 1, started: '2026-11-18T14:32:00Z', duration: 10, sent: 0, received: 20, host: 'shop.test', url: 'http://shop.test' + path, method: 'GET', path: path.split('?')[0], status: 200 }));
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const status = () => ({ running: true, address: '127.0.0.1:9090', count: rows.length, config, rules: 0, systemProxy: false });
    const searches: string[] = [];
    (window as unknown as { searches: string[] }).searches = searches;
    const msg = { headers: {}, body: '', binary: false, truncated: false };
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [...rows],
      StartProxyCapture: async () => status(),
      ProxyCaptureEntry: async (id: number) => ({ entry: rows.find(row => row.id === id), request: msg, response: { ...msg, body: bodies[id] } }),
      SearchProxyCapture: async (query: string) => {
        searches.push(query);
        return rows.filter(row => bodies[row.id].toLowerCase().includes(query)).map(row => ({ id: row.id, where: ['response body'] }));
      },
      ClearProxyCapture: async () => { rows = []; return status(); },
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await expect(page.locator('.capture-row')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Open HAR', exact: true })).toBeDisabled();
  await page.getByLabel('Filter traffic').fill('inv-42');
  await expect(page.locator('.capture-row')).toHaveCount(1);
  await expect(page.locator('.capture-row')).toContainText('/orders');
  await expect(page.locator('.capture-row .capture-match')).toHaveText('in response body');
  const shot = process.env.KURLO_PROXY_SEARCH_SCREENSHOT;
  if (shot) await page.screenshot({ path: shot, animations: 'disabled' });
  await page.getByLabel('Filter traffic').fill('/cart');
  await expect(page.locator('.capture-row')).toHaveCount(1);
  await expect(page.locator('.capture-row .capture-match')).toHaveCount(0);
  await page.getByLabel('Filter traffic').fill('aquamarine');
  await expect(page.locator('.capture-row')).toHaveCount(1);
  await expect(page.locator('.capture-row')).toContainText('/orders');
  await page.getByLabel('Filter traffic').fill('orders');
  await expect(page.locator('.capture-row')).toHaveCount(1);
  await page.getByLabel('Filter traffic').fill('');
  await expect(page.locator('.capture-row')).toHaveCount(3);
  expect(await page.evaluate(() => (window as unknown as { searches: string[] }).searches)).toContain('inv-42');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.locator('.capture-row')).toHaveCount(0);
  await expect(page.locator('.capture .empty-state')).toContainText('Waiting for traffic');
  await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled();
});

test('search starts while capture events continue arriving', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.evaluate(() => {
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const row: ProxyEntry = { id: 1, started: '2026-11-18T14:32:00Z', duration: 10, sent: 0, received: 20, host: 'shop.test', url: 'http://shop.test/orders', method: 'GET', path: '/orders', status: 200 };
    const calls: string[] = [];
    (window as unknown as { proxySearchCalls: string[] }).proxySearchCalls = calls;
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => ({ running: true, address: '127.0.0.1:9090', count: 1, config, rules: 0, systemProxy: false }),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [row],
      StartProxyCapture: async () => ({ running: true, address: '127.0.0.1:9090', count: 1, config, rules: 0, systemProxy: false }),
      SearchProxyCapture: async (query: string) => {
        calls.push(query);
        await new Promise(resolve => setTimeout(resolve, 620));
        return query === 'fixed-query' ? [{ id: 1, where: ['response body'] }] : [];
      },
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await expect(page.locator('.capture-row')).toHaveCount(1);
  await page.getByLabel('Filter traffic').fill('fixed-query');
  await page.evaluate(() => {
    const state = window.__kurloE2E;
    const timer = window.setInterval(() => state.emit('proxy:changed', {}), 80);
    window.setTimeout(() => window.clearInterval(timer), 1300);
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { proxySearchCalls: string[] }).proxySearchCalls.includes('fixed-query')), { timeout: 1050 }).toBe(true);
  await expect(page.locator('.capture-row .capture-match')).toHaveText('in response body', { timeout: 1250 });
});

test('a newer search wins while capture traffic continues', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.evaluate(() => {
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const row: ProxyEntry = { id: 1, started: '2026-11-18T14:32:00Z', duration: 10, sent: 0, received: 20, host: 'shop.test', url: 'http://shop.test/orders', method: 'GET', path: '/orders', status: 200 };
    const calls: string[] = [];
    (window as unknown as { proxySearchCalls: string[] }).proxySearchCalls = calls;
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => ({ running: true, address: '127.0.0.1:9090', count: 1, config, rules: 0, systemProxy: false }),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [row],
      StartProxyCapture: async () => ({ running: true, address: '127.0.0.1:9090', count: 1, config, rules: 0, systemProxy: false }),
      SearchProxyCapture: async (query: string) => {
        calls.push(query);
        if (query === 'first-query') await new Promise(resolve => setTimeout(resolve, 600));
        return query === 'first-query' ? [{ id: 1, where: ['response body'] }] : [];
      },
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await expect(page.locator('.capture-row')).toHaveCount(1);
  const filter = page.getByLabel('Filter traffic');
  await filter.fill('first-query');
  await expect.poll(() => page.evaluate(() => (window as unknown as { proxySearchCalls: string[] }).proxySearchCalls.includes('first-query'))).toBe(true);
  await page.evaluate(() => {
    const state = window.__kurloE2E;
    const timer = window.setInterval(() => state.emit('proxy:changed', {}), 80);
    window.setTimeout(() => window.clearInterval(timer), 1400);
  });
  await filter.fill('second-query');
  await expect.poll(() => page.evaluate(() => (window as unknown as { proxySearchCalls: string[] }).proxySearchCalls.includes('second-query'))).toBe(true);
  await expect(page.locator('.capture-row')).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect(page.locator('.capture-row')).toHaveCount(0);
});

test('Map local copies the complete text body of an archived response', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const body = 'x'.repeat(20 * 1024) + 'ARCHIVE_TAIL_MARKER';
  await page.evaluate(body => {
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const row: ProxyEntry = { id: 1, started: '2026-11-22T10:00:00Z', duration: 15, sent: 0, received: body.length, host: 'shop.test', url: 'https://shop.test/orders/42', method: 'GET', path: '/orders/42', status: 201 };
    const rules: ProxyRule[][] = [];
    (window as unknown as { archiveRuleWrites: ProxyRule[][] }).archiveRuleWrites = rules;
    const status = () => ({ running: true, address: '127.0.0.1:9090', count: 1, config, rules: 0, systemProxy: false });
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [row],
      StartProxyCapture: async () => status(),
      ProxyCaptureEntry: async () => ({ entry: row, request: { headers: {}, body: '', binary: false, truncated: false }, response: { headers: { 'Content-Type': ['text/plain'] }, body: body.slice(0, 16 * 1024), binary: false, truncated: true, archived: true } }),
      ProxyCaptureHAR: async () => JSON.stringify({ log: { entries: [{ response: { content: { mimeType: 'text/plain', text: body } } }] } }),
      SetProxyRules: async (next: ProxyRule[]) => { rules.push(JSON.parse(JSON.stringify(next))); return next; },
    });
  }, body);
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  const detail = page.getByRole('region', { name: 'Captured exchange' });
  await expect(detail).toContainText('First 16 KiB shown. Export HAR for the full body.');
  await detail.getByRole('button', { name: 'Map local' }).click();
  const editor = page.getByRole('dialog', { name: 'New Map local rule' });
  await expect(editor.getByRole('status')).toHaveCount(0);
  const screenshot = process.env.KURLO_PROXY_ARCHIVED_RULE_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot, animations: 'disabled' });
  await editor.getByRole('button', { name: 'Add rule' }).click();
  const saved = await page.evaluate(() => (window as unknown as { archiveRuleWrites: ProxyRule[][] }).archiveRuleWrites.at(-1)?.[0].local.body ?? '');
  expect(saved).toBe(body);
});

test('warns and omits binary, incomplete, and oversized archived bodies', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const row: ProxyEntry = { id: 1, started: '2026-11-22T10:00:00Z', duration: 15, sent: 0, received: 20 * 1024, host: 'shop.test', url: 'https://shop.test/orders/42', method: 'GET', path: '/orders/42', status: 201 };
    let content: Record<string, unknown> = { mimeType: 'text/plain', text: 'x'.repeat(20 * 1024), _incomplete: true };
    const status = () => ({ running: true, address: '127.0.0.1:9090', count: 1, config, rules: 0, systemProxy: false });
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [row],
      StartProxyCapture: async () => status(),
      ProxyCaptureEntry: async () => ({ entry: row, request: { headers: {}, body: '', binary: false, truncated: false }, response: { headers: { 'Content-Type': ['text/plain'] }, body: 'x'.repeat(16 * 1024), binary: false, truncated: true, archived: true } }),
      ProxyCaptureHAR: async () => JSON.stringify({ log: { entries: [{ response: { content } }] } }),
      SetProxyRules: async (next: ProxyRule[]) => next,
    });
    (window as unknown as { setArchivedContent: (value: Record<string, unknown>) => void }).setArchivedContent = value => { content = value; };
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  const detail = page.getByRole('region', { name: 'Captured exchange' });
  await detail.getByRole('button', { name: 'Map local' }).click();
  const editor = page.getByRole('dialog', { name: 'New Map local rule' });
  await expect(editor.getByRole('status')).toContainText('incomplete');
  await expect(editor.getByLabel('Local response body').locator('.cm-placeholder')).toBeVisible();
  await editor.getByRole('button', { name: 'Close dialog' }).click();
  await page.evaluate(() => (window as unknown as { setArchivedContent: (value: Record<string, unknown>) => void }).setArchivedContent({ mimeType: 'application/octet-stream', text: 'AA==', encoding: 'base64' }));
  await detail.getByRole('button', { name: 'Map local' }).click();
  const binaryEditor = page.getByRole('dialog', { name: 'New Map local rule' });
  await expect(binaryEditor.getByRole('status')).toContainText('binary');
  await expect(binaryEditor.getByLabel('Local response body').locator('.cm-placeholder')).toBeVisible();
  await binaryEditor.getByRole('button', { name: 'Close dialog' }).click();
  await page.evaluate(() => (window as unknown as { setArchivedContent: (value: Record<string, unknown>) => void }).setArchivedContent({ mimeType: 'text/plain', text: 'x'.repeat((1 << 20) + 1) }));
  await detail.getByRole('button', { name: 'Map local' }).click();
  const largeEditor = page.getByRole('dialog', { name: 'New Map local rule' });
  await expect(largeEditor.getByRole('status')).toContainText('exceeds the 1 MiB');
  await expect(largeEditor.getByLabel('Local response body').locator('.cm-placeholder')).toBeVisible();
});

test('does not use the preview of an incomplete unarchived response', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.evaluate(() => {
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const row: ProxyEntry = { id: 1, started: '2026-11-22T10:00:00Z', duration: 15, sent: 0, received: 20 * 1024, host: 'shop.test', url: 'https://shop.test/orders/42', method: 'GET', path: '/orders/42', status: 201 };
    const status = () => ({ running: true, address: '127.0.0.1:9090', count: 1, config, rules: 0, systemProxy: false });
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [row],
      StartProxyCapture: async () => status(),
      ProxyCaptureEntry: async () => ({ entry: row, request: { headers: {}, body: '', binary: false, truncated: false }, response: { headers: { 'Content-Type': ['text/plain'] }, body: 'x'.repeat(16 * 1024), binary: false, truncated: true, archived: false } }),
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  const detail = page.getByRole('region', { name: 'Captured exchange' });
  await expect(detail).toContainText('Only the first 16 KiB were kept.');
  await detail.getByRole('button', { name: 'Map local' }).click();
  const editor = page.getByRole('dialog', { name: 'New Map local rule' });
  await expect(editor.getByRole('status')).toContainText('incomplete');
  await expect(editor.getByLabel('Local response body').locator('.cm-placeholder')).toBeVisible();
});

test('does not open an archived rule after the selected exchange changes', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const rows: ProxyEntry[] = [1, 2].map(id => ({ id, started: '2026-11-22T10:00:00Z', duration: 15, sent: 0, received: 20 * 1024, host: 'shop.test', url: `https://shop.test/orders/${id}`, method: 'GET', path: `/orders/${id}`, status: 201 }));
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => ({ running: true, address: '127.0.0.1:9090', count: 2, config, rules: 0, systemProxy: false }),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => rows,
      StartProxyCapture: async () => ({ running: true, address: '127.0.0.1:9090', count: 2, config, rules: 0, systemProxy: false }),
      ProxyCaptureEntry: async (id: number) => ({ entry: rows.find(row => row.id === id), request: { headers: {}, body: '', binary: false, truncated: false }, response: id === 1 ? { headers: {}, body: 'preview', binary: false, truncated: true, archived: true } : { headers: {}, body: 'second body', binary: false, truncated: false } }),
      ProxyCaptureHAR: async () => new Promise(resolve => { (window as unknown as { resolveArchiveHAR: (value: string) => void }).resolveArchiveHAR = resolve; }),
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  const detail = page.getByRole('region', { name: 'Captured exchange' });
  await expect(detail).toContainText('/orders/1');
  await detail.getByRole('button', { name: 'Map local' }).click();
  await page.locator('.capture-row').filter({ hasText: '/orders/2' }).click();
  await expect(detail).toContainText('/orders/2');
  await page.evaluate(() => {
    const har = JSON.stringify({ log: { entries: [{ response: { content: { mimeType: 'text/plain', text: 'stale archived body' } } }] } });
    (window as unknown as { resolveArchiveHAR: (value: string) => void }).resolveArchiveHAR(har);
  });
  await expect(page.getByRole('dialog', { name: 'New Map local rule' })).toHaveCount(0);
  await detail.getByRole('button', { name: 'Map local' }).click();
  const editor = page.getByRole('dialog', { name: 'New Map local rule' });
  await expect(editor.getByLabel('URL pattern')).toHaveValue('https://shop.test/orders/2');
});

test('Load file replaces the body with the selected empty file', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await installRulesCapture(page);
  await page.evaluate(() => {
    const files = ['/tmp/response.txt', '/tmp/empty-response.txt'];
    Object.assign(window.go!.api!.App!, {
      OpenFileDialog: async () => files.shift() ?? '',
      ReadProxyResponseFile: async (path: string) => path.endsWith('empty-response.txt') ? '' : 'loaded file response',
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await page.getByRole('button', { name: 'Capture rules' }).click();
  await page.getByRole('button', { name: 'Add Map local' }).click();
  const editor = page.getByRole('dialog', { name: 'New Map local rule' });
  const body = editor.getByLabel('Local response body').locator('.cm-content');
  await body.fill('old response body');
  await editor.getByRole('button', { name: 'Load file…' }).click();
  await expect(body).toContainText('loaded file response');
  await body.fill('old response body');
  await editor.getByRole('button', { name: 'Load file…' }).click();
  await expect(body.locator('.cm-placeholder')).toBeVisible();
  const screenshot = process.env.KURLO_PROXY_EMPTY_FILE_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot, animations: 'disabled' });
});

test('Use a saved example fills the local response status, type and body', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1120, height: 680 });
  await page.goto('/');
  await page.evaluate(() => {
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const row: ProxyEntry = { id: 1, started: '2026-11-22T10:00:00Z', duration: 15, sent: 0, received: 20, host: 'shop.test', url: 'https://shop.test/orders', method: 'GET', path: '/orders', status: 201 };
    const status = () => ({ running: true, address: '127.0.0.1:9090', count: 1, config, rules: 0, systemProxy: false });
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [row],
      StartProxyCapture: async () => status(),
      ProxyCaptureEntry: async () => ({ entry: row, request: { headers: {}, body: '', binary: false, truncated: false }, response: { headers: { 'Content-Type': ['text/plain'] }, body: 'saved example body', binary: false, truncated: false } }),
      ProxyCaptureHAR: async () => JSON.stringify({ log: { entries: [{ request: { method: 'GET', url: row.url, queryString: [] }, response: { status: 201, statusText: 'Created', headers: [{ name: 'Content-Type', value: 'text/plain' }], content: { mimeType: 'text/plain', text: 'saved example body' } } }] } }),
      ProxyRules: async () => [],
      SetProxyRules: async (next: ProxyRule[]) => next,
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await page.getByRole('button', { name: 'Create collection', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.length)).toBe(1);
  await page.getByRole('tab', { name: /Capture/ }).click();
  await page.getByRole('button', { name: 'Capture rules' }).click();
  await page.getByRole('button', { name: 'Add Map local' }).click();
  const editor = page.getByRole('dialog', { name: 'New Map local rule' });
  await editor.getByLabel('URL pattern').fill('https://shop.test/orders');
  await editor.getByLabel('Saved request').click();
  await page.getByRole('option', { name: /GET \/orders/ }).click();
  await editor.getByLabel('Response example').click();
  await page.getByRole('option', { name: '201 Created' }).click();
  await expect(editor.getByLabel('Status')).toHaveValue('201');
  await expect(editor.getByLabel('Content-Type')).toHaveValue('text/plain');
  await expect(editor.getByLabel('Local response body').locator('.cm-content')).toContainText('saved example body');
  const screenshot = process.env.KURLO_PROXY_SAVED_EXAMPLE_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot, animations: 'disabled' });
});

async function installRulesCapture(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'darwin';
    let rows: ProxyEntry[] = ['/orders/1', '/orders/2', '/cart', '/profile'].map((path, index) => ({ id: index + 1, started: '2026-11-18T14:32:00Z', duration: 10, sent: 0, received: 20, host: 'shop.test', url: 'https://shop.test' + path + (index === 0 ? '?expand=items' : ''), method: index === 2 ? 'POST' : 'GET', path, status: 200 }));
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    let rules: ProxyRule[] = [];
    const calls: { rules: ProxyRule[][]; deleted: number[][]; har: number[][] } = { rules: [], deleted: [], har: [] };
    (window as unknown as { captureCalls: typeof calls }).captureCalls = calls;
    const status = () => ({ running: true, address: '127.0.0.1:9090', count: rows.length, config, rules: rules.filter(rule => rule.enabled).length, systemProxy: false });
    const msg = { headers: { 'Content-Type': ['application/json'] }, body: '{"id":1}', binary: false, truncated: false };
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [...rows],
      StartProxyCapture: async () => status(),
      ProxyCaptureEntry: async (id: number) => ({ entry: rows.find(row => row.id === id), request: { ...msg, body: '' }, response: msg }),
      ProxyCaptureHAR: async (ids: number[]) => { calls.har.push(ids); return JSON.stringify({ log: { entries: [] } }); },
      ProxyRules: async () => rules.map(rule => ({ ...rule })),
      SetProxyRules: async (next: ProxyRule[]) => {
        if (next.some(rule => rule.url.includes('reject'))) throw new Error('Orders: start the URL pattern with http://, https:// or *://');
        calls.rules.push(JSON.parse(JSON.stringify(next)));
        rules = next.map(rule => ({ ...rule, hits: rule.id === next[0]?.id ? 3 : 0 }));
        return rules;
      },
      DeleteProxyEntries: async (ids: number[]) => { calls.deleted.push(ids); rows = rows.filter(row => !ids.includes(row.id)); return status(); },
    });
  });
}

test('create, edit, order and remove capture rules', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await installRulesCapture(page);
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await page.getByRole('button', { name: 'https://shop.test/orders/1?expand=items', exact: true }).click();
  await page.getByRole('button', { name: 'Map local', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New Map local rule' });
  const pattern = editor.getByPlaceholder('https://api.example.com/orders/*');
  await expect(pattern).toHaveValue('https://shop.test/orders/1');
  await expect(editor.getByText('Matches 1 recorded request')).toBeVisible();
  await expect(editor.getByLabel('Local response body').locator('.cm-line')).toHaveText(['{', '  "id": 1', '}']);
  await pattern.fill('https://shop.test/orders/*');
  await expect(editor.getByText('Matches 2 recorded requests')).toBeVisible();
  await pattern.fill('shop.test/orders');
  await expect(editor.getByText('Start with http://, https:// or *:// and include a host.')).toBeVisible();
  await pattern.fill('https://shop.test/orders/*');
  await editor.getByLabel('Name').fill('reject me');
  await editor.getByLabel('Name').fill('Orders');
  await editor.getByRole('button', { name: 'Add rule' }).click();
  await expect(editor).toHaveCount(0);
  const drawer = page.getByRole('complementary', { name: 'Capture rules' });
  await expect(drawer.getByRole('listitem').filter({ hasText: 'Orders' })).toContainText('Responds 200 · used 3 times');
  await expect(page.locator('.capture .mock-head').getByText('1 rule on')).toBeVisible();

  await drawer.getByRole('button', { name: 'Add Rewrite' }).click();
  const rewrite = page.getByRole('dialog', { name: 'New Rewrite rule' });
  await rewrite.getByPlaceholder('https://api.example.com/orders/*').fill('https://shop.test/reject/*');
  await rewrite.getByPlaceholder('Keep the original server, or http://localhost:3000').fill('http://localhost:3000');
  await rewrite.getByRole('button', { name: 'Add header' }).first().click();
  await rewrite.getByLabel('Request header name 1').fill('X-Env');
  await rewrite.getByLabel('Request header value 1').fill('dev');
  await rewrite.getByRole('button', { name: 'Add rule' }).click();
  await expect(rewrite.getByRole('alert')).toContainText('start the URL pattern');
  await rewrite.getByPlaceholder('https://api.example.com/orders/*').fill('https://shop.test/api/*');
  await rewrite.getByRole('button', { name: 'Add rule' }).click();
  await expect(rewrite).toHaveCount(0);
  await expect(drawer.getByRole('listitem')).toHaveCount(2);
  await expect(drawer.getByRole('listitem').nth(1)).toContainText('to http://localhost:3000 · 1 request header change');

  const shot = process.env.KURLO_PROXY_RULES_SCREENSHOT;
  if (shot) await page.screenshot({ path: shot, animations: 'disabled' });

  await drawer.getByRole('button', { name: 'Move https://shop.test/api/* up' }).click();
  await expect(drawer.getByRole('listitem').first()).toContainText('Rewrite');
  await drawer.locator('.capture-rule').filter({ hasText: 'Orders' }).locator('.switch-track').click();
  await expect(drawer.getByLabel('Turn on Orders')).toBeVisible();
  await drawer.getByRole('button', { name: 'Delete https://shop.test/api/*' }).click();
  await drawer.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(drawer.getByRole('listitem')).toHaveCount(1);
  const saved = await page.evaluate(() => (window as unknown as { captureCalls: { rules: ProxyRule[][] } }).captureCalls.rules);
  expect(saved.map(list => list.map(rule => `${rule.kind}:${rule.enabled}`))).toEqual([
    ['local:true'], ['local:true', 'rewrite:true'], ['rewrite:true', 'local:true'], ['rewrite:true', 'local:false'], ['local:false'],
  ]);
  expect(saved[1][1].rewrite.setRequestHeaders).toEqual([{ name: 'X-Env', value: 'dev' }]);
  await drawer.getByRole('button', { name: 'Close rules' }).click();
  await expect(drawer).toHaveCount(0);
});

test('edit a Map local rule returned with null rewrite header arrays', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1120, height: 680 });
  await page.goto('/');
  await page.evaluate(() => {
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const rule = { id: 'audit-local', name: 'Audit local', enabled: true, kind: 'local', method: '', url: 'https://shop.test/orders/*', local: { status: 200, contentType: 'text/plain', body: 'saved response', delayMs: 0, rateKiB: 0, errorPercent: 0, pause: false, script: '' }, rewrite: { target: '', pathFrom: '', pathTo: '', setRequestHeaders: null, removeRequestHeaders: null, setResponseHeaders: null, removeResponseHeaders: null }, hits: 0 } as unknown as ProxyRule;
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => ({ running: true, address: '127.0.0.1:9090', count: 0, config, rules: 1, systemProxy: false }),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [],
      StartProxyCapture: async () => ({ running: true, address: '127.0.0.1:9090', count: 0, config, rules: 1, systemProxy: false }),
      ProxyRules: async () => [rule],
      SetProxyRules: async (next: ProxyRule[]) => next,
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await page.getByRole('button', { name: 'Capture rules' }).click();
  const drawer = page.getByRole('complementary', { name: 'Capture rules' });
  await drawer.locator('.capture-rule-main').filter({ hasText: 'Audit local' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit Map local rule' });
  await expect(editor.getByLabel('Local response body').locator('.cm-line')).toHaveText(['saved response']);
  const screenshot = process.env.KURLO_PROXY_NULL_REWRITE_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot, animations: 'disabled' });
});

test('create a collection without dropping requests that differ by query parameters', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const rows: ProxyEntry[] = [1, 2].map(page => ({ id: page, started: '2026-11-18T14:32:00Z', duration: 10, sent: 0, received: 20, host: 'shop.test', url: `https://shop.test/orders?page=${page}`, method: 'GET', path: '/orders', status: 200 }));
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => ({ running: true, address: '127.0.0.1:9090', count: rows.length, config, rules: 0, systemProxy: false }),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => rows,
      StartProxyCapture: async () => ({ running: true, address: '127.0.0.1:9090', count: rows.length, config, rules: 0, systemProxy: false }),
      ProxyCaptureEntry: async (id: number) => ({ entry: rows.find(row => row.id === id), request: { headers: {}, body: '', binary: false, truncated: false }, response: { headers: {}, body: '', binary: false, truncated: false } }),
      ProxyCaptureHAR: async () => JSON.stringify({ log: { entries: [1, 2].map(page => ({ request: { method: 'GET', url: `https://shop.test/orders?page=${page}`, queryString: [{ name: 'page', value: String(page) }] }, response: { status: 200, content: { mimeType: 'text/plain', text: '' } } })) } }),
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await expect(page.locator('.capture-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Create collection', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.filter(request => request.url.startsWith('https://shop.test/orders')).map(request => request.params.map(param => [param.key, param.value])))).toEqual([[['page', '1']], [['page', '2']]]);
});

test('select several captured rows and act on them', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await installRulesCapture(page);
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  const row = (path: string) => page.locator('.capture-row').filter({ hasText: path });
  await row('/orders/1').click();
  await row('/cart').click({ modifiers: ['Shift'] });
  await expect(page.getByText('3 selected')).toBeVisible();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await row('/orders/2').click({ modifiers: [modifier] });
  await expect(page.getByText('2 selected')).toBeVisible();
  await expect(row('/orders/2')).not.toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Export HAR' }).click();
  await page.getByRole('button', { name: 'Save as requests…' }).click();
  await expect(page.getByRole('dialog', { name: 'Save 2 requests' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Save 2 requests' }).getByLabel('Request name')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await row('/cart').focus();
  await page.keyboard.press(`${modifier}+a`);
  await expect(page.getByText('4 selected')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.capture-selection')).toHaveCount(0);
  await row('/orders/2').click();
  await row('/profile').click({ modifiers: ['Shift'] });
  const shot = process.env.KURLO_PROXY_SELECT_SCREENSHOT;
  if (shot) await page.screenshot({ path: shot, animations: 'disabled' });
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.capture-row')).toHaveCount(1);
  await expect(row('/orders/1')).toHaveClass(/active/);
  const calls = await page.evaluate(() => (window as unknown as { captureCalls: { deleted: number[][]; har: number[][] } }).captureCalls);
  expect(calls.har[0]).toEqual([1, 3]);
  expect(calls.deleted).toEqual([[2, 3, 4]]);
});

test('open a HAR session and reopen it from recent sessions', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('kurlo.proxy.recentSessions', JSON.stringify(['/Users/me/sessions/gone.har']));
    let rows: ProxyEntry[] = [];
    let source = '';
    const opened: string[] = [];
    (window as unknown as { opened: string[] }).opened = opened;
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const status = () => ({ running: false, address: '', count: rows.length, config, rules: 0, systemProxy: false, source });
    const msg = { headers: { 'Content-Type': ['application/json'] }, body: '{"ok":true}', binary: false, truncated: false };
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [...rows],
      StartProxyCapture: async () => status(),
      ProxyCaptureEntry: async (id: number) => ({ entry: rows.find(row => row.id === id), request: { ...msg, body: '' }, response: msg }),
      OpenFileDialog: async (title: string) => title === 'Open a HAR session' ? '/Users/me/sessions/shop.har' : '',
      OpenProxyCaptureSession: async (path: string) => {
        opened.push(path);
        if (path.endsWith('gone.har')) throw new Error('stat ' + path + ': no such file or directory');
        source = path.split('/').pop()!;
        rows = ['/login', '/orders'].map((item, index) => ({ id: index + 11, started: '2026-11-22T10:00:00Z', duration: 12, sent: 0, received: 11, host: 'shop.test', url: 'https://shop.test' + item, method: index ? 'GET' : 'POST', path: item, status: 200 }));
        return status();
      },
      ClearProxyCapture: async () => { rows = []; source = ''; return status(); },
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  const recentSessions = page.getByRole('group', { name: 'Recent sessions' });
  await recentSessions.getByRole('button', { name: /^gone\.har/ }).click();
  await expect(page.getByRole('alert')).toContainText('no such file');
  await expect(recentSessions.getByRole('button', { name: /^gone\.har/ })).toHaveCount(0);
  await expect(recentSessions).toHaveCount(0);
  await page.getByRole('button', { name: 'Open HAR', exact: true }).click();
  await expect(page.locator('.capture-row')).toHaveCount(2);
  await expect(page.locator('.mock-head')).toContainText('2 exchanges from shop.har');
  await expect(page.locator('.mock-status')).toContainText('Opened');
  const middles = await page.locator('.mock-status').evaluate(node => [...node.querySelectorAll('.mock-status-state, .capture-pill, .capture-status-text')].map(el => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
  expect(new Set(middles).size).toBe(1);
  await expect(page.locator('.capture-detail-wrap')).toContainText('"ok"');
  const shot = process.env.KURLO_PROXY_SESSION_SCREENSHOT;
  if (shot) await page.screenshot({ path: shot, animations: 'disabled' });
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.locator('.mock-status')).toContainText('Stopped');
  await expect(recentSessions.getByRole('button', { name: /^shop\.har/ })).toBeVisible();
  await recentSessions.getByRole('button', { name: /^shop\.har/ }).click();
  await expect(page.locator('.capture-row')).toHaveCount(2);
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(['/Users/me/sessions/gone.har', '/Users/me/sessions/shop.har', '/Users/me/sessions/shop.har']);
  expect(await page.evaluate(() => localStorage.getItem('kurlo.proxy.recentSessions'))).toBe(JSON.stringify(['/Users/me/sessions/shop.har']));
});

test('show timing phases and the client protocol of a captured exchange', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    const rows: ProxyEntry[] = [
      { id: 1, started: '2026-11-22T10:00:00Z', duration: 75, sent: 0, received: 12, host: 'api.shop.test', url: 'https://api.shop.test/orders', method: 'GET', path: '/orders', status: 200, protocol: 'HTTP/2.0' },
      { id: 2, started: '2026-11-22T10:00:01Z', duration: 400, sent: 10, received: 40, host: 'api.shop.test', url: 'https://api.shop.test/live', method: 'GET', path: '/live', status: 101, protocol: 'HTTP/1.1', stream: 'WebSocket' },
    ];
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: ['api.shop.test'], systemProxy: false };
    const status = () => ({ running: false, address: '', count: rows.length, config, rules: 0, systemProxy: false });
    const msg = { headers: { 'Content-Type': ['application/json'] }, body: '{"orders":[]}', binary: false, truncated: false };
    const timings = { total: 74.62, prepare: 0.01, socketInitialization: 0.01, dnsLookup: 3.2, tcpHandshake: 0.4, tlsHandshake: 6.8, send: 5, waitingTTFB: 36.38, download: 22.8, process: 0.02 };
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [...rows],
      StartProxyCapture: async () => status(),
      ProxyCaptureEntry: async (id: number) => ({ entry: rows.find(row => row.id === id), request: { ...msg, body: '' }, response: msg, timings: id === 1 ? timings : undefined, frames: id === 2 ? [{ direction: 'Sent', kind: 'Text', text: 'hello', size: 5 }] : undefined }),
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  const detail = page.getByRole('region', { name: 'Captured exchange' });
  await expect(detail.locator('.capture-protocol')).toHaveText('HTTP/2');
  const trigger = detail.getByRole('button', { name: 'Response time details' });
  await expect(trigger).toHaveText('75 ms');
  await trigger.hover();
  const popover = detail.getByRole('tooltip');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('TLS Handshake');
  await expect(popover).toContainText('Send');
  await expect(popover).toContainText('5 ms');
  await expect(popover).toContainText('36 ms');
  const shot = process.env.KURLO_PROXY_TIMING_SCREENSHOT;
  if (shot) await page.screenshot({ path: shot, animations: 'disabled' });
  await page.locator('.capture-row').nth(1).click();
  await expect(detail.locator('.capture-protocol')).toHaveText('HTTP/1.1');
  await expect(detail.getByRole('button', { name: 'Response time details' })).toHaveCount(0);
  await expect(detail.getByRole('tab', { name: 'Messages' })).toBeVisible();
});

test('format a long event stream response', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    const flags: Record<string, unknown> = {};
    for (let i = 0; i < 400; i += 1) flags[`flag-${i}`] = { version: 7716 + i, flagVersion: 3, value: true, variation: 0, trackEvents: false };
    const stream = ('event:put\ndata:' + JSON.stringify(flags)).slice(0, 16 * 1024);
    const script = 'x'.repeat(6000);
    const rows: ProxyEntry[] = [
      { id: 1, started: '2026-11-22T23:42:44Z', duration: 6689, sent: 0, received: 186_000, host: 'clientstream.example.test', url: 'https://clientstream.example.test/meval/abc', method: 'GET', path: '/meval/abc', status: 200, protocol: 'HTTP/2.0', stream: 'SSE' },
      { id: 2, started: '2026-11-22T23:42:45Z', duration: 20, sent: 0, received: 6000, host: 'cdn.example.test', url: 'https://cdn.example.test/app.js', method: 'GET', path: '/app.js', status: 200, protocol: 'HTTP/2.0' },
    ];
    const config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [], systemProxy: false };
    const status = () => ({ running: false, address: '', count: rows.length, config, rules: 0, systemProxy: false });
    Object.assign(window.go!.api!.App!, {
      ProxyCaptureStatus: async () => status(),
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntries: async () => [...rows],
      StartProxyCapture: async () => status(),
      ProxyCaptureEntry: async (id: number) => ({
        entry: rows.find(row => row.id === id),
        request: { headers: {}, body: '', binary: false, truncated: false },
        response: id === 1
          ? { headers: { 'Content-Type': ['text/event-stream'] }, body: stream, binary: false, truncated: true }
          : { headers: { 'Content-Type': ['application/javascript'] }, body: script, binary: false, truncated: false },
        frames: id === 1 ? [{ direction: 'Received', kind: 'put', text: stream.slice(15, 400), size: 186_000 }] : undefined,
      }),
    });
  });
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  const detail = page.getByRole('region', { name: 'Captured exchange' });
  const viewer = detail.locator('.capture-viewer');
  await expect(viewer).toContainText('event: put');
  await expect(viewer).toContainText('"flag-0": {');
  await expect(detail.locator('.capture-headers summary')).toBeVisible();
  const shot = process.env.KURLO_PROXY_SSE_SCREENSHOT;
  if (shot) await page.screenshot({ path: shot, animations: 'disabled' });
  const scroll = await viewer.locator('.response-body-viewer, .response-body').first().evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
  expect(scroll.scroll).toBeLessThan(scroll.client * 1.5);
  await detail.getByRole('tab', { name: 'Events' }).click();
  await expect(detail.locator('.capture-frame pre')).toContainText('"flag-0": {\n    "version": 7716,');
  await page.locator('.capture-row').nth(1).click();
  await expect(viewer).toContainText('xxxx');
});

test('ask the agent about selected captured exchanges by id', async ({ page }) => {
  await installKurloBridge(page);
  await installAgentBridge(page, [connection]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await installRulesCapture(page);
  await page.getByRole('button', { name: 'Capture proxy' }).click();
  await page.getByRole('button', { name: /\/orders\/1/ }).first().click();
  await page.getByRole('button', { name: /\/cart/ }).first().click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await page.getByRole('group', { name: 'Selected entries' }).getByRole('button', { name: 'Ask agent' }).click();
  const draft = page.getByLabel('Message the agent');
  await expect(draft).toBeVisible();
  const text = await draft.inputValue();
  expect(text).toContain('get_captured');
  expect(text).toContain('{"id":1,"method":"GET","host":"shop.test","path":"/orders/1","status":200}');
  expect(text).toContain('{"id":3,"method":"POST","host":"shop.test","path":"/cart","status":200}');
  expect(text).not.toContain('"path":"/profile"');
});
