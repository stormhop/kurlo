import { describe, expect, it } from 'vitest';
import { agentHistoryPage, mergeAgentHistory, virtualOffsets, virtualIndex, virtualRange } from '../lib/agentHistory';
import { agentTurnsFromMessages } from '../lib/agent';
import type { AgentChat, AiMessage } from '../lib/wire';

function history(count: number): AgentChat {
  return { id: 'long-chat', messages: Array.from({ length: count }, (_, index) => [
    { role: 'user', blocks: [{ type: 'text', text: `Question ${index}` }] },
    { role: 'assistant', blocks: [{ type: 'tool_use', id: `call-${index}`, name: 'get_request', input: '{}' }] },
    { role: 'tool', blocks: [{ type: 'tool_result', id: `call-${index}`, text: '{}' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: `Answer ${index}` }] },
  ] as AiMessage[]).flat() } as AgentChat;
}

describe('paged agent history', () => {
  it('pages backwards without splitting tool calls, losing messages or changing turn IDs', () => {
    const chat = history(123);
    let merged = agentHistoryPage(chat);
    const lastId = agentTurnsFromMessages(merged.messages, chat.id, merged.messageOffset).at(-1)?.id;
    expect(merged.messages).toHaveLength(160);
    expect(merged.messageOffset).toBe(83 * 4);
    while (merged.messageOffset) merged = mergeAgentHistory(merged, agentHistoryPage(chat, merged.messageOffset));
    expect(merged.messages).toEqual(chat.messages);
    expect(agentTurnsFromMessages(merged.messages, chat.id).at(-1)?.id).toBe(lastId);
  });

  it('merges a new turn into already loaded history without duplication', () => {
    const old = history(80);
    const current = mergeAgentHistory(agentHistoryPage(old), agentHistoryPage(old, 160));
    const next = history(81);
    const merged = mergeAgentHistory(current, agentHistoryPage(next));
    expect(merged.messages).toEqual(next.messages);
    expect(mergeAgentHistory(merged, agentHistoryPage(next)).messages).toEqual(next.messages);
  });

  it('releases older loaded pages in background workspace snapshots without changing message IDs', () => {
    const all = history(123);
    const loaded = mergeAgentHistory(agentHistoryPage(all), agentHistoryPage(all, 83 * 4));
    const snapshot = agentHistoryPage(loaded);
    expect(snapshot.messages).toHaveLength(160);
    expect(snapshot.messageOffset).toBe(83 * 4);
    expect(snapshot.messageCount).toBe(all.messages.length);
    expect(agentTurnsFromMessages(snapshot.messages, all.id, snapshot.messageOffset).at(-1)?.id).toBe(agentTurnsFromMessages(all.messages, all.id).at(-1)?.id);
  });

  it('handles empty, short and orphaned histories' , () => {
    expect(agentHistoryPage(history(0))).toMatchObject({ messages: [], messageOffset: 0, messageCount: 0 });
    expect(agentHistoryPage(history(3)).messages).toHaveLength(12);
    expect(agentHistoryPage(history(3), 0).messages).toHaveLength(0);
    const chat = { ...history(1), messages: history(1).messages.slice(1) };
    expect(agentHistoryPage(chat).messages).toEqual(chat.messages);
  });
});

describe('variable height chat virtualization', () => {
  it('bounds rendered rows in a history of ten thousand turns', () => {
    const ids = Array.from({ length: 10000 }, (_, index) => String(index));
    const offsets = virtualOffsets(ids, new Map());
    for (const top of [0, 5000, 100000, offsets.at(-1)! - 500]) {
      const range = virtualRange(offsets, top, 600);
      expect(range.end - range.start).toBeLessThan(12);
      expect(offsets[range.start]).toBeLessThanOrEqual(top);
      expect(offsets[range.end]).toBeGreaterThanOrEqual(Math.min(top + 600, offsets.at(-1)!));
    }
  });

  it('finds rows at measured height boundaries and covers a very tall answer', () => {
    const offsets = virtualOffsets(['a', 'b', 'c'], new Map([['a', 50], ['b', 10000], ['c', 100]]));
    expect(offsets).toEqual([0, 50, 10050, 10150]);
    expect(virtualIndex(offsets, 49)).toBe(0);
    expect(virtualIndex(offsets, 50)).toBe(1);
    expect(virtualRange(offsets, 5000, 600)).toEqual({ start: 1, end: 2 });
    expect(virtualRange([0], 0, 600)).toEqual({ start: 0, end: 0 });
  });
});
