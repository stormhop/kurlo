import { chooseRequestSection, clickTabClose, collectionRow, folderRow, openCollectionImport } from './support/actions';

import { installKurloBridge, type E2EWindow } from './support/bridge';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test, type Page } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe('Import destination and save errors', () => {
  const specUrl = 'https://spec.kurlo.test/catalogue.json';
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Catalogue import', version: '1' },
    paths: { '/items': { get: { operationId: 'listItems' } } },
  };

  async function prepareImport(page: Page, source: string) {
    await page.goto('/');
    await page.getByRole('button', { name: 'Collections', exact: true }).click();
    await openCollectionImport(page);
    const dialog = page.getByRole('dialog', { name: 'Import collection' });
    await dialog.getByText(source, { exact: true }).click();
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog).toBeHidden();
  }

  async function startOpenApiImport(page: Page) {
    await prepareImport(page, 'OpenAPI / Swagger from URL');
    const prompt = page.getByRole('dialog', { name: 'Import from URL' });
    await prompt.getByRole('textbox').fill(specUrl);
    await prompt.getByRole('button', { name: 'Import', exact: true }).click();
    await page.waitForFunction(() => window.__kurloE2E.responseGate?.ready);
  }

  async function delaySpec(page: Page) {
    await page.addInitScript(({ specUrl, spec }) => {
      const app = (window as unknown as E2EWindow).go.api.App;
      const send = app.SendRequest;
      app.SendRequest = async (...args) => {
        if (args[0].url !== specUrl) return send(...args);
        await new Promise<void>(release => { window.__kurloE2E.responseGate = { ready: true, release }; });
        return { statusCode: 200, status: '200 OK', body: JSON.stringify(spec) };
      };
    }, { specUrl, spec });
  }

  test('cancels a delayed OpenAPI import if another workspace is active', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      activeWorkspaceId: 'workspace-a',
      workspaces: [{ id: 'workspace-a', name: 'Workspace A' }, { id: 'workspace-b', name: 'Workspace B' }],
    });
    await delaySpec(page);
    await startOpenApiImport(page);
    const switcher = page.getByRole('button', { name: 'Workspace switcher' });
    await expect(switcher).toContainText('Workspace A');
    await switcher.click();
    await page.getByRole('button', { name: /^Workspace B / }).click();
    await expect(switcher).toContainText('Workspace B');
    await page.evaluate(() => window.__kurloE2E.responseGate!.release());
    const error = page.getByRole('dialog', { name: 'Import from URL failed' });
    await expect(error).toContainText('The workspace changed during import.');
    await error.getByRole('button', { name: 'OK' }).click();
    await expect(switcher).toContainText('Workspace B');
    await expect(page.getByRole('button', { name: 'Catalogue import', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.__kurloE2E.savedStores.flatMap(store => store.collections).filter(collection => collection.name === 'Catalogue import'))).toEqual([]);
    await expect(page.getByText('Imported 1 request', { exact: true })).toHaveCount(0);
  });

  for (const source of ['OpenAPI', 'Postman']) {
    test(`reports a save failure instead of success when importing ${source}`, async ({ page }) => {
      await installKurloBridge(page);
      await page.addInitScript(() => { window.__kurloE2E.failSaves = true; });
      if (source === 'OpenAPI') {
        await delaySpec(page);
        await startOpenApiImport(page);
        await page.evaluate(() => window.__kurloE2E.responseGate!.release());
        const error = page.getByRole('dialog', { name: 'Import from URL failed' });
        await expect(error).toContainText('Kurlo could not save the workspace.');
        await error.getByRole('button', { name: 'OK' }).click();
      } else {
        await prepareImport(page, 'Postman collection');
        await page.setInputFiles('input[type="file"]', {
          name: 'catalogue.postman_collection.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({
            info: { name: 'Catalogue import', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
            item: [{ name: 'listItems', request: { method: 'GET', url: 'https://api.kurlo.test/items' } }],
          })),
        });
        await expect(page.getByText('Import failed: Kurlo could not save the workspace.', { exact: true })).toBeVisible();
      }
      await expect(page.getByText('Imported 1 request', { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => window.__kurloE2E.store.collections.some(collection => collection.name === 'Catalogue import'))).toBe(false);
      const save = page.getByRole('button', { name: 'Save', exact: true });
      await expect(save).toBeEnabled();
      await page.evaluate(() => { window.__kurloE2E.failSaves = false; });
      await save.click();
      await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.collections.filter(collection => collection.name === 'Catalogue import').length)).toBe(1);
      await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
    });
  }

  test('reports when OpenAPI saves the collection but fails to save the sync snapshot', async ({ page }) => {
    await installKurloBridge(page);
    await delaySpec(page);
    await page.addInitScript(() => {
      (window as unknown as E2EWindow).go.api.App.WriteOpenAPIBaseSpec = async () => 'Disk full';
    });
    await startOpenApiImport(page);
    await page.evaluate(() => window.__kurloE2E.responseGate!.release());
    const error = page.getByRole('dialog', { name: 'Import from URL failed' });
    await expect(error).toContainText('Kurlo could not save its OpenAPI sync settings or spec snapshot.');
    await expect(page.getByText('Imported 1 request', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.__kurloE2E.store.collections.some(collection => collection.name === 'Catalogue import'))).toBe(true);
  });
});

