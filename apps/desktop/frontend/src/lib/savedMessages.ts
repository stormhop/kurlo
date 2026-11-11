import { normalizeSioArgs } from './normalizers';
import { normalizeRawBodyTypeForUi } from './utils';
import type { RawBodyType, RequestType, SavedRealtimeMessage, SIOArg } from './types/models';

export type WebSocketDraft = { content: string; type: RawBodyType | 'binary' };
export type SocketIODraft = { event: string; args: SIOArg[]; ack: boolean };

export const SAVED_MESSAGES_MAX = 100;
export const SAVED_MESSAGE_MAX_BYTES = 256 * 1024;
export const SAVED_MESSAGES_SEARCH_FROM = 9;

export function requestTypeSupportsSavedMessages(requestType: RequestType | undefined): boolean {
  return requestType === 'ws' || requestType === 'socketio';
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function messageType(value: unknown): RawBodyType | 'binary' {
  if (value === 'binary') return 'binary';
  return asText(value) ? normalizeRawBodyTypeForUi(asText(value) as RawBodyType) : 'text';
}

export function newSavedMessageId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `msg-${random}`;
}

export function normalizeSavedMessages(input: unknown, requestType: RequestType | undefined): SavedRealtimeMessage[] {
  if (!requestTypeSupportsSavedMessages(requestType) || !Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: SavedRealtimeMessage[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    let id = asText(item.id).trim();
    if (!id || seen.has(id)) id = `msg-${out.length + 1}`;
    let suffix = 2;
    while (seen.has(id)) id = `msg-${out.length + 1}-${suffix++}`;
    seen.add(id);
    const name = asText(item.name).trim() || `Message ${out.length + 1}`;
    if (requestType === 'ws') {
      out.push({ id, name, content: asText(item.content), bodyType: messageType(item.bodyType) });
    } else {
      out.push({
        id,
        name,
        event: asText(item.event),
        args: normalizeSioArgs(Array.isArray(item.args) ? item.args as Partial<SIOArg>[] : undefined),
        ack: item.ack === true,
      });
    }
  }
  return out;
}

export function uniqueSavedMessageName(name: string, messages: SavedRealtimeMessage[], exceptId = ''): string {
  const base = name.trim() || 'Message';
  const taken = new Set(messages.filter(message => message.id !== exceptId).map(message => message.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (taken.has(`${base} ${suffix}`.toLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

export function suggestedSavedMessageName(requestType: RequestType | undefined, draft: { event?: string }, messages: SavedRealtimeMessage[]): string {
  const base = requestType === 'socketio' && draft.event?.trim() ? draft.event.trim() : 'Message';
  return uniqueSavedMessageName(base === 'Message' ? `Message ${messages.length + 1}` : base, messages);
}

export function webSocketMessageFromDraft(name: string, draft: WebSocketDraft, messages: SavedRealtimeMessage[]): SavedRealtimeMessage {
  return { id: newSavedMessageId(), name: uniqueSavedMessageName(name, messages), content: draft.content, bodyType: draft.type };
}

export function socketIOMessageFromDraft(name: string, draft: SocketIODraft, messages: SavedRealtimeMessage[]): SavedRealtimeMessage {
  return {
    id: newSavedMessageId(),
    name: uniqueSavedMessageName(name, messages),
    event: draft.event,
    args: draft.args.map(arg => ({ ...arg })),
    ack: draft.ack,
  };
}

export function webSocketDraftFromMessage(message: SavedRealtimeMessage): WebSocketDraft {
  return { content: message.content ?? '', type: message.bodyType ?? 'text' };
}

export function socketIODraftFromMessage(message: SavedRealtimeMessage): SocketIODraft {
  return { event: message.event ?? '', args: normalizeSioArgs(message.args), ack: message.ack === true };
}

export function savedMessageSummary(message: SavedRealtimeMessage, requestType: RequestType | undefined): string {
  if (requestType === 'socketio') {
    const args = (message.args ?? []).filter(arg => arg.content.trim()).length;
    const event = message.event?.trim() || 'message';
    return `${event} · ${args === 1 ? '1 arg' : `${args} args`}${message.ack ? ' · ack' : ''}`;
  }
  const preview = (message.content ?? '').replace(/\s+/g, ' ').trim();
  return preview.length > 60 ? `${preview.slice(0, 59)}…` : preview || 'Empty message';
}

export function cloneSavedMessages(messages: SavedRealtimeMessage[]): SavedRealtimeMessage[] {
  return messages.map(message => ({ ...message, ...(message.args ? { args: message.args.map(arg => ({ ...arg })) } : {}) }));
}

function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function savedMessageBytes(message: { content?: string; event?: string; args?: SIOArg[] }): number {
  return textBytes(message.content ?? '') + textBytes(message.event ?? '') + (message.args ?? []).reduce((sum, arg) => sum + textBytes(arg.content), 0);
}

export function savedMessageProblem(count: number, bytes: number): string {
  if (count >= SAVED_MESSAGES_MAX) return `A request keeps up to ${SAVED_MESSAGES_MAX} saved messages. Delete one to save another.`;
  if (bytes > SAVED_MESSAGE_MAX_BYTES) return `This message is over ${SAVED_MESSAGE_MAX_BYTES / 1024} KB. Saved messages are kept in the request file, so keep them under that size.`;
  return '';
}

export function savedMessageSearchText(message: SavedRealtimeMessage): string {
  return [message.name, message.content ?? '', message.event ?? '', ...(message.args ?? []).map(arg => arg.content)].join('\n').toLowerCase();
}

export function filterSavedMessages(messages: SavedRealtimeMessage[], query: string): SavedRealtimeMessage[] {
  const needle = query.trim().toLowerCase();
  return needle ? messages.filter(message => savedMessageSearchText(message).includes(needle)) : messages;
}
