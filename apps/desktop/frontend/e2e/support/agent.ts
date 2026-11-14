import type { E2EWindow } from './bridge';
import { installKurloBridge } from './bridge';
import { expect, type Page } from '@playwright/test';

export const agentStore = {
  collections: [{ id: 'col-shop', workspaceId: 'workspace-e2e', name: 'Shop API' }],
  requests: [
    { id: 'req-orders', collectionId: 'col-shop', collection: 'Shop API', folderPath: ['Orders'], name: 'List orders', requestType: 'http', method: 'GET', url: '{{baseUrl}}/orders', auth: { type: 'none' } },
  ],
  environments: [{ id: 'env-local', workspaceId: 'workspace-e2e', name: 'Local', values: [{ id: 1, key: 'baseUrl', value: 'http://localhost:8080', enabled: true }] }],
};

export async function installAgentBridge(page: Page, connections: unknown[]) {
  await page.addInitScript((connections) => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    const e2e = window.__kurloE2E as unknown as Record<string, unknown> & { emit: (name: string, payload: unknown) => void };
    const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    const chats: Array<Record<string, unknown>> = [];
    const sent: unknown[] = [];
    const answers: Array<{ id: string; decision: string }> = [];
    let release: (() => void) | null = null;
    e2e.agentSent = sent;
    e2e.agentAnswers = answers;
    app.AiConnections = async () => ({ connections });
    app.AgentScenarios = async () => ([
      { name: 'debug_last_failure', title: 'Why did my request fail?', description: 'Explain the last failure.', arguments: [] },
      { name: 'cover_endpoint', title: 'Cover one endpoint', description: 'Add a request with tests.', arguments: [{ name: 'endpoint', description: '', required: true }] },
      { name: 'check_collection', title: 'Run and check a collection', description: 'Run a collection and explain failures.', arguments: [] },
    ]);
    const summary = (chat: Record<string, unknown>) => ({ id: chat.id, title: chat.title, workspaceId: chat.workspaceId, createdAt: chat.createdAt, updatedAt: chat.updatedAt, archivedAt: chat.archivedAt });
    app.AgentChats = async (workspaceId: string) => chats.filter(chat => chat.workspaceId === workspaceId).map(summary);
    app.SetAgentChatArchived = async (id: string, workspaceId: string, archived: boolean) => {
      const chat = chats.find(item => item.id === id && item.workspaceId === workspaceId);
      if (!chat) throw new Error('Chat not found');
      chat.archivedAt = archived ? Date.now() : undefined;
      if (!archived) chat.updatedAt = Date.now();
      return summary(chat);
    };
    app.ExportAgentChat = async (id: string, workspaceId: string) => {
      e2e.agentExport = { id, workspaceId };
      return '/tmp/agent-chat.md';
    };
    app.AgentChat = async (id: string) => structuredClone(chats.find(chat => chat.id === id));
    app.AgentPendingApprovals = async () => [];
    const renames: unknown[] = [];
    e2e.agentRenames = renames;
    app.RenameAgentChat = async (id: string, title: string) => {
      renames.push([id, title]);
      const chat = chats.find(item => item.id === id);
      if (chat) chat.title = title;
      return { ok: true };
    };
    app.DeleteAgentChat = async (id: string) => {
      const index = chats.findIndex(chat => chat.id === id);
      if (index >= 0) chats.splice(index, 1);
      return { ok: true };
    };
    app.AnswerAgentApproval = async (id: string, decision: string) => {
      answers.push({ id, decision });
      e2e.emit('agent:approval-closed', { id, chatId: 'chat-1', decision });
      release?.();
      return { ok: true };
    };
    app.TestAiConnection = async () => ({ ok: true, models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', recommended: true, weakTools: false }, { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', recommended: true, weakTools: false }] });
    app.SaveAiConnection = async () => { e2e.aiConnectionSaves = ((e2e.aiConnectionSaves as number) ?? 0) + 1; return { connections }; };
    app.SendAgentMessage = async (input: Record<string, string>) => {
      sent.push(structuredClone(input));
      const sessionId = 'chat-1';
      const turnId = input.turnId;
      const listCall = { type: 'tool_use', id: 'call_1', name: 'get_request', input: '{"request":"Shop API/Orders/List orders"}' };
      const listResult = { type: 'tool_result', id: 'call_1', name: 'get_request', server: 'Kurlo', text: '{"id":"req-orders","method":"GET"}' };
      const batch = input.text === 'Review batch changes';
      const writeTool = batch ? 'apply_changes' : 'save_request';
      const saveCall = { type: 'tool_use', id: 'call_2', name: writeTool, input: '{"collection":"Shop API","name":"List orders","testScript":"pm.test(\\"status is 200\\")"}' };
      const saveResult = { type: 'tool_result', id: 'call_2', name: writeTool, server: 'Kurlo', text: '{"id":"req-orders","path":"Shop API/Orders/List orders","created":false}' };
      const finalText = 'Added a **status is 200** test to List orders.';
      e2e.emit('ai:deltas', {
        sessionId, turnId, deltas: [
          { sessionId, step: 0, index: 0, type: 'text', text: 'Let me look at the request first.' },
          { sessionId, step: 0, index: 1, type: 'tool_use', id: 'call_1', name: 'get_request', input: listCall.input },
        ]
      });
      e2e.emit('ai:step', { sessionId, turnId, step: { index: 0, blocks: [{ type: 'text', text: 'Let me look at the request first.' }, listCall], toolResults: [], stopReason: 'tool_use', model: 'claude-sonnet-4-5', usage: usage(900, 40), hasUsage: true, http: { statusCode: 200, status: '200 OK', headers: [] } } });
      e2e.emit('ai:tool', { sessionId, turnId, step: 0, block: listResult });
      e2e.emit('ai:step', { sessionId, turnId, step: { index: 1, blocks: [saveCall], toolResults: [], stopReason: 'tool_use', model: 'claude-sonnet-4-5', usage: usage(1100, 60), hasUsage: true, http: { statusCode: 200, status: '200 OK', headers: [] } } });
      const before = 'version: 1\nrequest:\n    id: req-orders\n    name: List orders\n    url: \'{{baseUrl}}/orders\'\n';
      const after = before + '    testScriptJs: |\n        pm.test("status is 200", () => pm.response.to.have.status(200))\n';
      const changes: Array<Record<string, unknown>> = [{ path: 'workspaces/Main/collections/Shop-API/requests/List-orders.yml', before, after, summary: { kind: 'request', name: 'List orders', location: 'Shop API / Orders', detail: 'GET {{baseUrl}}/orders', fields: [{ label: 'Tests', change: 'added' }] } }];
      if (batch) changes.push({ path: 'Profile globals', before: '[]', after: '[\n  { "key": "baseUrl", "value": "https://example.test" }\n]', summary: { kind: 'globals', name: 'Globals', fields: [{ label: 'Variable baseUrl', change: 'added' }] } });
      await new Promise<void>(resolve => {
        release = resolve;
        e2e.emit('agent:approval', { id: 'approval-1', chatId: sessionId, turnId, toolUseId: 'call_2', tool: writeTool, kind: 'write', arguments: saveCall.input, reason: batch ? 'Review all changes in this batch.' : 'Changes the workspace files.', changes });
      });
      e2e.emit('ai:tool', { sessionId, turnId, step: 1, block: saveResult });
      e2e.emit('ai:step', { sessionId, turnId, step: { index: 2, blocks: [{ type: 'text', text: finalText }], toolResults: [], stopReason: 'end_turn', model: 'claude-sonnet-4-5', usage: usage(1300, 30), hasUsage: true, http: { statusCode: 200, status: '200 OK', headers: [] } } });
      const now = Date.now();
      const existing = chats.find(chat => chat.id === sessionId);
      const messages = [
        ...((existing?.messages as unknown[]) ?? []),
        { role: 'user', blocks: [{ type: 'text', text: input.text }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'Let me look at the request first.' }, listCall] },
        { role: 'tool', blocks: [listResult] },
        { role: 'assistant', blocks: [saveCall] },
        { role: 'tool', blocks: [saveResult] },
        { role: 'assistant', blocks: [{ type: 'text', text: finalText }] },
      ];
      const chat = { id: sessionId, workspaceId: input.workspaceId, title: existing?.title ?? input.text.slice(0, 60), workspace: '/e2e', createdAt: existing?.createdAt ?? now, updatedAt: now, collection: input.collection, environment: input.environment, connectionId: input.connectionId, model: '', messages, usage: usage(3300, 130), allowedTools: [] };
      if (existing) Object.assign(existing, chat);
      else chats.push(chat);
      return { chat: structuredClone(chat), messages: messages.slice(-6), steps: [], text: finalText, usage: usage(3300, 130), hasUsage: true, warnings: [] };
    };
  }, connections);
}

