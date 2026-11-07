import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../lib/backend', async () => {
  const wire = await import('../lib/wire');
  return {
    ...wire,
    agentChatPage: vi.fn(),
    agentChats: vi.fn(async () => []),
    agentPendingApprovals: vi.fn(async () => []),
    answerAgentApproval: vi.fn(),
    branchAgentChat: vi.fn(),
    deleteAgentChat: vi.fn(),
    onAgentEvent: vi.fn(),
    renameAgentChat: vi.fn(),
    sendAgentMessage: vi.fn(),
    setAgentChatArchived: vi.fn(),
    stopAgent: vi.fn(async () => undefined),
  };
});

import * as backend from '../lib/backend';
import type { AgentApproval, AgentChat } from '../lib/backend';
import { AgentStore } from '../lib/stores/agent.svelte';

function chat(messages: string[]): AgentChat {
  return {
    id: 'chat-1',
    workspaceId: 'shop',
    title: 'Chat',
    messages: messages.map((text, index) => ({ role: index % 2 ? 'assistant' : 'user', blocks: [{ type: 'text', text }] })),
    messageOffset: 0,
    messageCount: messages.length,
  } as unknown as AgentChat;
}

function storeWithChat(driver = '') {
  const store = new AgentStore(driver as never);
  store.syncWorkspaceSelection('shop', [], [], '');
  store.activeChatId = 'chat-1';
  store.activeChat = chat(['first', 'answer', 'second', 'answer two']);
  return store;
}

describe('agent store', () => {
  beforeEach(() => vi.clearAllMocks());

  it('restores the cut history when an edited message fails to send', async () => {
    vi.mocked(backend.sendAgentMessage).mockRejectedValueOnce(new Error('bridge down'));
    const store = storeWithChat();
    store.startEdit(2, 'second');
    store.draft = 'second, edited';
    await store.send();
    expect(store.activeChat?.messages.map(message => message.blocks[0].text)).toEqual(['first', 'answer', 'second', 'answer two']);
    expect(store.notes?.error).toBe('bridge down');
  });

  it('tracks running and waiting chats', async () => {
    let finish: (value: never) => void = () => {};
    vi.mocked(backend.sendAgentMessage).mockReturnValueOnce(new Promise(resolve => { finish = resolve as never; }));
    const store = storeWithChat();
    store.draft = 'go';
    const sending = store.send();
    expect(store.isRunning('chat-1')).toBe(true);
    expect(store.isRunning('chat-2')).toBe(false);
    store.approvals = [{ id: 'a', chatId: 'chat-1', turnId: 't' } as AgentApproval];
    expect(store.isWaiting('chat-1')).toBe(true);
    expect(store.isWaiting('chat-2')).toBe(false);
    finish({ chat: chat(['first', 'answer', 'second', 'answer two', 'go', 'done']), messages: [], steps: [], text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, hasUsage: false, warnings: [], error: '' } as never);
    await sending;
    expect(store.isRunning('chat-1')).toBe(false);
  });

  it('stops only a turn of the open workspace', async () => {
    vi.mocked(backend.sendAgentMessage).mockReturnValueOnce(new Promise(() => {}));
    const store = storeWithChat('codex');
    store.draft = 'go';
    void store.send();
    store.syncWorkspaceSelection('other', [], [], '');
    await store.stop();
    expect(backend.stopAgent).not.toHaveBeenCalled();
    store.syncWorkspaceSelection('shop', [], [], '');
    store.activeChatId = '';
    await store.stop();
    expect(backend.stopAgent).toHaveBeenCalledTimes(1);
  });
});
