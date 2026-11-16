import type { E2EWindow } from './support/bridge';
import { chooseRequestSection, chooseRequestType, clickTabClose, collectionRow, fillCodeEditor, fillPrompt } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { openGitPanel, setGitStatus } from './support/git';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('asks for missing secrets by request, environment and cookie names instead of ids', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-sec', workspaceId: 'workspace-e2e', name: 'Secrets API' }],
      environments: [{ id: 'env-sec', workspaceId: 'workspace-e2e', name: 'Staging', values: [{ id: 3, key: 'password', value: '', enabled: true, secret: true }] }],
      requests: [
        { id: 'req-sec', collectionId: 'col-sec', collection: 'Secrets API', folderPath: ['Auth'], name: 'Login user', requestType: 'http', method: 'POST', url: 'https://shop.kurlo.test/login', auth: { type: 'bearer', bearerToken: '' }, headers: [{ id: 7, key: 'Authorization', value: '', enabled: true }] },
      ],
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();
    await setGitStatus(page, {
      isRepo: true, root: '/workspace', workspaceRoot: '/workspace',
      branch: 'main', head: 'a665a49', upstream: 'origin/main', remotes: ['origin'], clean: true, files: [],
    });
    await page.evaluate(() => {
      const app = (window as E2EWindow).go.api.App;
      app.GitPullWorkspaceWithStrategy = async () => ({
        ok: true, root: '/workspace', payload: JSON.stringify(window.__kurloE2E.store),
        git: await app.GitStatus(), diagnostics: [], error: '', output: 'Already up to date.',
        missingSecrets: [
          { key: 'request.req-sec.auth.bearerToken', label: '', scope: 'request' },
          { key: 'request.req-sec.headers.row.7.value', label: '', scope: 'request', rowKey: 'Authorization' },
          { key: 'environment.env-sec.row.3.value', label: '', scope: 'environment', rowKey: 'password' },
          { key: 'workspace.workspace-e2e.cookies.session.2ff83fa72e.value', label: '', scope: 'workspace' },
        ],
      });
    });
    await openGitPanel(page);
    await page.getByRole('button', { name: 'Pull', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add secrets on this computer' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.missing-secrets-group-title')).toHaveText(['Login user', 'Environment “Staging”', 'Saved cookies']);
    await expect(dialog.locator('.missing-secrets-group').first()).toContainText('POST · Secrets API / Auth');
    await expect(dialog.locator('.missing-secrets-item-label > span')).toHaveText(['Bearer token', 'Header “Authorization”', 'Variable “password”', 'Cookie “session”']);
    await expect(dialog).not.toContainText('req-sec');
    const save = dialog.getByRole('button', { name: /^Save/ });
    await expect(save).toBeDisabled();
    await dialog.getByLabel('Login user: Bearer token').fill('token-value');
    await expect(save).toHaveText('Save 1 secret');
    await page.screenshot({ path: join(tmpdir(), 'kurlo-missing-secrets.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Later', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  test('overview explains why a blocked workspace is locked and leads to the fix', async ({ page }, testInfo) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go.api.App;
      app.LoadWorkspaceDiagnostics = async () => {
        const store = JSON.parse(await app.LoadRequestStore());
        return [{
          scope: 'workspace', severity: 'error', blocking: true, workspaceId: store.activeWorkspaceId,
          path: 'workspaces/My-Workspace/workspace.yml', line: 3,
          message: "line 3: could not find expected ':'",
        }];
      };
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const notice = page.locator('.overview-blocked');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Editing is paused: 1 workspace file needs fixing');
    await expect(notice).toContainText('workspaces/My-Workspace/workspace.yml');
    await expect(notice).toContainText("could not find expected ':'");
    await expect(page.getByRole('button', { name: 'New request', exact: true }).first()).toBeDisabled();
    await page.screenshot({ path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `overview-blocked-${testInfo.project.name}.png`), animations: 'disabled' });
    await notice.getByRole('button', { name: 'Show all issues' }).click();
    await expect(page.locator('.git-yaml-card')).toContainText('Editing is paused');
  });

  test('recovers a missing workspace folder by switching back to app storage', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collections' })).toBeVisible();

    await setGitStatus(page, {
      isRepo: false,
      workspaceRoot: '/Users/ada/Library/Application Support/OldApp/workspaces',
      missingRoot: true,
    });

    await openGitPanel(page);
    await expect(page.locator('.git-local-eyebrow')).toHaveText('Folder missing');

    await page.evaluate(() => { window.__kurloE2E.calls.length = 0; });
    await page.getByRole('button', { name: /Use Kurlo's app storage/ }).click();

    await expect(page.locator('.git-local-eyebrow')).not.toHaveText('Folder missing');
    const calls = await page.evaluate(() => window.__kurloE2E.calls);
    expect(calls).toContain('UseLocalWorkspaceStore');
    expect(calls.some(call => call.startsWith('CreateLocalWorkspaceRoot'))).toBe(false);
  });
});

test.describe('Workspace overview', () => {
  test('renames the workspace in place, sends a recent request and keeps a README', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.example.test/orders');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(1);

    await page.getByRole('tab', { name: 'Overview' }).click();
    const overview = page.locator('.workspace-overview');

    await overview.getByRole('button', { name: 'Rename workspace E2E Workspace' }).click();
    const nameInput = overview.getByLabel('Workspace name');
    await expect(nameInput).toBeFocused();
    await nameInput.fill('Ignored name');
    await nameInput.press('Escape');
    await expect(overview.getByRole('heading', { level: 1 })).toHaveText('E2E Workspace');
    await overview.getByRole('button', { name: 'Rename workspace E2E Workspace' }).click();
    await nameInput.fill('Team API');
    await nameInput.press('Enter');
    await expect(overview.getByRole('heading', { level: 1 })).toHaveText('Team API');
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.store.workspaces as Array<{ name: string }>)[0].name)).toBe('Team API');

    const recent = page.getByRole('region', { name: 'Continue where you left off' });
    const row = recent.locator('.overview-recent-row').first();
    const send = row.getByRole('button', { name: /^Send / });
    await expect(send).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(send).toHaveCSS('opacity', '1');
    await send.click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(2);
    await expect(page.getByLabel('Request URL')).toHaveValue('https://api.example.test/orders');

    await page.getByRole('tab', { name: 'Overview' }).click();
    const readme = page.getByRole('region', { name: 'README' });
    await readme.getByRole('button', { name: 'Write README' }).click();
    const readmeInput = readme.getByLabel('README', { exact: true });
    await expect(readmeInput).toBeFocused();
    await readmeInput.fill('## Auth\n\nRun **Login** first.');
    await expect(readme.getByRole('button', { name: 'Revert unsaved changes', exact: true })).toBeEnabled();
    await readme.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(readme.getByRole('heading', { name: 'Auth' })).toBeVisible();
    await expect(readme.locator('strong')).toHaveText('Login');
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.store.workspaces as Array<{ description: string }>)[0].description)).toBe('## Auth\n\nRun **Login** first.');
    await expect(page.locator('.overview-tile')).toHaveCount(6);
  });

  test('collapses a long README and shows a README Kurlo cannot edit as read-only', async ({ page }) => {
    const long = Array.from({ length: 60 }, (_, index) => `## Section ${index + 1}\n\nText for section ${index + 1}.`).join('\n\n');
    await installKurloBridge(page, '', 'browser/e2e', false, {
      workspaces: [
        { id: 'workspace-e2e', name: 'E2E Workspace', filesystemName: 'E2E-Workspace', description: long },
        { id: 'workspace-big', name: 'Big', filesystemName: 'Big', description: '', readmeIssue: 'README.md is over 256 KB, so Kurlo does not show or edit it. Shorten it in another editor.' },
      ],
    });
    await page.goto('/');
    await page.getByRole('tab', { name: 'Overview' }).click();
    const readme = page.getByRole('region', { name: 'README' });
    const body = readme.locator('.overview-readme-body');
    await expect(body).toHaveClass(/collapsed/);
    const collapsedHeight = await body.evaluate((element) => element.getBoundingClientRect().height);
    expect(collapsedHeight).toBeLessThanOrEqual(24 * 16 + 1);
    await readme.getByRole('button', { name: 'Show all' }).click();
    await expect(body).not.toHaveClass(/collapsed/);
    await expect(readme.getByRole('heading', { name: 'Section 60' })).toBeVisible();
    await readme.getByRole('button', { name: 'Show less' }).click();
    await expect(body).toHaveClass(/collapsed/);

    await readme.getByRole('button', { name: 'Edit' }).click();
    await readme.getByLabel('README', { exact: true }).fill('x'.repeat(256 * 1024 + 1));
    await expect(readme.getByRole('alert')).toContainText('over 256 KB');
    await readme.getByLabel('README', { exact: true }).fill('short');
    await expect(readme.getByRole('alert')).toHaveCount(0);
    await readme.getByRole('button', { name: 'Done' }).click();

    await page.getByLabel('Workspace switcher').click();
    await page.getByRole('button', { name: /^Big/ }).first().click();
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(readme.getByRole('status')).toContainText('over 256 KB');
    await expect(readme).toContainText('Read-only');
    await expect(readme.getByRole('button')).toHaveCount(0);
    await expect(readme.getByRole('textbox')).toHaveCount(0);
  });
});

