import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenRuntime } from '../lib/runtimeEvents';
import { realtimeFeature } from '../lib/stores/features/realtime';

function fakeRuntime() {
  const handlers: Record<string, Array<(payload: unknown) => void>> = {};
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers[event] ?? []) handler(payload);
  };
  const count = (event: string) => (handlers[event] ?? []).length;
  vi.stubGlobal('window', {
    runtime: {
      EventsOn: (event: string, callback: (payload: unknown) => void) => {
        handlers[event] = [...(handlers[event] ?? []), callback];
        return () => {
          handlers[event] = (handlers[event] ?? []).filter(item => item !== callback);
        };
      },
    },
  });
  return { emit, count };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listenRuntime', () => {
  it('replaces an earlier listener for the same event instead of adding a second one', () => {
    const runtime = fakeRuntime();
    const first = vi.fn();
    const second = vi.fn();
    listenRuntime('ws:open', first);
    listenRuntime('ws:open', second);
    runtime.emit('ws:open', { sessionId: 's' });
    expect(runtime.count('ws:open')).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps one listener per event when the app registers its listeners again', () => {
    const runtime = fakeRuntime();
    const host = Object.create(realtimeFeature) as { initWebSocketListeners: () => void; initSocketIOListeners: () => void; initSSEListeners: () => void };
    for (let mount = 0; mount < 4; mount += 1) {
      host.initWebSocketListeners();
      host.initSocketIOListeners();
      host.initSSEListeners();
    }
    for (const event of ['ws:open', 'ws:event', 'ws:events', 'ws:close', 'sio:open', 'sio:event', 'sio:ack', 'sse:open', 'sse:event']) {
      expect(runtime.count(event)).toBe(1);
    }
  });

  it('tolerates a runtime whose EventsOn returns nothing', () => {
    vi.stubGlobal('window', { runtime: { EventsOn: () => undefined } });
    expect(() => {
      listenRuntime('ws:open', () => {});
      listenRuntime('ws:open', () => {});
    }).not.toThrow();
  });
});
