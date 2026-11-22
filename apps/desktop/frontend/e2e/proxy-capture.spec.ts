import { expect, test } from '@playwright/test';
import { installKurloBridge } from './support/bridge';
import type { ProxyConfig, ProxyEntry } from '../src/lib/wire';

test('capture, inspect a tunnel and save an HTTP request with its example', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    let running = false;
    let config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false };
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

test('decrypt a tunnelled host with the trusted Kurlo certificate', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'darwin';
    let running = false;
    let config: ProxyConfig = { port: 9090, listenIP: '127.0.0.1', clientIP: '', include: '', service: '', certificate: '', key: '', identifyProcess: false, sslHosts: [] };
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
    let rows: ProxyEntry[] = ['/orders', '/cart', '/profile'].map((path, index) => ({ id: index + 1, started: '2026-11-18T14:32:00Z', duration: 10, sent: 0, received: 20, host: 'shop.test', url: 'http://shop.test' + path, method: 'GET', path, status: 200 }));
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
  await page.getByLabel('Filter traffic').fill('inv-42');
  await expect(page.locator('.capture-row')).toHaveCount(1);
  await expect(page.locator('.capture-row')).toContainText('/orders');
  await expect(page.locator('.capture-row .capture-match')).toHaveText('in response body');
  const shot = process.env.KURLO_PROXY_SEARCH_SCREENSHOT;
  if (shot) await page.screenshot({ path: shot, animations: 'disabled' });
  await page.getByLabel('Filter traffic').fill('/cart');
  await expect(page.locator('.capture-row')).toHaveCount(1);
  await expect(page.locator('.capture-row .capture-match')).toHaveCount(0);
  await page.getByLabel('Filter traffic').fill('');
  await expect(page.locator('.capture-row')).toHaveCount(3);
  expect(await page.evaluate(() => (window as unknown as { searches: string[] }).searches)).toContain('inv-42');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.locator('.capture-row')).toHaveCount(0);
  await expect(page.locator('.capture .empty-state')).toContainText('Waiting for traffic');
  await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled();
});