test.describe('Collection overview', () => {
  test('renames in place, summarizes defaults, renders docs and keeps rare actions in a menu', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{
        id: 'col-ov', workspaceId: 'workspace-e2e', name: 'Orders API', description: '',
        defaults: {
          headers: [{ id: 1, enabled: true, key: 'X-Team', value: 'core' }, { id: 2, enabled: true, key: 'X-Trace', value: '1' }],
          variables: [],
          auth: { type: 'bearer', bearerToken: '{{token}}' },
          preRequestScriptJs: 'pm.environment.set("a", 1);\npm.environment.set("b", 2);',
          testScriptJs: '',
          preRequestScript: '', testScript: '',
          settings: { proxyUrl: 'http://proxy.local:8080' },
        },
      }],
      requests: [{ id: 'req-ov', collectionId: 'col-ov', collection: 'Orders API', name: 'List orders', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/orders', auth: { type: 'inherit' } }],
    });
    await page.goto('/');
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    const head = page.locator('.collection-workspace-head');

    const defaults = page.getByRole('complementary', { name: 'Applied to every request' });
    await expect(defaults.locator('.collection-default-row')).toHaveText([
      /Headers\s*2 headers/, /Variables\s*None/, /Auth\s*Bearer token/, /Pre-request script\s*2 lines/, /Tests\s*None/, /Proxy and settings\s*Proxy http:\/\/proxy\.local:8080/,
    ]);
    await defaults.getByRole('button', { name: /^Auth/ }).click();
    await expect(page.locator('.collection-tabs').getByRole('tab', { name: /Auth/ })).toHaveAttribute('aria-selected', 'true');
    await page.locator('.collection-tabs').getByRole('tab', { name: 'Overview' }).click();

    const docs = page.getByRole('region', { name: 'Documentation' });
    await docs.getByRole('button', { name: 'Write documentation' }).click();
    const docsInput = docs.getByRole('textbox', { name: 'Documentation' });
    await expect(docsInput).toBeFocused();
    await docsInput.fill('## Auth\n\nRun **Login** first.');
    await docs.getByRole('button', { name: 'Done' }).click();
    await expect(docs.getByRole('heading', { name: 'Auth' })).toBeVisible();
    await expect(docs.locator('.md p')).toHaveCSS('color', await page.locator('.collection-workspace h1').evaluate(node => getComputedStyle(node).color));

    await head.getByRole('button', { name: 'Rename collection Orders API' }).click();
    const nameInput = head.getByLabel('Collection name');
    await expect(nameInput).toBeFocused();
    await nameInput.fill('Billing API');
    await nameInput.press('Enter');
    await expect(head.getByRole('heading', { level: 1 })).toHaveText('Billing API');
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.store.collections as Array<{ id: string; name: string; description: string }>).find(item => item.id === 'col-ov'))).toMatchObject({
      name: 'Billing API', description: '## Auth\n\nRun **Login** first.',
    });
    await expect(collectionRow(page, 'Billing API')).toBeVisible();

    await expect(head.getByRole('button', { name: 'Reset defaults' })).toHaveCount(0);
    await head.getByRole('button', { name: 'More collection actions' }).click();
    const menu = head.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Export…', 'Reset defaults', 'Delete collection']);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    await head.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('.collection-runner-workspace')).toBeVisible();
  });

  test('keeps huge, long and blank collection documentation safe to show and save', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-docs', workspaceId: 'workspace-e2e', name: 'Docs API', description: '' }],
      requests: [{ id: 'req-docs', collectionId: 'col-docs', collection: 'Docs API', name: 'Ping', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/ping', auth: { type: 'inherit' } }],
    });
    await page.goto('/');
    await collectionRow(page, 'Docs API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Docs API').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    const docs = page.getByRole('region', { name: 'Documentation' });
    const stored = () => page.evaluate(() => (window.__kurloE2E.store.collections as Array<{ id: string; description: string }>).find(item => item.id === 'col-docs')?.description);
    const save = page.locator('.overview-actions').getByRole('button', { name: 'Save', exact: true });

    await docs.getByRole('button', { name: 'Write documentation' }).click();
    const input = docs.getByRole('textbox', { name: 'Documentation' });
    const huge = '## Part\n\n' + 'word '.repeat(70000);
    await input.fill(huge);
    await expect(docs.getByRole('alert')).toContainText('only previews documentation up to 256 KB');
    await save.click();
    await expect.poll(async () => (await stored())?.length).toBe(huge.length);
    await docs.getByRole('button', { name: 'Done' }).click();
    await expect(docs.locator('.md-too-long')).toContainText('too long to preview');
    await expect(docs.locator('.md-heading')).toHaveCount(0);

    await docs.getByRole('button', { name: 'Edit' }).click();
    const long = Array.from({ length: 50 }, (_, index) => `## Step ${index + 1}\n\nDo thing ${index + 1}.`).join('\n\n');
    await input.fill(long);
    await expect(docs.getByRole('alert')).toHaveCount(0);
    await docs.getByRole('button', { name: 'Done' }).click();
    const body = docs.locator('.overview-readme-body');
    await expect(body).toHaveClass(/collapsed/);
    expect(await body.evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(24 * 16 + 1);
    await docs.getByRole('button', { name: 'Show all' }).click();
    await expect(docs.getByRole('heading', { name: 'Step 50' })).toBeVisible();

    await docs.getByRole('button', { name: 'Edit' }).click();
    await input.fill('\n\n   \n');
    await save.click();
    await expect.poll(stored).toBe('');
    await expect(page.locator('.overview-actions')).not.toContainText('Updated elsewhere');
    await page.waitForTimeout(1500);
    await expect(page.locator('.overview-actions')).not.toContainText('Updated elsewhere');
  });

  test('Reset defaults clears JavaScript scripts and leaves the form clean', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{
        id: 'col-reset', workspaceId: 'workspace-e2e', name: 'Reset API',
        defaults: {
          headers: [], variables: [], auth: { type: 'none' },
          preRequestScript: '', testScript: '', preRequestScriptJs: 'console.log("pre");', testScriptJs: 'console.log("test");',
          settings: { timeoutMs: 9000 },
        },
      }],
      requests: [{ id: 'req-reset', collectionId: 'col-reset', collection: 'Reset API', name: 'Ping', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/ping', auth: { type: 'inherit' } }],
      activeId: 'req-reset', openIds: ['req-reset'],
    });
    await page.goto('/');
    await collectionRow(page, 'Reset API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Reset API').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'More collection actions' }).click();
    await page.getByRole('menuitem', { name: 'Reset defaults' }).click();
    await page.getByRole('dialog', { name: 'Reset collection defaults' }).getByRole('button', { name: 'Reset' }).click();

    await page.locator('.collection-tabs').getByRole('tab', { name: /^Script/ }).click();
    await expect(page.locator('.collection-script-section .cm-placeholder')).toBeVisible();
    await page.locator('.collection-tabs').getByRole('tab', { name: /^Tests/ }).click();
    await expect(page.locator('.collection-script-section .cm-placeholder')).toBeVisible();
    await page.locator('.collection-tabs').getByRole('tab', { name: 'Overview' }).click();
    await expect(page.getByRole('complementary', { name: 'Applied to every request' }).locator('.collection-default-row')).toHaveText([
      /Headers\s*None/, /Variables\s*None/, /Auth\s*None/, /Pre-request script\s*None/, /Tests\s*None/, /Proxy and settings\s*Defaults/,
    ]);
    await expect(page.locator('.overview-actions').getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => {
      const collection = (window.__kurloE2E.store.collections as Array<Record<string, any>>).find(item => item.id === 'col-reset');
      return {
        pre: collection?.defaults?.preRequestScriptJs ?? '',
        test: collection?.defaults?.testScriptJs ?? '',
        timeout: collection?.defaults?.settings?.timeoutMs,
      };
    })).toEqual({ pre: '', test: '', timeout: 30000 });
  });

  test('autosaved collection settings save when leaving before the delay', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{
        id: 'col-autosave', workspaceId: 'workspace-e2e', name: 'Autosave API',
        defaults: { headers: [{ id: 1, enabled: true, key: 'X-Saved', value: 'yes' }], variables: [], auth: { type: 'none' }, preRequestScript: '', testScript: '', preRequestScriptJs: '', testScriptJs: '' },
      }],
      requests: [{ id: 'req-autosave', collectionId: 'col-autosave', collection: 'Autosave API', name: 'Ping', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/ping', auth: { type: 'inherit' } }],
      activeId: 'req-autosave', openIds: ['req-autosave'],
    });
    await page.addInitScript(() => {
      localStorage.setItem('kurlo.autosave.v1', 'true');
      localStorage.setItem('kurlo.autosaveDelay.v1', '1000');
    });
    await page.goto('/');
    await collectionRow(page, 'Autosave API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Autosave API').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    await page.locator('.collection-tabs').getByRole('tab', { name: /^Headers/ }).click();
    await page.locator('.collection-kv-table .kv-row').nth(0).locator('input[placeholder="Header"]').fill('X-Autosaved');
    await clickTabClose(page.getByRole('button', { name: 'Close collection settings' }));
    await expect.poll(() => page.evaluate(() => {
      const collection = (window.__kurloE2E.store.collections as Array<Record<string, any>>).find(item => item.id === 'col-autosave');
      return collection?.defaults?.headers?.[0]?.key;
    })).toBe('X-Autosaved');
  });

  test('autosaved collection settings save when opening another collection', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [
        { id: 'col-switch-a', workspaceId: 'workspace-e2e', name: 'Switch A', defaults: { headers: [], variables: [], auth: { type: 'none' }, preRequestScript: '', testScript: '', preRequestScriptJs: '', testScriptJs: '' } },
        { id: 'col-switch-b', workspaceId: 'workspace-e2e', name: 'Switch B', defaults: { headers: [], variables: [], auth: { type: 'none' }, preRequestScript: '', testScript: '', preRequestScriptJs: '', testScriptJs: '' } },
      ],
      requests: [
        { id: 'req-switch-a', collectionId: 'col-switch-a', collection: 'Switch A', name: 'A', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/a', auth: { type: 'inherit' } },
        { id: 'req-switch-b', collectionId: 'col-switch-b', collection: 'Switch B', name: 'B', requestType: 'http', method: 'GET', url: 'https://api.kurlo.test/b', auth: { type: 'inherit' } },
      ],
      activeId: 'req-switch-a', openIds: ['req-switch-a'],
    });
    await page.addInitScript(() => {
      localStorage.setItem('kurlo.autosave.v1', 'true');
      localStorage.setItem('kurlo.autosaveDelay.v1', '1000');
    });
    await page.goto('/');
    await collectionRow(page, 'Switch A').getByLabel('Collection menu').click();
    await collectionRow(page, 'Switch A').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    await page.locator('.collection-tabs').getByRole('tab', { name: /^Headers/ }).click();
    await page.locator('.collection-kv-table .kv-row').nth(0).locator('input[placeholder="Header"]').fill('X-Switch');
    await collectionRow(page, 'Switch B').getByLabel('Collection menu').click();
    await collectionRow(page, 'Switch B').locator('.collection-menu').getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Switch B');
    await expect.poll(() => page.evaluate(() => {
      const collections = window.__kurloE2E.store.collections as Array<Record<string, any>>;
      return collections.find(item => item.id === 'col-switch-a')?.defaults?.headers?.[0]?.key;
    })).toBe('X-Switch');
  });
});

