import { chooseRequestType, collectionRow, fillPrompt } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('scrolls a long environment list without squeezing its rows', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      environments: Array.from({ length: 30 }, (_, index) => ({ id: `env-${index + 1}`, workspaceId: 'workspace-e2e', name: `Environment ${index + 1}`, values: [] })),
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    const list = page.locator('.environment-list');
    const envRow = (name: string) => list.locator('.environment-item-text > span').filter({ hasText: new RegExp(`^${name}$`) });
    const rowHeights = () => page.locator('.environment-item').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    const noneHeight = await page.locator('.environment-none-item').evaluate(row => row.getBoundingClientRect().height);
    for (const height of await rowHeights()) expect(Math.abs(height - noneHeight)).toBeLessThan(1);
    const overflow = await list.evaluate(node => node.scrollHeight - node.clientHeight);
    expect(overflow).toBeGreaterThan(100);

    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(envRow('Environment 30')).toBeInViewport();
    await page.screenshot({ path: join(tmpdir(), 'kurlo-environment-list-scrolled.png'), animations: 'disabled' });

    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await expect(envRow('Environment 1')).toBeInViewport();
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(envRow('Environment 30')).toBeInViewport();
    for (const height of await rowHeights()) expect(Math.abs(height - noneHeight)).toBeLessThan(1);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await expect(envRow('Environment 30')).toBeInViewport();
    await page.screenshot({ path: join(tmpdir(), 'kurlo-environment-list-resized.png'), animations: 'disabled' });
  });

  test('pins collection environments from a searchable picker instead of a full list', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-pins', workspaceId: 'workspace-e2e', name: 'Pins API' }],
      requests: [{ id: 'req-pins', collectionId: 'col-pins', collection: 'Pins API', name: 'Ping', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/ping', auth: { type: 'none' } }],
      environments: Array.from({ length: 30 }, (_, index) => ({ id: `env-${index + 1}`, workspaceId: 'workspace-e2e', name: `env-${String(index + 1).padStart(2, '0')}`, values: [] })),
    });
    await page.goto('/');
    await collectionRow(page, 'Pins API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Pins API').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    const block = page.locator('.collection-environments');
    await expect(block.getByRole('list', { name: 'Pinned environments' })).toHaveCount(0);
    await expect(block.getByRole('checkbox')).toHaveCount(0);
    const picker = block.getByRole('button', { name: 'Pin environment' });
    await expect(picker).toHaveText('Pin an environment…');

    await picker.click();
    const menu = block.getByRole('dialog', { name: 'Pin environment' });
    const search = menu.getByRole('textbox', { name: 'Search environments' });
    await expect(search).toBeFocused();
    await expect(menu.getByRole('option')).toHaveCount(30);
    await expect(menu.getByRole('option').first()).toContainText('0 variables');
    await search.fill('07');
    await expect(menu.locator('.search-picker-option-label')).toHaveText(['env-07']);
    await menu.getByRole('option', { name: /env-07/ }).click();
    await expect(menu).toHaveCount(0);
    await expect(picker).toHaveText('Pin another environment…');
    await picker.click();
    await search.fill('env-12');
    await search.press('Enter');
    await expect(menu).toHaveCount(0);

    const pinned = block.getByRole('list', { name: 'Pinned environments' }).getByRole('listitem');
    await expect(pinned.locator('.collection-environment-name')).toHaveText(['env-07', 'env-12']);
    await expect(pinned.first()).toContainText('Default');
    await pinned.nth(1).getByRole('button', { name: 'Set as default' }).click();
    await expect(pinned.nth(1)).toContainText('Default');
    const scrollTopBefore = await page.locator('.collection-workspace').evaluate(node => node.scrollTop);
    await picker.click();
    await expect(menu.getByRole('option', { name: /env-07/ })).toHaveCount(0);
    await expect(menu.getByRole('option')).toHaveCount(28);
    const geometry = await menu.evaluate((node) => {
      const trigger = node.parentElement!.querySelector('button')!.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const list = node.querySelector('.search-picker-list') as HTMLElement;
      let scroller = node.parentElement;
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const bounds = scroller!.getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return { width: Math.abs(box.width - trigger.width), listRem: list.clientHeight / rem, scrolls: list.scrollHeight > list.clientHeight, inside: box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1, scrollTop: scroller!.scrollTop, overscroll: getComputedStyle(list).overscrollBehaviorY };
    });
    expect(geometry.width).toBeLessThan(1);
    expect(geometry.listRem).toBeLessThanOrEqual(17.5);
    expect(geometry.scrolls).toBe(true);
    expect(geometry.inside).toBe(true);
    expect(geometry.scrollTop).toBe(scrollTopBefore);
    expect(geometry.overscroll).toBe('none');
    await page.screenshot({ path: join(tmpdir(), 'kurlo-collection-environment-picker-open.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(picker).toBeFocused();
    await picker.click();
    await expect(menu).toBeVisible();
    await picker.click();
    await expect(menu).toHaveCount(0);
    await picker.dblclick();
    await expect(menu).toHaveCount(0);
    await picker.click();
    await expect(menu).toBeVisible();
    await page.locator('.collection-workspace-head').click({ position: { x: 4, y: 4 } });
    await expect(menu).toHaveCount(0);
    await picker.click();
    await expect(search).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-collection-environment-picker.png'), animations: 'disabled' });

    const save = page.locator('.overview-actions').getByRole('button', { name: 'Save', exact: true });
    await save.click();
    const savedPins = () => page.evaluate(() => {
      const store = window.__kurloE2E.store as { collections?: Array<{ id: string; environmentIds?: string[]; defaultEnvironmentId?: string }> };
      const collection = store.collections?.find(item => item.id === 'col-pins');
      return { ids: collection?.environmentIds ?? [], defaultId: collection?.defaultEnvironmentId ?? '' };
    });
    await expect.poll(savedPins).toEqual({ ids: ['env-7', 'env-12'], defaultId: 'env-12' });

    await pinned.nth(1).getByRole('button', { name: 'Unpin env-12' }).click();
    await expect(pinned.locator('.collection-environment-name')).toHaveText(['env-07']);
    await save.click();
    await expect.poll(savedPins).toEqual({ ids: ['env-7'], defaultId: '' });
  });

  test('scrolls and searches the environment switcher when a workspace has many environments', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      environments: Array.from({ length: 30 }, (_, index) => ({ id: `env-${index + 1}`, workspaceId: 'workspace-e2e', name: `env-${String(index + 1).padStart(2, '0')}`, values: [] })),
    });
    await page.setViewportSize({ width: 1280, height: 640 });
    await page.goto('/');
    const trigger = page.locator('.environment-select');
    const menu = page.locator('.environment-menu');
    const list = menu.locator('.environment-menu-list');
    await trigger.click();
    await expect(menu).toBeVisible();
    const search = menu.getByRole('searchbox', { name: 'Search environments' });
    await expect(search).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(640);
    await expect(menu.getByRole('button', { name: 'Manage environments' })).toBeInViewport();
    expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(list.getByRole('button', { name: 'env-30' })).toBeInViewport();
    await page.screenshot({ path: join(tmpdir(), 'kurlo-environment-switcher-scroll.png'), animations: 'disabled' });

    await search.fill('27');
    await expect(list.locator('.environment-menu-name')).toHaveText(['env-27']);
    await search.fill('nothing like this');
    await expect(list).toContainText('No environment matches.');
    await search.fill('env-27');
    await search.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toContainText('env-27');

    await trigger.click();
    await expect(menu.getByRole('searchbox', { name: 'Search environments' })).toHaveValue('');
    await expect(list.locator('.menu-item.active')).toBeInViewport();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Alt+E');
    await expect(menu.getByRole('searchbox', { name: 'Search environments' })).toBeFocused();
    await page.screenshot({ path: join(tmpdir(), 'kurlo-environment-switcher-active.png'), animations: 'disabled' });
  });

  test('keeps environment selects and the matrix usable with many environments', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      environments: Array.from({ length: 30 }, (_, index) => ({ id: `env-${index + 1}`, workspaceId: 'workspace-e2e', name: `env-${String(index + 1).padStart(2, '0')}`, values: [{ id: 1, key: 'baseUrl', value: `https://env-${index + 1}.example.test`, enabled: true }] })),
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.locator('.environment-list').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.locator('.environment-item-main').filter({ hasText: 'env-30' }).click();
    await page.getByRole('radio', { name: 'Single' }).click();
    const parent = page.locator('.env-parent-select');
    await parent.locator('.app-select-trigger').click();
    const menu = parent.locator('.app-select-menu');
    await expect(menu).toBeVisible();
    const search = menu.getByRole('searchbox');
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute('placeholder', 'Search environments');
    const sizes = await menu.evaluate((node) => {
      const input = node.querySelector('input') as HTMLElement;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return { height: node.getBoundingClientRect().height / rem, inputWidth: input.getBoundingClientRect().width, menuWidth: node.clientWidth, scrolls: node.scrollHeight > node.clientHeight };
    });
    expect(sizes.height).toBeLessThanOrEqual(20.5);
    expect(sizes.scrolls).toBe(true);
    expect(sizes.menuWidth - sizes.inputWidth).toBeLessThan(40);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-environment-parent-select.png'), animations: 'disabled' });
    await search.fill('05');
    await expect(menu.getByRole('option')).toHaveText(['env-05']);
    await menu.getByRole('option', { name: 'env-05' }).click();
    await expect(parent.locator('.app-select-trigger')).toContainText('env-05');

    await page.getByRole('radio', { name: 'Matrix' }).click();
    const columnHeads = page.locator('.env-matrix-col-head');
    await expect(columnHeads).toHaveCount(5);
    const columnsButton = page.getByRole('button', { name: 'Environments 5 of 30' });
    await columnsButton.click();
    const picker = page.getByRole('dialog', { name: 'Environments in the matrix' });
    await expect(picker.getByLabel('Find environment')).toBeFocused();
    await expect(columnHeads.last()).toContainText('env-30');
    await picker.getByLabel('Find environment').fill('30');
    await expect(picker.getByRole('checkbox', { name: 'env-30' })).toBeChecked();
    await expect(picker.getByRole('checkbox', { name: 'env-30' })).toBeDisabled();
    await picker.getByLabel('Find environment').fill('17');
    await picker.getByRole('checkbox', { name: 'env-17' }).check();
    await expect(columnHeads).toHaveCount(6);
    await expect(columnHeads.nth(4)).toContainText('env-17');
    await page.screenshot({ path: process.env.MATRIX_SHOT_DIR ? join(process.env.MATRIX_SHOT_DIR, 'picker.png') : join(tmpdir(), 'kurlo-environment-matrix-picker.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Environments 6 of 30' })).toBeFocused();

    const grid = page.locator('.env-matrix-scroll');
    const table = page.getByRole('table', { name: 'Variables by environment' });
    const gridBox = (await grid.boundingBox())!;
    const tableBox = (await table.boundingBox())!;
    expect(gridBox.y + gridBox.height - (tableBox.y + tableBox.height)).toBeLessThan(24);

    await page.getByRole('button', { name: 'Environments 6 of 30' }).click();
    await picker.getByRole('button', { name: 'Show all' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Environments 30 of 30' })).toBeVisible();
    await expect(table).toHaveAttribute('aria-colcount', '32');
    expect(await columnHeads.count()).toBeLessThan(20);
    const name = page.getByLabel('Name of baseUrl');
    const before = (await name.boundingBox())!;
    await grid.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    await expect.poll(() => grid.evaluate(node => node.scrollLeft)).toBeGreaterThan(1000);
    const after = (await name.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    await expect(page.getByLabel('baseUrl in env-30', { exact: true })).toBeInViewport();
    await page.screenshot({ path: process.env.MATRIX_SHOT_DIR ? join(process.env.MATRIX_SHOT_DIR, 'scrolled.png') : join(tmpdir(), 'kurlo-environment-matrix-many.png'), animations: 'disabled' });

    await page.getByRole('button', { name: 'Environments 30 of 30' }).click();
    await picker.getByRole('button', { name: 'Reset' }).click();
    await expect(columnHeads).toHaveCount(5);
  });

  test('opens environments one at a time by default', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      environments: [
        { id: 'env-a', workspaceId: 'workspace-e2e', name: 'Alpha', values: [{ id: 1, key: 'baseUrl', value: 'https://a.example.test', enabled: true }] },
        { id: 'env-b', workspaceId: 'workspace-e2e', name: 'Beta', values: [{ id: 1, key: 'baseUrl', value: 'https://b.example.test', enabled: true }] },
      ],
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.locator('.environment-item-main').filter({ hasText: 'Beta' }).click();
    await expect(page.getByRole('radio', { name: 'Single' })).toBeChecked();
    await expect(page.getByTestId('environment-variable-row').first().getByLabel('Environment variable value')).toHaveValue('https://b.example.test');
    await expect(page.getByRole('table', { name: 'Variables by environment' })).toHaveCount(0);
  });

  test('imports a .env file picked in the dialog into an environment once', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      environments: [
        { id: 'env-dev', workspaceId: 'workspace-e2e', name: 'Dev', values: [{ id: 1, key: 'baseUrl', value: 'https://old.test', enabled: true }] },
      ],
    });
    await page.addInitScript(() => {
      const app = (window as any).go.api.App;
      const e2e = (window as any).__kurloE2E;
      e2e.envImports = [
        { path: '/Users/me/project/.env', values: [{ key: 'baseUrl', value: 'https://api.kurlo.test' }, { key: 'token', value: 'abc' }], error: '' },
        { path: '/Users/me/project/huge.env', values: [], error: '/Users/me/project/huge.env is larger than 1 MiB' },
      ];
      app.ChooseEnvFileToImport = async () => e2e.envImports.shift() ?? { path: '', values: [], error: '' };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.locator('.environment-item-main').filter({ hasText: 'Dev' }).click();

    await page.getByRole('button', { name: 'More environment actions' }).click();
    await page.getByRole('menuitem', { name: 'Import .env' }).click();
    const values = page.getByTestId('environment-variable-row').getByLabel('Environment variable value');
    await expect(values.nth(0)).toHaveValue('https://api.kurlo.test');
    await expect(page.getByTestId('environment-variable-row').getByLabel('Environment variable key').nth(1)).toHaveValue('token');
    await expect(values.nth(1)).toHaveValue('abc');
    await page.locator('.environment-workspace-head').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const store = (window as any).__kurloE2E.store as { environments?: Array<{ id: string; envFile?: string; values?: Array<{ key: string; value: string }> }> };
      const dev = store.environments?.find(environment => environment.id === 'env-dev');
      return dev ? Object.fromEntries((dev.values ?? []).filter(row => row.key).map(row => [row.key, row.value])) : null;
    })).toEqual({ baseUrl: 'https://api.kurlo.test', token: 'abc' });

    await page.getByRole('button', { name: 'More environment actions' }).click();
    await page.getByRole('menuitem', { name: 'Import .env' }).click();
    await expect(page.getByRole('dialog')).toContainText('larger than 1 MiB');
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();

    await page.getByRole('button', { name: 'More environment actions' }).click();
    await page.getByRole('menuitem', { name: 'Import .env' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(values.nth(1)).toHaveValue('abc');
  });

  test('compares and edits variables across environments in the matrix', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Environments' }).click();
    await page.getByLabel('New environment').click();
    await fillPrompt(page, 'New environment', 'Local');
    const envRows = page.getByTestId('environment-variable-row');
    await envRows.nth(0).getByLabel('Environment variable key').fill('baseUrl');
    await envRows.nth(0).getByLabel('Environment variable value').fill('http://localhost:4242');

    await page.getByLabel('New environment').click();
    await fillPrompt(page, 'New environment', 'Staging');

    await page.getByRole('radio', { name: 'Matrix' }).click();
    await expect(page.getByRole('heading', { name: 'Variables' })).toBeVisible();
    const matrixRows = page.getByTestId('environment-matrix-row');
    await expect(matrixRows).toHaveCount(1);
    await expect(page.getByLabel('baseUrl in Local', { exact: true })).toHaveValue('http://localhost:4242');

    await page.getByRole('button', { name: 'Set baseUrl in Staging' }).click();
    await page.getByLabel('baseUrl in Staging', { exact: true }).fill('https://staging.kurlo.test');

    const name = page.getByLabel('Name of baseUrl');
    await name.fill('apiBase');
    await name.press('Enter');
    await expect(page.getByLabel('apiBase in Staging', { exact: true })).toHaveValue('https://staging.kurlo.test');

    await page.getByRole('button', { name: 'Make apiBase secret' }).click();
    await expect(page.getByLabel('apiBase in Local', { exact: true })).toHaveAttribute('type', 'password');
    await captureDocsScreenshot(page, 'environment-matrix');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => {
      const store = await page.evaluate(() => window.__kurloE2E.store as {
        environments?: Array<{ name: string; values: Array<{ key: string; value: string; secret?: boolean }> }>;
      });
      return (store.environments ?? []).map(environment => ({
        name: environment.name,
        values: environment.values.filter(row => row.key).map(row => `${row.key}=${row.value}${row.secret ? ' (secret)' : ''}`),
      }));
    }).toEqual([
      { name: 'Local', values: ['apiBase=http://localhost:4242 (secret)'] },
      { name: 'Staging', values: ['apiBase=https://staging.kurlo.test (secret)'] },
    ]);

    await page.getByRole('radio', { name: 'Single' }).click();
    await expect(page.getByTestId('environment-variable-row').first().getByLabel('Environment variable key')).toHaveValue('apiBase');

    await page.getByRole('radio', { name: 'Matrix' }).click();
    await page.getByLabel('apiBase in Staging', { exact: true }).hover();
    await page.getByRole('button', { name: 'Unset apiBase in Staging', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Set apiBase in Staging', exact: true })).toBeVisible();
    await expect(page.getByLabel('apiBase in Local', { exact: true })).toHaveValue('http://localhost:4242');
    await expect(page.getByRole('button', { name: 'Unset apiBase in Local', exact: true })).toHaveCount(0);
  });

  test('fits the Secret label of a global variable inside its button', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Environments' }).click();
    await page.locator('.environment-globals-item').click();
    await page.getByLabel('Variable name').first().fill('token');
    const toggle = page.locator('.globals-secret-toggle').first();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const fit = await toggle.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return { left: text.left - box.left, right: box.right - text.right };
    });
    expect(fit.left).toBeGreaterThanOrEqual(4);
    expect(fit.right).toBeGreaterThanOrEqual(4);
  });

  test('lets an environment inherit the variables it does not set from another', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Environments' }).click();
    await page.getByLabel('New environment').click();
    await fillPrompt(page, 'New environment', 'Base');
    const envRows = page.getByTestId('environment-variable-row');
    await envRows.nth(0).getByLabel('Environment variable key').fill('baseUrl');
    await envRows.nth(0).getByLabel('Environment variable value').fill('https://api.kurlo.test');
    await envRows.nth(1).getByLabel('Environment variable key').fill('region');
    await envRows.nth(1).getByLabel('Environment variable value').fill('us');

    await page.getByLabel('New environment').click();
    await fillPrompt(page, 'New environment', 'Staging');
    await page.getByRole('radio', { name: 'Single' }).click();
    await page.getByRole('button', { name: 'Inherits from: Nothing' }).click();
    await page.getByRole('option', { name: 'Base' }).click();

    const inherited = page.getByTestId('environment-inherited-row');
    await expect(inherited).toHaveCount(2);
    await expect(inherited.first()).toContainText('baseUrl');
    await expect(inherited.first()).toContainText('from Base');
    await page.getByRole('button', { name: 'Override region in Staging' }).click();
    await expect(inherited).toHaveCount(1);
    await page.getByTestId('environment-variable-row').first().getByLabel('Environment variable value').fill('eu');
    await expect(page.getByText('1 variable · 1 inherited from Base')).toBeVisible();
    await expect(page.locator('.environment-item.active small')).toHaveText('In use · 1 variable · inherits Base');
    await captureDocsScreenshot(page, 'environment-inheritance');

    await page.getByRole('radio', { name: 'Matrix' }).click();
    const fromBase = page.getByRole('button', { name: 'Override baseUrl in Staging, now inherited from Base' });
    await expect(fromBase).toContainText('https://api.kurlo.test');
    await expect(page.getByLabel('region in Staging', { exact: true })).toHaveValue('eu');
    await expect(page.locator('.env-matrix-parent')).toHaveText('↳ Base');
    await captureDocsScreenshot(page, 'environment-matrix-inherited');
    await page.getByRole('radio', { name: 'Single' }).click();
    await page.locator('.environment-workspace').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.environment-workspace').getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();

    await expect(page.locator('.environment-select')).toContainText('Staging');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    const url = page.getByLabel('Request URL');
    await url.fill('{{baseUrl}}/{{region}}/orders');
    await url.press('Enter');
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.sentRequests.at(-1) as { url?: string } | undefined)?.url)).toBe('https://api.kurlo.test/eu/orders');

    await expect.poll(async () => {
      const store = await page.evaluate(() => window.__kurloE2E.store as {
        environments?: Array<{ name: string; parentId?: string; id: string; values: Array<{ key: string; value: string }> }>;
      });
      const environments = store.environments ?? [];
      const base = environments.find(environment => environment.name === 'Base');
      return environments.map(environment => ({
        name: environment.name,
        inherits: environment.parentId === base?.id ? 'Base' : '',
        values: environment.values.filter(row => row.key).map(row => `${row.key}=${row.value}`),
      }));
    }).toEqual([
      { name: 'Base', inherits: '', values: ['baseUrl=https://api.kurlo.test', 'region=us'] },
      { name: 'Staging', inherits: 'Base', values: ['region=eu'] },
    ]);
  });
});

