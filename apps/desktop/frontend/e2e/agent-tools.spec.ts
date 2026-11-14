import type { E2EWindow } from './support/bridge';
import { fillCodeEditor } from './support/actions';

import { agentStore, connection, installAgentBridge } from './support/agent';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Agent", () => {
  test('sends approval mode, trusted hosts and budgets and shows a plan for approval', async ({ page }, testInfo) => {
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(() => {
      localStorage.setItem('kurlo.agentDetails.v1', '1');
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const e2e = window.__kurloE2E as unknown as Record<string, unknown> & { emit: (name: string, payload: unknown) => void };
      const sent: unknown[] = [];
      e2e.planSent = sent;
      app.SendAgentMessage = async (input: Record<string, unknown>) => {
        sent.push(structuredClone(input));
        const sessionId = 'chat-plan';
        const plan = { summary: 'Cover the orders endpoint.', steps: ['Save a request for POST /orders', 'Add a status test', 'Save the example'], calls: [{ tool: 'save_request', target: 'Shop API/Orders/Create order' }, { tool: 'send_request', target: 'http://localhost:8080/orders' }] };
        await new Promise<void>(resolve => {
          e2e.planRelease = resolve;
          e2e.emit('agent:approval', { id: 'plan-1', chatId: sessionId, turnId: input.turnId, toolUseId: 'call_plan', tool: 'propose_plan', kind: 'write', arguments: JSON.stringify(plan), reason: plan.summary, changes: [], plan });
        });
        const chat = { id: sessionId, workspaceId: input.workspaceId, title: 'Plan', createdAt: Date.now(), updatedAt: Date.now(), collection: '', environment: '', connectionId: 'c1', model: '', messages: [{ role: 'user', blocks: [{ type: 'text', text: input.text }] }, { role: 'assistant', blocks: [{ type: 'text', text: 'Planned.' }] }], usage: { input: 1200, output: 80, cacheRead: 300, cacheWrite: 0, reasoning: 0, cost: 0.0123 }, allowedTools: [], mode: input.mode, allowedHosts: input.allowedHosts, budgetTokens: input.budgetTokens, budgetRequests: input.budgetRequests, requestsSent: 2, contextTokens: 3000, contextWindow: 200000 };
        return { chat, messages: chat.messages, steps: [], text: 'Planned.', usage: chat.usage, hasUsage: true, warnings: [] };
      };
      app.AnswerAgentApproval = async (id: string, decision: string) => {
        e2e.planAnswer = { id, decision };
        e2e.emit('agent:approval-closed', { id, chatId: 'chat-plan', decision });
        (e2e.planRelease as () => void)?.();
        return { ok: true };
      };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const details = page.getByRole('complementary', { name: 'Chat details', exact: true });
    if (!(await details.isVisible())) await page.getByRole('button', { name: 'Toggle chat details' }).click();
    await page.locator('.agent-composer').getByRole('button', { name: /^Approvals:/ }).click();
    await page.getByRole('option', { name: 'Auto', exact: true }).click();
    const permissions = details.getByRole('region', { name: 'Permissions' });
    await expect(permissions.getByRole('button', { name: /Permissions/ })).toContainText('Auto · 2 hosts');
    await permissions.getByRole('button', { name: /Permissions/ }).click();
    await expect(permissions).toContainText('Requests and workspace changes run on their own');
    const hosts = details.getByRole('textbox', { name: 'Trusted hosts' });
    await expect(hosts).toHaveValue('localhost, 127.0.0.1');
    await hosts.fill('localhost, *.staging.example.com');
    await hosts.press('Tab');
    await details.getByRole('region', { name: 'Budget' }).getByRole('button', { name: /Budget/ }).click();
    const tokenBudget = details.getByRole('textbox', { name: 'Token budget' });
    await tokenBudget.fill('3.213123131231231231');
    await tokenBudget.press('Tab');
    await expect(tokenBudget).toHaveValue('1000000000');
    await tokenBudget.fill('200000');
    await tokenBudget.press('Tab');
    await details.getByRole('textbox', { name: 'Request budget' }).fill('25');
    await details.getByRole('textbox', { name: 'Request budget' }).press('Tab');
    await expect(details.getByRole('region', { name: 'Budget' }).getByRole('button', { name: /Budget/ })).toContainText('/ 200k');
    const composer = page.getByRole('textbox', { name: 'Message the agent' });
    await composer.fill('Cover POST /orders');
    await composer.press('Enter');
    const card = page.locator('.agent-approval');
    await expect(card).toContainText('Follow this plan?');
    await expect(page.locator('.agent-user-row.editing')).toHaveCount(0);
    await expect(card.locator('.agent-plan-steps li')).toHaveCount(3);
    await expect(card).toContainText('Shop API/Orders/Create order');
    await expect(card.getByRole('button', { name: 'Allow for this chat' })).toHaveCount(0);
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-plan-${testInfo.project.name}.png`), animations: 'disabled' });
    await card.getByRole('button', { name: 'Approve plan' }).click();
    await expect(page.getByText('Planned.')).toBeVisible();
    const input = await page.evaluate(() => ((window.__kurloE2E as unknown as { planSent: Array<Record<string, unknown>> }).planSent)[0]);
    expect(input.mode).toBe('auto');
    expect(input.allowedHosts).toEqual(['localhost', '*.staging.example.com']);
    expect(input.budgetTokens).toBe(200000);
    expect(input.budgetRequests).toBe(25);
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { planAnswer: unknown }).planAnswer)).toEqual({ id: 'plan-1', decision: 'allow' });
    await expect(details).toContainText('2 requests');
    await expect(details).toContainText('$0.01');
    await expect(details.getByText('Context (last request)')).toBeVisible();
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-permissions-${testInfo.project.name}.png`), animations: 'disabled' });
  });

  test('adds an MCP server for the agent in Settings', async ({ page }, testInfo) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      localStorage.removeItem('kurlo.disclosure.settings-ai-agents');
      localStorage.removeItem('kurlo.disclosure.settings-ai-kurlo');
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
      let servers: Array<Record<string, unknown>> = [];
      app.AiConnections = async () => ({ connections: [] });
      app.AgentMcpServers = async () => ({ servers });
      app.TestAgentMcpServer = async (server: Record<string, unknown>) => {
        e2e.mcpTested = structuredClone(server);
        return { ok: true, tools: [{ name: 'create_issue' }, { name: 'list_issues' }] };
      };
      app.SaveAgentMcpServer = async (server: Record<string, unknown>) => {
        e2e.mcpSaved = structuredClone(server);
        const saved = { ...server, id: 'mcp-1', headers: (server.headers as Array<{ key: string }>).map(pair => ({ key: pair.key, set: true })), env: [] };
        servers = [saved];
        return { servers };
      };
    });
    await page.goto('/');
    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const section = page.getByRole('region', { name: 'MCP servers for the agent' });
    await expect(section.getByRole('button', { name: /MCP servers for the agent/ })).toContainText('None');
    await expect(page.getByRole('region', { name: 'Your agents' }).getByRole('button', { name: /Your agents/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('region', { name: 'Kurlo agent' }).getByRole('button', { name: /Kurlo agent/ })).toContainText('No connections');
    await page.getByRole('region', { name: 'Your agents' }).getByRole('button', { name: /Your agents/ }).click();
    await expect(page.getByRole('region', { name: 'Codex connection' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Your agents' }).getByRole('button', { name: /Your agents/ })).toHaveAttribute('aria-expanded', 'false');
    await section.getByRole('button', { name: /MCP servers for the agent/ }).click();
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-mcp-list-${testInfo.project.name}.png`), animations: 'disabled' });
    await section.getByRole('button', { name: 'Add MCP server' }).click();
    await section.getByRole('textbox', { name: 'Name' }).fill('GitHub');
    await section.getByRole('textbox', { name: 'URL' }).fill('https://api.githubcopilot.com/mcp/');
    await section.getByRole('textbox', { name: 'Headers' }).fill('Authorization: Bearer ghp_test');
    await section.getByRole('button', { name: 'Test' }).click();
    await expect(section).toContainText('Connected. 2 tools available.');
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-mcp-settings-${testInfo.project.name}.png`), animations: 'disabled' });
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByRole('list', { name: 'Agent MCP servers' })).toContainText('GitHub');
    await expect(section.getByRole('button', { name: /MCP servers for the agent/ })).toContainText('GitHub');
    const saved = await page.evaluate(() => (window.__kurloE2E as unknown as { mcpSaved: Record<string, unknown> }).mcpSaved);
    expect(saved).toMatchObject({ name: 'GitHub', kind: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: [{ key: 'Authorization', value: 'Bearer ghp_test' }], enabled: true });
  });

  test('signs in to an MCP server with OAuth', async ({ page }, testInfo) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
      let servers: Array<Record<string, unknown>> = [];
      app.AiConnections = async () => ({ connections: [] });
      app.AgentMcpServers = async () => ({ servers });
      app.SaveAgentMcpServer = async (server: Record<string, unknown>) => {
        e2e.mcpSaved = structuredClone(server);
        servers = [{ ...server, id: 'mcp-oauth', headers: [], env: [], signedIn: false }];
        return { servers };
      };
      app.SignInAgentMcpServer = async (id: string) => {
        e2e.mcpSignIn = id;
        servers = servers.map(server => ({ ...server, signedIn: true }));
        return { servers };
      };
      app.SignOutAgentMcpServer = async () => {
        servers = servers.map(server => ({ ...server, signedIn: false }));
        return { servers };
      };
      app.TestAgentMcpServer = async () => ({ ok: true, tools: [{ name: 'search' }], resources: true, prompts: true });
    });
    await page.goto('/');
    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const section = page.getByRole('region', { name: 'MCP servers for the agent' });
    await section.getByRole('button', { name: /MCP servers for the agent/ }).click();
    await section.getByRole('button', { name: 'Add MCP server' }).click();
    await section.getByRole('textbox', { name: 'Name' }).fill('Linear');
    await section.getByRole('textbox', { name: 'URL' }).fill('https://mcp.linear.app/mcp');
    await section.getByRole('button', { name: /^Sign-in/ }).click();
    await page.getByRole('option', { name: 'OAuth sign-in' }).click();
    await expect(section.getByRole('textbox', { name: 'Client ID' })).toBeVisible();
    await section.getByRole('button', { name: 'Test' }).click();
    await expect(section).toContainText('Connected. 1 tool, resources, prompts available.');
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-mcp-oauth-form-${testInfo.project.name}.png`), animations: 'disabled' });
    await section.getByRole('button', { name: 'Save' }).click();
    const saved = await page.evaluate(() => (window.__kurloE2E as unknown as { mcpSaved: Record<string, unknown> }).mcpSaved);
    expect(saved).toMatchObject({ name: 'Linear', kind: 'http', auth: 'oauth', oauthClientId: '' });

    const row = section.getByRole('list', { name: 'Agent MCP servers' }).getByRole('listitem').filter({ hasText: 'Linear' });
    await expect(row).toContainText('Not signed in');
    await row.getByRole('button', { name: 'Sign in' }).click();
    await expect(row).toContainText('Signed in');
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { mcpSignIn: string }).mcpSignIn)).toBe('mcp-oauth');
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-mcp-oauth-${testInfo.project.name}.png`), animations: 'disabled' });
    await row.getByRole('button', { name: 'Sign out' }).click();
    await expect(row).toContainText('Not signed in');
  });

  test('shows agent changes as a readable summary and folds long change lists', async ({ page }) => {
    await installKurloBridge(page, '', 'darwin/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const e2e = window.__kurloE2E as unknown as { emit: (name: string, payload: unknown) => void };
      const uuid = () => crypto.randomUUID();
      const req = (name: string, extra = '') => `version: 1\nrequest:\n    auth:\n        type: inherit\n    collectionId: collection-${uuid()}\n    id: request-${uuid()}\n    method: GET\n    name: ${name}\n    url: '{{baseUrl}}/${name.toLowerCase().replace(/ /g, '-')}'\n${extra}`;
      const listOrders = req('List orders');
      const scenarios: Record<string, unknown[]> = {
        one: [{ path: 'workspaces/Main/collections/Shop-API/requests/List-orders.yml', before: listOrders, after: listOrders + '    testScriptJs: |\n        pm.test("status is 200", () => pm.response.to.have.status(200))\n', summary: { kind: 'request', name: 'List orders', location: 'Shop API / Orders', detail: 'GET {{baseUrl}}/list-orders', fields: [{ label: 'Tests', change: 'added' }, { label: 'URL', change: 'changed', before: '{{baseUrl}}/orders', after: '{{baseUrl}}/orders?limit=20' }] } }],
        created: [{ summary: { kind: 'request', name: 'Create order', location: 'Shop API', detail: 'POST {{baseUrl}}/create-order' }, path: 'workspaces/Main/collections/Shop-API/requests/Create-order.yml', before: null, after: req('Create order', '    bodyType: json\n    bodyContent: |-\n        {\n          "item": "book",\n          "qty": 1\n        }\n    headers:\n        - enabled: true\n          key: Content-Type\n          value: application/json\n    testScriptJs: |\n        pm.test("created", () => pm.response.to.have.status(201))\n') }],
        many: Array.from({ length: 9 }, (_, i) => ({ summary: { kind: 'request', name: `Endpoint ${i + 1}`, location: 'Shop API / Orders', detail: `GET {{baseUrl}}/endpoint-${i + 1}` }, path: `workspaces/Main/collections/Shop-API/requests/Endpoint-${i + 1}.yml`, before: null, after: req(`Endpoint ${i + 1}`, '    testScriptJs: |\n        pm.test("ok", () => pm.response.to.be.ok)\n') })),
      };
      app.SendAgentMessage = async (input: Record<string, string>) => {
        const kind = input.text;
        const base = { id: `approval-${kind}`, chatId: '', turnId: input.turnId, toolUseId: 'call_1' };
        if (kind === 'args') e2e.emit('agent:approval', { ...base, tool: 'send_request', kind: 'send', arguments: JSON.stringify({ method: 'POST', url: 'https://api.example.com/orders', body: '{"item":"book"}' }), reason: 'Sends POST to api.example.com, which is not a trusted host.', changes: [] });
        else if (kind === 'plan') e2e.emit('agent:approval', { ...base, tool: 'propose_plan', kind: 'plan', arguments: '{}', reason: 'Three steps to cover the orders endpoints.', changes: [], plan: { steps: ['Read the Orders folder', 'Add status tests to each request', 'Run the folder and report failures'], calls: [{ tool: 'save_request', target: 'Shop API/Orders/List orders' }, { tool: 'run_collection', target: '' }] } });
        else e2e.emit('agent:approval', { ...base, tool: kind === 'many' ? 'apply_changes' : 'save_request', kind: 'write', arguments: '{}', reason: 'Changes the workspace files.', changes: scenarios[kind] });
        await new Promise(() => {});
      };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message the agent' });
    const ask = async (kind: string) => {
      await page.getByRole('button', { name: 'New chat' }).click();
      await composer.fill(kind);
      await composer.press('Enter');
      const card = page.locator('.agent-approval').last();
      await expect(card).toBeVisible();
      return card;
    };

    const one = await ask('one');
    const row = one.getByRole('button', { name: /List orders/ });
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(row).toContainText('Shop API / Orders');
    await expect(row).toContainText('Changed');
    await expect(one).toContainText('GET {{baseUrl}}/list-orders');
    await expect(one).toContainText('Tests');
    await expect(one).toContainText('{{baseUrl}}/orders?limit=20');
    await expect(one).not.toContainText('collectionId');
    await expect(one.getByRole('table')).toHaveCount(0);
    await one.getByRole('button', { name: 'Show file changes' }).click();
    await expect(one.getByRole('table', { name: /List-orders\.yml/ })).toContainText('testScriptJs');
    await one.getByRole('button', { name: 'Hide file changes' }).click();
    await expect(one.getByRole('table')).toHaveCount(0);

    const many = await ask('many');
    await expect(many).toContainText('9 new requests');
    const rows = many.getByRole('list', { name: 'Changes' }).getByRole('button', { name: /Endpoint/ });
    await expect(rows).toHaveCount(9);
    for (const button of await rows.all()) await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(many).not.toContainText('{{baseUrl}}/endpoint-1');
    expect((await many.boundingBox())!.height).toBeLessThan(700);
    await many.getByRole('button', { name: /Endpoint 2/ }).click();
    await expect(many).toContainText('GET {{baseUrl}}/endpoint-2');
    await many.getByRole('button', { name: 'Expand all' }).click();
    for (const button of await rows.all()) await expect(button).toHaveAttribute('aria-expanded', 'true');
    expect((await many.boundingBox())!.height).toBeLessThan(700);
    await many.getByRole('button', { name: 'Collapse all' }).click();
    for (const button of await rows.all()) await expect(button).toHaveAttribute('aria-expanded', 'false');

    const args = await ask('args');
    const note = args.getByText('This turn stops after 30 minutes without a response.');
    const actions = args.locator('.agent-approval-actions');
    const gap = (await actions.boundingBox())!.y - ((await note.boundingBox())!.y + (await note.boundingBox())!.height);
    expect(gap).toBeGreaterThanOrEqual(8);
  });

  test('reviews an Agent Mode batch with one Apply button', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message the agent' });
    await composer.fill('Review batch changes');
    await composer.press('Enter');
    const approval = page.getByRole('group', { name: 'Apply these changes?' });
    await expect(approval.getByRole('button', { name: /List orders/ })).toContainText('Shop API / Orders');
    await expect(approval.getByRole('button', { name: /Globals/ })).toBeVisible();
    await expect(approval).toContainText('Variable baseUrl');
    await expect(approval.getByRole('button', { name: 'Allow for this chat' })).toHaveCount(0);
    await captureDocsScreenshot(page, 'agent-apply-changes');
    await approval.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(approval).toHaveCount(0);
  });

  test('loads older agent activity as you scroll and searches all of it', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const now = Date.now();
      const all = Array.from({ length: 250 }, (_, index) => ({ id: `${String(now - index * 3_600_000).padStart(13, '0')}-${String(index).padStart(4, '0')}`, time: now - index * 3_600_000, client: 'Kurlo agent', tool: `tool_${index}`, status: 'ok', files: [], reverted: false, workspace: '/e2e', here: true }));
      const calls: Array<Record<string, unknown>> = [];
      (window as unknown as { __activityCalls: unknown[] }).__activityCalls = calls;
      app.AgentActivity = async (filter: { limit: number; before?: string; text?: string }) => {
        calls.push(structuredClone(filter));
        const words = (filter.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const matching = all.filter(entry => (!filter.before || entry.id < filter.before) && words.every(word => entry.tool.includes(word)));
        return structuredClone({ entries: matching.slice(0, filter.limit), hasMore: matching.length > filter.limit, enabled: true, overview: { today: 1, week: 168, errors: 0, changed: 0, changes: [], problems: [] } });
      };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    const list = page.getByRole('list', { name: 'Agent activity' });
    await expect(list.locator('.agent-activity-tool').first()).toHaveText('tool_0');
    const calls = () => page.evaluate(() => (window as unknown as { __activityCalls: Array<{ before?: string }> }).__activityCalls);
    expect((await calls()).every(call => !call.before)).toBe(true);
    await expect.poll(async () => {
      await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
      return list.locator('.agent-activity-tool').last().textContent();
    }, { timeout: 15_000 }).toBe('tool_249');
    expect((await calls()).filter(call => call.before).length).toBe(2);
    expect(await list.locator('.agent-activity-row').count()).toBeLessThan(250);

    await page.getByLabel('Filter activity').fill('tool_248');
    await expect(list.locator('.agent-activity-tool')).toHaveText(['tool_248']);
  });

  test('shows agent activity, restores a file and commits on an agent branch', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(() => {
      const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
      e2e.gitStatusOverride = { isRepo: true, workspaceRoot: '/e2e', root: '/e2e', branch: 'main', head: '1a2b3c4', clean: true, files: [], remotes: ['origin'], pushRemote: 'origin' };
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const now = Date.now();
      const path = 'workspaces/Main/collections/Shop-API/requests/List-orders.yml';
      const before = "version: 1\nrequest:\n    id: req-orders\n    name: List orders\n    url: '{{baseUrl}}/orders'\n";
      const after = before + '    testScriptJs: |\n        pm.test("status is 200", () => pm.response.to.have.status(200))\n';
      const summaries = [
        { id: '0001-save', time: now - 5 * 60_000, client: 'Kurlo agent', chatId: 'chat-1', tool: 'save_request', status: 'ok', files: [path], reverted: false, workspace: '/e2e', commit: '4e1c9b2', branch: 'kurlo-agent/add-a-status-test-chat1' },
        { id: '0002-run', time: now - 8 * 60_000, client: 'Kurlo agent', chatId: 'chat-1', tool: 'run_request', status: 'ok', files: [], reverted: false, workspace: '' },
        { id: '0003-list', time: now - 40 * 60_000, client: 'Claude Code', tool: 'list_requests', status: 'ok', files: [], reverted: false, workspace: '' },
        { id: '0004-push', time: now - 2 * 60 * 60_000, client: 'Kurlo agent', chatId: 'chat-1', tool: 'git_push', status: 'declined', error: 'The user declined this call, so it did not run.', files: [], reverted: false, workspace: '' },
      ];
      const details: Record<string, Record<string, unknown>> = {
        '0001-save': { ...summaries[0], arguments: '{"collection":"Shop API","name":"List orders","testScript":"pm.test(\\"status is 200\\")"}', result: '{"id":"req-orders","path":"Shop API/Orders/List orders","created":false}\nCommitted as 4e1c9b2 on branch kurlo-agent/add-a-status-test-chat1.', changes: [{ path, before, after }] },
      };
      const reverts: unknown[] = [];
      const enabled: boolean[] = [];
      e2e.activityReverts = reverts;
      e2e.activityEnabled = enabled;
      e2e.pullRequestCalls = 0;
      const elsewhere = { id: '0005-other', time: now - 20 * 60_000, client: 'Kurlo agent', chatId: 'chat-9', tool: 'save_request', status: 'ok', files: ['workspaces/Billing-team/collections/Billing/requests/List-invoices.yml'], reverted: false, workspace: '/e2e', workspaceId: 'workspace-billing', workspaceName: 'Billing team' };
      const filters: unknown[] = [];
      e2e.activityFilters = filters;
      app.AgentActivity = async (filter: { workspaceId: string; allWorkspaces: boolean; text?: string; client?: string; overviewSince?: number; todaySince?: number }) => {
        filters.push(structuredClone(filter));
        const mine = summaries.map(entry => ({ ...entry, here: true, workspaceId: filter.workspaceId }));
        const scoped: Array<Record<string, unknown> & { time: number; status: string; files: string[] }> = filter.allWorkspaces ? [...mine, elsewhere].sort((a, b) => b.time - a.time) : mine;
        const words = (filter.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const entries = scoped.filter(entry => (!filter.client || entry.client === filter.client)
          && words.every(word => [entry.tool, entry.client, entry.status, entry.error ?? '', entry.branch ?? '', entry.commit ?? '', ...entry.files].join(' ').toLowerCase().includes(word)));
        const week = filter.overviewSince ? scoped.filter(entry => entry.time >= filter.overviewSince!) : [];
        const changed = week.filter(entry => entry.files.length && entry.status !== 'declined');
        const overview = filter.overviewSince ? {
          today: week.filter(entry => entry.time >= (filter.todaySince ?? 0)).length,
          week: week.length,
          errors: week.filter(entry => entry.status === 'error').length,
          changed: changed.length,
          changes: changed.slice(0, 5),
          problems: week.filter(entry => entry.status === 'error' || entry.status === 'declined').slice(0, 5),
        } : undefined;
        return structuredClone({ entries, enabled: enabled.at(-1) ?? true, hasMore: false, overview });
      };
      details['0005-other'] = { ...elsewhere, arguments: '{}', result: '', changes: [] };
      app.AgentActivityEntry = async (id: string) => structuredClone(details[id] ?? { ...summaries.find(entry => entry.id === id), arguments: '{}', result: '', changes: [] });
      app.RevertAgentActivity = async (id: string, file: string) => {
        reverts.push([id, file]);
        const entry = details[id];
        (entry.changes as Array<Record<string, unknown>>).forEach(change => { change.reverted = true; });
        entry.reverted = true;
        summaries.find(item => item.id === id)!.reverted = true;
        return structuredClone(entry);
      };
      app.SetAgentActivityEnabled = async (value: boolean) => { enabled.push(value); return { ok: true }; };
      app.GitPullRequestURL = async () => {
        e2e.pullRequestCalls = (e2e.pullRequestCalls as number) + 1;
        return { url: '', branch: 'main', base: 'main', error: 'The current branch is main, the branch to merge into. Create a branch for the changes first.' };
      };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();

    const branch = page.getByRole('button', { name: 'Agent branch' });
    await expect(branch).toHaveAttribute('aria-pressed', 'false');
    await branch.click();
    await expect(branch).toHaveAttribute('aria-pressed', 'true');
    const composer = page.getByRole('textbox', { name: 'Message the agent' });
    await composer.fill('Add a status test');
    await composer.press('Enter');
    await page.getByRole('group', { name: 'Change 1 file?' }).getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByText('status is 200').first()).toBeVisible();
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { agentSent: Array<{ ownBranch?: boolean }> }).agentSent[0].ownBranch)).toBe(true);

    if (!(await page.getByRole('complementary', { name: 'Chat details' }).isVisible())) await page.getByRole('button', { name: 'Toggle chat details' }).click();
    const git = page.getByRole('region', { name: 'Git' });
    await expect(git.getByRole('button', { name: /^Git/ })).toContainText('agent branch');
    await git.getByRole('button', { name: /^Git/ }).click();
    await expect(git).toContainText('Current branch');
    await expect(git).toContainText('Each change you approve is committed to the agent branch.');
    await captureDocsScreenshot(page, 'agent-git');
    await git.getByRole('button', { name: 'Open pull request' }).click();
    await expect(git.getByRole('alert')).toContainText('Create a branch for the changes first.');

    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    const list = page.getByRole('list', { name: 'Agent activity' });
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await expect(page.getByRole('heading', { name: 'Agent activity', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Recent changes' }).getByRole('button')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Errors and declined' })).toContainText('git_push');
    await page.getByRole('button', { name: /^Client:/ }).click();
    await page.getByRole('option', { name: 'Claude Code' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await page.getByRole('button', { name: /^Client:/ }).click();
    await page.getByRole('option', { name: 'All clients' }).click();
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { activityFilters: Array<{ workspaceId: string; allWorkspaces: boolean }> }).activityFilters.at(-1))).toMatchObject({ workspaceId: 'workspace-e2e', allWorkspaces: false });
    await page.getByRole('button', { name: /^Workspaces:/ }).click();
    await page.getByRole('option', { name: 'All workspaces' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(5);
    await expect(list).toContainText('Billing team · Kurlo agent · 1 file');
    await list.getByRole('button', { name: /Billing team/ }).click();
    await expect(page.getByText('The chat is in the workspace Billing team.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open chat' })).toHaveCount(0);
    await page.getByRole('button', { name: /^Workspaces:/ }).click();
    await page.getByRole('option', { name: 'This workspace' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await page.getByLabel('Filter activity').fill('push');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await list.getByRole('button', { name: /git_push/ }).click();
    await expect(page.getByText('The user declined this call, so it did not run.')).toBeVisible();
    await page.getByLabel('Filter activity').fill('');

    await list.getByRole('button', { name: /save_request/ }).click();
    await expect(page.getByText('kurlo-agent/add-a-status-test-chat1', { exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: /Changes in .*List-orders\.yml/ })).toContainText('status is 200');
    await expect(page.locator('[title]:not(iframe)')).toHaveCount(0);
    await captureDocsScreenshot(page, 'agent-activity');
    await page.getByRole('button', { name: /^Restore workspaces/ }).click();
    await expect(page.locator('.agent-activity-status')).toHaveText('Restored');
    await expect(page.getByRole('button', { name: /^Restore workspaces/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { activityReverts: unknown[] }).activityReverts)).toEqual([['0001-save', 'workspaces/Main/collections/Shop-API/requests/List-orders.yml']]);

    await page.getByRole('button', { name: 'Back to overview' }).click();
    await page.getByRole('button', { name: 'Activity options' }).click();
    await page.getByRole('menuitem', { name: 'Pause recording' }).click();
    await expect(page.getByText('Recording is off.')).toBeVisible();
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { activityEnabled: boolean[] }).activityEnabled)).toEqual([false]);

    await page.getByRole('region', { name: 'Recent changes' }).getByRole('button', { name: /List-orders/ }).click();
    await page.getByRole('button', { name: 'Open chat' }).click();
    await expect(page.getByRole('textbox', { name: 'Message the agent' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Chats', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => { ((window as E2EWindow).go!.api!.App as Record<string, unknown>).AgentActivity = async () => ({ entries: [], enabled: true }); });
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(page.getByText('No agent activity yet')).toBeVisible();
  });

  test('creates and edits kurlo-agent.md in the app and refuses to overwrite a newer copy', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(() => {
      const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const disk = { exists: false, content: '' };
      const saves: unknown[] = [];
      e2e.notesDisk = disk;
      e2e.notesSaves = saves;
      const templates = (text: string) => Array.from(text.matchAll(/^### (.+)\n(.+)$/gm)).map(match => ({ title: match[1], text: match[2] }));
      const notes = () => ({ path: '/e2e/kurlo-agent.md', exists: disk.exists, content: disk.content, templates: templates(disk.content) });
      app.AgentWorkspaceNotes = async () => notes();
      app.SaveAgentWorkspaceNotes = async (content: string, base: string, baseExists: boolean) => {
        saves.push([content, base, baseExists]);
        if (disk.exists !== baseExists || disk.content !== base) return { ok: false, conflict: true, current: disk.content, currentExists: disk.exists, error: 'kurlo-agent.md changed outside this editor since you opened it.', notes: notes() };
        disk.exists = true;
        disk.content = content.replace(/\s+$/, '') + '\n';
        return { ok: true, notes: notes() };
      };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const workspace = page.locator('.agent-workspace');

    await workspace.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('menu', { name: 'Templates' }).getByRole('menuitem', { name: 'Create kurlo-agent.md…' }).click();
    const dialog = page.getByRole('dialog', { name: 'kurlo-agent.md' });
    await expect(dialog).toContainText('There is no kurlo-agent.md in this workspace yet.');
    await expect(dialog.getByTestId('agent-notes-editor').locator('.cm-content')).toContainText('## Templates');
    await expect(dialog.getByRole('status')).toContainText('1 template');
    await expect(page.locator('[title]:not(iframe)')).toHaveCount(0);
    await dialog.getByRole('radio', { name: 'Preview' }).click();
    await expect(dialog.getByRole('radio', { name: 'Preview' })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('heading', { name: 'Notes for the agent' })).toBeVisible();
    await captureDocsScreenshot(page, 'agent-notes-editor');
    await dialog.getByRole('radio', { name: 'Edit' }).click();
    await fillCodeEditor(page, 'agent-notes-editor', '# Team notes\n\nUse the Local environment.\n\n## Templates\n\n### Check orders\nRun List orders and explain the failures.\n');
    await dialog.getByRole('button', { name: 'Create file' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Created kurlo-agent.md')).toBeVisible();

    await workspace.getByRole('button', { name: 'Templates' }).click();
    const menu = page.getByRole('menu', { name: 'Templates' });
    await expect(menu).toContainText('From kurlo-agent.md');
    await expect(menu.getByRole('menuitem', { name: /Check orders/ })).toBeVisible();
    await page.keyboard.press('Escape');

    if (!(await page.getByRole('complementary', { name: 'Chat details' }).isVisible())) await page.getByRole('button', { name: 'Toggle chat details' }).click();
    const details = page.getByRole('complementary', { name: 'Chat details' });
    const context = details.getByRole('button', { name: /^Context/ });
    if ((await context.getAttribute('aria-expanded')) !== 'true') await context.click();
    await details.getByRole('button', { name: 'kurlo-agent.md' }).click();
    await expect(dialog).not.toContainText('There is no kurlo-agent.md');
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await fillCodeEditor(page, 'agent-notes-editor', '# Team notes\n\nUse the Staging environment.\n');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('dialog', { name: 'Discard changes' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeVisible();

    await page.evaluate(() => { ((window.__kurloE2E as unknown as Record<string, unknown>).notesDisk as { content: string }).content = '# Edited in an IDE\n'; });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('changed outside this editor');
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Load newer version' }).click();
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await expect(dialog.getByTestId('agent-notes-editor').locator('.cm-content')).toHaveText('# Edited in an IDE');
    await fillCodeEditor(page, 'agent-notes-editor', '# Edited in an IDE\n\nAlso tag smoke requests.\n');
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+S`);
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => ((window.__kurloE2E as unknown as Record<string, unknown>).notesDisk as { content: string }).content)).toBe('# Edited in an IDE\n\nAlso tag smoke requests.\n');
  });

  test('runs tools, asks before writing with a diff and keeps the chat in the sidebar', async ({ page }, testInfo) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.goto('/');

    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Agent', exact: true })).toHaveAttribute('aria-selected', 'true');
    const workspace = page.locator('.agent-workspace');
    await expect(workspace).toContainText('What should we check?');
    await expect(page.locator('[title]:not(iframe)')).toHaveCount(0);
    await expect(page.locator('.agent-sidebar')).toContainText('No chats yet.');
    await expect(page.locator('.agent-sidebar').getByRole('button', { name: 'New chat' })).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Message the agent' });
    const emptyHeight = (await composer.boundingBox())!.height;
    expect(emptyHeight).toBeLessThanOrEqual(48);
    await composer.fill('First line\nSecond line\nThird line\nFourth line');
    await expect.poll(async () => (await composer.boundingBox())!.height).toBeGreaterThan(emptyHeight);
    await expect(composer).toHaveCSS('overflow-y', 'hidden');
    await composer.press('Shift+Enter');
    await expect(composer).toHaveValue('First line\nSecond line\nThird line\nFourth line\n');
    await expect(page.locator('.agent-user')).toHaveCount(0);
    await composer.fill(Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join('\n'));
    await expect(composer).toHaveCSS('overflow-y', 'auto');
    expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(192);
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-long-prompt-${testInfo.project.name}.png`), animations: 'disabled' });
    await composer.fill('A long prompt that wraps to another line. '.repeat(12));
    await expect.poll(async () => (await composer.boundingBox())!.height).toBeGreaterThan(emptyHeight);
    await expect(composer).toHaveCSS('overflow-y', 'hidden');
    await composer.fill('');
    await expect.poll(async () => (await composer.boundingBox())!.height).toBe(emptyHeight);
    const picker = workspace.getByRole('button', { name: /^Agent:/ });
    await expect(picker).toHaveAccessibleName('Agent: Kurlo agent · claude-sonnet-4-5');

    await picker.click();
    const pickerPanel = page.getByRole('dialog', { name: 'Choose agent and model' });
    const connectionRadio = pickerPanel.getByRole('radio', { name: /^Anthropic/ });
    await expect(connectionRadio).toHaveAttribute('aria-checked', 'true');
    await expect(connectionRadio).toBeFocused();
    const models = pickerPanel.getByRole('radiogroup', { name: 'Anthropic model' });
    await expect(models.getByRole('radio')).toHaveCount(2);
    await expect(models.getByRole('radio', { name: /Claude Sonnet 4\.5/ })).toHaveAttribute('aria-checked', 'true');
    const menuBox = await pickerPanel.boundingBox();
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) - 4);
    expect(menuBox!.y).toBeGreaterThanOrEqual(0);
    await pickerPanel.getByRole('searchbox', { name: 'Search Anthropic models' }).fill('opus');
    await expect(models.getByRole('radio')).toHaveCount(1);
    await models.getByRole('radio', { name: /Claude Opus 4\.1/ }).click();
    await expect(pickerPanel).toHaveCount(0);
    await expect(picker).toHaveAccessibleName('Agent: Kurlo agent · claude-opus-4-1');
    await picker.click();
    await pickerPanel.getByRole('radiogroup', { name: 'Anthropic model' }).getByRole('radio', { name: /Claude Sonnet 4\.5/ }).click();
    await expect(picker).toHaveAccessibleName('Agent: Kurlo agent · claude-sonnet-4-5');
    await picker.click();
    await pickerPanel.getByRole('radiogroup', { name: 'Anthropic model' }).getByRole('radio', { name: /Claude Opus 4\.1/ }).click();
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { aiConnectionSaves?: number }).aiConnectionSaves ?? 0)).toBe(0);

    const input = page.getByRole('textbox', { name: 'Message the agent' });
    await workspace.getByRole('button', { name: /Run and check the collection/ }).click();
    await expect(input).toHaveValue(/^Run the collection and explain every failure/);
    await expect(input).toBeFocused();

    await workspace.getByRole('button', { name: /^Collection:/ }).click();
    await page.getByRole('option', { name: 'Shop API' }).click();
    await workspace.getByRole('button', { name: /^Environment:/ }).click();
    await page.getByRole('option', { name: 'Local' }).click();

    await workspace.getByRole('button', { name: 'Templates' }).click();
    const templates = page.getByRole('menu', { name: 'Templates' });
    await expect(templates.getByRole('menuitem')).toHaveCount(6);
    await expect(templates.getByRole('menuitem').last()).toHaveText('Create kurlo-agent.md…');
    await expect(templates.getByRole('menuitem').first()).toBeFocused();
    await captureDocsScreenshot(page, 'agent-templates');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(templates).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(/Write tests for the request REQUEST NAME/);
    expect(await input.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('REQUEST NAME');
    await input.fill('Add a status test to List orders');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toHaveCSS('color', 'rgb(255, 255, 255)');
    await input.press('Enter');

    const approval = page.locator('.agent-approval');
    await expect(approval).toBeVisible();
    await expect(approval).toContainText('Change 1 file?');
    await expect(approval.getByRole('button', { name: /List orders/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(approval).toContainText('GET {{baseUrl}}/orders');
    await expect(approval).toContainText('Tests');
    await expect(page.locator('.agent-tool-waiting')).toHaveAttribute('aria-label', 'Waiting for you');
    await expect(page.locator('.agent-status-wait')).toContainText('is waiting for your approval');
    await expect(page.getByRole('button', { name: 'Stop the agent' })).toBeVisible();
    await captureDocsScreenshot(page, 'agent-approval');
    await approval.getByRole('button', { name: 'Show file changes' }).click();
    await expect(approval.locator('.agent-diff-added')).toHaveCount(2);
    await expect(approval.locator('.agent-diff-added').last()).toContainText('status is 200');
    await approval.getByRole('button', { name: 'Hide file changes' }).click();

    const sentInput = await page.evaluate(() => (window.__kurloE2E as unknown as { agentSent: Array<Record<string, string>> }).agentSent[0]);
    expect(sentInput).toMatchObject({ chatId: '', text: 'Add a status test to List orders', collection: 'Shop API', environment: 'Local', connectionId: 'c1', model: 'claude-opus-4-1' });

    await approval.getByRole('button', { name: 'Apply' }).click();
    await expect(approval).toHaveCount(0);
    await expect(page.locator('.agent-text').last()).toContainText('status is 200');
    await expect(page.locator('.agent-text').last().locator('strong')).toHaveText('status is 200');
    const answers = await page.evaluate(() => (window.__kurloE2E as unknown as { agentAnswers: unknown[] }).agentAnswers);
    expect(answers).toEqual([{ id: 'approval-1', decision: 'allow' }]);
    await expect(page.locator('.agent-tool-state').first()).toHaveAttribute('aria-label', 'Done');
    await expect(page.locator('.agent-usage')).toContainText('3,300');
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

    await expect(page.locator('.agent-header')).not.toContainText('claude-sonnet-4-5');
    const chatRow = page.locator('.agent-chat-main');
    await expect(chatRow).toHaveCount(1);
    await expect(chatRow).toContainText('Add a status test to List orders');
    await expect(page.locator('.agent-chat-group')).toHaveText('Today');
    const entry = page.locator('.agent-chat.active');
    await entry.hover();
    const chatMenu = entry.getByRole('button', { name: 'Chat menu' });
    await expect(chatMenu).toBeVisible();
    const rowBox = (await entry.boundingBox())!;
    const menuBoxInRow = (await chatMenu.boundingBox())!;
    expect(menuBoxInRow.x + menuBoxInRow.width).toBeLessThanOrEqual(rowBox.x + rowBox.width - 3);
    expect(Math.abs(menuBoxInRow.y + menuBoxInRow.height / 2 - rowBox.y - rowBox.height / 2)).toBeLessThan(1);
    await expect(entry).toHaveCSS('box-shadow', /inset/);
    await chatMenu.click();
    await expect(chatMenu).toHaveAttribute('aria-expanded', 'true');
    await composer.click();
    await expect(chatMenu).toHaveAttribute('aria-expanded', 'false');
    await entry.hover();
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-layout-${testInfo.project.name}.png`), animations: 'disabled' });
    await captureDocsScreenshot(page, 'agent-chat');

    await expect(page.locator('.agent-user')).toHaveCSS('-webkit-user-select', 'text');
    await page.locator('.agent-user-row').hover();
    await page.getByRole('button', { name: 'Copy message' }).click();
    await expect(page.locator('.agent-user-row').getByRole('button', { name: 'Copied' })).toBeVisible();
    await page.locator('.agent-turn').hover();
    await page.getByRole('button', { name: 'Copy answer' }).click();
    const copies = await page.evaluate(() => window.__kurloE2E.calls.filter(call => call.startsWith('clipboard:')));
    expect(copies).toEqual([`clipboard:${'Add a status test to List orders'.length}`, `clipboard:${'Let me look at the request first.\n\nAdded a **status is 200** test to List orders.'.length}`]);

    await chatRow.dblclick();
    const rename = page.getByRole('textbox', { name: 'Rename chat' });
    await expect(rename).toBeFocused();
    await rename.fill('Orders tests');
    await rename.press('Enter');
    await expect(chatRow).toContainText('Orders tests');
    const headerTitle = page.getByRole('textbox', { name: 'Chat name' });
    await expect(headerTitle).toHaveValue('Orders tests');
    const compactWidth = (await headerTitle.boundingBox())!.width;
    await headerTitle.fill('Что видишь в коллекции и как устроены запросы?');
    const expandedWidth = (await headerTitle.boundingBox())!.width;
    expect(expandedWidth).toBeGreaterThan(compactWidth);
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-rename-${testInfo.project.name}.png`), animations: 'disabled' });
    const longTitle = 'Что видишь в коллекции и как устроены запросы? '.repeat(2);
    await headerTitle.fill(longTitle);
    const cappedWidth = (await headerTitle.boundingBox())!.width;
    expect(cappedWidth).toBeGreaterThan(expandedWidth);
    const fullTitle = longTitle + 'Посмотри примеры.';
    await headerTitle.fill(fullTitle);
    await headerTitle.press('Backspace');
    await expect(headerTitle).toHaveValue(fullTitle.slice(0, -1));
    expect((await headerTitle.boundingBox())!.width).toBe(cappedWidth);
    await expect(page.getByRole('button', { name: 'Chat actions', exact: true })).toHaveCount(0);
    await headerTitle.fill('Orders checks');
    expect((await headerTitle.boundingBox())!.width).toBeLessThan(expandedWidth);
    await headerTitle.press('Enter');
    await expect(chatRow).toContainText('Orders checks');
    const renamed = await page.evaluate(() => (window.__kurloE2E as unknown as { agentRenames: unknown[] }).agentRenames);
    expect(renamed).toEqual([['chat-1', 'Orders tests'], ['chat-1', 'Orders checks']]);

    await page.locator('.status-search-btn').click();
    const globalSearch = page.getByRole('dialog', { name: 'Search requests, chats and commands' });
    const searchQuery = globalSearch.getByRole('combobox');
    await searchQuery.fill('Orders');
    await captureDocsScreenshot(page, 'global-search');
    await searchQuery.fill('Orders checks');
    await expect(globalSearch.locator('[data-chat-id]')).toHaveCount(1);
    const chatTitleFits = await globalSearch.locator('[data-chat-id] .gsr-name').evaluate(element => element.scrollWidth <= element.clientWidth);
    expect(chatTitleFits).toBe(true);
    await expect(globalSearch).toContainText('Chats in this workspace');
    await searchQuery.fill('> Orders checks');
    await expect(globalSearch.locator('[data-chat-id]')).toHaveCount(0);
    await searchQuery.fill('Orders checks');
    await searchQuery.press('Enter');
    await expect(globalSearch).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Chat name' })).toHaveValue('Orders checks');

    const filter = page.getByRole('textbox', { name: 'Filter chats' });
    await filter.fill('nothing like it');
    await expect(page.locator('.agent-sidebar')).toContainText('No chat matches this filter.');
    await filter.fill('checks');
    await expect(chatRow).toHaveCount(1);
    const headEdges = () => page.locator('.agent-sidebar').evaluate(panel => {
      const box = (selector: string) => panel.querySelector(selector)!.getBoundingClientRect();
      return { newChat: box('.agent-new-chat').right, searchRight: box('.sidebar-search').right, lists: box('.agent-chat-lists').right, newChatLeft: box('.agent-new-chat').left };
    });
    const newChat = page.getByRole('button', { name: 'New chat' });
    await expect(newChat.locator('.agent-new-chat-label')).toBeVisible();
    const wide = await headEdges();
    expect(wide.newChat).toBeLessThanOrEqual(wide.searchRight);
    const shellWidths = await page.locator('.shell').evaluate((shell) => {
      const style = (shell as HTMLElement).style;
      const previous = [style.getPropertyValue('--sidebar-w'), style.getPropertyValue('--sidebar-slide-w')];
      style.setProperty('--sidebar-w', '16.25rem');
      style.setProperty('--sidebar-slide-w', '16.25rem');
      return previous;
    });
    await expect(newChat.locator('.agent-new-chat-label')).toBeHidden();
    const narrow = await headEdges();
    expect(narrow.newChat).toBeLessThanOrEqual(narrow.searchRight);
    expect(narrow.lists).toBeLessThan(narrow.newChatLeft);
    await page.locator('.agent-sidebar-head').screenshot({ path: join(tmpdir(), `kurlo-agent-head-narrow-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.locator('.shell').evaluate((shell, [sidebarWidth, slideWidth]) => {
      (shell as HTMLElement).style.setProperty('--sidebar-w', sidebarWidth);
      (shell as HTMLElement).style.setProperty('--sidebar-slide-w', slideWidth);
    }, shellWidths);

    await page.locator('.agent-tool-toggle').first().click();
    await expect(page.locator('.agent-tool-body').first()).toContainText('Shop API/Orders/List orders');
    await page.getByRole('button', { name: 'Open request' }).first().click();
    await expect(page.getByRole('tab', { name: /List orders/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.agent-sidebar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Collections', exact: true })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('tab', { name: 'Agent', exact: true }).click();
    await expect(page.locator('.agent-sidebar')).toBeVisible();
    await input.fill('Thanks');
    await input.press('Enter');
    await expect(page.locator('.agent-approval')).toBeVisible();
    const second = await page.evaluate(() => (window.__kurloE2E as unknown as { agentSent: Array<Record<string, string>> }).agentSent[1]);
    expect(second).toMatchObject({ chatId: 'chat-1', text: 'Thanks' });
    await page.locator('.agent-approval').getByRole('button', { name: 'Reject' }).click();
    await expect(page.locator('.agent-user')).toHaveCount(2);
    await expect(page.locator('.agent-turn').nth(1)).toHaveCSS('border-top-width', '0px');
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-no-dividers-${testInfo.project.name}.png`), animations: 'disabled' });

    const sidebar = page.locator('.agent-sidebar');
    const rowMenu = sidebar.getByRole('button', { name: 'Chat menu' });
    await rowMenu.click({ force: true });
    await expect(sidebar.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(sidebar.getByRole('menuitem', { name: 'Archive', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sidebar).toContainText('No chats yet.');
    await sidebar.getByRole('button', { name: 'Archived', exact: true }).click();
    await sidebar.locator('.agent-chat-main').click();
    await expect(workspace).toContainText('Archived chat. Restore it from the chat menu to continue.');
    await expect(composer).toHaveCount(0);
    await expect(page.locator('.agent-user')).toHaveCount(2);
    await rowMenu.click({ force: true });
    await captureDocsScreenshot(page, 'agent-chat-archive');
    await sidebar.getByRole('menuitem', { name: 'Export as Markdown…' }).click();
    const exportDialog = page.getByRole('dialog', { name: 'Export chat as Markdown' });
    await expect(exportDialog).toContainText('unencrypted');
    await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E as unknown as { agentExport: unknown }).agentExport)).toEqual({ id: 'chat-1', workspaceId: 'workspace-e2e' });
    await rowMenu.click({ force: true });
    await sidebar.getByRole('menuitem', { name: 'Restore' }).click();
    await expect(sidebar.getByRole('button', { name: 'Chats', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(composer).toBeVisible();

    await page.locator('.agent-chat-menu-btn').click({ force: true });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.locator('.agent-chat-main')).toHaveCount(0);
    await expect(workspace).toContainText('What should we check?');
  });
});

test('requires a fresh cookie jar approval and retries a failed response', async ({ page }, testInfo) => {
  await installKurloBridge(page);
  await page.addInitScript(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    const e2e = window.__kurloE2E as unknown as Record<string, unknown> & { emit: (name: string, payload: unknown) => void };
    app.AiConnections = async () => ({ connections: [{ id: 'c1', label: 'Test API', kind: 'openai', provider: 'openai', model: 'test-model', hasKey: true, default: true }] });
    app.AgentChats = async () => [];
    app.CodexStatus = async () => ({ connected: false, installed: false, authenticated: false, models: [] });
    let release: (() => void) | undefined;
    let answers = 0;
    app.AnswerAgentApproval = async () => {
      answers++;
      if (answers === 1) throw new Error('Decision could not be delivered. Try again.');
      e2e.closeAcceptedApproval = () => {
        e2e.emit('agent:approval-closed', { id: 'waiting', chatId: 'waiting-chat', decision: 'allow' });
        release?.();
      };
      return { ok: true };
    };
    app.SendAgentMessage = async (input: Record<string, string>) => {
      await new Promise<void>(resolve => {
        release = resolve;
        e2e.emit('agent:approval', { id: 'waiting', chatId: 'waiting-chat', turnId: input.turnId, tool: 'clear_cookie_jar', kind: 'write', arguments: '{}', reason: 'Clears all cookies in the selected workspace jar. This can sign you out.', changes: [] });
      });
      return { text: 'Done', messages: [], steps: [], warnings: [] };
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message the agent' }).fill('Clear the cookie jar');
  await page.getByRole('textbox', { name: 'Message the agent' }).press('Enter');
  const approval = page.locator('.agent-approval');
  await expect(approval).toBeVisible();
  await expect(approval.getByText('Clear the cookie jar?', { exact: true })).toBeVisible();
  await expect(approval.getByRole('button', { name: 'Allow for this chat' })).toHaveCount(0);
  await approval.getByRole('button', { name: 'Clear cookies', exact: true }).click();
  await expect(approval.getByRole('alert')).toHaveText('Decision could not be delivered. Try again.');
  await expect(approval.getByRole('button', { name: 'Clear cookies', exact: true })).toBeEnabled();
  await expect(approval).toContainText('30 minutes');
  await page.screenshot({ path: join(tmpdir(), `kurlo-cookie-approval-${testInfo.project.name}.png`), animations: 'disabled' });
  await approval.getByRole('button', { name: 'Clear cookies', exact: true }).click();
  await expect(approval).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop the agent' })).toBeVisible();
  await page.evaluate(() => (window.__kurloE2E as unknown as { closeAcceptedApproval: () => void }).closeAcceptedApproval());
  await expect(page.getByRole('button', { name: 'Stop the agent' })).toHaveCount(0);
});

test('connects project context and drops files onto an agent message', async ({ page }, testInfo) => {
  await installKurloBridge(page);
  await page.addInitScript(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
    app.AiConnections = async () => ({ connections: [{ id: 'c1', label: 'Test API', kind: 'openai', provider: 'openai', model: 'test-model', hasKey: true, default: true }] });
    let savedChat: Record<string, unknown> | undefined;
    const originals: Record<string, string> = { 'spec': 'openapi: 3.1.0' };
    app.AgentChats = async () => savedChat ? [savedChat] : [];
    app.AgentChatPage = async () => savedChat;
    app.AgentAttachmentData = async (chatId: string, workspaceId: string, id: string) => {
      if (chatId !== 'source-chat' || workspaceId !== 'workspace-e2e' || !(id in originals)) throw new Error('Attachment missing');
      return originals[id];
    };
    app.CodexStatus = async () => ({ connected: false, installed: false, authenticated: false, models: [] });
    app.OpenDirectoryDialog = async () => '/source/pet-store';
    app.OpenFileDialog = async () => '/data/openapi.yaml';
    window.runtime!.OnFileDrop = (callback, useDropTarget) => {
      e2e.dropAgentFiles = callback;
      e2e.agentDropTargetEnabled = useDropTarget;
    };
    window.runtime!.OnFileDropOff = () => { delete e2e.dropAgentFiles; };
    app.SendAgentMessage = async (input: Record<string, unknown>) => {
      e2e.knowledgeInput = input;
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 420;
      const image = canvas.getContext('2d')!;
      image.scale(3, 3);
      image.fillStyle = '#20242b';
      image.fillRect(0, 0, 240, 140);
      image.font = '18px monospace';
      image.fillStyle = '#78dfac';
      image.fillText('200 OK', 16, 34);
      image.fillStyle = '#f1f4f8';
      image.fillText('{ "pet": "Mochi" }', 16, 68);
      const thumbnail = document.createElement('canvas');
      thumbnail.width = 240;
      thumbnail.height = 140;
      thumbnail.getContext('2d')!.drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
      originals.screenshot = canvas.toDataURL('image/png');
      originals.icon = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect x="8" y="8" width="80" height="80" rx="16" fill="#35404e"/><path d="M48 66c-15-10-24-19-24-29 0-16 19-20 24-7 5-13 24-9 24 7 0 10-9 19-24 29Z" fill="#7bdca9"/></svg>');
      const attachments = [
        { name: 'openapi.yaml', id: 'spec', mediaType: 'text/plain' },
        { name: 'screenshot.png', id: 'screenshot', mediaType: 'image/png', preview: thumbnail.toDataURL('image/jpeg') },
        { name: 'icon.svg', id: 'icon', mediaType: 'image/svg+xml', preview: originals.icon },
      ];
      (e2e.emit as (name: string, payload: unknown) => void)('ai:deltas', { sessionId: 'source-chat', turnId: input.turnId, deltas: [], attachments });
      await new Promise<void>(resolve => { e2e.finishAttachmentTurn = resolve; });
      const messages = [{ role: 'user', blocks: [{ type: 'text', text: input.text }], attachments }, { role: 'assistant', blocks: [{ type: 'text', text: 'I found the pet routes.' }] }];
      savedChat = { ...input, id: 'source-chat', title: 'Review the pet routes', messages, allowedTools: [], createdAt: Date.now(), updatedAt: Date.now() };
      return { chat: savedChat, messages, steps: [], warnings: [], text: 'I found the pet routes.' };
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('button', { name: 'Connect project folder' }).click();
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message the agent' });
  await composer.evaluate(input => {
    const bridge = window.__kurloE2E as unknown as {
      dropAgentFiles: (x: number, y: number, paths: string[]) => void;
      agentDropTargetEnabled: boolean;
    };
    if (!bridge.agentDropTargetEnabled || getComputedStyle(input).getPropertyValue('--wails-drop-target').trim() !== 'drop') {
      throw new Error('The agent composer is not registered as a file drop target.');
    }
    const { left, top } = input.getBoundingClientRect();
    bridge.dropAgentFiles(0, 0, ['/data/outside.txt']);
    bridge.dropAgentFiles(left + 10, top + 10, ['/data/screenshot.png', '/data/openapi.yaml', '/data/rows.csv', '/data/icon.svg']);
  });
  await expect(page.getByRole('button', { name: 'Remove attachment outside.txt' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove attachment rows.csv' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove attachment rows.csv' }).click();
  await expect(page.getByRole('button', { name: 'Disconnect project pet-store' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove attachment openapi.yaml' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove attachment screenshot.png' })).toBeVisible();
  await composer.fill('Review the pet routes');
  await page.screenshot({ path: join(tmpdir(), `kurlo-agent-context-${testInfo.project.name}.png`), animations: 'disabled' });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const bubble = page.locator('.agent-user');
  const files = page.getByRole('list', { name: 'Attachments' });
  const preview = files.getByRole('img', { name: 'Preview of screenshot.png' });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(240);
  await expect(files.getByText('openapi.yaml')).toBeVisible();
  await expect(files.getByRole('img', { name: 'Preview of icon.svg' })).toBeVisible();
  await expect(bubble).toHaveText('Review the pet routes');
  const fileBox = (await files.boundingBox())!;
  expect(fileBox.y + fileBox.height).toBeLessThan((await bubble.boundingBox())!.y);
  await expect(page.getByRole('button', { name: 'Remove attachment screenshot.png' })).toHaveCount(0);
  await page.evaluate(() => (window.__kurloE2E as unknown as { finishAttachmentTurn: () => void }).finishAttachmentTurn());
  await expect(page.getByText('I found the pet routes.', { exact: true })).toBeVisible();
  const input = await page.evaluate(() => (window.__kurloE2E as unknown as { knowledgeInput: Record<string, unknown> }).knowledgeInput);
  expect(input.projectRoot).toBe('/source/pet-store');
  expect(input.attachments).toEqual(['/data/openapi.yaml', '/data/screenshot.png', '/data/icon.svg']);
  await expect(page.getByRole('button', { name: 'Remove attachment openapi.yaml' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Disconnect project pet-store' })).toBeVisible();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.locator('.agent-sidebar').getByRole('button', { name: /Review the pet routes/ }).click();
  await expect(preview).toBeVisible();
  await expect(bubble).toHaveText('Review the pet routes');
  await captureDocsScreenshot(page, 'agent-context');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(tmpdir(), `kurlo-agent-attachments-${testInfo.project.name}.png`), animations: 'disabled' });
  const openImage = files.getByRole('button', { name: 'Open screenshot.png' });
  await openImage.click();
  const viewer = page.getByRole('dialog', { name: 'screenshot.png' });
  const image = viewer.getByRole('img', { name: 'screenshot.png' });
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(720);
  const fitted = (await image.boundingBox())!.width;
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fitted);
  await page.screenshot({ path: join(tmpdir(), `kurlo-agent-attachment-zoom-${testInfo.project.name}.png`), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(openImage).toBeFocused();
  await files.getByRole('button', { name: 'Open icon.svg' }).click();
  const svg = page.getByRole('dialog', { name: 'icon.svg' }).getByRole('img', { name: 'icon.svg' });
  await expect.poll(() => svg.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await files.getByRole('button', { name: 'Open openapi.yaml' }).click();
  await expect(page.getByRole('dialog', { name: 'openapi.yaml' }).getByRole('region', { name: 'File contents' })).toHaveText('openapi: 3.1.0');
});