test.describe("Kurlo desktop browser E2E", () => {
  test('imports a Postman collection into the sidebar', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const saved = sessionStorage.getItem('import-collapse-store');
      if (saved) window.__kurloE2E.store = JSON.parse(saved);
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await page.getByRole('button', { name: 'Collections' }).click();
    await openCollectionImport(page);

    const sourceDialog = page.getByRole('dialog', { name: 'Import collection' });
    await expect(sourceDialog).toBeVisible();
    await sourceDialog.getByText('Postman collection').click();
    await sourceDialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(sourceDialog).toBeHidden();

    const collection = {
      info: { name: 'Billing API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'baseUrl', value: 'https://api.billing.test' }],
      item: [
        {
          name: 'List invoices',
          request: { method: 'GET', url: { raw: '{{baseUrl}}/invoices' }, header: [{ key: 'Accept', value: 'application/json' }] },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200))'] } }],
        },
        {
          name: 'Invoices',
          item: [{ name: 'Archived', item: [{
            name: 'Create invoice',
            request: { method: 'POST', url: { raw: '{{baseUrl}}/invoices' }, body: { mode: 'raw', raw: '{"amount":10}' } },
          }] }],
        },
        { name: 'Empty folder', item: [] },
      ],
    };

    await page.setInputFiles('input[type="file"]', {
      name: 'billing.postman_collection.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(collection)),
    });

    await expect(collectionRow(page, 'Billing API')).toBeVisible();
    await expect(collectionRow(page, 'Billing API').getByLabel('Expand collection')).toBeVisible();
    await expect(page.getByRole('button', { name: 'GET List invoices' })).toBeHidden();
    await expect(folderRow(page, 'Invoices')).toBeHidden();
    await page.screenshot({ path: join(tmpdir(), 'kurlo-import-collapsed.png'), animations: 'disabled' });
    await page.evaluate(() => sessionStorage.setItem('import-collapse-store', JSON.stringify(window.__kurloE2E.store)));
    await page.reload();
    await expect(collectionRow(page, 'Billing API').getByLabel('Expand collection')).toBeVisible();
    await collectionRow(page, 'Billing API').getByLabel('Expand collection').click();
    await expect(folderRow(page, 'Invoices').getByLabel('Expand folder')).toBeVisible();
    await expect(folderRow(page, 'Empty folder').getByLabel('Expand folder')).toBeVisible();
    await expect(folderRow(page, 'Archived')).toBeHidden();
    await folderRow(page, 'Invoices').getByLabel('Expand folder').click();
    await expect(folderRow(page, 'Archived').getByLabel('Expand folder')).toBeVisible();
    await expect(page.getByRole('button', { name: 'POST Create invoice' })).toBeHidden();
    await folderRow(page, 'Archived').getByLabel('Expand folder').click();
    await expect(page.getByRole('button', { name: 'GET List invoices' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'POST Create invoice' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const store = window.__kurloE2E.store as { collections: Array<{ id: string; name: string; collapsed: boolean }>; folderCollapsed: Record<string, boolean> };
      const collection = store.collections.find(entry => entry.name === 'Billing API')!;
      return [collection.collapsed, store.folderCollapsed[`${collection.id}:Invoices`], store.folderCollapsed[`${collection.id}:Invoices/Archived`]];
    })).toEqual([false, false, false]);
    await page.evaluate(() => sessionStorage.setItem('import-collapse-store', JSON.stringify(window.__kurloE2E.store)));
    await page.reload();
    await expect(page.getByRole('button', { name: 'POST Create invoice' })).toBeVisible();
    await expect(folderRow(page, 'Empty folder').getByLabel('Expand folder')).toBeVisible();
    await page.screenshot({ path: join(tmpdir(), 'kurlo-import-expanded-restored.png'), animations: 'disabled' });

    const store = await page.evaluate(() => window.__kurloE2E.store as {
      collections: Array<{ id: string; name: string }>;
      requests: Array<{ name: string; method: string; url: string; testScriptJs?: string }>;
    });
    const imported = store.collections.find(entry => entry.name === 'Billing API');
    expect(imported).toBeTruthy();
    const requests = store.requests.filter(entry => ['List invoices', 'Create invoice'].includes(entry.name));
    expect(requests).toHaveLength(2);
    expect(requests.find(entry => entry.name === 'List invoices')?.method).toBe('GET');
    expect(requests.find(entry => entry.name === 'List invoices')?.url).toContain('{{baseUrl}}/invoices');
    expect(requests.find(entry => entry.name === 'List invoices')?.testScriptJs ?? '').toContain('pm.test');
  });

  test('keeps imported Postman request and collection scripts', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Collections' }).click();
    await openCollectionImport(page);
    const sourceDialog = page.getByRole('dialog', { name: 'Import collection' });
    await sourceDialog.getByText('Postman collection').click();
    await sourceDialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(sourceDialog).toBeHidden();
    const collection = {
      info: { name: 'Imported scripts API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      event: [{ listen: 'prerequest', script: { exec: ['pm.variables.set("trace", "1")'] } }],
      item: [{
        name: 'Ping',
        request: { method: 'GET', url: { raw: 'https://api.billing.test/ping' } },
        event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200))'] } }],
      }],
    };
    await page.setInputFiles('input[type="file"]', {
      name: 'scripts.postman_collection.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(collection)),
    });
    await collectionRow(page, 'Imported scripts API').getByLabel('Expand collection').click();
    await expect(page.getByRole('button', { name: 'GET Ping' })).toBeVisible();
    const store = await page.evaluate(() => window.__kurloE2E.store as {
      collections: Array<{ name: string; defaults?: { preRequestScriptJs?: string } }>;
      requests: Array<{ name: string; testScriptJs?: string }>;
    });
    const ping = store.requests.find(entry => entry.name === 'Ping')!;
    expect(ping.testScriptJs).toContain('pm.test');
    const defaults = store.collections.find(entry => entry.name === 'Imported scripts API')?.defaults;
    expect(defaults?.preRequestScriptJs ?? '').toContain('pm.variables.set');
  });
});