test('marks an environment as a sandbox for the agent', async ({ page }, testInfo) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Environments', exact: true }).click();
  await page.getByLabel('New environment', { exact: true }).click();
  await fillPrompt(page, 'New environment', 'Sandbox test');
  const workspace = page.locator('.environment-workspace');
  const trigger = page.getByRole('button', { name: 'More environment actions', exact: true });
  await trigger.click();
  await workspace.getByRole('menu').getByRole('menuitemcheckbox', { name: 'Sandbox for the agent' }).click();
  await expect(workspace.locator('.env-sandbox')).toHaveText('Sandbox');
  await trigger.click();
  await expect(workspace.getByRole('menu').getByRole('menuitemcheckbox', { name: 'Stop treating as a sandbox' })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: join(tmpdir(), `kurlo-environment-sandbox-${testInfo.project.name}.png`), animations: 'disabled' });
  await workspace.getByRole('menu').getByRole('menuitemcheckbox', { name: 'Protect from AI agents' }).click();
  await expect(workspace.locator('.env-protected')).toHaveText('Protected');
  const nameField = workspace.getByLabel('Environment name');
  const gapToText = () => nameField.evaluate((input: HTMLInputElement) => {
    const probe = document.createElement('span');
    const style = getComputedStyle(input);
    probe.style.font = style.font;
    probe.style.letterSpacing = style.letterSpacing;
    probe.style.whiteSpace = 'pre';
    probe.style.position = 'absolute';
    probe.textContent = input.value;
    document.body.append(probe);
    const textRight = input.getBoundingClientRect().left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) + probe.getBoundingClientRect().width;
    probe.remove();
    const mark = document.querySelector('.environment-workspace .env-protected')!.getBoundingClientRect();
    return mark.left - textRight;
  });
  await expect.poll(gapToText).toBeLessThan(32);
  expect(await gapToText()).toBeGreaterThanOrEqual(0);
  await nameField.fill('Sandbox test with a much longer name');
  await expect.poll(gapToText).toBeLessThan(32);
  expect(await gapToText()).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: process.env.ENV_BADGE_SHOT || join(tmpdir(), `kurlo-environment-protected-${testInfo.project.name}.png`), animations: 'disabled' });
  await nameField.press('Enter');
  await trigger.click();
  await expect(workspace.getByRole('menu').getByRole('menuitemcheckbox', { name: 'Stop treating as a sandbox' })).toBeDisabled();
});

