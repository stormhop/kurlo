import { collectionRow } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { expect, test } from '@playwright/test';

test.describe('Scale', { tag: '@scale' }, () => {
  test('stays responsive with ten thousand requests, 200-deep folders and unicode names', async ({ page }) => {
    test.setTimeout(180_000);
    await installKurloBridge(page);
    await page.addInitScript((total) => {
      const deep = Array.from({ length: 200 }, (_, index) => `Уровень ${index} 📁`);
      const requests = Array.from({ length: total }, (_, index) => ({
        id: `big-${index}`,
        name: index % 4 === 1 ? `Заказ №${index} 🚀 注文` : index % 4 === 2 ? `request-${index}` : 'New Request',
        collectionId: 'collection-big',
        collection: 'Big',
        folderPath: index % 10 === 0 ? deep : [`Папка ${index % 50}`],
        method: 'GET',
        url: `https://api.example.test/items/${index}`,
      }));
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-big', workspaceId: 'workspace-e2e', name: 'Big', filesystemName: 'Big' }];
      store.requests = requests;
    }, Number(process.env.SCALE_N ?? 10_000));

    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    const started = Date.now();
    await page.goto('/');
    await expect(collectionRow(page, 'Big')).toBeVisible({ timeout: 60_000 });
    const firstPaint = Date.now() - started;

    const searchStarted = Date.now();
    await page.getByRole('textbox', { name: 'Filter requests' }).fill('Заказ №9997');
    await expect(page.getByText('Заказ №9997 🚀 注文').first()).toBeVisible({ timeout: 30_000 });
    const searchMs = Date.now() - searchStarted;

    await page.getByText('Заказ №9997 🚀 注文').first().click();
    const url = page.getByPlaceholder('Enter request URL or paste cURL…');
    await expect(url).toHaveValue('https://api.example.test/items/9997');

    const savesBefore = await page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length);
    const editStarted = Date.now();
    await url.fill('https://api.example.test/edited');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length), { timeout: 30_000 }).toBeGreaterThan(savesBefore);
    const saveMs = Date.now() - editStarted;

    const saved = await page.evaluate(() => {
      const stores = window.__kurloE2E.savedStores as Array<{ requests: Array<{ id: string; url: string; folderPath: string[] }> }>;
      const last = stores[stores.length - 1];
      return { count: last.requests.length, edited: last.requests.find(r => r.id === 'big-9997')?.url, depth: last.requests.find(r => r.id === 'big-0')?.folderPath.length };
    });

    console.log(`scale: first paint ${firstPaint}ms, search ${searchMs}ms, save ${saveMs}ms`);
    expect(saved).toEqual({ count: 10_000, edited: 'https://api.example.test/edited', depth: 200 });
    expect(pageErrors).toEqual([]);
    expect(firstPaint).toBeLessThan(5_000);
    expect(searchMs).toBeLessThan(2_000);
    expect(saveMs).toBeLessThan(8_000);
  });
});

test.describe('Perf fixtures', () => {
  const fixtures = process.env.KURLO_PERF_FIXTURES ?? '';
  test.skip(!fixtures, 'set KURLO_PERF_FIXTURES to the generated perf/fixtures folder');

  test('stays responsive on the generated perf fixtures', async ({ page }) => {
    test.setTimeout(240_000);
    const { readFile } = await import('node:fs/promises');
    const storeBody = await readFile(`${fixtures}/request-store-large.json`, 'utf8');
    const hugeBody = await readFile(`${fixtures}/huge-response.json`, 'utf8');
    await page.route('**/__perf/store.json', route => route.fulfill({ body: storeBody, contentType: 'application/json' }));
    await page.route('**/__perf/huge.json', route => route.fulfill({ body: hugeBody, contentType: 'application/json' }));
    await installKurloBridge(page);
    await page.addInitScript(() => {
      (window.__kurloE2E as Record<string, unknown>).perfStoreUrl = '/__perf/store.json';
    });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(String(error)));

    const timings: Record<string, number> = {};
    const time = async (label: string, step: () => Promise<void>) => {
      const started = Date.now();
      await step();
      timings[label] = Date.now() - started;
    };

    const cdp = process.env.KURLO_PERF_PROFILE ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
    }
    await time('first paint', async () => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: /^Starred \d+/ })).toBeVisible({ timeout: 120_000 });
    });
    if (cdp) {
      const { profile } = await cdp.send('Profiler.stop');
      (await import('node:fs')).writeFileSync(process.env.KURLO_PERF_PROFILE!, JSON.stringify(profile));
    }
    await time('sidebar search', async () => {
      await page.getByRole('textbox', { name: 'Filter requests' }).fill('Заказ 04999');
      await expect(page.getByText(/Заказ 04999/).first()).toBeVisible({ timeout: 30_000 });
    });
    await time('open request', async () => {
      await page.getByText(/Заказ 04999/).first().click();
      await expect(page.getByLabel('Request URL')).toHaveValue(/resources\/4999/, { timeout: 30_000 });
    });
    await page.getByRole('textbox', { name: 'Filter requests' }).fill('');
    await time('history view', async () => {
      await page.getByLabel('History', { exact: true }).first().click();
      await expect(page.locator('.sidebar').getByText(/200|204|500/).first()).toBeVisible({ timeout: 30_000 });
    });
    await time('huge response', async () => {
      await page.evaluate(async () => {
        const body = await (await fetch('/__perf/huge.json')).text();
        (window.__kurloE2E as Record<string, unknown>).hugeBody = body;
      });
    });

    console.log(`perf fixtures: ${Object.entries(timings).map(([label, ms]) => `${label} ${ms}ms`).join(', ')}`);
    expect(pageErrors).toEqual([]);
    expect(timings['first paint']).toBeLessThan(10_000);
    expect(timings['sidebar search']).toBeLessThan(500);
    expect(timings['open request']).toBeLessThan(400);
  });
});