for (const source of ['file', 'URL']) {
  test(`imports OpenAPI server variables from ${source}, switches servers and restores them`, async ({ page }) => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Server variables API', version: '1' },
      paths: {
        '/ping': { get: { summary: 'Server ping', servers: [
          { url: 'https://production.kurlo.test/api/', description: 'Production' },
          { url: 'https://sandbox.kurlo.test/secured/', description: 'Sandbox' },
        ] } },
        '/upload': { post: { summary: 'Server upload', servers: [{ url: 'https://files.kurlo.test' }] } },
      },
    };
    await installKurloBridge(page);
    await page.addInitScript(({ spec }) => {
      const saved = sessionStorage.getItem('openapi-server-store');
      if (saved) window.__kurloE2E.store = JSON.parse(saved);
      const app = (window as unknown as { go: { api: { App: Record<string, (...args: unknown[]) => Promise<unknown>> } } }).go.api.App;
      const send = app.SendRequest;
      app.SendRequest = async (...args) => {
        const request = args[0] as { url: string };
        if (request.url === 'https://spec.kurlo.test/openapi.json') {
          return { statusCode: 200, status: '200 OK', body: JSON.stringify(spec), headers: [{ key: 'Content-Type', value: 'application/json' }] };
        }
        return send(...args);
      };
    }, { spec });
    await page.goto('/');
    await page.getByRole('button', { name: 'Collections', exact: true }).click();
    await openCollectionImport(page);
    const dialog = page.getByRole('dialog', { name: 'Import collection' });
    await dialog.getByText(source === 'file' ? 'OpenAPI / Swagger' : 'OpenAPI / Swagger from URL', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    if (source === 'file') {
      await page.setInputFiles('input[type="file"]', {
        name: 'server-variables.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(spec)),
      });
    } else {
      const prompt = page.getByRole('dialog', { name: 'Import from URL' });
      await prompt.getByRole('checkbox', { name: 'Keep in sync with this URL' }).uncheck();
      await prompt.getByRole('textbox').fill('https://spec.kurlo.test/openapi.json');
      await prompt.getByRole('button', { name: 'Import', exact: true }).click();
    }
    const collection = collectionRow(page, 'Server variables API');
    await expect(collection).toBeVisible();
    await collection.getByLabel('Expand collection').click();
    await page.getByRole('button', { name: 'GET Server ping', exact: true }).click();
    await expect(page.getByLabel('Request URL')).toHaveValue('{{baseUrl}}/ping');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.at(-1)?.url)).toBe('https://production.kurlo.test/api/ping');
    await chooseRequestSection(page, 'Vars');
    const servers = page.locator('.request-vars-table').first().locator('.kv-row');
    await expect(servers).toHaveCount(3);
    await expect(servers.nth(0).getByPlaceholder('userId')).toHaveValue('baseUrl');
    await expect(servers.nth(0).getByRole('textbox', { name: 'Value' })).toHaveValue('https://production.kurlo.test/api');
    await expect(servers.nth(0).getByPlaceholder('Description')).toHaveValue('Production server from the spec');
    await expect(servers.nth(1).getByRole('textbox', { name: 'Value' })).toHaveValue('https://sandbox.kurlo.test/secured');
    await expect(servers.nth(0).getByRole('checkbox')).toBeChecked();
    await expect(servers.nth(1).getByRole('checkbox')).not.toBeChecked();
    await page.screenshot({ path: join(tmpdir(), `kurlo-openapi-server-variables-${source}.png`), animations: 'disabled' });
    await servers.nth(0).getByRole('checkbox').uncheck();
    await servers.nth(1).getByRole('checkbox').check();
    const saveRequest = page.getByRole('button', { name: 'Save', exact: true });
    if (await saveRequest.isEnabled()) await saveRequest.click();
    await expect.poll(() => page.evaluate(() => {
      const store = window.__kurloE2E.store as { requests: Array<{ name: string; vars?: Array<{ value: string; enabled: boolean }> }> };
      return store.requests.find(entry => entry.name === 'Server ping')?.vars?.filter(row => row.enabled).map(row => row.value);
    })).toEqual(['https://sandbox.kurlo.test/secured']);
    await page.evaluate(() => sessionStorage.setItem('openapi-server-store', JSON.stringify(window.__kurloE2E.store)));
    await page.reload();
    await page.getByRole('button', { name: 'GET Server ping', exact: true }).click();
    await expect(page.getByLabel('Request URL')).toHaveValue('{{baseUrl}}/ping');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.at(-1)?.url)).toBe('https://sandbox.kurlo.test/secured/ping');
    await page.getByRole('button', { name: 'POST Server upload', exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.at(-1)?.url)).toBe('https://files.kurlo.test/upload');
  });
}