test('dismisses environment actions outside the menu and keeps switching in the top bar and sidebar', async ({ page }, testInfo) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Environments', exact: true }).click();
  for (const name of ['Local menu test', 'Staging menu test']) {
    await page.getByLabel('New environment', { exact: true }).click();
    await fillPrompt(page, 'New environment', name);
  }
  await page.getByRole('radio', { name: 'Single', exact: true }).click();
  const workspace = page.locator('.environment-workspace');
  const trigger = page.getByRole('button', { name: 'More environment actions', exact: true });
  const menu = workspace.getByRole('menu');
  await expect(workspace.getByRole('button', { name: /^(In use|Use environment)$/ })).toHaveCount(0);
  await expect(page.locator('.environment-select')).toContainText('Staging menu test');
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await workspace.getByRole('heading', { name: 'Staging menu test', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu.getByRole('menuitemcheckbox', { name: 'Protect from AI agents' }).click();
  await expect(menu).toHaveCount(0);
  await expect(workspace.locator('.env-protected')).toHaveText('Protected');
  await trigger.click();
  await page.screenshot({ path: join(tmpdir(), `kurlo-environment-actions-${testInfo.project.name}.png`), animations: 'disabled' });
  await page.locator('.environment-select').click();
  await expect(menu).toHaveCount(0);
  await page.locator('.environment-menu').getByRole('button', { name: 'Local menu test' }).click();
  await expect(page.locator('.environment-select')).toContainText('Local menu test');
  await page.locator('.environment-item-main').filter({ hasText: 'Staging menu test' }).click();
  await expect(page.locator('.environment-select')).toContainText('Staging menu test');
  await expect(workspace.getByRole('textbox', { name: 'Environment name', exact: true })).toHaveValue('Staging menu test');
  await trigger.click();
  await trigger.click();
  await expect(menu).toHaveCount(0);
});

test('renames environments inline in the header and sidebar without a dialog', async ({ page }, testInfo) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Environments', exact: true }).click();
  await page.getByLabel('New environment', { exact: true }).click();
  await fillPrompt(page, 'New environment', 'Local rename');
  const workspace = page.locator('.environment-workspace');
  const dialog = page.getByRole('dialog', { name: 'Rename environment' });
  const title = workspace.getByRole('textbox', { name: 'Environment name', exact: true });
  const row = page.locator('button.environment-item-main');
  const sidebarName = page.getByRole('textbox', { name: 'Sidebar environment name', exact: true });
  await page.getByTestId('environment-variable-row').first().getByLabel('Environment variable key').fill('baseUrl');
  await page.getByTestId('environment-variable-row').first().getByLabel('Environment variable value').fill('https://example.test');
  const original = await page.evaluate(() => (window.__kurloE2E.store as { environments: Array<{ id: string; name: string }> }).environments.find(environment => environment.name === 'Local rename')!.id);
  await title.dblclick();
  await expect(dialog).toHaveCount(0);
  await title.fill('Cancel this');
  await title.press('Escape');
  await expect(title).toHaveValue('Local rename');
  await title.fill('Staging renamed');
  await title.press('Enter');
  await expect(title).toHaveValue('Staging renamed');
  await expect(page.locator('.environment-select')).toContainText('Staging renamed');
  await expect(row).toContainText('Staging renamed');
  await row.dblclick();
  await expect(sidebarName).toBeFocused();
  await expect(sidebarName).toHaveValue('Staging renamed');
  await expect(dialog).toHaveCount(0);
  await sidebarName.fill('Discard sidebar edit');
  await sidebarName.press('Escape');
  await expect(row).toContainText('Staging renamed');
  await row.dblclick();
  await sidebarName.fill('Production renamed');
  await sidebarName.press('Enter');
  await expect(title).toHaveValue('Production renamed');
  await row.focus();
  await row.press('F2');
  await sidebarName.fill('Keyboard renamed');
  await title.click();
  await expect(title).toHaveValue('Keyboard renamed');
  await page.getByRole('button', { name: 'More environment actions', exact: true }).click();
  await workspace.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await expect(title).toBeFocused();
  await expect(title).toHaveJSProperty('selectionStart', 0);
  await expect(title).toHaveJSProperty('selectionEnd', 'Keyboard renamed'.length);
  await expect(dialog).toHaveCount(0);
  await title.fill('');
  await title.press('Enter');
  await expect(title).toHaveValue('Keyboard renamed');
  await title.fill('Final name');
  await title.press('Tab');
  await expect.poll(() => page.evaluate(() => (window.__kurloE2E.store as { environments: Array<{ name: string }> }).environments.some(environment => environment.name === 'Final name'))).toBe(false);
  await workspace.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(workspace.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => {
    const store = window.__kurloE2E.store as { activeEnvironmentId: string; environments: Array<{ id: string; name: string; values: Array<{ key: string; value: string }> }> };
    const environment = store.environments.find(environment => environment.name === 'Final name');
    return { id: environment?.id, active: store.activeEnvironmentId, value: environment?.values.find(row => row.key === 'baseUrl')?.value };
  })).toEqual({ id: original, active: original, value: 'https://example.test' });
  await row.focus();
  await row.press('F2');
  await page.screenshot({ path: join(tmpdir(), `kurlo-environment-inline-name-${testInfo.project.name}.png`), animations: 'disabled' });
  await sidebarName.press('Escape');
});

