import { describe, expect, it } from 'vitest';
import {
  SAVED_MESSAGE_MAX_BYTES,
  SAVED_MESSAGES_MAX,
  filterSavedMessages,
  normalizeSavedMessages,
  savedMessageBytes,
  savedMessageProblem,
  savedMessageSummary,
  socketIODraftFromMessage,
  socketIOMessageFromDraft,
  suggestedSavedMessageName,
  uniqueSavedMessageName,
  webSocketDraftFromMessage,
  webSocketMessageFromDraft,
} from '../lib/savedMessages';
import { normalizeSavedRequest } from '../lib/normalizers';
import { requestDirtyFingerprint } from '../lib/manualSave';
import type { SavedRealtimeMessage, SavedRequest } from '../lib/types/models';

describe('saved realtime messages', () => {
  it('keeps WebSocket messages as text with a type and drops Socket.IO fields', () => {
    const messages = normalizeSavedMessages([
      { name: 'Subscribe', content: '{"op":"sub"}', bodyType: 'json', event: 'ignored' },
      { content: 'ping' },
      'not a message',
    ], 'ws');
    expect(messages).toEqual([
      { id: 'msg-1', name: 'Subscribe', content: '{"op":"sub"}', bodyType: 'json' },
      { id: 'msg-2', name: 'Message 2', content: 'ping', bodyType: 'text' },
    ]);
  });

  it('keeps Socket.IO events with their arguments and acknowledgement', () => {
    const [join] = normalizeSavedMessages([
      { name: 'Join', event: 'join', ack: true, args: [{ content: '{"room":"a"}', bodyType: 'json' }, { content: 'second' }] },
    ], 'socketio');
    expect(join).toMatchObject({ id: 'msg-1', name: 'Join', event: 'join', ack: true });
    expect(join.args?.map(arg => [arg.id, arg.content, arg.bodyType])).toEqual([['1', '{"room":"a"}', 'json'], ['2', 'second', 'json']]);
  });

  it('only exists for WebSocket and Socket.IO requests', () => {
    for (const type of ['http', 'graphql', 'grpc', 'mcp', 'ai'] as const) {
      expect(normalizeSavedMessages([{ name: 'x', content: 'y' }], type)).toEqual([]);
    }
  });

  it('gives stable ids so loading the same YAML twice is not a change', () => {
    const raw = [{ name: 'A', content: '1' }, { name: 'B', content: '2' }];
    expect(normalizeSavedMessages(raw, 'ws')).toEqual(normalizeSavedMessages(raw, 'ws'));
    expect(normalizeSavedMessages([{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }], 'ws').map(m => m.id)).toEqual(['x', 'msg-2']);
  });

  it('names new messages without clashing', () => {
    const existing: SavedRealtimeMessage[] = [{ id: '1', name: 'Join' }, { id: '2', name: 'Join 2' }];
    expect(uniqueSavedMessageName('join', existing)).toBe('join 3');
    expect(uniqueSavedMessageName('Leave', existing)).toBe('Leave');
    expect(uniqueSavedMessageName('Join', existing, '1')).toBe('Join');
    expect(suggestedSavedMessageName('socketio', { event: 'join' }, existing)).toBe('join 3');
    expect(suggestedSavedMessageName('ws', {}, existing)).toBe('Message 3');
  });

  it('captures the editor and gives it back unchanged', () => {
    const ws = webSocketMessageFromDraft('Binary frame', { content: 'AAEC', type: 'binary' }, []);
    expect(webSocketDraftFromMessage(ws)).toEqual({ content: 'AAEC', type: 'binary' });

    const args = [{ id: '1', content: '{"room":"a"}', bodyType: 'json' as const, encoding: 'base64' as const }];
    const sio = socketIOMessageFromDraft('Join', { event: 'join', args, ack: true }, []);
    args[0].content = 'edited later';
    expect(socketIODraftFromMessage(sio)).toEqual({ event: 'join', ack: true, args: [{ id: '1', content: '{"room":"a"}', bodyType: 'json', encoding: 'base64' }] });
  });

  it('summarises a message for the menu', () => {
    expect(savedMessageSummary({ id: '1', name: 'A', content: '{\n  "op": "sub"\n}' }, 'ws')).toBe('{ "op": "sub" }');
    expect(savedMessageSummary({ id: '1', name: 'A', content: '' }, 'ws')).toBe('Empty message');
    expect(savedMessageSummary({ id: '1', name: 'A', event: 'join', ack: true, args: [{ id: '1', content: 'x', bodyType: 'text', encoding: 'base64' }] }, 'socketio')).toBe('join · 1 arg · ack');
  });

  it('round-trips through request normalisation without marking the request changed', () => {
    const request = normalizeSavedRequest({
      id: 'req-ws', name: 'Feed', requestType: 'ws', url: 'wss://feed.test',
      savedMessages: [{ name: 'Subscribe', content: '{"op":"sub"}', bodyType: 'json' }],
    } as Partial<SavedRequest>, [], []);
    expect(request.savedMessages).toEqual([{ id: 'msg-1', name: 'Subscribe', content: '{"op":"sub"}', bodyType: 'json' }]);
    const withoutMessages = normalizeSavedRequest({ id: 'req-ws2', name: 'Feed', requestType: 'ws', url: 'wss://feed.test' } as Partial<SavedRequest>, [], []);
    const { savedMessages, ...snapshotWithoutField } = withoutMessages;
    expect(savedMessages).toEqual([]);
    expect(requestDirtyFingerprint(snapshotWithoutField as SavedRequest)).toBe(requestDirtyFingerprint(withoutMessages));
  });
});

