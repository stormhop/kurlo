import { describe, expect, it } from 'vitest';
import type { AgentActivitySummary, AgentApproval } from '../lib/backend';
import {
  agentActivityChangeStatus, agentActivityChatMode, agentActivityClients, agentActivityGroups, agentActivityPretty,
  agentActivityPlace, agentActivityRestorable, agentActivityStatus, filterAgentActivity,
} from '../lib/agentActivity';
import { agentApprovalAction, agentApprovalTitle, agentToolLabel } from '../lib/agent';

const now = new Date('2026-11-04T15:00:00').getTime();
const hour = 60 * 60 * 1000;

function entry(id: string, patch: Partial<AgentActivitySummary> = {}): AgentActivitySummary {
  return { id, time: now - hour, client: 'Kurlo agent', tool: 'save_request', status: 'ok', files: [], reverted: false, workspace: '', ...patch };
}

describe('agent activity', () => {
  const entries = [
    entry('a', { files: ['workspaces/Demo/collections/Shop/requests/Create-order.yml'], commit: 'abc1234', branch: 'kurlo-agent/orders-1a2b3c' }),
    entry('b', { client: 'Claude Code', tool: 'list_requests', time: now - 30 * hour }),
    entry('c', { client: 'Codex via Kurlo', tool: 'git_push', status: 'declined', time: now - 10 * 24 * hour }),
  ];

  it('filters by words, client and period', () => {
    expect(filterAgentActivity(entries, { text: 'create order', client: '', period: 'all' }, now).map(item => item.id)).toEqual(['a']);
    expect(filterAgentActivity(entries, { text: 'delete', client: '', period: 'all' }, now)).toEqual([]);
    expect(filterAgentActivity(entries, { text: 'create-order', client: '', period: 'all' }, now).map(item => item.id)).toEqual(['a']);
    expect(filterAgentActivity(entries, { text: 'orders-1a2b3c', client: '', period: 'all' }, now).map(item => item.id)).toEqual(['a']);
    expect(filterAgentActivity(entries, { text: '', client: 'Claude Code', period: 'all' }, now).map(item => item.id)).toEqual(['b']);
    expect(filterAgentActivity(entries, { text: '', client: '', period: 'day' }, now).map(item => item.id)).toEqual(['a']);
    expect(filterAgentActivity(entries, { text: '', client: '', period: 'week' }, now).map(item => item.id)).toEqual(['a', 'b']);
  });

  it('lists clients once and groups by day', () => {
    expect(agentActivityClients(entries)).toEqual(['Claude Code', 'Codex via Kurlo', 'Kurlo agent']);
    expect(agentActivityGroups(entries, now).map(group => [group.label, group.entries.map(item => item.id)])).toEqual([
      ['Today', ['a']], ['Yesterday', ['b']], ['Earlier', ['c']],
    ]);
  });

  it('names the status of a call', () => {
    expect(agentActivityStatus(entries[0])).toEqual({ label: 'Changed files', tone: 'ok' });
    expect(agentActivityStatus(entries[1])).toEqual({ label: 'Done', tone: 'ok' });
    expect(agentActivityStatus(entries[2])).toEqual({ label: 'Declined', tone: 'muted' });
    expect(agentActivityStatus(entry('d', { status: 'error' }))).toEqual({ label: 'Error', tone: 'bad' });
    expect(agentActivityStatus(entry('e', { reverted: true, files: ['x.yml'] }))).toEqual({ label: 'Restored', tone: 'muted' });
  });

  it('offers restore only for files it kept and has not restored', () => {
    const full = { ...entries[0], arguments: '', result: '', changes: [
      { path: 'new.yml', before: null, after: 'a' },
      { path: 'gone.yml', before: 'a', after: null },
      { path: 'big.yml', before: null, after: null, tooLarge: true },
      { path: 'done.yml', before: 'a', after: 'b', reverted: true },
    ] } as never;
    expect(agentActivityRestorable(full).map(change => change.path)).toEqual(['new.yml', 'gone.yml']);
    expect(agentActivityRestorable(null)).toEqual([]);
    expect(['new.yml', 'gone.yml', 'big.yml', 'done.yml'].map((_, index) => agentActivityChangeStatus((full as { changes: never[] }).changes[index]))).toEqual(['new file', 'deleted', 'changed', 'restored']);
  });

  it('finds the chat of in-app agents only', () => {
    expect(agentActivityChatMode('Kurlo agent')).toBe('kurlo');
    expect(agentActivityChatMode('Codex via Kurlo')).toBe('external');
    expect(agentActivityChatMode('Claude Code via Kurlo')).toBe('claude');
    expect(agentActivityChatMode('Cursor')).toBeNull();
  });

  it('names where a call from elsewhere happened', () => {
    expect(agentActivityPlace(entry('x', { here: true, workspaceId: 'w' }))).toBe('');
    expect(agentActivityPlace(entry('x', { workspaceId: 'w', workspaceName: 'Billing' }))).toBe('Billing');
    expect(agentActivityPlace(entry('x', { workspaceId: 'w' }))).toBe('Another workspace');
    expect(agentActivityPlace(entry('x'))).toBe('No workspace');
  });

  it('pretty-prints JSON and keeps other text', () => {
    expect(agentActivityPretty('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(agentActivityPretty('plain')).toBe('plain');
    expect(agentActivityPretty('  ')).toBe('');
  });
});

describe('git approvals', () => {
  const approval = (tool: string, kind: string, changes = 0): AgentApproval => ({
    id: '1', chatId: 'c', tool, kind, arguments: '{}', reason: '', changes: Array.from({ length: changes }, (_, index) => ({ path: `${index}.yml`, before: null, after: '' })),
  });

  it('names Git approvals and their buttons', () => {
    expect(agentApprovalTitle(approval('git_commit', 'write', 2))).toBe('Commit 2 files?');
    expect(agentApprovalAction(approval('git_commit', 'write', 2))).toBe('Commit');
    expect(agentApprovalTitle(approval('git_push', 'external'))).toBe('Push this branch?');
    expect(agentApprovalAction(approval('git_push', 'external'))).toBe('Push');
    expect(agentApprovalTitle(approval('git_create_branch', 'write'))).toBe('Create this branch?');
    expect(agentApprovalAction(approval('save_request', 'write', 1))).toBe('Apply');
    expect(agentApprovalAction(approval('authorize_oauth2', 'external'))).toBe('Authorize');
    expect(agentApprovalAction(approval('run_request', 'run'))).toBe('Send');
    expect(agentToolLabel('git_commit')).toBe('Committed changes');
  });
});