test('colors an environment and shows it in the switcher, sidebar and matrix', async ({ page }, testInfo) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Environments', exact: true }).click();
  await page.getByLabel('New environment', { exact: true }).click();
  await fillPrompt(page, 'New environment', 'Production');
  const workspace = page.locator('.environment-workspace');
  await page.getByRole('button', { name: 'More environment actions', exact: true }).click();
  const swatches = workspace.getByRole('group', { name: 'Environment color' });
  await expect(swatches.getByRole('menuitemradio', { name: 'No color' })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: join(tmpdir(), `kurlo-environment-color-menu-${testInfo.project.name}.png`), animations: 'disabled' });
  await swatches.getByRole('menuitemradio', { name: 'Red' }).click();
  await expect(workspace.locator('.env-title-color')).toBeVisible();
  await expect(workspace.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  const storedColor = () => page.evaluate(() => {
    const store = window.__kurloE2E.store as { environments?: Array<{ name: string; color?: string }> };
    return store.environments?.find(environment => environment.name === 'Production')?.color;
  });
  expect(await storedColor()).toBeUndefined();
  await page.screenshot({ path: join(tmpdir(), `kurlo-environment-color-unsaved-${testInfo.project.name}.png`), animations: 'disabled' });
  await workspace.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const store = (window as any).__kurloE2E.store as { environments?: Array<{ name: string; color?: string }> };
    return store.environments?.find(environment => environment.name === 'Production')?.color;
  })).toBe('red');

  const sidebarDot = page.locator('.environment-item').filter({ hasText: 'Production' }).locator('.environment-dot');
  await expect(sidebarDot).toHaveClass(/env-colored/);
  const danger = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--danger').trim());
  const sidebarColor = await sidebarDot.evaluate(element => getComputedStyle(element).backgroundColor);
  const probe = await page.evaluate(color => { const el = document.createElement('span'); el.style.color = color; document.body.append(el); const value = getComputedStyle(el).color; el.remove(); return value; }, danger);
  expect(sidebarColor).toBe(probe);

  const switcher = page.locator('.environment-select');
  await switcher.click();
  await page.locator('.environment-menu').getByRole('button', { name: /Production/ }).click();
  await expect(switcher).toHaveClass(/env-colored/);
  await expect(switcher).toContainText('Production');
  await page.screenshot({ path: join(tmpdir(), `kurlo-environment-color-${testInfo.project.name}.png`), animations: 'disabled' });
  if (testInfo.project.name === 'chromium') await captureDocsScreenshot(page, 'environment-colors');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(tmpdir(), `kurlo-environment-color-dark-${testInfo.project.name}.png`), animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'light' });

  await page.getByRole('button', { name: 'More environment actions', exact: true }).click();
  await swatches.getByRole('menuitemradio', { name: 'No color' }).click();
  await expect(switcher).not.toHaveClass(/env-colored/);
  await expect(workspace.locator('.env-title-color')).toHaveCount(0);
  expect(await storedColor()).toBe('red');
  await workspace.getByRole('button', { name: 'Revert unsaved changes', exact: true }).click();
  await expect(workspace.locator('.env-title-color')).toBeVisible();
  await expect(workspace.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'More environment actions', exact: true }).click();
  await swatches.getByRole('menuitemradio', { name: 'No color' }).click();
  await workspace.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(storedColor).toBeUndefined();

  await page.getByRole('button', { name: 'More environment actions', exact: true }).click();
  await swatches.getByRole('menuitemradio', { name: 'Blue' }).click();
  await workspace.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByLabel('New environment', { exact: true }).click();
  await fillPrompt(page, 'New environment', 'Staging');
  await page.getByRole('radio', { name: 'Matrix' }).click();
  await expect(page.locator('.env-matrix-col-head').filter({ hasText: 'Production' }).locator('.env-matrix-dot.env-colored')).toHaveCount(1);
  await expect(page.locator('.env-matrix-col-head').filter({ hasText: 'Staging' }).locator('.env-matrix-dot.env-colored')).toHaveCount(0);
  await page.locator('.env-matrix-columns').getByRole('button').click();
  const columns = page.getByRole('dialog', { name: 'Environments in the matrix' });
  await expect(columns.locator('.env-matrix-columns-item').filter({ hasText: 'Production' }).locator('.env-color-dot')).toBeVisible();
  await expect(columns.locator('.env-matrix-columns-item').filter({ hasText: 'Staging' }).locator('.env-color-dot')).toHaveCount(0);
  await page.screenshot({ path: join(tmpdir(), `kurlo-environment-columns-${testInfo.project.name}.png`), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Single', exact: true }).click();
  const parent = workspace.getByRole('button', { name: /^Inherits from:/ });
  await parent.click();
  await expect(page.getByRole('option', { name: 'Production', exact: true }).locator('.env-color-dot')).toBeVisible();
  await page.getByRole('option', { name: 'Production', exact: true }).click();
  await expect(parent).toHaveClass(/env-colored/);
  await expect(parent.locator('.env-color-dot')).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), `kurlo-environment-parent-${testInfo.project.name}.png`), animations: 'disabled' });
});

