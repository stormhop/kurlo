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
  await page.getByRole('button', { name: 'Start proxy' }).click();
  await expect(page.getByText('"total": 42', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Structure', exact: true }).click();
  await page.getByRole('navigation', { name: 'Capture hosts' }).getByRole('button', { name: 'cdn.test:443' }).click();
  await expect(page.getByText('HTTPS tunnel · metadata only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as request' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Filter traffic').fill('/orders');
  await page.getByRole('button', { name: 'Headers', exact: true }).click();
  await expect(page.getByText('Content-Type').first()).toBeVisible();
  await page.getByRole('button', { name: 'Bodies' }).click();
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

test('Record browser displays individual HTTPS calls and keeps their responses after stop', async ({ page }) => {
  await installKurloBridge(page);
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto('/');
  await page.evaluate(() => {
    let running = false;
    let browser = false;
    const calls = [
      {id: 1, method: 'GET', path: '/', status: 200},
      {id: 2, method: 'POST', path: '/api/orders', status: 201}
    ].map(call => ({...call, host: 'shop.test', url: 'https://shop.test' + call.path, started: '2026-11-18T10:32:00Z', duration: 18, sent: 0, received: 15}));
    const config = {port: 0, include: '', service: '', certificate: '', key: '', listenIP: '', clientIP: '', identifyProcess: false};
    const status = () => ({browser, running, count: browser ? calls.length : 0, config, rules: 0, address: ''});
    Object.assign(window.go!.api!.App!, {
      StartProxyCapture: async () => { throw new Error('Unexpected proxy start'); },
      StartBrowserCapture: async () => { browser = true; running = true; return status(); },
      StopProxyCapture: async () => { running = false; return status(); },
      ProxyCaptureStatus: async () => status(),
      ProxyCaptureEntries: async () => browser ? calls : [],
      ProxyPausedResponses: async () => [],
      ProxyCaptureEntry: async (id: number) => ({
        entry: calls.find(call => call.id === id),
        request: {headers: {}, body: id === 2 ? '{"order":17}' : '', truncated: false, binary: false},
        response: {headers: {}, body: id === 2 ? '{"accepted":17}' : 'Storefront', truncated: false, binary: false}
      })
    });
  });
  await page.getByRole('button', {name:'Capture proxy'}).click();
  await page.getByRole('button', {name:'Record browser'}).click();
  await page.getByRole('button', {name:'https://shop.test/api/orders'}).click();
  await expect(page.getByText('"accepted": 17', {exact:false})).toBeVisible();
  await expect(page.getByRole('button', {name:'Map local'})).toHaveCount(0);
  if (process.env.KURLO_BROWSER_CAPTURE_SCREENSHOT) await page.screenshot({path:process.env.KURLO_BROWSER_CAPTURE_SCREENSHOT});
  await page.getByRole('button', {name:'Stop capture'}).click();
  await expect(page.getByRole('button', {name:'Record browser'})).toBeEnabled();
  await expect(page.getByText('"accepted": 17', {exact:false})).toBeVisible();
});
