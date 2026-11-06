import type { AgentChat } from './wire';

export const AGENT_HISTORY_PAGE_TURNS = 40;

export function agentHistoryPage(chat: AgentChat, before = -1): AgentChat {
  const messages = chat.messages ?? [];
  const offset = chat.messageOffset ?? 0;
  const end = before < 0 ? messages.length : Math.max(0, Math.min(before - offset, messages.length));
  let start = end;
  let turns = 0;
  while (start > 0) {
    start--;
    if (messages[start].role === 'user' && ++turns === AGENT_HISTORY_PAGE_TURNS) break;
  }
  return { ...chat, messages: messages.slice(start, end), messageOffset: offset + start, messageCount: chat.messageCount ?? offset + messages.length };
}

export function mergeAgentHistory(current: AgentChat | null, page: AgentChat): AgentChat {
  if (!current || current.id !== page.id) return page;
  const start = current.messageOffset ?? 0;
  const next = page.messageOffset ?? 0;
  const end = start + current.messages.length;
  const pageEnd = next + page.messages.length;
  if (pageEnd < start || next > end) return page;
  if (pageEnd < end) {
    return { ...current, messageOffset: Math.min(start, next), messages: [...page.messages.slice(0, Math.max(0, start - next)), ...current.messages] };
  }
  return { ...page, messageOffset: Math.min(start, next), messages: [...current.messages.slice(0, Math.max(0, next - start)), ...page.messages] };
}

export function virtualOffsets(ids: string[], heights: ReadonlyMap<string, number>, estimate = 220): number[] {
  const offsets = [0];
  for (const id of ids) offsets.push(offsets[offsets.length - 1] + (heights.get(id) ?? estimate));
  return offsets;
}

export function virtualIndex(offsets: number[], position: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function virtualRange(offsets: number[], top: number, height: number, overscan = 700): { start: number; end: number } {
  if (offsets.length < 2) return { start: 0, end: 0 };
  return { start: virtualIndex(offsets, Math.max(0, top - overscan)), end: Math.min(offsets.length - 1, virtualIndex(offsets, top + height + overscan) + 1) };
}