test.describe('Text fields and workspace files', () => {
  test('edits text through the right-click menu', async ({ page }, testInfo) => {
    await installKurloBridge(page, '', 'windows/e2e');
    await page.goto('/');
    const url = page.getByLabel('Request URL');
    await url.fill('https://api.kurlo.test/orders');
    const menu = page.getByRole('menu', { name: 'Edit' });

    await url.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Cut/ })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: /Copy/ })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: /Paste/ })).toContainText('Ctrl+V');
    await menu.getByRole('menuitem', { name: /Select all/ }).click();
    await expect(menu).toBeHidden();

    await url.click({ button: 'right' });
    await page.screenshot({ path: join(tmpdir(), `kurlo-text-menu-${testInfo.project.name}.png`), animations: 'disabled' });
    await menu.getByRole('menuitem', { name: /Copy/ }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.clipboard)).toBe('https://api.kurlo.test/orders');

    const key = page.locator('.kv-table input.kv-desc').first();
    await key.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: /Paste/ }).click();
    await expect(key).toHaveValue('https://api.kurlo.test/orders');
    await expect(key).toBeFocused();

    await url.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: /Select all/ }).click();
    await url.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: /Cut/ }).click();
    await expect(url).toHaveText('');
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.clipboard)).toBe('https://api.kurlo.test/orders');

    await url.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: /Paste/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await page.locator('.request-meta, .request-title').first().click({ button: 'right' });
    await expect(menu).toBeHidden();
  });

  test('edits the code editor through the right-click menu', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Editor API');
    await collectionRow(page, 'Editor API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Editor API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestSection(page, 'Body');
    await page.locator('label.body-mode-label').filter({ hasText: 'raw' }).click();
    await fillCodeEditor(page, 'request-body-editor', '{"a":1}');

    const editor = page.getByTestId('request-body-editor').locator('.cm-content');
    const menu = page.getByRole('menu', { name: 'Edit' });
    await editor.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: /Select all/ }).click();
    await expect(menu).toBeHidden();

    await editor.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: /Copy/ }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.clipboard)).toBe('{"a":1}');
  });

  test('shows a saved request and its collection in the file manager', async ({ page }, testInfo) => {
    await installKurloBridge(page, '', 'darwin/e2e');
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('List orders');
    await page.getByLabel('Request name').press('Enter');
    await page.getByLabel('Request URL').fill('https://api.kurlo.test/orders');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await page.evaluate(() => { window.__kurloE2E.calls.length = 0; });
    await page.locator('.collection-request').filter({ hasText: 'List orders' }).click({ button: 'right' });
    await page.screenshot({ path: join(tmpdir(), `kurlo-reveal-menu-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.locator('.request-menu').getByRole('button', { name: 'Show in Finder' }).click();
    await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Show in Finder' }).click();
    const calls = await page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('reveal:')));
    expect(calls.map(call => call.split(':').slice(0, 2).join(':'))).toEqual(['reveal:request', 'reveal:collection']);
    expect(calls.every(call => call.split(':')[2])).toBe(true);
  });
});

test.describe('External workspace changes', () => {
  test('keep the open request on the tab the user is looking at', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-ext', workspaceId: 'workspace-e2e', name: 'Orders', filesystemName: 'Orders' }];
      store.requests = [{ id: 'req-ext', name: 'Create order', collectionId: 'collection-ext', collection: 'Orders', folderPath: [], requestType: 'http', method: 'POST', url: 'https://api.example.test/orders', testScriptJs: 'pm.test("first", () => {})' }];
      store.activeId = 'req-ext';
      store.openIds = ['req-ext'];
    });
    await page.goto('/');
    await chooseRequestSection(page, 'Scripts');
    await page.getByRole('tab', { name: /^Tests/ }).click();
    await expect(page.getByTestId('test-script-editor')).toContainText('first');
    await page.evaluate(() => {
      const store = window.__kurloE2E.store as { requests: Array<Record<string, unknown>> };
      store.requests[0].testScriptJs = 'pm.test("added by an agent", () => {})';
      window.__kurloE2E.emit('kurlo:workspace-changed', 'Create-order.yml changed');
    });
    await expect(page.getByTestId('test-script-editor')).toContainText('added by an agent');
    await expect(page.locator('.request-editor-tabs-shell').getByRole('tab', { name: 'Scripts' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /^Tests/ })).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Agent workspace changes', () => {
  test('load quietly and keep an unsaved draft', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const store = window.__kurloE2E.store as Record<string, unknown>;
      store.collections = [{ id: 'collection-ext', workspaceId: 'workspace-e2e', name: 'Orders', filesystemName: 'Orders' }];
      store.requests = [{ id: 'req-ext', name: 'Create order', collectionId: 'collection-ext', collection: 'Orders', folderPath: [], requestType: 'http', method: 'POST', url: 'https://api.example.test/orders' }];
      store.activeId = 'req-ext';
      store.openIds = ['req-ext'];
    });
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill('https://api.example.test/draft-in-progress');
    await page.evaluate(() => {
      const e2e = window.__kurloE2E as unknown as { store: { requests: Array<Record<string, unknown>> }; emit: (name: string, payload: unknown) => void };
      const added = { id: 'req-agent', name: 'Added by agent', collectionId: 'collection-ext', collection: 'Orders', folderPath: [], requestType: 'http', method: 'GET', url: 'https://api.example.test/agent' };
      e2e.store.requests.push(added);
      const app = (window as E2EWindow).go.api.App;
      const save = app.SaveRequestStoreWithError;
      app.SaveRequestStoreWithError = async (payload: string) => {
        const result = await save(payload);
        if (!e2e.store.requests.some(request => request.id === added.id)) e2e.store.requests.push(added);
        return result;
      };
      e2e.emit('kurlo:workspace-changed', 'changed by the Kurlo agent');
    });
    await expect(page.locator('.sidebar')).toContainText('Added by agent');
    await expect(page.getByLabel('Request URL')).toHaveValue('https://api.example.test/draft-in-progress');
    await expect(page.getByText(/Workspace refreshed|is paused/)).toHaveCount(0);
    await expect(page.locator('.saved-request-tab-btn')).toHaveCount(3);
    await expect(page.getByRole('tab', { name: /Create order/ })).toBeVisible();
  });

  test('still report a change made by another program', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.evaluate(() => window.__kurloE2E.emit('kurlo:workspace-changed', 'files changed outside Kurlo'));
    await expect(page.getByText('Workspace refreshed (files changed outside Kurlo).')).toBeVisible();
  });
});

test.describe('Real workspace round trip', () => {
  const input = process.env.KURLO_ROUNDTRIP_IN ?? '';
  const output = process.env.KURLO_ROUNDTRIP_OUT ?? '';
  test.skip(!input || !output, 'driven by the Go Git flow test');

  test('real workspace round trip', async ({ page }) => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const body = await readFile(input, 'utf8');
    await page.route('**/__roundtrip/store.json', route => route.fulfill({ body, contentType: 'application/json' }));
    await installKurloBridge(page);
    await page.addInitScript(() => {
      (window.__kurloE2E as Record<string, unknown>).perfStoreUrl = '/__roundtrip/store.json';
    });
    await page.goto('/');
    const toggle = page.getByRole('button', { name: /^(Collapse|Expand) collection$/ }).first();
    await expect(toggle).toBeVisible();
    const before = await page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length);
    await toggle.click();
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length)).toBeGreaterThan(before);
    const afterFirst = await page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length);
    await page.getByRole('button', { name: /^(Collapse|Expand) collection$/ }).first().click();
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E.savedStores as unknown[]).length)).toBeGreaterThan(afterFirst);
    const saved = await page.evaluate(() => {
      const stores = window.__kurloE2E.savedStores as unknown[];
      return JSON.stringify(stores[stores.length - 1]);
    });
    await writeFile(output, saved);
  });
});

test('undoes a deletion and restores items from Recently deleted', async ({ page }, testInfo) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.getByLabel('New collection').click();
  await fillPrompt(page, 'New collection', 'Billing API');
  for (const url of ['https://api.example.test/invoices', 'https://api.example.test/refunds']) {
    await collectionRow(page, 'Billing API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Billing API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request URL').fill(url);
    await page.keyboard.press('Control+s');
  }
  const storedNames = () => page.evaluate(() => ((window as any).__kurloE2E.store.requests ?? []).map((request: { url: string }) => request.url));
  await expect.poll(storedNames).toEqual(expect.arrayContaining(['https://api.example.test/invoices', 'https://api.example.test/refunds']));

  await collectionRow(page, 'Billing API').getByLabel('Collection menu').click();
  await collectionRow(page, 'Billing API').locator('.collection-menu').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Delete|OK|Confirm/ }).click();
  const toast = page.locator('.undo-toast');
  await expect(toast).toContainText('Deleted collection “Billing API”');
  await page.screenshot({ path: join(tmpdir(), `kurlo-undo-toast-${testInfo.project.name}.png`), animations: 'disabled' });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(collectionRow(page, 'Billing API')).toBeVisible();
  await expect.poll(storedNames).toEqual(expect.arrayContaining(['https://api.example.test/invoices', 'https://api.example.test/refunds']));

  await collectionRow(page, 'Billing API').getByLabel('Collection menu').click();
  await collectionRow(page, 'Billing API').locator('.collection-menu').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Delete|OK|Confirm/ }).click();
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await expect(toast).toHaveCount(0);
  await expect.poll(storedNames).toEqual([]);
  await page.getByRole('button', { name: 'Recently deleted', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Recently deleted' });
  await expect(menu).toContainText('Billing API');
  await page.screenshot({ path: join(tmpdir(), `kurlo-recently-deleted-${testInfo.project.name}.png`), animations: 'disabled' });
  if (testInfo.project.name === 'chromium') await captureDocsScreenshot(page, 'recently-deleted');
  await menu.getByRole('menuitem', { name: 'Restore collection Billing API' }).click();
  await expect(collectionRow(page, 'Billing API')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recently deleted', exact: true })).toHaveCount(0);
  await expect.poll(storedNames).toEqual(expect.arrayContaining(['https://api.example.test/invoices', 'https://api.example.test/refunds']));
});

for (const scale of [1, 1.5]) {
  test(`lists twenty deletions in Recently deleted and scrolls them at ${scale}`, async ({ page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem('kurlo.uiScale.v1', String(value)), scale);
    await page.setViewportSize({ width: 1100, height: 720 });
    const requests = Array.from({ length: 22 }, (_, index) => {
      const number = String(index + 1).padStart(2, '0');
      return { id: `bulk-${number}`, collectionId: 'col-bulk', collection: 'Bulk', name: `Request ${number} with a rather long name to check truncation`, requestType: 'http', method: 'GET', url: `https://api.example.test/${number}`, auth: { type: 'none' } };
    });
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'col-bulk', workspaceId: 'workspace-e2e', name: 'Bulk' }],
      requests,
      activeId: '',
      openIds: [],
    });
    await page.goto('/');
    for (const request of requests) {
      const row = page.locator('.collection-request-wrap').filter({ hasText: request.name.slice(0, 10) }).first();
      await row.hover();
      await row.getByLabel('Request menu').click();
      await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
      await page.getByRole('dialog').getByRole('button', { name: /Delete|OK|Confirm/ }).click();
      await expect(page.locator('.collection-request-wrap').filter({ hasText: request.name.slice(0, 10) })).toHaveCount(0);
    }

    await page.locator('.undo-toast').getByRole('button', { name: 'Dismiss' }).click();
    await page.getByRole('button', { name: 'Recently deleted', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'Recently deleted' });
    const list = page.getByTestId('recently-deleted-list');
    await expect(menu).toContainText('20 of 20');
    await expect(list.getByRole('menuitem')).toHaveCount(20);
    await expect(list.getByRole('menuitem').first()).toHaveAccessibleName(/Request 22/);
    const geometry = await list.evaluate(node => {
      const box = node.closest('[role="menu"]')!.getBoundingClientRect();
      return { scrolls: node.scrollHeight > node.clientHeight, sideways: node.scrollWidth > node.clientWidth, fits: box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth };
    });
    expect(geometry).toEqual({ scrolls: true, sideways: false, fits: true });
    expect(await list.evaluate(node => getComputedStyle(node).overscrollBehaviorY)).toBe('none');
    await page.screenshot({ path: join(tmpdir(), `kurlo-recently-deleted-20-${scale}-${testInfo.project.name}.png`), animations: 'disabled' });

    await list.hover();
    for (let step = 0; step < 4; step += 1) await page.mouse.wheel(0, 30000);
    await expect.poll(() => list.evaluate(node => Math.ceil(node.scrollTop + node.clientHeight) >= node.scrollHeight)).toBe(true);
    const oldest = list.getByRole('menuitem', { name: /Restore request Request 03/ });
    await expect(oldest).toBeInViewport();
    await expect(menu.getByRole('menuitem', { name: 'Clear list' })).toBeInViewport();
    await oldest.click();
    await expect(page.locator('.collection-request-wrap').filter({ hasText: 'Request 03' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Recently deleted', exact: true }).click();
    await expect(list.getByRole('menuitem')).toHaveCount(19);
    await menu.getByRole('menuitem', { name: 'Clear list' }).click();
    await expect(page.getByRole('button', { name: 'Recently deleted', exact: true })).toHaveCount(0);
  });
}