test('keeps a later environment page while editing a variable there', async ({ page }) => {
  const values = Array.from({ length: 120 }, (_, index) => ({ id: index + 1, key: `v${index + 1}`, value: `val${index + 1}`, enabled: true }));
  await installKurloBridge(page, '', 'browser/e2e', false, {
    environments: [{ id: 'env-pages', workspaceId: 'workspace-e2e', name: 'Pages', values }],
    activeEnvironmentId: 'env-pages',
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Environments', exact: true }).click();
  await page.locator('.environment-item-main').filter({ hasText: 'Pages' }).click();
  await expect(page.locator('.environment-pagination')).toContainText('Variables 1-100 of 120');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.environment-pagination')).toContainText('Variables 101-120 of 120');
  const rows = page.getByTestId('environment-variable-row');
  await expect(rows.first().getByLabel('Environment variable key')).toHaveValue('v101');
  await rows.first().getByLabel('Environment variable value').fill('changed-101');
  await expect(page.locator('.environment-pagination')).toContainText('Variables 101-120 of 120');
  await expect(rows.first().getByLabel('Environment variable key')).toHaveValue('v101');
  await rows.nth(19).getByLabel('Environment variable value').fill('changed-120');
  await page.locator('.environment-workspace').getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const store = window.__kurloE2E.store as { environments: Array<{ id: string; values: Array<{ key: string; value: string }> }> };
    const env = store.environments.find(environment => environment.id === 'env-pages')!;
    return { first: env.values.find(row => row.key === 'v101')?.value, last: env.values.find(row => row.key === 'v120')?.value };
  })).toEqual({ first: 'changed-101', last: 'changed-120' });
});