describe('saved message limits', () => {
  it('allows saving below the count and size limits', () => {
    expect(savedMessageProblem(SAVED_MESSAGES_MAX - 1, SAVED_MESSAGE_MAX_BYTES)).toBe('');
  });

  it('stops at 100 messages per request', () => {
    expect(savedMessageProblem(SAVED_MESSAGES_MAX, 10)).toBe('A request keeps up to 100 saved messages. Delete one to save another.');
  });

  it('refuses a message over 256 KB', () => {
    expect(savedMessageProblem(0, SAVED_MESSAGE_MAX_BYTES + 1)).toContain('over 256 KB');
  });

  it('counts UTF-8 bytes of the content, the event and every argument', () => {
    expect(savedMessageBytes({ content: 'привет' })).toBe(12);
    expect(savedMessageBytes({ event: 'join', args: [{ id: '1', content: 'ab', bodyType: 'text' }, { id: '2', content: 'é', bodyType: 'text' }] })).toBe(8);
  });

  it('keeps every message from the request file even past the limit', () => {
    const raw = Array.from({ length: SAVED_MESSAGES_MAX + 20 }, (_, index) => ({ id: `m${index}`, name: `Message ${index}`, content: `${index}` }));
    expect(normalizeSavedMessages(raw, 'ws')).toHaveLength(SAVED_MESSAGES_MAX + 20);
  });

  it('finds messages by name, content, event and arguments', () => {
    const messages = [
      { id: 'a', name: 'Subscribe orders', content: '{"op":"subscribe"}' },
      { id: 'b', name: 'Ping', content: 'heartbeat' },
      { id: 'c', name: 'Join', event: 'room:join', args: [{ id: '1', content: '{"room":"Kitchen"}', bodyType: 'text' as const }] },
    ];
    expect(filterSavedMessages(messages, 'ORDERS').map(item => item.id)).toEqual(['a']);
    expect(filterSavedMessages(messages, 'heartbeat').map(item => item.id)).toEqual(['b']);
    expect(filterSavedMessages(messages, 'room:join').map(item => item.id)).toEqual(['c']);
    expect(filterSavedMessages(messages, 'kitchen').map(item => item.id)).toEqual(['c']);
    expect(filterSavedMessages(messages, '  ')).toHaveLength(3);
  });
});