export const connection = { id: 'c1', kind: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', hasKey: true, keyHint: 'sk-ant-…XYZ', default: true, provider: 'anthropic' };

export async function installLongAgentHistory(page: Page) {
  await installKurloBridge(page);
  await page.addInitScript(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    const e2e = window.__kurloE2E as unknown as Record<string, unknown> & { emit: (name: string, payload: unknown) => void };
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const base = { id: 'long-history', workspaceId: 'workspace-e2e', title: 'Ten thousand exchanges', driver: 'codex', model: 'test-model', collection: '', environment: '', createdAt: Date.now(), updatedAt: Date.now(), usage, allowedTools: [] };
    let total = 20000;
    const requests: Array<{ id: string; before: number; count: number }> = [];
    e2e.historyRequests = requests;
    app.AiConnections = async () => ({ connections: [] });
    app.CodexStatus = async () => ({ installed: true, connected: true, authenticated: true, path: '/test/codex', model: 'test-model', models: [{ id: 'test-model', name: 'Test model' }] });
    app.AgentChats = async () => [base, { ...base, id: 'short-history', title: 'Small chat' }];
    app.AgentPendingApprovals = async () => [];
    app.AgentChat = async () => { throw new Error('The full history must not be requested'); };
    const pageOf = (id: string, before: number) => {
      const end = before < 0 ? total : before;
      const start = Math.max(0, end - (before < 0 && (window as unknown as { __shortFirstPage?: boolean }).__shortFirstPage ? 2 : 80));
      const messages = Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        const turn = Math.floor(index / 2);
        return index % 2 === 0 ? { role: 'user', blocks: [{ type: 'text', text: `Question ${turn}` }] } : { role: 'assistant', blocks: [{ type: 'text', text: `Answer ${turn}\n\n` + 'A paragraph with **formatted text**. '.repeat(turn % 7 + 1) }] };
      });
      return { ...base, id, messageOffset: start, messageCount: total, messages };
    };
    app.AgentChatPage = async (id: string, before: number) => {
      if (id === 'short-history') return { ...base, id, title: 'Small chat', messages: [{ role: 'user', blocks: [{ type: 'text', text: 'Small question' }] }, { role: 'assistant', blocks: [{ type: 'text', text: 'Small answer' }] }] };
      if (before >= 0 && e2e.failEarlier) { e2e.failEarlier = false; throw new Error('History temporarily unavailable'); }
      const result = pageOf(id, before);
      requests.push({ id, before, count: result.messages.length });
      if (before >= 0 && e2e.deferEarlier) await new Promise<void>(resolve => { e2e.releaseHistory = resolve; });
      return result;
    };
    app.SendAgentMessage = async (input: Record<string, string>) => {
      e2e.longInput = input;
      await new Promise<void>(resolve => { e2e.finishLongTurn = resolve; });
      total += 2;
      const chat = pageOf(base.id, -1);
      chat.messages[chat.messages.length - 2] = { role: 'user', blocks: [{ type: 'text', text: input.text }] };
      chat.messages[chat.messages.length - 1] = { role: 'assistant', blocks: [{ type: 'text', text: 'New answer finished' }] };
      return { chat, messages: chat.messages.slice(-2), steps: [], text: 'New answer finished', usage, hasUsage: true, warnings: [] };
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.locator('.agent-sidebar').getByRole('button', { name: /Ten thousand exchanges/ }).click();
  await expect(page.locator('.agent-text').last()).toContainText('Answer 9999');
}

export async function visibleHistoryAnchor(page: Page) {
  return page.locator('.agent-main > .agent-chat').evaluate(async element => {
    await document.fonts.ready;
    let previous = { id: '', top: 0 };
    let stable = 0;
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll<HTMLElement>('.virtual-agent-row')].find(row => row.getBoundingClientRect().bottom > top + 2);
      if (!row) continue;
      const current = { id: row.dataset.turnId!, top: row.getBoundingClientRect().top - top };
      stable = current.id === previous.id && Math.abs(current.top - previous.top) < 0.5 ? stable + 1 : 0;
      previous = current;
      if (stable >= 3) break;
    }
    return previous;
  });
}