test('shows one hundred variables with the add row and no empty page', async ({ page }) => {
  const values = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, key: `v${index + 1}`, value: `val${index + 1}`, enabled: true }));
  await installKurloBridge(page, '', 'browser/e2e', false, {
    environments: [{ id: 'env-hundred', workspaceId: 'workspace-e2e', name: 'Hundred', values }],
    activeEnvironmentId: 'env-hundred',
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Environments', exact: true }).click();
  await page.locator('.environment-item-main').filter({ hasText: 'Hundred' }).click();
  await expect(page.locator('.environment-pagination')).toHaveCount(0);
  const rows = page.getByTestId('environment-variable-row');
  await expect(rows).toHaveCount(101);
  const addRow = rows.last().getByLabel('Environment variable key');
  await expect(addRow).toHaveValue('');
  await addRow.fill('v101');
  await expect(page.locator('.environment-pagination')).toContainText('Variables 101-101 of 101');
  await expect(page.getByTestId('environment-variable-row').first().getByLabel('Environment variable key')).toHaveValue('v101');
  await page.locator('.environment-workspace').getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const store = window.__kurloE2E.store as { environments: Array<{ id: string; values: Array<{ key: string }> }> };
    return store.environments.find(environment => environment.id === 'env-hundred')!.values.some(row => row.key === 'v101');
  })).toBe(true);
});

test('keeps the secret provider picker within the minimum window at 125% scale', async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 680 });
  await installKurloBridge(page);
  await page.goto('/');
  await page.keyboard.press('Control+=');
  await page.keyboard.press('Control+=');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('20px');
  await page.getByRole('button', { name: 'Environments', exact: true }).click();
  await page.getByRole('button', { name: 'Add secret provider' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a secret provider' });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(680);
  const choices = dialog.getByRole('radiogroup');
  await expect(choices.getByRole('radio')).toHaveCount(11);
  await choices.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => choices.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await choices.getByRole('radio', { name: /Environment variables/ }).click();
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeInViewport({ ratio: 1 });
  const next = dialog.getByRole('button', { name: 'Continue' });
  await expect(next).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), 'add-provider-125.png'), animations: 'disabled' });
  await next.click();
  await expect(page.getByRole('heading', { name: 'New Environment variables' })).toBeVisible();
});
