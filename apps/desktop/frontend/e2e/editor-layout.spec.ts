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
