import { expect, test } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentStore, connection, installAgentBridge } from './support/agent';
import { installKurloBridge, type E2EWindow } from './support/bridge';
import { chooseRequestSection, collectionRow } from './support/actions';

for (const kind of ['http', 'graphql', 'ws', 'socketio', 'grpc', 'mcp', 'ai', 'collection']) {
  test(`audits editor scrolling and height for ${kind}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await installKurloBridge(page, '', 'browser/e2e', false, {
      collections: [{ id: 'audit-col', workspaceId: 'workspace-e2e', name: 'Editors' }],
      activeId: 'audit', openIds: ['audit'],
      requests: [{ id: 'audit', name: 'Editor audit', collectionId: 'audit-col', collection: 'Editors',
        requestType: kind === 'collection' ? 'http' : kind, method: 'POST', url: 'https://example.test',
        bodyType: 'json', bodyContent: '{}', graphqlSchema: 'type Query { viewer: String }',
        mcpMethod: 'tools/call', mcpArguments: '{}', auth: { type: 'none' } }],
    });
    await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'below'));
    await page.goto('/');
    if (kind === 'collection') {
      await collectionRow(page, 'Editors').getByLabel('Collection menu').click();
      await collectionRow(page, 'Editors').locator('.collection-menu').getByRole('button', { name: 'Settings', exact: true }).click();
      await page.locator('.collection-tabs').getByRole('tab', { name: /^Script/ }).click();
    } else {
      await chooseRequestSection(page, kind === 'graphql' ? 'Query' : kind === 'mcp' ? 'Arguments' : kind === 'ai' ? 'Prompt' : kind === 'http' ? 'Body' : 'Message');
      const divider = page.getByRole('button', { name: 'Resize panels', exact: true });
      const box = await divider.boundingBox();
      if (!box) throw new Error('Missing divider');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, 1100, { steps: 6 });
      await page.mouse.up();
    }
    const editors = page.locator(kind === 'collection' ? '.collection-script-section .cm-wrap' : '.tab-content .cm-wrap');
    await expect(editors.first()).toBeVisible();
    for (const editor of await editors.all()) {
      if (kind === 'graphql') {
        const id = await editor.getAttribute('data-testid');
        await page.getByRole('button', { name: id === 'graphql-query-editor' ? 'Query editor' : 'Variables', exact: true }).click();
      }
      const content = editor.locator('.cm-content');
      if (await content.getAttribute('contenteditable') === 'false') continue;
      await content.fill(Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'));
      const scroller = editor.locator('.cm-scroller');
      await scroller.evaluate(node => { node.scrollTop = 0; });
      await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(0);
      const box = await scroller.boundingBox();
      if (!box) throw new Error('Missing scroller');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 10);
      await page.mouse.wheel(0, 450);
      await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
    }
    const geometry = await editors.last().evaluate(node => {
      const panel = node.closest('.tab-content, .collection-workspace')!;
      return { editorBottom: node.getBoundingClientRect().bottom, panelBottom: panel.getBoundingClientRect().bottom };
    });
    await page.screenshot({ path: join(tmpdir(), `kurlo-editor-audit-${kind}.png`), animations: 'disabled' });
    expect(geometry.panelBottom - geometry.editorBottom).toBeLessThan(50);
  });
}


for (const kind of ['yaml', 'notes']) {
  test(`keeps long ${kind} files inside the modal scroller`, async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(({ kind }) => {
      const app = (window as E2EWindow).go.api.App as unknown as Record<string, unknown>;
      if (kind === 'yaml') {
        app.LoadWorkspaceDiagnostics = async () => [{ scope: 'workspace', severity: 'error', blocking: true,
          workspaceId: window.__kurloE2E.store.activeWorkspaceId, path: 'workspace.yml', line: 1, message: 'Invalid YAML' }];
        app.ReadWorkspaceYAMLFile = async () => ({ ok: true, path: 'workspace.yml', content: 'name: Example' });
      } else {
        app.AgentWorkspaceNotes = async () => ({ path: '/e2e/kurlo-agent.md', exists: false, content: '', templates: [] });
      }
    }, { kind });
    await page.goto('/');
    if (kind === 'yaml') {
      await page.locator('.overview-blocked').getByRole('button', { name: 'Edit YAML', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Agent', exact: true }).click();
      await page.locator('.agent-workspace').getByRole('button', { name: 'Templates', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Create kurlo-agent.md…' }).click();
    }
    const editor = page.getByTestId(kind === 'yaml' ? 'yaml-editor' : 'agent-notes-editor');
    await editor.locator('.cm-content').fill(Array.from({ length: 100 }, (_, i) => `item${i}: value`).join('\n'));
    const scroller = editor.locator('.cm-scroller');
    await scroller.evaluate(node => { node.scrollTop = 0; });
    await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(0);
    const box = await scroller.boundingBox();
    if (!box) throw new Error('Missing modal scroller');
    const bottom = await page.locator('.yaml-editor-body').evaluate(node => node.getBoundingClientRect().bottom);
    expect(Math.abs(box.y + box.height - bottom)).toBeLessThan(3);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 10);
    await page.mouse.wheel(0, 450);
    await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
    await page.screenshot({ path: join(tmpdir(), `kurlo-editor-audit-${kind}.png`), animations: 'disabled' });
  });
}

test('dims commented lines of a long body, including a block opened above the screen', async ({ page }) => {
  const lines = ['{', '  // first note'];
  for (let index = 0; index < 3000; index += 1) lines.push(`  "key${index}": ${index},`);
  lines.push('  /* tail block', '   still inside', '   end */', '  "last": true', '}');
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'long-col', workspaceId: 'workspace-e2e', name: 'Long' }],
    activeId: 'long', openIds: ['long'],
    requests: [{ id: 'long', name: 'Long body', collectionId: 'long-col', collection: 'Long', requestType: 'http', method: 'POST',
      url: 'https://example.test', bodyType: 'json', bodyContent: lines.join('\n'), auth: { type: 'none' } }],
  });
  await page.goto('/');
  await chooseRequestSection(page, 'Body');
  const editor = page.getByTestId('request-body-editor');
  const commented = editor.locator('.cm-line.cm-kurlo-commented-line');
  await expect(commented.filter({ hasText: 'first note' })).toHaveCount(1);
  await expect(editor.locator('.cm-line', { hasText: '"key5": 5,' })).not.toHaveClass(/cm-kurlo-commented-line/);

  await editor.locator('.cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await expect(commented.filter({ hasText: 'still inside' })).toHaveCount(1);
  await expect(commented.filter({ hasText: 'end */' })).toHaveCount(1);
  await expect(editor.locator('.cm-line', { hasText: '"last": true' })).not.toHaveClass(/cm-kurlo-commented-line/);
  await expect(editor.locator('.cm-line', { hasText: '"key2999": 2999,' })).not.toHaveClass(/cm-kurlo-commented-line/);
  await expect(commented.filter({ hasText: 'first note' })).toHaveCount(0);
});

test('uses the same code font for the HTTP request and response bodies', async ({ page }, testInfo) => {
  await installKurloBridge(page, '{"message":"Hello"}', 'windows/e2e', false, {
    collections: [{ id: 'fonts', workspaceId: 'workspace-e2e', name: 'Fonts' }],
    activeId: 'echo', openIds: ['echo'],
    requests: [{ id: 'echo', name: 'Echo', collectionId: 'fonts', collection: 'Fonts', requestType: 'http', method: 'POST',
      url: 'https://example.test/large-response', bodyType: 'json', bodyContent: '{"message":"Hello"}', auth: { type: 'none' } }],
  });
  await page.goto('/');
  await chooseRequestSection(page, 'Body');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const requestLine = page.getByTestId('request-body-editor').locator('.cm-line').first();
  const responseLine = page.getByRole('textbox', { name: 'Response body', exact: true }).locator('.response-line-code').first();
  await expect(responseLine).toBeVisible();
  for (const property of ['font-family', 'font-size']) {
    const expected = await requestLine.evaluate((node, prop) => getComputedStyle(node).getPropertyValue(prop), property);
    await expect(responseLine).toHaveCSS(property, expected);
  }
  await page.screenshot({ path: join(tmpdir(), `kurlo-http-body-fonts-${testInfo.project.name}.png`), animations: 'disabled' });
});