test('reorders requests by dragging above and below siblings and restores the saved order', async ({ page, browserName }) => {
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [
      { id: 'reorder-api', workspaceId: 'workspace-e2e', name: 'API', filesystemName: 'API' },
      { id: 'other-api', workspaceId: 'workspace-e2e', name: 'Other', filesystemName: 'Other' },
    ],
    folderCollapsed: {},
    requests: [
      ...['Alpha', 'Bravo', 'Charlie'].map(name => ({ id: name, name, collectionId: 'reorder-api', folderPath: [], method: 'GET', url: `https://example.test/${name}` })),
      ...['Nested one', 'Nested two'].map(name => ({ id: name, name, collectionId: 'reorder-api', folderPath: ['Users'], method: 'GET', url: `https://example.test/${name}` })),
      { id: 'outside', name: 'Outside', collectionId: 'other-api', folderPath: [], method: 'GET', url: 'https://example.test/outside' },
    ],
  });
  await page.goto('/');
  const list = page.locator('.collection-list');
  const row = (name: string) => list.locator('.collection-request-wrap').filter({ has: page.locator('.collection-title', { hasText: new RegExp(`^${name}$`) }) });
  const titles = () => list.locator('.collection-title').allTextContents();
  await expect(row('Alpha')).toBeVisible();
  await row('Charlie').hover();
  await row('Charlie').locator('.request-drag-handle').dragTo(row('Alpha'), { targetPosition: { x: 80, y: 3 } });
  await expect.poll(titles).toEqual(['Nested one', 'Nested two', 'Charlie', 'Alpha', 'Bravo', 'Outside']);
  await row('Charlie').dragTo(row('Bravo'), { targetPosition: { x: 80, y: 24 } });
  await expect.poll(titles).toEqual(['Nested one', 'Nested two', 'Alpha', 'Bravo', 'Charlie', 'Outside']);
  await row('Nested two').dragTo(row('Nested one'), { targetPosition: { x: 80, y: 3 } });
  await expect.poll(titles).toEqual(['Nested two', 'Nested one', 'Alpha', 'Bravo', 'Charlie', 'Outside']);
  await row('Alpha').dragTo(row('Outside'), { targetPosition: { x: 80, y: 3 } });
  await row('Alpha').dragTo(row('Nested two'), { targetPosition: { x: 80, y: 3 } });
  await expect.poll(titles).toEqual(['Nested two', 'Nested one', 'Alpha', 'Bravo', 'Charlie', 'Outside']);
  await page.getByRole('textbox', { name: 'Filter requests' }).fill('Alpha');
  await expect(row('Alpha')).toHaveAttribute('draggable', 'false');
  await page.getByRole('textbox', { name: 'Filter requests' }).fill('');
  await expect(row('Alpha')).toHaveAttribute('draggable', 'true');
  await expect.poll(() => page.evaluate(() => {
    const requests = window.__kurloE2E.store.requests as Array<{ id: string }>;
    return requests.map(request => request.id);
  })).toEqual(['Alpha', 'Bravo', 'Charlie', 'Nested two', 'Nested one', 'outside']);
  const saved = await page.evaluate(() => window.__kurloE2E.store);
  await page.addInitScript(store => { window.__kurloE2E.store = store; }, saved);
  await page.reload();
  await expect.poll(titles).toEqual(['Nested two', 'Nested one', 'Alpha', 'Bravo', 'Charlie', 'Outside']);
  await row('Alpha').hover();
  await page.screenshot({ path: join(tmpdir(), 'kurlo-request-reorder.png'), animations: 'disabled' });
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row('Charlie').dispatchEvent('dragstart', { dataTransfer: transfer });
  const target = await row('Alpha').boundingBox();
  expect(target).not.toBeNull();
  await row('Alpha').dispatchEvent('dragover', { dataTransfer: transfer, clientY: target!.y + 3 });
  await expect(row('Alpha').locator('.request-drop-line.before')).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), 'kurlo-request-reorder-drop.png'), animations: 'disabled' });
  await row('Charlie').dispatchEvent('dragend');
  await expect(list.locator('.request-drop-line')).toHaveCount(0);
  await expect(list.locator('.collection-request-wrap.active')).toHaveCount(1);
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    for (const name of ['Bravo', 'Charlie', 'Nested one']) {
      await row(name).evaluate((element, value) => element.setAttribute('data-sticky-hover', value), name);
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-sticky-hover="${name}"]` });
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    }
    await page.mouse.move(800, 400);
    for (const name of ['Bravo', 'Charlie', 'Nested one']) {
      await expect(row(name).locator('.request-drag-handle')).toHaveCSS('opacity', '0');
      await expect(row(name).locator('.request-menu-btn')).toHaveCSS('opacity', '0');
      await expect(row(name).locator('.collection-request')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
    await row('Bravo').hover();
    await expect(row('Bravo').locator('.request-drag-handle')).toHaveCSS('opacity', '1');
    await row('Charlie').hover();
    await expect(row('Bravo').locator('.request-drag-handle')).toHaveCSS('opacity', '0');
    await expect(row('Charlie').locator('.request-drag-handle')).toHaveCSS('opacity', '1');
    await expect(row('Nested one').locator('.request-menu-btn')).toHaveCSS('opacity', '0');
    const collectionHeader = (name: string) => list.locator('.collection-folder').filter({ has: page.locator('.collection-name', { hasText: new RegExp(`^${name}$`) }) });
    const folderHeader = list.locator('.collection-subfolder').filter({ hasText: 'Users' });
    for (const [key, locator] of [['API', collectionHeader('API')], ['Other', collectionHeader('Other')], ['Users', folderHeader]] as const) {
      await locator.evaluate((element, value) => element.setAttribute('data-sticky-hover', value), `group-${key}`);
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-sticky-hover="group-${key}"]` });
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    }
    await page.mouse.move(800, 400);
    for (const locator of [collectionHeader('API'), collectionHeader('Other'), folderHeader]) {
      await expect(locator).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
    await expect(collectionHeader('Other').locator('.collection-menu-btn')).toHaveCSS('opacity', '0');
    await expect(folderHeader.locator('.folder-menu-btn')).toHaveCSS('opacity', '0');
    await collectionHeader('Other').hover();
    await expect(collectionHeader('Other').locator('.collection-menu-btn')).toHaveCSS('opacity', '1');
    await folderHeader.hover();
    await expect(collectionHeader('Other').locator('.collection-menu-btn')).toHaveCSS('opacity', '0');
    await expect(folderHeader.locator('.folder-menu-btn')).toHaveCSS('opacity', '1');
    await expect(list.locator('.hovered')).toHaveCount(1);
    await page.screenshot({ path: join(tmpdir(), 'kurlo-request-hover-after-drag.png'), animations: 'disabled' });
    await cdp.detach();
  }
});
