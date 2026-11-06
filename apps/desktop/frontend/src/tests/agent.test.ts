import { describe, expect, it } from 'vitest';
import {
  agentApprovalTitle, agentChangeSummary, agentContextPercent, agentQuotaWindows, agentChatGroups, agentFilterChats, agentFindRequest, agentToolTarget, agentTurnAnswer,
  agentTurnsFromMessages, agentEffortChoice, agentEffortToStore, agentEffortLabel, agentKindMonogram, AGENT_STARTERS, AGENT_TEMPLATES, agentStepSummary, agentTurnSegments,
} from '../lib/agent';
import type { AgentApproval, AiBlock, AiMessage } from '../lib/wire';

describe('agent chat view', () => {
  it('turns saved messages into turns with steps and matched tool results', () => {
    const messages: AiMessage[] = [
      { role: 'user', blocks: [{ type: 'text', text: 'Run the orders request' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'Running it.' }, { type: 'tool_use', id: 'c1', name: 'run_request', input: '{"request":"Shop/Orders"}' }] },
      { role: 'tool', blocks: [{ type: 'tool_result', id: 'c1', name: 'run_request', text: '{"status":200}' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'It returned 200.' }] },
      { role: 'user', blocks: [{ type: 'text', text: 'Thanks' }] },
    ];
    const turns = agentTurnsFromMessages(messages, 'chat');
    expect(turns.map(turn => turn.prompt)).toEqual(['Run the orders request', 'Thanks']);
    expect(turns[0].steps).toHaveLength(2);
    expect(turns[0].steps[0].stopReason).toBe('tool_use');
    expect(turns[0].steps[0].toolResults[0].text).toBe('{"status":200}');
    expect(turns[0].steps[1].blocks[0].text).toBe('It returned 200.');
    expect(turns[1].steps).toEqual([]);
    expect(new Set(turns.map(turn => turn.id)).size).toBe(2);
  });

  it('groups chats into Today and Earlier, newest first', () => {
    const now = new Date(2026, 10, 1, 15, 0).getTime();
    const groups = agentChatGroups([
      { id: 'a', title: 'Old', workspaceId: 'shop', createdAt: 0, updatedAt: new Date(2026, 9, 30).getTime() },
      { id: 'b', title: 'Morning', workspaceId: 'shop', createdAt: 0, updatedAt: new Date(2026, 10, 1, 9).getTime() },
      { id: 'c', title: 'Noon', workspaceId: 'shop', createdAt: 0, updatedAt: new Date(2026, 10, 1, 12).getTime() },
    ], now);
    expect(groups.map(group => [group.label, group.chats.map(chat => chat.id)])).toEqual([['Today', ['c', 'b']], ['Earlier', ['a']]]);
    expect(agentChatGroups([], now)).toEqual([]);
  });

  it('links tool calls to the request, history entry or environment they touched', () => {
    expect(agentToolTarget({ type: 'tool_use', name: 'run_request', input: '{"request":"Shop/Orders"}' })).toEqual({ kind: 'request', ref: 'Shop/Orders' });
    expect(agentToolTarget({ type: 'tool_use', name: 'save_request', input: '{"name":"New"}' }, { type: 'tool_result', text: '{"id":"req-9","path":"Shop/New"}' })).toEqual({ kind: 'request', ref: 'req-9' });
    expect(agentToolTarget({ type: 'tool_use', name: 'get_history_entry', input: '{"entry":"h1"}' })).toEqual({ kind: 'history', id: 'h1' });
    expect(agentToolTarget({ type: 'tool_use', name: 'set_variable', input: '{"environment":"Local","key":"a"}' })).toEqual({ kind: 'environment', name: 'Local' });
    expect(agentToolTarget({ type: 'tool_use', name: 'delete_request', input: '{"request":"x"}' })).toBeNull();
    expect(agentToolTarget({ type: 'tool_use', name: 'list_requests', input: 'not json' })).toBeNull();
  });

  it('finds a request by id, path or name', () => {
    const requests = [{ id: 'r1', name: 'Orders', path: 'Shop/Orders' }, { id: 'r2', name: 'Login', path: 'Auth/Login' }];
    expect(agentFindRequest(requests, 'r2')?.id).toBe('r2');
    expect(agentFindRequest(requests, 'shop/orders')?.id).toBe('r1');
    expect(agentFindRequest(requests, 'login')?.id).toBe('r2');
    expect(agentFindRequest(requests, 'missing')).toBeNull();
  });

  it('titles approvals by what they do', () => {
    const base: AgentApproval = { id: 'a', chatId: 'c', tool: 'save_request', kind: 'write', arguments: '{}', reason: '', changes: [] };
    expect(agentApprovalTitle({ ...base, changes: [{ path: 'a.yml', after: 'x' }] })).toBe('Change 1 file?');
    expect(agentApprovalTitle({ ...base, changes: [{ path: 'a.yml' }, { path: 'b.yml' }] })).toBe('Change 2 files?');
    expect(agentApprovalTitle({ ...base, kind: 'run', tool: 'send_request' })).toBe('Send this request?');
    expect(agentApprovalTitle({ ...base, tool: 'apply_changes' })).toBe('Apply these changes?');
    expect(agentApprovalTitle({ ...base, kind: 'external', tool: 'authorize_oauth2' })).toBe('Authorize this request?');
    expect(agentChangeSummary({ path: 'a', after: 'x' })).toBe('new file');
    expect(agentChangeSummary({ path: 'a', before: 'x' })).toBe('deleted');
    expect(agentChangeSummary({ path: 'a', before: 'x', after: 'y' })).toBe('changed');
  });

  it('filters chats by every word of the query', () => {
    const chats = [
      { id: 'a', title: 'Orders tests', workspaceId: 'shop', createdAt: 0, updatedAt: 0 },
      { id: 'b', title: 'Login failure', workspaceId: 'shop', createdAt: 0, updatedAt: 0 },
    ];
    expect(agentFilterChats(chats, '').map(chat => chat.id)).toEqual(['a', 'b']);
    expect(agentFilterChats(chats, 'TESTS ord').map(chat => chat.id)).toEqual(['a']);
    expect(agentFilterChats(chats, 'orders login')).toEqual([]);
  });

  it('copies only the text the agent wrote', () => {
    expect(agentTurnAnswer([
      { blocks: [{ type: 'thinking', text: 'secret plan' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', name: 'x' }] },
      { blocks: [{ type: 'text', text: ' Done. ' }] },
    ])).toBe('Checking.\n\nDone.');
  });
});

describe('Agent session status', () => {
  it('only computes a context percentage from an available window', () => {
    expect(agentContextPercent(110, 1000)).toBe(11);
    expect(agentContextPercent(0, 1000)).toBe(0);
    expect(agentContextPercent(110, 0)).toBeNull();
    expect(agentContextPercent(-1, 1000)).toBeNull();
    expect(agentContextPercent(1200, 1000)).toBe(100);
  });

  it('keeps separate quota windows and does not invent missing limits', () => {
    expect(agentQuotaWindows([])).toEqual([]);
    expect(agentQuotaWindows([{ limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 110, windowDurationMins: 10080 } }])).toEqual([
      { label: 'codex · 5h', duration: '5h', remaining: 75, resetsAt: 1800000000 },
      { label: 'codex · 7d', duration: '7d', remaining: 0, resetsAt: 0 },
    ]);
  });
});

describe('agent picker', () => {
  it('shows the model default effort until another one is chosen', () => {
    const efforts = ['low', 'medium', 'high'];
    expect(agentEffortChoice('', efforts, 'medium')).toBe('medium');
    expect(agentEffortChoice('high', efforts, 'medium')).toBe('high');
    expect(agentEffortChoice('xhigh', efforts, 'medium')).toBe('medium');
    expect(agentEffortChoice('', [], '')).toBe('');
  });

  it('stores the default effort as empty so the model keeps its own default', () => {
    expect(agentEffortToStore('medium', 'medium')).toBe('');
    expect(agentEffortToStore('high', 'medium')).toBe('high');
    expect(agentEffortLabel('xhigh')).toBe('Extra high');
    expect(agentEffortLabel('low')).toBe('Low');
  });

  it('labels connections by provider and offers only known starters', () => {
    expect(agentKindMonogram('openrouter')).toBe('OR');
    expect(agentKindMonogram('anthropic')).toBe('An');
    expect(agentKindMonogram('compatible')).toBe('Ai');
    expect(AGENT_STARTERS.every(id => AGENT_TEMPLATES.some(template => template.id === id && template.summary))).toBe(true);
  });
});

describe('agent steps', () => {
  it('summarises a run with its target, request line, status and time', () => {
    const block = { type: 'tool_use', id: 'c1', name: 'run_request', input: '{"request":"Orders/List"}' } as const;
    const result = { type: 'tool_result', id: 'c1', text: '{"name":"List orders","method":"GET","url":"https://api.test/orders","statusCode":401,"durationMs":182}' } as const;
    expect(agentStepSummary(block, result)).toEqual({ target: 'List orders', detail: 'GET https://api.test/orders', status: 401, durationMs: 182 });
    expect(agentStepSummary(block)).toEqual({ target: 'Orders/List', detail: '', status: 0, durationMs: 0 });
    expect(agentStepSummary(block, { ...result, isError: true })).toMatchObject({ target: 'Orders/List', status: 0 });
  });

  it('groups consecutive tool calls of a turn into one card and keeps text between them', () => {
    const steps = [
      { blocks: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'a', name: 'get_request' }], error: '' },
      { blocks: [{ type: 'tool_use', id: 'b', name: 'run_request' }], error: '' },
      { blocks: [{ type: 'text', text: 'Found it.' }, { type: 'text', text: '' }], error: 'stopped' },
    ] as Array<{ blocks: AiBlock[]; error: string }>;
    expect(agentTurnSegments(steps).map(segment => segment.kind === 'tools' ? `tools:${segment.items.length}` : segment.kind)).toEqual(['block', 'tools:2', 'block', 'error']);
  });
});