test('keeps an imported OpenAPI collection in sync with its URL and applies reviewed changes', async ({ page }) => {
  const getPet = { operationId: 'getPet', summary: 'Get pet', tags: ['Pets'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] };
  const first = {
    openapi: '3.0.3',
    info: { title: 'Synced Pets', version: '1' },
    servers: [{ url: 'https://pets.kurlo.test' }],
    paths: {
      '/pets/{id}': { get: getPet },
      '/pets': { post: { operationId: 'createPet', summary: 'Create pet', tags: ['Pets'] } },
    },
  };
  const second = {
    ...first,
    paths: {
      '/pets/{id}': { get: { ...getPet, description: 'Returns one pet by id.', parameters: [...getPet.parameters, { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }] } },
      '/owners': { get: { operationId: 'listOwners', summary: 'List owners', tags: ['Owners'] } },
    },
  };
  await installKurloBridge(page);
  await page.addInitScript(({ first, second }) => {
    const bridge = window as unknown as { go: { api: { App: Record<string, (...args: unknown[]) => Promise<unknown>> } }; __openapi: { version: number; base: Record<string, string>; fetches: number } };
    bridge.__openapi = { version: 1, base: {}, fetches: 0 };
    const app = bridge.go.api.App;
    const send = app.SendRequest;
    app.SendRequest = async (...args) => {
      const request = args[0] as { url: string };
      if (request.url === 'https://spec.kurlo.test/pets.json') {
        bridge.__openapi.fetches++;
        const body = JSON.stringify(bridge.__openapi.version === 1 ? first : second);
        return { statusCode: 200, status: '200 OK', body, headers: [{ key: 'Content-Type', value: 'application/json' }] };
      }
      return send(...args);
    };
    app.ReadOpenAPIBaseSpec = async (id) => {
      const content = bridge.__openapi.base[id as string];
      return { content: content ?? '', exists: content !== undefined, path: 'workspaces/E2E/collections/Synced-Pets/openapi/spec.json' };
    };
    app.WriteOpenAPIBaseSpec = async (id, content) => { bridge.__openapi.base[id as string] = content as string; return ''; };
    app.DeleteOpenAPIBaseSpec = async (id) => { delete bridge.__openapi.base[id as string]; return ''; };
  }, { first, second });
  await page.goto('/');
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await openCollectionImport(page);
  const dialog = page.getByRole('dialog', { name: 'Import collection' });
  await dialog.getByText('OpenAPI / Swagger from URL', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: 'Import from URL' });
  await expect(prompt.getByRole('checkbox', { name: 'Keep in sync with this URL' })).toBeChecked();
  await prompt.getByRole('textbox').fill('https://spec.kurlo.test/pets.json');
  await prompt.getByRole('button', { name: 'Import', exact: true }).click();
  const collection = collectionRow(page, 'Synced Pets');
  await expect(collection).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys((window as unknown as { __openapi: { base: Record<string, string> } }).__openapi.base).length)).toBe(1);
  const stored = await page.evaluate(() => {
    const store = window.__kurloE2E.store as { collections: Array<{ name: string; openapi?: { source: string; intervalMinutes: number } }>; requests: Array<{ name: string; openapi?: string }> };
    return {
      source: store.collections.find(entry => entry.name === 'Synced Pets')?.openapi,
      keys: store.requests.map(entry => entry.openapi).filter(Boolean).sort(),
    };
  });
  expect(stored).toEqual({ source: { source: 'https://spec.kurlo.test/pets.json', intervalMinutes: 15 }, keys: ['GET /pets/{id}', 'POST /pets'] });

  await page.evaluate(() => { (window as unknown as { __openapi: { version: number } }).__openapi.version = 2; });
  await collection.getByLabel('Collection menu').click();
  await page.getByRole('button', { name: 'OpenAPI sync…', exact: true }).click();
  await expect(page.locator('.collection-tabs').getByRole('tab', { name: /OpenAPI/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.openapi-sync-status')).toContainText('In sync');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Spec changes · Synced Pets' });
  await expect(review).toBeVisible();
  await expect(review.getByRole('region', { name: 'New' })).toContainText('/owners');
  await expect(review.getByRole('region', { name: 'Changed' })).toContainText('/pets/{id}');
  const removed = review.getByRole('region', { name: 'Removed from the spec' });
  await expect(removed).toContainText('/pets');
  await expect(removed.getByRole('checkbox')).not.toBeChecked();
  await review.getByRole('button', { name: /\/pets\/\{id\}/ }).click();
  await expect(review.locator('.openapi-review-field').filter({ hasText: 'Docs' })).toContainText('Returns one pet by id.');
  await page.screenshot({ path: join(tmpdir(), 'kurlo-openapi-sync-review.png'), animations: 'disabled' });
  await captureDocsScreenshot(page, 'openapi-sync-review');
  await removed.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Apply 3', exact: true }).click();
  await expect(review).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    const store = window.__kurloE2E.store as { requests: Array<{ name: string; openapi?: string; requestNotes?: string; folderPath?: string[] }> };
    return store.requests.filter(entry => entry.openapi).map(entry => [entry.openapi, entry.requestNotes ?? '', (entry.folderPath ?? []).join('/')]).sort();
  })).toEqual([['GET /owners', '', 'Owners'], ['GET /pets/{id}', 'Returns one pet by id.', 'Pets']]);
  await expect(page.locator('.openapi-sync-status')).toContainText('In sync');
  const base = await page.evaluate(() => Object.values((window as unknown as { __openapi: { base: Record<string, string> } }).__openapi.base)[0]);
  expect(JSON.parse(base).paths['/owners']).toBeTruthy();
  await page.screenshot({ path: join(tmpdir(), 'kurlo-openapi-sync-panel.png'), animations: 'disabled' });
  await page.locator('.undo-toast').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.undo-toast')).toHaveCount(0);
  await captureDocsScreenshot(page, 'openapi-sync-panel');

  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('.openapi-sync-status')).toContainText('In sync');
  await expect(page.getByRole('dialog', { name: 'Spec changes · Synced Pets' })).toHaveCount(0);
  await collection.getByLabel('Expand collection').click();
  await folderRow(page, 'Pets').getByLabel('Expand folder').click();
  await page.locator('.collection-request').filter({ hasText: 'Get pet' }).click();
  const syncedTab = page.locator('.saved-request-tab.active');
  await chooseRequestSection(page, 'Params');
  await expect.poll(() => page.locator('.kv-row input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toContain('limit');
  await page.waitForTimeout(500);
  await expect(syncedTab).not.toHaveClass(/unsaved/);
  await clickTabClose(syncedTab.getByRole('button', { name: 'Close tab', exact: true }));
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toHaveCount(0);
  await page.locator('.collection-request').filter({ hasText: 'Get pet' }).click();
  await chooseRequestSection(page, 'Params');
  await expect.poll(() => page.locator('.kv-row input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toContain('limit');
  await page.evaluate(() => sessionStorage.setItem('openapi-sync-store', JSON.stringify(window.__kurloE2E.store)));
  await page.addInitScript(() => {
    const app = (window as unknown as { go: { api: { App: Record<string, (...args: unknown[]) => Promise<unknown>> } } }).go.api.App;
    app.LoadRequestStore = async () => sessionStorage.getItem('openapi-sync-store');
  });
  await page.reload();
  await chooseRequestSection(page, 'Params');
  await expect.poll(() => page.locator('.kv-row input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toContain('limit');
  await expect(page.locator('.saved-request-tab.active')).not.toHaveClass(/unsaved/);
  await page.screenshot({ path: join(tmpdir(), 'kurlo-openapi-sync-saved-params.png'), animations: 'disabled' });
});
